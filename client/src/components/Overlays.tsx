import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { cx } from '../util';
import styles from './Overlays.module.css';

/** Диалоги (ввод текста / подтверждение) и всплывающие уведомления. */
export function Overlays() {
  const dialog = useStore((s) => s.dialog);
  const toasts = useStore((s) => s.toasts);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (dialog?.kind === 'prompt') {
      setValue(dialog.value ?? '');
      setTimeout(() => inputRef.current?.select(), 20);
    }
  }, [dialog]);

  const close = (result: string | boolean | null) => {
    dialog?.resolve(result);
    useStore.setState({ dialog: null });
  };

  return (
    <>
      {dialog && (
        <div className={styles.backdrop} onMouseDown={() => close(null)}>
          <div className={cx(styles.dialog, 'card')} onMouseDown={(e) => e.stopPropagation()}>
            <h3>{dialog.title}</h3>
            {dialog.message && <p className="muted">{dialog.message}</p>}
            {dialog.kind === 'prompt' && (
              <input
                ref={inputRef}
                className="input"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && value.trim()) close(value.trim());
                  if (e.key === 'Escape') close(null);
                }}
              />
            )}
            <div className={styles.actions}>
              <button className="btn ghost" onClick={() => close(null)}>
                Отмена
              </button>
              <button
                className={cx('btn', dialog.danger ? 'danger' : 'primary')}
                disabled={dialog.kind === 'prompt' && !value.trim()}
                onClick={() => close(dialog.kind === 'prompt' ? value.trim() : true)}
                autoFocus={dialog.kind === 'confirm'}
              >
                {dialog.confirmText || 'OK'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className={styles.toasts}>
        {toasts.map((t) => (
          <div key={t.id} className={cx(styles.toast, t.kind === 'error' && styles.error)}>
            {t.text}
          </div>
        ))}
      </div>
    </>
  );
}
