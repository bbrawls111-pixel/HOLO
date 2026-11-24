import { Check, Download, File as FileIcon, Hash, Loader2, Paperclip, Pencil, SendHorizontal, Trash2, X } from 'lucide-react';
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, fileContentPath, useBinaryUrl } from '../api';
import { Avatar } from '../components/Avatar';
import { addOwnMessage, confirmAction, loadMessages, openFile, setActiveChannel, toast, useStore } from '../store';
import type { HoloFile, Message } from '../types';
import { uploadOne } from '../upload';
import { cx, fileKind, formatBytes, formatTime } from '../util';
import styles from './Chat.module.css';

const URL_RE = /(https?:\/\/[^\s<]+)/g;

function Linkified({ text }: { text: string }) {
  const parts = text.split(URL_RE);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 ? (
          <a
            key={i}
            href={p}
            onClick={(e) => {
              e.preventDefault();
              window.holo.openExternal(p);
            }}
          >
            {p}
          </a>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}

function Attachment({ file }: { file: HoloFile }) {
  const isImage = fileKind(file) === 'image' && file.size < 15 * 1024 * 1024;
  const url = useBinaryUrl(isImage ? fileContentPath(file) : null);
  if (isImage) {
    return (
      <button className={styles.imageAttach} onClick={() => openFile(file)} title={file.path}>
        {url ? <img src={url} alt={file.name} /> : <Loader2 className="spin faint" />}
      </button>
    );
  }
  return (
    <div className={styles.fileAttach}>
      <FileIcon size={22} className="faint" />
      <button className={styles.fileAttachName} onClick={() => openFile(file)}>
        <strong>{file.name}</strong>
        <span className="faint">{formatBytes(file.size)}</span>
      </button>
      <button className="btn ghost sm icon" title="Скачать" onClick={() => window.holo.download(file.id, file.name)}>
        <Download size={16} />
      </button>
    </div>
  );
}

const dayLabel = (ts: number) => {
  const d = new Date(ts);
  const today = new Date();
  const y = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Сегодня';
  if (d.toDateString() === y.toDateString()) return 'Вчера';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
};

export function Chat() {
  const channels = useStore((s) => s.channels);
  const active = useStore((s) => s.activeChannel);
  const unread = useStore((s) => s.unread);
  const state = useStore((s) => s.messages[active]);
  const users = useStore((s) => s.users);
  const me = useStore((s) => s.me)!;
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const stickToBottom = useRef(true);
  const prevHeight = useRef(0);

  const items = state?.items ?? [];
  const channel = channels.find((c) => c.id === active);

  useEffect(() => {
    stickToBottom.current = true;
    loadMessages(active).catch((e) => toast(e.message));
    inputRef.current?.focus();
  }, [active]);

  // Автопрокрутка вниз, если пользователь и так внизу.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (loadingOlder) {
      el.scrollTop = el.scrollHeight - prevHeight.current;
      return;
    }
    if (stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [items.length, active, loadingOlder]);

  const onScroll = () => {
    const el = scrollRef.current!;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const loadOlder = async () => {
    prevHeight.current = scrollRef.current?.scrollHeight ?? 0;
    setLoadingOlder(true);
    try {
      await loadMessages(active, true);
    } finally {
      setTimeout(() => setLoadingOlder(false), 0);
    }
  };

  const send = async () => {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    try {
      const m = await api<Message>('POST', `/api/channels/${active}/messages`, { text: t });
      addOwnMessage(m);
      setText('');
      stickToBottom.current = true;
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  };

  const sendFiles = async (files: File[]) => {
    for (const f of files) {
      const stamp = new Date().toISOString().slice(0, 10);
      const name = f.name && f.name !== 'image.png' ? f.name : `screenshot-${Date.now()}.png`;
      const uploaded = await uploadOne(f, `chat/${stamp}/${Date.now().toString(36)}-${name}`);
      if (!uploaded) continue;
      try {
        const m = await api<Message>('POST', `/api/channels/${active}/messages`, { fileId: uploaded.id, text: '' });
        addOwnMessage(m);
        stickToBottom.current = true;
      } catch (e) {
        toast((e as Error).message);
      }
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    const t = editing.text.trim();
    if (!t) return;
    try {
      addOwnMessage(await api<Message>('PATCH', `/api/messages/${editing.id}`, { text: t }));
      setEditing(null);
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const remove = async (m: Message) => {
    if (!(await confirmAction('Удалить сообщение?', 'Оно исчезнет у обоих участников.'))) return;
    try {
      await api('DELETE', `/api/messages/${m.id}`);
    } catch (e) {
      toast((e as Error).message);
    }
  };

  return (
    <div className={styles.page}>
      <aside className={cx('card', styles.channels)}>
        <div className={styles.channelsHead}>Каналы</div>
        {channels.map((c) => (
          <button key={c.id} className={cx(styles.channel, c.id === active && styles.channelActive)} onClick={() => setActiveChannel(c.id)}>
            <Hash size={16} className="faint" />
            <span>{c.name}</span>
            {!!unread[c.id] && c.id !== active && <span className={styles.badge}>{unread[c.id]}</span>}
          </button>
        ))}
      </aside>

      <section
        className={cx('card', styles.chat)}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          sendFiles(Array.from(e.dataTransfer.files));
        }}
      >
        <header className={styles.chatHead}>
          <Hash size={18} className="faint" />
          <strong>{channel?.name}</strong>
        </header>

        <div className={styles.messages} ref={scrollRef} onScroll={onScroll}>
          {state?.hasMore && (
            <button className={cx('btn sm ghost', styles.older)} onClick={loadOlder} disabled={loadingOlder}>
              {loadingOlder ? <Loader2 size={14} className="spin" /> : null} Показать раньше
            </button>
          )}
          {!state?.loaded && (
            <div className="empty">
              <Loader2 className="spin" />
            </div>
          )}
          {state?.loaded && !items.length && (
            <div className="empty">Здесь пока тихо. Напишите первое сообщение в #{channel?.name}.</div>
          )}

          {items.map((m, i) => {
            const prev = items[i - 1];
            const newDay = !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
            const grouped = !newDay && prev && prev.userId === m.userId && m.createdAt - prev.createdAt < 5 * 60_000;
            const author = users[m.userId];
            const mine = m.userId === me.id;
            const isEditing = editing?.id === m.id;
            return (
              <Fragment key={m.id}>
                {newDay && (
                  <div className={styles.day}>
                    <span>{dayLabel(m.createdAt)}</span>
                  </div>
                )}
                <div className={cx(styles.message, grouped && styles.grouped)}>
                  <div className={styles.gutter}>
                    {grouped ? (
                      <span className={styles.hoverTime}>{formatTime(m.createdAt)}</span>
                    ) : (
                      author && <Avatar user={author} size={38} />
                    )}
                  </div>
                  <div className={styles.body}>
                    {!grouped && (
                      <div className={styles.meta}>
                        <strong>{author?.nickname ?? 'Неизвестно'}</strong>
                        <span className="faint">{formatTime(m.createdAt)}</span>
                      </div>
                    )}
                    {isEditing ? (
                      <div className={styles.editBox}>
                        <textarea
                          className="input"
                          rows={2}
                          autoFocus
                          value={editing.text}
                          onChange={(e) => setEditing({ id: m.id, text: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                              e.preventDefault();
                              saveEdit();
                            }
                            if (e.key === 'Escape') setEditing(null);
                          }}
                        />
                        <button className="btn sm icon primary" onClick={saveEdit}>
                          <Check size={15} />
                        </button>
                        <button className="btn sm icon ghost" onClick={() => setEditing(null)}>
                          <X size={15} />
                        </button>
                      </div>
                    ) : (
                      m.text && (
                        <div className={cx(styles.text, 'selectable')}>
                          <Linkified text={m.text} />
                          {m.editedAt && <span className={styles.edited}> (изм.)</span>}
                        </div>
                      )
                    )}
                    {m.file && <Attachment file={m.file} />}
                  </div>
                  {mine && !isEditing && (
                    <div className={styles.msgActions}>
                      {m.text && (
                        <button title="Изменить" onClick={() => setEditing({ id: m.id, text: m.text })}>
                          <Pencil size={14} />
                        </button>
                      )}
                      <button title="Удалить" onClick={() => remove(m)}>
                        <Trash2 size={14} />
                      </button>
                    </div>
                  )}
                </div>
              </Fragment>
            );
          })}
        </div>

        <div className={styles.composer}>
          <button className="btn ghost icon" title="Прикрепить файл" onClick={() => fileRef.current?.click()}>
            <Paperclip size={18} />
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              const list = Array.from(e.target.files || []);
              e.target.value = '';
              sendFiles(list);
            }}
          />
          <textarea
            ref={inputRef}
            className={styles.input}
            rows={1}
            placeholder={`Написать в #${channel?.name ?? ''}`}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = Math.min(e.target.scrollHeight, 180) + 'px';
            }}
            onPaste={(e) => {
              const imgs = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'));
              if (imgs.length) {
                e.preventDefault();
                sendFiles(imgs);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button className={cx('btn primary icon', styles.send)} disabled={!text.trim() || sending} onClick={send}>
            {sending ? <Loader2 size={17} className="spin" /> : <SendHorizontal size={17} />}
          </button>
        </div>
      </section>
    </div>
  );
}
