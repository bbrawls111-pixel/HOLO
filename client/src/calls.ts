import { create } from 'zustand';
import { api } from './api';
import { DM_CHANNEL, eventBus, toast, useStore } from './store';
import type { HoloEvent, Message } from './types';

/*
 * Звонки один на один: WebRTC, звук и видео идут напрямую между компьютерами.
 * Сервер Holo только передаёт сигналы (вызов, SDP, ICE-кандидаты).
 *
 * Схема: «вежливое» согласование (perfect negotiation) — вызывающий «невежливый»,
 * принимающий «вежливый». Три медиа-линии создаются сразу (звук, камера, экран),
 * поэтому камеру и показ экрана можно включать без повторного дозвона.
 * Служебные состояния (микрофон/камера/экран) ходят по прямому data-каналу.
 */

export type CallPhase = 'idle' | 'outgoing' | 'incoming' | 'connecting' | 'active' | 'ended';

export interface CallQuality {
  rtt: number | null; // мс
  loss: number; // % потерь входящего звука
  route: 'direct' | 'relay' | 'unknown';
  bitrate: number; // кбит/с исходящий звук
}

interface CallState {
  phase: CallPhase;
  callId: string | null;
  peerId: number | null;
  outgoing: boolean;
  videoInvite: boolean;
  startedAt: number | null;
  endedText: string | null;
  mic: boolean;
  cam: boolean;
  screen: boolean;
  remote: { mic: boolean; cam: boolean; screen: boolean };
  remoteCam: MediaStream | null;
  remoteScreen: MediaStream | null;
  remoteAudio: MediaStream | null;
  localCam: MediaStream | null;
  localScreen: MediaStream | null;
  quality: CallQuality | null;
  connState: string;
  expanded: boolean;
  volume: number;
}

const INITIAL: CallState = {
  phase: 'idle',
  callId: null,
  peerId: null,
  outgoing: false,
  videoInvite: false,
  startedAt: null,
  endedText: null,
  mic: true,
  cam: false,
  screen: false,
  remote: { mic: true, cam: false, screen: false },
  remoteCam: null,
  remoteScreen: null,
  remoteAudio: null,
  localCam: null,
  localScreen: null,
  quality: null,
  connState: 'new',
  expanded: false,
  volume: 1,
};

export const useCall = create<CallState>(() => ({ ...INITIAL }));
const set = useCall.setState;
const get = useCall.getState;

// ------------------------------------------------------------------ внутреннее состояние
let pc: RTCPeerConnection | null = null;
let dc: RTCDataChannel | null = null;
let micStream: MediaStream | null = null;
let camTrack: MediaStreamTrack | null = null;
let screenTrack: MediaStreamTrack | null = null;
const tx: { audio?: RTCRtpTransceiver; cam?: RTCRtpTransceiver; screen?: RTCRtpTransceiver } = {};
let polite = false;
let gotRemoteOffer = false;
let makingOffer = false;
let ignoreOffer = false;
let pendingIce: RTCIceCandidateInit[] = [];
let iceOut: RTCIceCandidateInit[] = [];
let iceTimer: ReturnType<typeof setTimeout> | undefined;
let inviteTimer: ReturnType<typeof setInterval> | undefined;
let giveUpTimer: ReturnType<typeof setTimeout> | undefined;
let statsTimer: ReturnType<typeof setInterval> | undefined;
let lostTimer: ReturnType<typeof setTimeout> | undefined;
let remoteAudio: HTMLAudioElement | null = null;
let everConnected = false;
const seen = new Set<number>();
const endedCalls = new Set<string>();
let lastSignalId = 0;

/** Отладочный журнал звонков: localStorage.setItem('holo.debugCalls', '1'). */
const dbg = (...a: unknown[]) => {
  try {
    if (localStorage.getItem('holo.debugCalls')) console.info('[call]', ...a);
  } catch {
    /* ignore */
  }
};
const me = () => useStore.getState().me;
const partnerId = () => Object.values(useStore.getState().users).find((u) => u.id !== me()?.id)?.id ?? null;
const nick = (id: number | null) => (id ? useStore.getState().users[id]?.nickname : null) ?? 'Напарник';

