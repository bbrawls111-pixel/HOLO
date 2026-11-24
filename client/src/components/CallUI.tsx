import {
  ChevronDown, Maximize2, Mic, MicOff, Minimize2, MonitorUp, MonitorX, Phone, PhoneOff, Video, VideoOff, Volume2, X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  acceptCall, declineCall, endCall, fmtDuration, setVolume, startScreen, stopScreen, switchMic, toggleCam, toggleMic, useCall,
} from '../calls';
import { useStore } from '../store';
import { cx } from '../util';
import { Avatar } from './Avatar';
import styles from './CallUI.module.css';

function StreamVideo({ stream, muted, className, contain }: { stream: MediaStream | null; muted?: boolean; className?: string; contain?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream;
  }, [stream]);
  return <video ref={ref} className={className} autoPlay playsInline muted={muted} style={{ objectFit: contain ? 'contain' : 'cover' }} />;
}

/** Уровень громкости собеседника — для подсветки «говорит». */
function useSpeaking(stream: MediaStream | null) {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (!stream || !stream.getAudioTracks().length) return;
    const ctx = new AudioContext();
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Uint8Array(an.fftSize);
    let raf = 0;
    const tick = () => {
      an.getByteTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
      setLevel((l) => l * 0.7 + (peak / 128) * 0.3);
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelAnimationFrame(raf);
      ctx.close();
    };
  }, [stream]);
  return level;
}

