import { ImagePlus, Loader2, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { api } from '../api';
import { toast, useStore } from '../store';
import type { Me } from '../types';
import { AVATAR_GRADIENTS, cx, initials } from '../util';
import { Avatar } from './Avatar';
import styles from './ProfileEditor.module.css';

const SIZE = 256;

interface PendingAvatar {
  blob: Blob;
  url: string;
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Не удалось обработать изображение'))), 'image/webp', 0.9),
  );
}

/** Обрезает картинку до квадрата по центру и уменьшает до 256×256. */
async function cropToSquare(file: File): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const s = Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = SIZE;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, SIZE, SIZE);
    return await canvasToBlob(canvas);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Генерирует аватар-заглушку: градиент + инициалы. */
async function generatedAvatar(colors: string[], nickname: string): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, SIZE, SIZE);
  g.addColorStop(0, colors[0]);
  g.addColorStop(1, colors[1]);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.fillStyle = '#fff';
  ctx.font = `650 ${SIZE * 0.38}px "Segoe UI", system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(initials(nickname || '?'), SIZE / 2, SIZE / 2 + SIZE * 0.02);
  return canvasToBlob(canvas);
}

interface Props {
  me: Me;
  submitLabel?: string;
  onSaved?: (me: Me) => void;
}

export function ProfileEditor({ me, submitLabel = 'Сохранить', onSaved }: Props) {
  const [nickname, setNickname] = useState(me.needsSetup ? '' : me.nickname);
  const [pending, setPending] = useState<PendingAvatar | null>(null);
  const [removeAvatar, setRemoveAvatar] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const setAvatarBlob = (blob: Blob) => {
    if (pending) URL.revokeObjectURL(pending.url);
    setPending({ blob, url: URL.createObjectURL(blob) });
    setRemoveAvatar(false);
  };

  const onPick = async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) return setError('Выберите изображение');
    try {
      setAvatarBlob(await cropToSquare(file));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const trimmed = nickname.trim();
  const nickValid = trimmed.length >= 2 && trimmed.length <= 32;
  const dirty = me.needsSetup || trimmed !== me.nickname || !!pending || removeAvatar;

  const save = async () => {
    if (!nickValid) return setError('Ник: от 2 до 32 символов');
    setSaving(true);
    setError('');
    try {
      let updated = me;
      if (me.needsSetup || trimmed !== me.nickname) {
        updated = await api<Me>('PATCH', '/api/me', { nickname: trimmed });
      }
      if (pending) {
        const r = await window.holo.uploadAvatar(await pending.blob.arrayBuffer(), 'image/webp');
        if (!r.ok) throw new Error(r.error);
        updated = r.data!;
      } else if (removeAvatar) {
        updated = await api<Me>('DELETE', '/api/me/avatar');
      }
      const merged = { ...updated, online: true };
      useStore.setState((s) => ({ me: merged, users: { ...s.users, [merged.id]: { ...s.users[merged.id], ...merged } } }));
      setPending(null);
      setRemoveAvatar(false);
      onSaved?.(merged);
      if (!onSaved) toast('Профиль сохранён', 'info');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const previewUser = { ...me, nickname: trimmed || me.nickname, hasAvatar: removeAvatar ? false : me.hasAvatar };

  return (
    <div className={styles.editor}>
      <div className={styles.avatarRow}>
        <div
          className={styles.avatarDrop}
          onClick={() => fileRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            onPick(e.dataTransfer.files[0]);
          }}
          title="Загрузить аватар"
        >
          <Avatar user={previewUser} size={104} srcOverride={pending?.url} />
          <div className={styles.avatarHover}>
            <ImagePlus size={22} />
          </div>
        </div>

        <div className={styles.avatarSide}>
          <div className="label">Аватар</div>
          <div className={styles.avatarButtons}>
            <button className="btn sm" onClick={() => fileRef.current?.click()}>
              <ImagePlus size={15} /> Загрузить фото
            </button>
            {(me.hasAvatar || pending) && !removeAvatar && (
              <button
                className="btn sm ghost danger"
                onClick={() => {
                  if (pending) URL.revokeObjectURL(pending.url);
                  setPending(null);
                  setRemoveAvatar(me.hasAvatar);
                }}
              >
                <Trash2 size={15} /> Убрать
              </button>
            )}
          </div>
          <div className="faint" style={{ fontSize: 12 }}>
            Или выберите цвет:
          </div>
          <div className={styles.presets}>
            {AVATAR_GRADIENTS.map((c, i) => (
              <button
                key={i}
                className={styles.preset}
                style={{ background: `linear-gradient(135deg, ${c[0]}, ${c[1]})` }}
                onClick={async () => setAvatarBlob(await generatedAvatar(c, trimmed || me.nickname))}
              >
                {initials(trimmed || me.nickname)}
              </button>
            ))}
          </div>
        </div>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => onPick(e.target.files?.[0])} />
      </div>

      <label className={styles.field}>
        <span className="label">Ник</span>
        <input
          className="input"
          value={nickname}
          maxLength={32}
          placeholder="Как вас называть?"
          onChange={(e) => setNickname(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && dirty && save()}
          autoFocus={me.needsSetup}
        />
        <span className={cx('faint', styles.hint)}>От 2 до 32 символов. Виден второму участнику.</span>
      </label>

      {error && <div className={styles.error}>{error}</div>}

      <div>
        <button className="btn primary" disabled={!dirty || !nickValid || saving} onClick={save}>
          {saving && <Loader2 size={16} className="spin" />}
          {submitLabel}
        </button>
      </div>
    </div>
  );
}
