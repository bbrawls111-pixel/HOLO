import { File as FileIcon, FileAudio, FileCode2, FileText, FileVideo, Image, Loader2, Type } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { binaryText, binaryUrl, fileContentPath } from '../api';
import type { HoloFile } from '../types';
import { cx, fileKind, type FileKind } from '../util';
import styles from './FilePreview.module.css';

export const KIND_ICON: Record<FileKind, typeof FileIcon> = {
  image: Image,
  audio: FileAudio,
  video: FileVideo,
  text: FileText,
  code: FileCode2,
  font: Type,
  other: FileIcon,
};

export const KIND_LABEL: Record<FileKind, string> = {
  image: 'Изображение',
  audio: 'Аудио',
  video: 'Видео',
  text: 'Текст',
  code: 'Код / данные',
  font: 'Шрифт',
  other: 'Файл',
};

/** Полноразмерный предпросмотр: картинки, аудио, видео, текст, шрифты. */
export function FilePreview({ file, version, large }: { file: HoloFile; version?: number; large?: boolean }) {
  const kind = fileKind(file);
  const path = fileContentPath(file, version);
  const [url, setUrl] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [fontFamily, setFontFamily] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    setUrl(null);
    setText(null);
    setFontFamily(null);
    setError('');
    const fail = (e: Error) => alive && setError(e.message);
    if (['image', 'audio', 'video'].includes(kind) && file.size < 200 * 1024 * 1024) {
      binaryUrl(path).then((u) => alive && setUrl(u)).catch(fail);
    } else if ((kind === 'text' || kind === 'code') && file.size < 5 * 1024 * 1024) {
      binaryText(path).then((t) => alive && setText(t)).catch(fail);
    } else if (kind === 'font') {
      binaryUrl(path)
        .then(async (u) => {
          const family = `holo-preview-${file.id}-${version ?? file.version}`;
          const face = new FontFace(family, `url(${u})`);
          await face.load();
          document.fonts.add(face);
          if (alive) setFontFamily(family);
        })
        .catch(fail);
    }
    return () => {
      alive = false;
    };
  }, [path, kind, file.size, file.id, file.version, version]);

  const Icon = KIND_ICON[kind];
  const wrap = (node: ReactNode) => <div className={cx(styles.box, large && styles.large)}>{node}</div>;

  if (error) return wrap(<div className={styles.empty}>{error}</div>);
  if (kind === 'image') return wrap(url ? <img className={styles.media} src={url} alt="" /> : <Loading />);
  if (kind === 'audio')
    return wrap(
      url ? (
        <div className={styles.audio}>
          <FileAudio size={56} strokeWidth={1.2} />
          <audio src={url} controls />
        </div>
      ) : (
        <Loading />
      ),
    );
  if (kind === 'video') return wrap(url ? <video className={styles.media} src={url} controls /> : <Loading />);
  if (kind === 'text' || kind === 'code')
    return wrap(text !== null ? <pre className={cx(styles.text, 'selectable')}>{text}</pre> : <Loading />);
  if (kind === 'font')
    return wrap(
      fontFamily ? (
        <div className={styles.font} style={{ fontFamily }}>
          <div style={{ fontSize: 44 }}>Aa Бб Вв</div>
          <div style={{ fontSize: 20 }}>Съешь же ещё этих мягких французских булок.</div>
          <div>The quick brown fox jumps over the lazy dog 0123456789</div>
        </div>
      ) : (
        <Loading />
      ),
    );
  return wrap(
    <div className={styles.empty}>
      <Icon size={48} strokeWidth={1.2} />
      Предпросмотр недоступен
    </div>,
  );
}

const Loading = () => (
  <div className={styles.empty}>
    <Loader2 className="spin" />
  </div>
);

