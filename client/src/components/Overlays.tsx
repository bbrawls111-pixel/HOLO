import { BookmarkPlus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useStore, type LibraryForm } from '../store';
import { cx } from '../util';
import styles from './Overlays.module.css';

/** Диалоги (ввод текста / подтверждение / сохранение в библиотеку) и уведомления. */
export function Overlays() {
  const dialog = useStore((s) => s.dialog);
  const toasts = useStore((s) => s.toasts);
  const [value, setValue] = useState('');
  const [form, setForm] = useState<LibraryForm>({ title: '', description: '' });
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (dialog?.kind === 'prompt') {
      setValue(dialog.value ?? '');
      setTimeout(() => inputRef.current?.select(), 20);
    }
    if (dialog?.kind === 'library') {
      setForm(dialog.value);
      setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [dialog]);

  const close = (result: unknown) => {
    if (!dialog) return;
    (dialog.resolve as (v: unknown) => void)(result);
    useStore.setState({ dialog: null });
  };

  const confirm = () => {
    if (!dialog) return;
    if (dialog.kind === 'prompt') return value.trim() && close(value.trim());
    if (dialog.kind === 'library') return close({ title: form.title.trim(), description: form.description.trim() });
    close(true);
  };

  return (
    <>
      {dialog && (
        <div className={styles.backdrop} onMouseDown={() => close(null)}>
          <div
            className={cx(styles.dialog, 'card', dialog.kind === 'library' && styles.wide)}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') close(null);
              if (e.key === 'Enter' && (e.ctrlKey || (dialog.kind !== 'library' && !(e.target instanceof HTMLTextAreaElement)))) {
                e.preventDefault();
                confirm();
              }
            }}
          >
            <div className={styles.head}>
              {dialog.kind === 'library' && (
                <span className={styles.headIcon}>
                  <BookmarkPlus size={18} />
                </span>
              )}
              <h3>{dialog.title}</h3>
            </div>
            {dialog.message && <p className="muted">{dialog.message}</p>}

            {dialog.kind === 'prompt' && (
              <input ref={inputRef} className="input" value={value} onChange={(e) => setValue(e.target.value)} />
            )}

            {dialog.kind === 'library' && (
              <div className={styles.libForm}>
                {dialog.preview && <img className={styles.preview} src={dialog.preview} alt="" />}
                <div className={styles.fields}>
                  <div className={styles.fileName}>{dialog.fileName}</div>
                  <input
                    ref={inputRef}
                    className="input"
                    placeholder="Название (необязательно)"
                    value={form.title}
                    maxLength={200}
                    onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                  />
                  <textarea
                    className="input"
                    rows={3}
                    placeholder="Описание (необязательно)"
                    value={form.description}
                    maxLength={4000}
                    onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  />
                </div>
              </div>
            )}

            <div className={styles.actions}>
              <button className="btn ghost" onClick={() => close(null)}>
                {dialog.kind === 'library' ? 'Не сохранять' : 'Отмена'}
              </button>
              <button
                className={cx('btn', dialog.kind !== 'library' && dialog.danger ? 'danger' : 'primary')}
                disabled={dialog.kind === 'prompt' && !value.trim()}
                onClick={confirm}
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