async function signal(payload: Record<string, unknown>) {
  const { peerId, callId } = get();
  dbg('send', payload.kind, (payload.description as RTCSessionDescriptionInit | undefined)?.type ?? '');
  if (!peerId) return;
  try {
    await api('POST', '/api/call/signal', { to: peerId, payload: { ...payload, callId } });
  } catch (e) {
    console.warn('signal failed', e);
  }
}

// ------------------------------------------------------------------ звуки (тихо, ~30%)
let toneCtx: AudioContext | null = null;
let toneTimer: ReturnType<typeof setInterval> | undefined;
function playTone(kind: 'ring' | 'back' | 'end') {
  stopTone();
  toneCtx ??= new AudioContext();
  const ctx = toneCtx;
  const beep = (freq: number, at: number, dur: number, vol = 0.06) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0, ctx.currentTime + at);
    g.gain.linearRampToValueAtTime(vol, ctx.currentTime + at + 0.02);
    g.gain.linearRampToValueAtTime(0, ctx.currentTime + at + dur);
    o.connect(g).connect(ctx.destination);
    o.start(ctx.currentTime + at);
    o.stop(ctx.currentTime + at + dur + 0.05);
  };
  const pattern = () => {
    if (kind === 'ring') [659, 784, 988, 784].forEach((f, i) => beep(f, i * 0.16, 0.15, 0.07));
    else if (kind === 'back') beep(440, 0, 0.9, 0.035);
  };
  if (kind === 'end') {
    beep(523, 0, 0.18, 0.05);
    beep(392, 0.2, 0.25, 0.05);
    return;
  }
  pattern();
  toneTimer = setInterval(pattern, kind === 'ring' ? 2200 : 3000);
}
function stopTone() {
  clearInterval(toneTimer);
  toneTimer = undefined;
}

/** RTCSessionDescription — объект браузера: через IPC он превращается в {}. Передаём обычный объект. */
const plainDesc = (d: RTCSessionDescription | null) => (d ? { type: d.type, sdp: d.sdp } : null);

