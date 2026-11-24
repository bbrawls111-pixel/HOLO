import { BookmarkPlus, Check, Download, File as FileIcon, Loader2, Paperclip, Pencil, SendHorizontal, Trash2, X } from 'lucide-react';
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { api, fileContentPath, useBinaryUrl } from '../api';
import { Avatar } from '../components/Avatar';
import {
  addOwnMessage, askLibrary, confirmAction, DM_CHANNEL, loadMessages, openChat, toast, upsertFile, useStore, type AiProvider,
} from '../store';
import type { HoloFile, Message } from '../types';
import { uploadOne } from '../upload';
import { cx, fileKind, formatBytes, formatTime, presenceText } from '../util';
import { activeSession, AiAvatar, AiPane, PROVIDER_IDS, PROVIDERS, useAi } from './AiPane';
import styles from './Chat.module.css';

const URL_RE = /(https?:\/\/[^\s<]+)/g;

function Linkified({ text }: { text: string }) {
  return (
    <>
      {text.split(URL_RE).map((p, i) =>
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

/** Скачать вложение, затем предложить сохранить его в библиотеку. */
async function downloadAttachment(file: HoloFile, preview: string | null) {
  const r = await window.holo.download(file.id, file.name);
  if (!r.ok) {
    if (!r.canceled) toast(r.error || 'Не удалось скачать');
    return;
  }
  await saveToLibrary(file, preview, 'Файл скачан. Сохранить в библиотеку?');
}

async function saveToLibrary(file: HoloFile, preview: string | null, title = 'Сохранить в библиотеку?') {
  const form = await askLibrary({ fileName: `${file.name} · ${formatBytes(file.size)}`, title, preview });
  if (!form) return;
  try {
    const r = await api<{ file: HoloFile }>('POST', `/api/files/${file.id}/to-library`, form);
    upsertFile(r.file);
    toast('Добавлено в библиотеку', 'info');
  } catch (e) {
    toast((e as Error).message);
  }
}

function Attachment({ file }: { file: HoloFile }) {
  const isImage = fileKind(file) === 'image' && file.size < 15 * 1024 * 1024;
  const url = useBinaryUrl(isImage ? fileContentPath(file) : null);
  const actions = (
    <div className={styles.attachActions}>
      <button title="Сохранить в библиотеку" onClick={() => saveToLibrary(file, url)}>
        <BookmarkPlus size={15} />
      </button>
      <button title="Скачать" onClick={() => downloadAttachment(file, url)}>
        <Download size={15} />
      </button>
    </div>
  );
  if (isImage) {
    return (
      <div className={styles.imageAttach}>
        {url ? <img src={url} alt={file.name} /> : <div className={cx(styles.imgSkeleton, 'skeleton')} />}
        {actions}
      </div>
    );
  }
  return (
    <div className={styles.fileAttach}>
      <span className={styles.fileIcon}>
        <FileIcon size={20} />
      </span>
      <div className={styles.fileAttachName}>
        <strong>{file.name}</strong>
        <span className="faint">{formatBytes(file.size)}</span>
      </div>
      {actions}
    </div>
  );
}

const dayLabel = (ts: number) => {
  const d = new Date(ts);
  if (d.toDateString() === new Date().toDateString()) return 'Сегодня';
  if (d.toDateString() === new Date(Date.now() - 86_400_000).toDateString()) return 'Вчера';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
};

// =================================================================== список слева
function ChatList() {
  const target = useStore((s) => s.chatTarget);
  const users = useStore((s) => s.users);
  const me = useStore((s) => s.me)!;
  const unread = useStore((s) => s.unread[DM_CHANNEL] || 0);
  const dm = useStore((s) => s.messages[DM_CHANNEL]);
  const ai = useAi();
  const partner = Object.values(users).find((u) => u.id !== me.id);
  const last = dm?.items[dm.items.length - 1];
  const lastText = last ? (last.userId === me.id ? 'Вы: ' : '') + (last.text || (last.file ? `📎 ${last.file.name}` : '')) : 'Напишите первым';

  return (
    <aside className={cx('card', styles.list)}>
      <div className={styles.listHead}>Чаты</div>

      <button className={cx(styles.row, target === 'dm' && styles.rowOn)} onClick={() => openChat('dm')}>
        {partner ? <Avatar user={partner} size={46} status /> : <div className={styles.ghostAvatar} />}
        <div className={styles.rowText}>
          <div className={styles.rowTop}>
            <span className={styles.rowName}>{partner?.nickname ?? 'Напарник'}</span>
            {last && <span className={styles.rowTime}>{formatTime(last.createdAt)}</span>}
          </div>
          <div className={styles.rowBottom}>
            <span className={styles.rowPreview}>{lastText}</span>
            {unread > 0 && target !== 'dm' && <span className={styles.badge}>{unread}</span>}
          </div>
        </div>
      </button>

      <div className={styles.section}>ИИ-ассистенты</div>
      {PROVIDER_IDS.map((p, i) => {
        const P = PROVIDERS[p];
        const s = activeSession(ai, p);
        const count = ai.sessions.filter((x) => x.provider === p).length;
        return (
          <button
            key={p}
            className={cx(styles.row, target === `ai:${p}` && styles.rowOn)}
            style={{ '--i': i } as CSSProperties}
            onClick={() => openChat(`ai:${p}`)}
          >
            <AiAvatar provider={p} size={46} />
            <div className={styles.rowText}>
              <div className={styles.rowTop}>
                <span className={styles.rowName}>{P.name}</span>
                <span className={styles.rowTime}>{P.tagline}</span>
              </div>
              <div className={styles.rowBottom}>
                <span className={styles.rowPreview}>
                  {s?.name} · акк. {s?.account}
                  {count > 1 ? ` · сессий: ${count}` : ''}
                </span>
              </div>
            </div>
          </button>
        );
      })}
      {!partner && <p className={styles.note}>Второй участник ещё не зарегистрирован.</p>}
    </aside>
  );
}

// =================================================================== личка
function DmPane({ visible }: { visible: boolean }) {
  const state = useStore((s) => s.messages[DM_CHANNEL]);
  const users = useStore((s) => s.users);
  const me = useStore((s) => s.me)!;
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [dragging, setDragging] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const stickToBottom = useRef(true);
  const prevHeight = useRef(0);
  const firstIds = useRef<Set<number> | null>(null);

  const items = state?.items ?? [];
  const partner = Object.values(users).find((u) => u.id !== me.id);

  useEffect(() => {
    loadMessages(DM_CHANNEL).catch((e) => toast(e.message));
  }, []);

  useEffect(() => {
    if (state?.loaded && !firstIds.current) firstIds.current = new Set(items.map((m) => m.id));
  }, [state?.loaded, items]);

  useEffect(() => {
    if (visible) {
      stickToBottom.current = true;
      inputRef.current?.focus();
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [visible]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (loadingOlder) {
      el.scrollTop = el.scrollHeight - prevHeight.current;
      return;
    }
    if (stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [items.length, loadingOlder]);

  const onScroll = () => {
    const el = scrollRef.current!;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const loadOlder = async () => {
    prevHeight.current = scrollRef.current?.scrollHeight ?? 0;
    setLoadingOlder(true);
    try {
      await loadMessages(DM_CHANNEL, true);
    } finally {
      setTimeout(() => setLoadingOlder(false), 0);
    }
  };

  const send = async () => {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    try {
      addOwnMessage(await api<Message>('POST', `/api/channels/${DM_CHANNEL}/messages`, { text: t }));
      setText('');
      if (inputRef.current) inputRef.current.style.height = 'auto';
      stickToBottom.current = true;
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  };

  // Вложения живут в чате (scope=chat) и в библиотеку сами не попадают.
  const sendFiles = async (files: File[]) => {
    for (const f of files) {
      const name = f.name && f.name !== 'image.png' ? f.name : `screenshot-${Date.now()}.png`;
      const uploaded = await uploadOne(f, { scope: 'chat', name });
      if (!uploaded) continue;
      try {
        addOwnMessage(await api<Message>('POST', `/api/channels/${DM_CHANNEL}/messages`, { fileId: uploaded.id, text: '' }));
        stickToBottom.current = true;
      } catch (e) {
        toast((e as Error).message);
      }
    }
  };

  const saveEdit = async () => {
    if (!editing?.text.trim()) return;
    try {
      addOwnMessage(await api<Message>('PATCH', `/api/messages/${editing.id}`, { text: editing.text.trim() }));
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
    <section
      className={cx(styles.dm, !visible && styles.hidden)}
      onDragEnter={(e) => e.dataTransfer.types.includes('Files') && setDragging(true)}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        sendFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <header className={styles.dmHead}>
        {partner && <Avatar user={partner} size={40} status />}
        <div>
          <div className={styles.dmName}>{partner?.nickname ?? 'Напарник'}</div>
          <div className={cx(styles.dmStatus, partner?.online && styles.online)}>{partner ? presenceText(partner) : ''}</div>
        </div>
      </header>

      <div className={styles.messages} ref={scrollRef} onScroll={onScroll}>
        {state?.hasMore && (
          <button className={cx('btn sm ghost', styles.older)} onClick={loadOlder} disabled={loadingOlder}>
            {loadingOlder && <Loader2 size={14} className="spin" />} Показать раньше
          </button>
        )}
        {!state?.loaded && (
          <div className="empty">
            <Loader2 className="spin" />
          </div>
        )}
        {state?.loaded && !items.length && <div className={cx('empty', styles.hello)}>👋 Здесь пока тихо. Напишите первое сообщение.</div>}

        {items.map((m, i) => {
          const prev = items[i - 1];
          const newDay = !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
          const grouped = !newDay && prev && prev.userId === m.userId && m.createdAt - prev.createdAt < 5 * 60_000;
          const mine = m.userId === me.id;
          const isEditing = editing?.id === m.id;
          const fresh = firstIds.current && !firstIds.current.has(m.id);
          return (
            <Fragment key={m.id}>
              {newDay && (
                <div className={styles.day}>
                  <span>{dayLabel(m.createdAt)}</span>
                </div>
              )}
              <div className={cx(styles.msgRow, mine && styles.mine, grouped && styles.grouped, fresh && styles.fresh)}>
                <div className={cx(styles.bubble, m.file && !m.text && styles.bubbleMedia)}>
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
                    <>
                      {m.file && <Attachment file={m.file} />}
                      {m.text && (
                        <div className={cx(styles.text, 'selectable')}>
                          <Linkified text={m.text} />
                        </div>
                      )}
                    </>
                  )}
                  <span className={styles.time}>
                    {m.editedAt && 'изм. '}
                    {formatTime(m.createdAt)}
                  </span>
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
          placeholder="Сообщение"
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

      {dragging && (
        <div className={styles.dropOverlay}>
          <Paperclip size={40} />
          Отправить в чат
        </div>
      )}
    </section>
  );
}

// =================================================================== страница
export function Chat({ visible }: { visible: boolean }) {
  const target = useStore((s) => s.chatTarget);
  const [aiOpened, setAiOpened] = useState<Set<AiProvider>>(new Set());

  useEffect(() => {
    if (target.startsWith('ai:')) {
      const p = target.slice(3) as AiProvider;
      if (!aiOpened.has(p)) setAiOpened((s) => new Set(s).add(p));
    }
  }, [target, aiOpened]);

  return (
    <div className={cx(styles.page, !visible && styles.pageHidden, visible && 'page-enter')}>
      <ChatList />
      <div className={cx('card', styles.main)}>
        <DmPane visible={target === 'dm'} />
        {[...aiOpened].map((p) => (
          <AiPane key={p} provider={p} visible={visible && target === `ai:${p}`} />
        ))}
      </div>
    </div>
  );
}