function useTimer(startedAt: number | null) {
  const [, force] = useState(0);
  useEffect(() => {
    if (!startedAt) return;
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [startedAt]);
  return startedAt ? fmtDuration(Date.now() - startedAt) : null;
}

function QualityBadge() {
  const q = useCall((s) => s.quality);
  const conn = useCall((s) => s.connState);
  if (conn === 'disconnected' || conn === 'failed') return <span className={cx(styles.q, styles.qBad)}>переподключение…</span>;
  if (!q) return null;
  const level = q.loss > 5 || (q.rtt ?? 0) > 300 ? 'bad' : q.loss > 1 || (q.rtt ?? 0) > 150 ? 'mid' : 'good';
  return (
    <span className={cx(styles.q, level === 'good' ? styles.qGood : level === 'mid' ? styles.qMid : styles.qBad)} title={`Потери ${q.loss}% · ${q.bitrate} кбит/с`}>
      <span className={styles.bars}>
        <i />
        <i />
        <i />
      </span>
      {q.rtt !== null ? `${q.rtt} мс` : ''} · {q.route === 'relay' ? 'через TURN' : 'напрямую'}
    </span>
  );
}

function ScreenPicker({ onClose }: { onClose: () => void }) {
  const [sources, setSources] = useState<Awaited<ReturnType<typeof window.holo.screenSources>> | null>(null);
  useEffect(() => {
    window.holo.screenSources().then(setSources).catch(() => setSources([]));
  }, []);
  return (
    <div className={styles.pickerBackdrop} onMouseDown={onClose}>
      <div className={cx('card', styles.picker)} onMouseDown={(e) => e.stopPropagation()}>
        <div className={styles.pickerHead}>
          <h3>Что показать?</h3>
          <button className="btn ghost sm icon" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className={styles.pickerGrid}>
          {sources === null && <div className="faint">Ищем экраны и окна…</div>}
          {sources?.map((s) => (
            <button
              key={s.id}
              className={styles.source}
              onClick={() => {
                onClose();
                void startScreen(s.id);
              }}
            >
              <img src={s.thumbnail} alt="" />
              <span>
                {s.icon && <img src={s.icon} alt="" className={styles.srcIcon} />}
                {s.screen ? `Экран · ${s.name}` : s.name}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function MicMenu({ onClose }: { onClose: () => void }) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const volume = useCall((s) => s.volume);
  useEffect(() => {
    navigator.mediaDevices.enumerateDevices().then((d) => setDevices(d.filter((x) => x.kind === 'audioinput')));
  }, []);
  return (
    <div className={styles.menu} onMouseLeave={onClose}>
      <div className={styles.menuLabel}>Микрофон</div>
      {devices.map((d) => (
        <button
          key={d.deviceId}
          onClick={() => {
            void switchMic(d.deviceId);
            onClose();
          }}
        >
          {d.label || 'Микрофон'}
        </button>
      ))}
      <div className={styles.menuLabel}>
        <Volume2 size={12} /> Громкость собеседника
      </div>
      <input type="range" min={0} max={1} step={0.05} value={volume} onChange={(e) => setVolume(Number(e.target.value))} />
    </div>
  );
}

function Controls({ big }: { big?: boolean }) {
  const { mic, cam, screen, expanded } = useCall();
  const [picker, setPicker] = useState(false);
  const [menu, setMenu] = useState(false);
  return (
    <div className={cx(styles.controls, big && styles.controlsBig)}>
      <div className={styles.split}>
        <button className={cx(styles.ctl, !mic && styles.ctlOff)} onClick={toggleMic} title={mic ? 'Выключить микрофон' : 'Включить микрофон'}>
          {mic ? <Mic size={18} /> : <MicOff size={18} />}
        </button>
        <button className={styles.caret} onClick={() => setMenu((m) => !m)}>
          <ChevronDown size={13} />
        </button>
        {menu && <MicMenu onClose={() => setMenu(false)} />}
      </div>
      <button className={cx(styles.ctl, cam && styles.ctlOn)} onClick={() => void toggleCam()} title="Камера">
        {cam ? <Video size={18} /> : <VideoOff size={18} />}
      </button>
      <button
        className={cx(styles.ctl, screen && styles.ctlOn)}
        onClick={() => (screen ? void stopScreen() : setPicker(true))}
        title={screen ? 'Остановить показ экрана' : 'Показать экран'}
      >
        {screen ? <MonitorX size={18} /> : <MonitorUp size={18} />}
      </button>
      <button className={styles.ctl} onClick={() => useCall.setState({ expanded: !expanded })} title={expanded ? 'Свернуть' : 'На весь экран'}>
        {expanded ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
      </button>
      <button className={cx(styles.ctl, styles.hang)} onClick={() => endCall()} title="Завершить">
        <PhoneOff size={18} />
      </button>
      {picker && <ScreenPicker onClose={() => setPicker(false)} />}
    </div>
  );
}

export function CallUI() {
  const s = useCall();
  const users = useStore((st) => st.users);
  const peer = s.peerId ? users[s.peerId] : undefined;
  const timer = useTimer(s.startedAt);
  const speaking = useSpeaking(s.remoteAudio) > 0.06;

  if (s.phase === 'idle') return null;

  if (s.phase === 'incoming') {
    return (
      <div className={styles.incoming}>
        <div className={styles.pulse}>
          {peer && <Avatar user={peer} size={84} />}
        </div>
        <div className={styles.inName}>{peer?.nickname ?? 'Напарник'}</div>
        <div className={styles.inSub}>{s.videoInvite ? 'Входящий видеозвонок' : 'Входящий звонок'}</div>
        <div className={styles.inBtns}>
          <button className={cx(styles.round, styles.decline)} onClick={declineCall} title="Отклонить">
            <PhoneOff size={22} />
          </button>
          <button className={cx(styles.round, styles.accept)} onClick={() => void acceptCall(false)} title="Принять">
            <Phone size={22} />
          </button>
          <button className={cx(styles.round, styles.acceptVideo)} onClick={() => void acceptCall(true)} title="Принять с видео">
            <Video size={22} />
          </button>
        </div>
      </div>
    );
  }

  if (s.phase === 'ended') {
    return (
      <div className={styles.ended}>
        <PhoneOff size={16} /> {s.endedText}
      </div>
    );
  }

  const remoteMain = s.remote.screen && s.remoteScreen ? s.remoteScreen : s.remote.cam && s.remoteCam ? s.remoteCam : null;
  const status =
    s.phase === 'outgoing' ? 'Вызов…' : s.phase === 'connecting' ? 'Соединение…' : timer ?? '';

  if (s.expanded && (s.phase === 'active' || s.phase === 'connecting')) {
    return (
      <div className={styles.full}>
        <div className={styles.fullTop}>
          <div className={styles.who}>
            {peer && <Avatar user={peer} size={36} />}
            <div>
              <strong>{peer?.nickname}</strong>
              <span>{status}</span>
            </div>
          </div>
          <QualityBadge />
        </div>
        <div className={styles.stage}>
          {remoteMain ? (
            <StreamVideo stream={remoteMain} className={styles.stageVideo} contain={remoteMain === s.remoteScreen} />
          ) : (
            <div className={cx(styles.bigAvatar, speaking && styles.speaking)}>{peer && <Avatar user={peer} size={160} />}</div>
          )}
          {!s.remote.mic && <div className={styles.mutedBadge}><MicOff size={14} /> микрофон выключен</div>}
          <div className={styles.pips}>
            {s.remote.screen && s.remote.cam && s.remoteCam && <StreamVideo stream={s.remoteCam} className={styles.pip} />}
            {s.localCam && <StreamVideo stream={s.localCam} muted className={cx(styles.pip, styles.mirror)} />}
            {s.localScreen && <StreamVideo stream={s.localScreen} muted className={styles.pip} contain />}
          </div>
        </div>
        <Controls big />
      </div>
    );
  }

  return (
    <div className={styles.mini}>
      <div className={styles.miniTop}>
        <div className={cx(styles.miniAvatar, speaking && styles.speaking, s.phase === 'outgoing' && styles.calling)}>
          {peer && <Avatar user={peer} size={40} />}
        </div>
        <div className={styles.miniText}>
          <strong>{peer?.nickname ?? 'Напарник'}</strong>
          <span>{status}</span>
        </div>
        {s.phase === 'active' && <QualityBadge />}
      </div>
      {remoteMain && s.phase === 'active' && (
        <div className={styles.miniVideo} onClick={() => useCall.setState({ expanded: true })}>
          <StreamVideo stream={remoteMain} contain={remoteMain === s.remoteScreen} className={styles.fill} />
        </div>
      )}
      {s.phase === 'outgoing' ? (
        <div className={styles.controls}>
          <button className={cx(styles.ctl, styles.hang, styles.wide)} onClick={() => endCall('Вызов отменён')}>
            <PhoneOff size={17} /> Отменить
          </button>
        </div>
      ) : (
        <Controls />
      )}
    </div>
  );
}