// ------------------------------------------------------------------ SDP: настройка Opus
function tuneSdp(sdp?: string) {
  if (!sdp) return sdp;
  const m = /a=rtpmap:(\d+) opus\/48000\/2/i.exec(sdp);
  if (!m) return sdp;
  const pt = m[1];
  const want = 'maxaveragebitrate=96000;useinbandfec=1;usedtx=0;stereo=0;maxplaybackrate=48000';
  const re = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`);
  if (re.test(sdp)) {
    return sdp.replace(re, (_l, params: string) => {
      const kept = params
        .split(';')
        .filter((p) => p && !/^(maxaveragebitrate|useinbandfec|usedtx|stereo|maxplaybackrate)=/.test(p.trim()));
      return `a=fmtp:${pt} ${[...kept, want].join(';')}`;
    });
  }
  return sdp.replace(m[0], `${m[0]}\r\na=fmtp:${pt} ${want}`);
}

async function tuneSender(t: RTCRtpTransceiver | undefined, maxBitrate: number, extra: Partial<RTCRtpEncodingParameters> = {}) {
  if (!t) return;
  try {
    const p = t.sender.getParameters();
    p.encodings = p.encodings?.length ? p.encodings : [{}];
    p.encodings[0] = { ...p.encodings[0], maxBitrate, priority: 'high', networkPriority: 'high', ...extra };
    await t.sender.setParameters(p);
  } catch {
    /* параметры применятся при следующем согласовании */
  }
}

// ------------------------------------------------------------------ медиа
async function getMic() {
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1, sampleRate: 48000 },
  });
  return micStream.getAudioTracks()[0];
}

async function getCam() {
  const s = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } });
  camTrack = s.getVideoTracks()[0];
  set({ localCam: s, cam: true });
  return camTrack;
}

function sendState() {
  if (dc?.readyState !== 'open') return;
  const s = get();
  dc.send(JSON.stringify({ t: 'state', mic: s.mic, cam: s.cam, screen: s.screen }));
}

// ------------------------------------------------------------------ соединение
async function createPeer(isPolite: boolean) {
  polite = isPolite;
  let iceServers: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
  try {
    iceServers = (await api<{ iceServers: RTCIceServer[] }>('GET', '/api/call/ice')).iceServers;
  } catch {
    /* только STUN */
  }
  const peer = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle', iceCandidatePoolSize: 2 });
  pc = peer;
  dc = peer.createDataChannel('ctl', { negotiated: true, id: 0 });
  dc.onopen = sendState;
  dc.onmessage = (e) => {
    try {
      const m = JSON.parse(e.data);
      if (m.t === 'state') set({ remote: { mic: !!m.mic, cam: !!m.cam, screen: !!m.screen } });
    } catch {
      /* ignore */
    }
  };

  peer.onicecandidate = (e) => {
    if (!e.candidate) return;
    iceOut.push(e.candidate.toJSON());
    clearTimeout(iceTimer);
    iceTimer = setTimeout(() => {
      const batch = iceOut;
      iceOut = [];
      if (batch.length) void signal({ kind: 'ice', candidates: batch });
    }, 60);
  };

  peer.ontrack = (e) => {
    const mid = e.transceiver.mid;
    const stream = new MediaStream([e.track]);
    if (e.track.kind === 'audio') {
      remoteAudio ??= new Audio();
      remoteAudio.autoplay = true;
      remoteAudio.srcObject = stream;
      remoteAudio.volume = get().volume;
      void remoteAudio.play().catch(() => {});
      set({ remoteAudio: stream });
    } else if (mid === '1') set({ remoteCam: stream });
    else if (mid === '2') set({ remoteScreen: stream });
  };

  peer.onnegotiationneeded = async () => {
    // Принимающий не начинает согласование первым: его data-канал (negotiated)
    // и медиа-линии придут в предложении вызывающего.
    if (polite && !gotRemoteOffer) return;
    try {
      makingOffer = true;
      const offer = await peer.createOffer();
      if (peer.signalingState !== 'stable') return;
      await peer.setLocalDescription({ type: 'offer', sdp: tuneSdp(offer.sdp) });
      await signal({ kind: 'sdp', description: plainDesc(peer.localDescription) });
    } catch (err) {
      dbg('negotiation error', String(err));
      console.warn('negotiation', err);
    } finally {
      makingOffer = false;
    }
  };

  peer.onconnectionstatechange = () => {
    const st = peer.connectionState;
    dbg('conn', st, 'ice', peer.iceConnectionState, 'sig', peer.signalingState);
    set({ connState: st });
    if (st === 'connected') {
      clearTimeout(lostTimer);
      if (!everConnected) {
        everConnected = true;
        stopTone();
        set({ phase: 'active', startedAt: Date.now() });
        startStats();
      }
    } else if (st === 'disconnected') {
      // Короткий обрыв (смена сети, Wi-Fi) — пробуем переподнять ICE.
      clearTimeout(lostTimer);
      lostTimer = setTimeout(() => {
        if (pc?.connectionState === 'disconnected' && !polite) pc.restartIce();
        lostTimer = setTimeout(() => {
          if (pc && pc.connectionState !== 'connected') endCall('Связь потеряна');
        }, 15000);
      }, 3000);
    } else if (st === 'failed') {
      if (!polite) peer.restartIce();
      clearTimeout(lostTimer);
      lostTimer = setTimeout(() => {
        if (pc && pc.connectionState !== 'connected') {
          endCall(everConnected ? 'Связь потеряна' : 'Не удалось соединиться — нужен TURN-сервер (см. Настройки)');
        }
      }, 12000);
    }
  };

  if (!polite) {
    // Вызывающий создаёт три линии: звук, камера, экран.
    const mic = micStream?.getAudioTracks()[0];
    tx.audio = peer.addTransceiver(mic ?? 'audio', { direction: 'sendrecv' });
    tx.cam = peer.addTransceiver(camTrack ?? 'video', { direction: 'sendrecv' });
    tx.screen = peer.addTransceiver('video', { direction: 'sendrecv' });
    await tuneSender(tx.audio, 96_000);
    await tuneSender(tx.cam, 1_500_000);
    await tuneSender(tx.screen, 4_000_000, { priority: 'medium' });
  }
}

/** Принимающий: после первого предложения привязываем свои дорожки к линиям по порядку. */
async function mapTransceivers() {
  if (!pc || tx.audio) return;
  const list = pc.getTransceivers();
  tx.audio = list.find((t) => t.mid === '0');
  tx.cam = list.find((t) => t.mid === '1');
  tx.screen = list.find((t) => t.mid === '2');
  for (const t of [tx.audio, tx.cam, tx.screen]) if (t) t.direction = 'sendrecv';
  const mic = micStream?.getAudioTracks()[0];
  if (mic) await tx.audio?.sender.replaceTrack(mic);
  if (camTrack) await tx.cam?.sender.replaceTrack(camTrack);
}

async function onDescription(desc: RTCSessionDescriptionInit) {
  if (!pc) return;
  const collision = desc.type === 'offer' && (makingOffer || pc.signalingState !== 'stable');
  ignoreOffer = !polite && collision;
  if (ignoreOffer) return;
  await pc.setRemoteDescription(desc);
  if (desc.type === 'offer') {
    gotRemoteOffer = true;
    await mapTransceivers();
    const answer = await pc.createAnswer();
    await pc.setLocalDescription({ type: 'answer', sdp: tuneSdp(answer.sdp) });
    await signal({ kind: 'sdp', description: plainDesc(pc.localDescription) });
    await tuneSender(tx.audio, 96_000);
    await tuneSender(tx.cam, 1_500_000);
    await tuneSender(tx.screen, 4_000_000, { priority: 'medium' });
  }
  for (const c of pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => {});
}

async function onIce(candidates: RTCIceCandidateInit[]) {
  if (!pc || !pc.remoteDescription) {
    pendingIce.push(...candidates);
    return;
  }
  for (const c of candidates) {
    try {
      await pc.addIceCandidate(c);
    } catch (err) {
      if (!ignoreOffer) console.warn('ice', err);
    }
  }
}

// ------------------------------------------------------------------ качество связи
let prevStats: { lost: number; received: number; bytes: number; ts: number } | null = null;
function startStats() {
  clearInterval(statsTimer);
  statsTimer = setInterval(async () => {
    if (!pc) return;
    const stats = await pc.getStats();
    let rtt: number | null = null;
    let route: CallQuality['route'] = 'unknown';
    let lost = 0;
    let received = 0;
    let bytes = 0;
    const candidates = new Map<string, RTCStats & { candidateType?: string }>();
    stats.forEach((r) => {
      if (r.type === 'local-candidate' || r.type === 'remote-candidate') candidates.set(r.id, r);
    });
    stats.forEach((r) => {
      const s = r as RTCStats & Record<string, number & string & boolean>;
      if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') {
        if (typeof s.currentRoundTripTime === 'number') rtt = Math.round(s.currentRoundTripTime * 1000);
        const local = candidates.get(s.localCandidateId);
        const remote = candidates.get(s.remoteCandidateId);
        route = local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'relay' : 'direct';
      }
      if (s.type === 'inbound-rtp' && s.kind === 'audio') {
        lost = s.packetsLost ?? 0;
        received = s.packetsReceived ?? 0;
      }
      if (s.type === 'outbound-rtp' && s.kind === 'audio') bytes = s.bytesSent ?? 0;
    });
    const now = Date.now();
    let loss = 0;
    let bitrate = 0;
    if (prevStats) {
      const dl = lost - prevStats.lost;
      const dr = received - prevStats.received;
      loss = dl + dr > 0 ? Math.max(0, Math.round((dl / (dl + dr)) * 1000) / 10) : 0;
      bitrate = Math.round(((bytes - prevStats.bytes) * 8) / (now - prevStats.ts));
    }
    prevStats = { lost, received, bytes, ts: now };
    set({ quality: { rtt, loss, route, bitrate } });
  }, 2000);
}

// ------------------------------------------------------------------ сценарии
export async function startCall(video = false) {
  if (get().phase !== 'idle') return;
  const peer = partnerId();
  if (!peer) return toast('Второй участник ещё не зарегистрирован');
  const callId = crypto.randomUUID();
  set({ ...INITIAL, phase: 'outgoing', callId, peerId: peer, outgoing: true, videoInvite: video, volume: get().volume });
  try {
    await getMic();
    if (video) await getCam();
  } catch {
    cleanup();
    set({ ...INITIAL });
    return toast('Нет доступа к микрофону или камере');
  }
  playTone('back');
  const invite = () => signal({ kind: 'invite', video });
  void invite();
  // Повторяем вызов, пока не ответят (на случай переподключения сокета у напарника).
  inviteTimer = setInterval(invite, 3500);
  giveUpTimer = setTimeout(() => {
    if (get().phase === 'outgoing') endCall('Нет ответа', true);
  }, 45_000);
}

export async function acceptCall(withVideo = false) {
  const s = get();
  if (s.phase !== 'incoming') return;
  stopTone();
  try {
    await getMic();
    if (withVideo) await getCam();
  } catch {
    toast('Нет доступа к микрофону или камере');
    return declineCall();
  }
  set({ phase: 'connecting' });
  await createPeer(true);
  await signal({ kind: 'accept' });
}

export function declineCall() {
  if (get().phase !== 'incoming') return;
  void signal({ kind: 'decline' });
  finish('Вызов отклонён');
}

export function endCall(reason = 'Звонок завершён', silentPeer = false) {
  const s = get();
  if (s.phase === 'idle' || s.phase === 'ended') return;
  if (!silentPeer) void signal({ kind: s.phase === 'outgoing' ? 'cancel' : 'hangup' });
  // Итог звонка в чате пишет вызывающий — один раз.
  if (s.outgoing) {
    const dur = s.startedAt ? fmtDuration(Date.now() - s.startedAt) : null;
    const text = dur ? `📞 ${s.videoInvite ? 'Видеозвонок' : 'Звонок'} · ${dur}` : `📞 ${reason === 'Вызов отклонён' ? 'Звонок отклонён' : 'Пропущенный звонок'}`;
    void api<Message>('POST', `/api/channels/${DM_CHANNEL}/messages`, { text }).catch(() => {});
  }
  finish(reason);
}

function finish(reason: string) {
  const s = get();
  if (s.callId) endedCalls.add(s.callId);
  const dur = s.startedAt ? fmtDuration(Date.now() - s.startedAt) : null;
  cleanup();
  playTone('end');
  set({ ...INITIAL, volume: s.volume, phase: 'ended', peerId: s.peerId, endedText: dur ? `${reason} · ${dur}` : reason });
  setTimeout(() => {
    if (get().phase === 'ended') set({ ...INITIAL, volume: get().volume });
  }, 2600);
}

function cleanup() {
  stopTone();
  clearInterval(inviteTimer);
  clearTimeout(giveUpTimer);
  clearInterval(statsTimer);
  clearTimeout(lostTimer);
  clearTimeout(iceTimer);
  prevStats = null;
  micStream?.getTracks().forEach((t) => t.stop());
  camTrack?.stop();
  screenTrack?.stop();
  micStream = null;
  camTrack = null;
  screenTrack = null;
  dc?.close();
  pc?.close();
  pc = null;
  dc = null;
  tx.audio = tx.cam = tx.screen = undefined;
  pendingIce = [];
  iceOut = [];
  makingOffer = false;
  ignoreOffer = false;
  gotRemoteOffer = false;
  everConnected = false;
  if (remoteAudio) {
    remoteAudio.srcObject = null;
    remoteAudio = null;
  }
}

export const fmtDuration = (ms: number) => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

// ------------------------------------------------------------------ управление во время звонка
export function toggleMic() {
  const t = micStream?.getAudioTracks()[0];
  if (!t) return;
  t.enabled = !t.enabled;
  set({ mic: t.enabled });
  sendState();
}

export async function toggleCam() {
  if (get().cam) {
    camTrack?.stop();
    camTrack = null;
    await tx.cam?.sender.replaceTrack(null);
    set({ cam: false, localCam: null });
  } else {
    try {
      const t = await getCam();
      await tx.cam?.sender.replaceTrack(t);
    } catch {
      toast('Камера недоступна');
    }
  }
  sendState();
}

export async function startScreen(sourceId: string) {
  try {
    await window.holo.setScreenSource(sourceId);
    const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 60 } }, audio: false });
    screenTrack = s.getVideoTracks()[0];
    screenTrack.contentHint = 'detail';
    screenTrack.onended = () => void stopScreen();
    await tx.screen?.sender.replaceTrack(screenTrack);
    await tuneSender(tx.screen, 4_000_000, { priority: 'medium' });
    set({ screen: true, localScreen: s });
    sendState();
  } catch {
    toast('Не удалось показать экран');
  }
}

export async function stopScreen() {
  screenTrack?.stop();
  screenTrack = null;
  await tx.screen?.sender.replaceTrack(null);
  set({ screen: false, localScreen: null });
  sendState();
}

export function setVolume(v: number) {
  set({ volume: v });
  if (remoteAudio) remoteAudio.volume = v;
}

export async function switchMic(deviceId: string) {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const t = s.getAudioTracks()[0];
    t.enabled = get().mic;
    await tx.audio?.sender.replaceTrack(t);
    micStream?.getTracks().forEach((x) => x.stop());
    micStream = s;
  } catch {
    toast('Не удалось переключить микрофон');
  }
}

// ------------------------------------------------------------------ входящие сигналы
async function handleSignal(id: number, from: number, payload: Record<string, unknown> | undefined) {
  if (seen.has(id)) return;
  seen.add(id);
  lastSignalId = Math.max(lastSignalId, id);
  let p = payload;
  if (!p) {
    try {
      p = (await api<{ payload: Record<string, unknown> }>('GET', `/api/call/signal/${id}`)).payload;
    } catch {
      return;
    }
  }
  const kind = p.kind as string;
  const callId = p.callId as string;
  dbg('recv', kind, (p.description as RTCSessionDescriptionInit | undefined)?.type ?? '', 'phase', get().phase, 'pc', !!pc);
  if (kind === 'sdp') {
    const sdp = (p.description as RTCSessionDescriptionInit).sdp ?? '';
    dbg('sdp len', sdp.length, 'crlf', sdp.split('\r\n').length, 'opus', (sdp.match(/a=fmtp:\d+ [^\r\n]*useinbandfec[^\r\n]*/) || [''])[0], 'tail', JSON.stringify(sdp.slice(-60)));
  }
  const s = get();

  if (kind === 'invite') {
    if (endedCalls.has(callId)) return; // запоздавший повтор уже завершённого вызова
    if (s.phase === 'idle' || (s.phase === 'ended' && s.callId !== callId)) {
      set({ ...INITIAL, volume: s.volume, phase: 'incoming', callId, peerId: from, outgoing: false, videoInvite: !!p.video });
      playTone('ring');
      if (!document.hasFocus()) {
        try {
          new Notification(`${nick(from)} звонит`, { body: p.video ? 'Видеозвонок' : 'Аудиозвонок', silent: true });
        } catch {
          /* уведомления недоступны */
        }
      }
    } else if (s.callId === callId) {
      // повтор того же вызова — игнорируем
    } else if (s.phase === 'outgoing' && s.peerId === from) {
      // Звоним друг другу одновременно: побеждает вызов участника с меньшим id.
      if ((me()?.id ?? 0) > from) {
        clearInterval(inviteTimer);
        clearTimeout(giveUpTimer);
        stopTone();
        set({ phase: 'incoming', callId, outgoing: false, videoInvite: !!p.video });
        await acceptCall(get().cam);
      }
    } else {
      void api('POST', '/api/call/signal', { to: from, payload: { kind: 'busy', callId } }).catch(() => {});
    }
    return;
  }
  if (callId !== s.callId) return;

  switch (kind) {
    case 'accept':
      if (s.phase !== 'outgoing') return;
      clearInterval(inviteTimer);
      clearTimeout(giveUpTimer);
      stopTone();
      set({ phase: 'connecting' });
      await createPeer(false);
      break;
    case 'decline':
      endCall('Вызов отклонён', true);
      break;
    case 'busy':
      endCall('Собеседник занят', true);
      break;
    case 'cancel':
      if (s.phase === 'incoming') finish('Пропущенный звонок');
      break;
    case 'hangup':
      endCall('Собеседник завершил звонок', true);
      break;
    case 'sdp':
      await onDescription(p.description as RTCSessionDescriptionInit).catch((e) => {
        dbg('sdp error', String(e));
        console.warn('sdp', e);
      });
      break;
    case 'ice':
      await onIce(p.candidates as RTCIceCandidateInit[]);
      break;
  }
}

/** Подключить звонки к событиям сервера. Вызывается один раз при старте. */
export function initCalls() {
  const onSignal = (e: Event) => {
    const ev = (e as CustomEvent<HoloEvent>).detail;
    const p = ev.payload as { id: number; from: number; to: number; payload?: Record<string, unknown> };
    if (p.to !== me()?.id) return;
    void handleSignal(p.id, p.from, p.payload);
  };
  eventBus.addEventListener('call.signal', onSignal);
  // После переподключения дочитываем сигналы, которые могли пролететь мимо.
  const off = window.holo.on('holo:connection', async ({ state }: { state: string }) => {
    if (state !== 'online' || !me()) return;
    try {
      const list = await api<{ id: number; from: number; payload: Record<string, unknown>; createdAt: number; now: number }[]>(
        'GET',
        `/api/call/inbox?since=${lastSignalId}`,
      );
      // Вызовы, которые уже отменили, и слишком старые приглашения — не звоним.
      const closed = new Set(list.filter((x) => ['cancel', 'hangup', 'decline'].includes(x.payload.kind as string)).map((x) => x.payload.callId));
      for (const sgn of list) {
        if (sgn.payload.kind === 'invite' && (closed.has(sgn.payload.callId) || sgn.now - sgn.createdAt > 30_000)) {
          seen.add(sgn.id);
          lastSignalId = Math.max(lastSignalId, sgn.id);
          continue;
        }
        await handleSignal(sgn.id, sgn.from, sgn.payload);
      }
    } catch {
      /* не критично */
    }
  });
  const onUnload = () => {
    if (get().phase !== 'idle' && get().phase !== 'ended') void signal({ kind: get().phase === 'outgoing' ? 'cancel' : 'hangup' });
  };
  window.addEventListener('beforeunload', onUnload);
  return () => {
    eventBus.removeEventListener('call.signal', onSignal);
    off();
    window.removeEventListener('beforeunload', onUnload);
  };
}
