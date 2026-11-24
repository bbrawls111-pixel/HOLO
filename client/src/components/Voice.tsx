import { Loader2, Mic, Pause, Play, SendHorizontal, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { binaryUrl, fileContentPath } from '../api';
import { toast } from '../store';
import type { HoloFile } from '../types';
import { cx } from '../util';
import styles from './Voice.module.css';

const BARS = 42;
const peaksCache = new Map<string, number[]>();

/** Волна громкости: BARS значений 0..1. */
async function computePeaks(url: string): Promise<number[]> {
  const cached = peaksCache.get(url);
  if (cached) return cached;
  const buf = await (await fetch(url)).arrayBuffer();
  const ctx = new AudioContext();
  try {
    const audio = await ctx.decodeAudioData(buf);
    const data = audio.getChannelData(0);
    const step = Math.max(1, Math.floor(data.length / BARS));
    const peaks: number[] = [];
    for (let i = 0; i < BARS; i++) {
      let sum = 0;
      for (let j = i * step; j < Math.min(data.length, (i + 1) * step); j += 16) sum += Math.abs(data[j]);
      peaks.push(sum / (step / 16));
    }
    const max = Math.max(...peaks, 0.0001);
    const norm = peaks.map((p) => Math.max(0.08, p / max));
    peaksCache.set(url, norm);
    return norm;
  } finally {
    ctx.close();
  }
}

const fmt = (s: number) => {
  if (!Number.isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

const SPEEDS = [1, 1.5, 2];
let current: HTMLAudioElement | null = null; // играет только одно сообщение

/** Проигрыватель голосовых и аудио: волна, перемотка по клику, скорость. */
export function AudioPlayer({ file, mine, voice }: { file: HoloFile; mine?: boolean; voice?: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState(1);
  const audio = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    let alive = true;
    binaryUrl(fileContentPath(file))
      .then(async (u) => {
        if (!alive) return;
        setUrl(u);
        setPeaks(await computePeaks(u).catch(() => Array(BARS).fill(0.3)));
      })
      .catch(() => {});
    return () => {
      alive = false;
      audio.current?.pause();
    };
  }, [file]);

  useEffect(() => {
    if (!url) return;
    const a = new Audio(url);
    audio.current = a;
    a.onloadedmetadata = () => {
      // У записей MediaRecorder длительность бывает Infinity, пока не дочитать до конца.
      if (a.duration === Infinity) {
        a.currentTime = 1e9;
        a.ontimeupdate = () => {
          a.ontimeupdate = () => setTime(a.currentTime);
          setDuration(a.duration);
          a.currentTime = 0;
        };
      } else setDuration(a.duration);
    };
    a.ontimeupdate = () => setTime(a.currentTime);
    a.onplay = () => setPlaying(true);
    a.onpause = () => setPlaying(false);
    a.onended = () => {
      setPlaying(false);
      setTime(0);
    };
    return () => a.pause();
  }, [url]);

  const toggle = () => {
    const a = audio.current;
    if (!a) return;
    if (a.paused) {
      if (current && current !== a) current.pause();
      current = a;
      a.playbackRate = speed;
      void a.play();
    } else a.pause();
  };

  const seek = (e: ReactMouseEvent<HTMLDivElement>) => {
    const a = audio.current;
    if (!a || !duration) return;
    const r = e.currentTarget.getBoundingClientRect();
    a.currentTime = ((e.clientX - r.left) / r.width) * duration;
    setTime(a.currentTime);
  };

  const nextSpeed = () => {
    const s = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
    setSpeed(s);
    if (audio.current) audio.current.playbackRate = s;
  };

  const progress = duration ? time / duration : 0;

  return (
    <div className={cx(styles.player, mine && styles.mine)}>
      <button className={styles.play} onClick={toggle} disabled={!url}>
        {!url ? <Loader2 size={18} className="spin" /> : playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
      </button>
      <div className={styles.body}>
        {!voice && <div className={styles.title}>{file.name}</div>}
        <div className={styles.wave} onClick={seek}>
          {(peaks ?? Array(BARS).fill(0.15)).map((p, i) => (
            <span key={i} className={cx(styles.bar, i / BARS < progress && styles.barOn)} style={{ height: `${Math.round(p * 100)}%` }} />
          ))}
        </div>
        <div className={styles.meta}>
          <span>{fmt(playing || time ? time : duration)}</span>
          <button className={styles.speed} onClick={nextSpeed}>
            {speed}×
          </button>
        </div>
      </div>
    </div>
  );
}

// =================================================================== запись
export function useVoiceRecorder(onDone: (file: File) => void) {
  const [state, setState] = useState<'idle' | 'recording'>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState<number[]>([]);
  const rec = useRef<{ mr: MediaRecorder; stream: MediaStream; chunks: Blob[]; start: number; timer: number; ctx: AudioContext; cancel: boolean } | null>(null);

  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
      const mr = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 64000 });
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Uint8Array(analyser.frequencyBinCount);
      const r = { mr, stream, chunks: [] as Blob[], start: Date.now(), timer: 0, ctx, cancel: false };
      rec.current = r;
      mr.ondataavailable = (e) => e.data.size && r.chunks.push(e.data);
      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        ctx.close();
        clearInterval(r.timer);
        setState('idle');
        setLevel([]);
        if (r.cancel || Date.now() - r.start < 500) return;
        const blob = new Blob(r.chunks, { type: 'audio/webm' });
        onDone(new File([blob], `voice-${Date.now()}.webm`, { type: 'audio/webm' }));
      };
      r.timer = window.setInterval(() => {
        setElapsed((Date.now() - r.start) / 1000);
        analyser.getByteTimeDomainData(buf);
        let peak = 0;
        for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
        setLevel((l) => [...l.slice(-31), Math.max(0.1, peak / 128)]);
      }, 80);
      mr.start(250);
      setElapsed(0);
      setState('recording');
    } catch {
      toast('Нет доступа к микрофону');
    }
  };

  const stop = (cancel = false) => {
    if (!rec.current) return;
    rec.current.cancel = cancel;
    rec.current.mr.stop();
    rec.current = null;
  };

  return { state, elapsed, level, start, stop };
}

export function RecordingBar({ elapsed, level, onCancel, onSend }: { elapsed: number; level: number[]; onCancel: () => void; onSend: () => void }) {
  return (
    <div className={styles.recording}>
      <button className="btn ghost icon danger" title="Отменить" onClick={onCancel}>
        <Trash2 size={18} />
      </button>
      <span className={styles.recDot} />
      <span className={styles.recTime}>{fmt(elapsed)}</span>
      <div className={styles.recWave}>
        {level.map((l, i) => (
          <span key={i} style={{ height: `${Math.round(l * 100)}%` }} />
        ))}
      </div>
      <button className={cx('btn primary icon', styles.recSend)} title="Отправить" onClick={onSend}>
        <SendHorizontal size={17} />
      </button>
    </div>
  );
}

export function MicButton({ onClick }: { onClick: () => void }) {
  return (
    <button className={cx('btn primary icon', styles.mic)} title="Голосовое сообщение" onClick={onClick}>
      <Mic size={18} />
    </button>
  );
}

