import {
  CloudUpload, Download, History, Loader2, MessageSquare, Pencil, Search, Send, Trash2, Upload, X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { api, fileContentPath, useBinaryUrl } from '../api';
import { Avatar } from '../components/Avatar';
import { FilePreview, KIND_ICON, KIND_LABEL } from '../components/FilePreview';
import { askLibrary, askText, confirmAction, DM_CHANNEL, eventBus, toast, upsertFile, useStore } from '../store';
import type { FileComment, FileVersion, HoloEvent, HoloFile } from '../types';
import { collectDropped, uploadOne, useUploads } from '../upload';
import { openImageViewer } from '../components/ImageViewer';
import { ModelViewer } from '../components/ModelViewer';
import { ensureModelThumb, thumbPath } from '../modelThumbs';
import { cx, fileKind, formatBytes, formatDateTime, timeAgo, type FileKind } from '../util';
import styles from './Library.module.css';

const FILTERS: { id: 'all' | FileKind | 'docs'; label: string }[] = [
  { id: 'all', label: 'Всё' },
  { id: 'image', label: 'Изображения' },
  { id: 'audio', label: 'Звуки' },
  { id: 'video', label: 'Видео' },
  { id: 'model', label: '3D-модели' },
  { id: 'docs', label: 'Тексты и данные' },
  { id: 'font', label: 'Шрифты' },
  { id: 'other', label: 'Другое' },
];


/** Загрузить файлы в библиотеку. Один файл — спросим название и описание. */
export async function addToLibrary(files: File[]) {
  if (!files.length) return;
  if (files.length === 1) {
    const f = files[0];
    const preview = f.type.startsWith('image/') ? URL.createObjectURL(f) : null;
    const form = await askLibrary({
      fileName: `${f.name} · ${formatBytes(f.size)}`,
      title: 'Добавить в библиотеку',
      preview,
      confirmText: 'Добавить',
    });
    if (preview) URL.revokeObjectURL(preview);
    if (!form) return;
    await uploadOne(f, { scope: 'library', ...form });
    return;
  }
  for (const f of files) await uploadOne(f, { scope: 'library' });
  toast(`Загружено файлов: ${files.length}. Название и описание можно добавить в карточке.`, 'info');
}

export function Library() {
  const files = useStore((s) => s.files);
  const selectedId = useStore((s) => s.selectedFileId);
  const users = useStore((s) => s.users);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['id']>('all');
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const jobs = useUploads((s) => s.jobs);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return Object.values(files)
      .filter((f) => {
        const k = fileKind(f);
        if (filter === 'docs' ? k !== 'text' && k !== 'code' : filter !== 'all' && k !== filter) return false;
        return !q || `${f.title} ${f.description} ${f.name}`.toLowerCase().includes(q);
      })
      .sort((a, b) => b.id - a.id);
  }, [files, query, filter]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: 0 };
    for (const f of Object.values(files)) {
      const k = fileKind(f);
      const key = k === 'text' || k === 'code' ? 'docs' : k;
      c[key] = (c[key] || 0) + 1;
      c.all++;
    }
    return c;
  }, [files]);

  const selected = selectedId ? files[selectedId] : undefined;

  return (
    <div
      className={cx(styles.page, 'page-enter')}
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        dragDepth.current++;
        setDragging(true);
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDragging(false);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        collectDropped(e.dataTransfer).then(addToLibrary);
      }}
    >
      <header className={styles.head}>
        <div>
          <h1>Библиотека</h1>
          <p className="muted">Общая коллекция ресурсов — у напарника она та же самая.</p>
        </div>
        <div className={styles.tools}>
          <div className={styles.search}>
            <Search size={16} className="faint" />
            <input value={query} placeholder="Название, описание, имя файла" onChange={(e) => setQuery(e.target.value)} />
            {query && (
              <button onClick={() => setQuery('')}>
                <X size={14} />
              </button>
            )}
          </div>
          <button className="btn primary" onClick={() => inputRef.current?.click()}>
            <Upload size={16} /> Добавить
          </button>
          <input
            ref={inputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              const picked = Array.from(e.target.files || []);
              e.target.value = '';
              addToLibrary(picked);
            }}
          />
        </div>
      </header>

      <div className={styles.filters}>
        {FILTERS.map((f) => (
          <button key={f.id} className={cx(styles.chip, filter === f.id && styles.chipOn)} onClick={() => setFilter(f.id)}>
            {f.label}
            <span>{counts[f.id] || 0}</span>
          </button>
        ))}
      </div>

      <div className={styles.scroll}>
        {list.length ? (
          <div className={cx(styles.masonry, 'stagger')}>
            {list.map((f, i) => (
              <LibraryCard key={f.id} file={f} index={i} author={users[f.updatedBy ?? 0]?.nickname} />
            ))}
          </div>
        ) : (
          <div className={cx('empty', styles.emptyBig)}>
            <CloudUpload size={54} strokeWidth={1.1} />
            <div>{query || filter !== 'all' ? 'Ничего не найдено' : 'Перетащите сюда изображения, звуки или любые файлы'}</div>
            {!query && filter === 'all' && <div className="faint">Они сразу появятся в библиотеке напарника</div>}
          </div>
        )}
      </div>

      {jobs.length > 0 && (
        <div className={styles.jobs}>
          {jobs.map((j) => (
            <div key={j.id} className={styles.job} data-status={j.status}>
              {j.status === 'uploading' ? <Loader2 size={14} className="spin" /> : j.status === 'done' ? '✓' : '✕'}
              <span>{j.name}</span>
            </div>
          ))}
        </div>
      )}

      {dragging && (
        <div className={styles.dropOverlay}>
          <CloudUpload size={56} strokeWidth={1.2} />
          <div>Отпустите, чтобы добавить в библиотеку</div>
        </div>
      )}

      {selected && <FileModal key={selected.id} file={selected} />}
    </div>
  );
}

// ======================================================================= карточка
function LibraryCard({ file, index, author }: { file: HoloFile; index: number; author?: string }) {
  const kind = fileKind(file);
  const modelThumb = kind === 'model' && file.thumbVersion === file.version;
  const thumb = useBinaryUrl(kind === 'image' ? fileContentPath(file) : modelThumb ? thumbPath(file) : null);
  const Icon = KIND_ICON[kind];
  const ext = file.name.includes('.') ? file.name.split('.').pop()!.toUpperCase() : '';
  // Превью модели делается один раз — при первом показе карточки, у того, кто открыл библиотеку.
  useEffect(() => {
    if (kind === 'model' && !modelThumb) ensureModelThumb(file);
  }, [kind, modelThumb, file]);
  return (
    <button
      className={cx(styles.card, 'lift')}
      style={{ '--i': index } as CSSProperties}
      onClick={() => useStore.setState({ selectedFileId: file.id })}
    >
      {kind === 'image' ? (
        thumb ? (
          <img className={styles.cardImg} src={thumb} alt="" draggable={false} />
        ) : (
          <div className={cx(styles.cardPlaceholder, 'skeleton')} />
        )
      ) : kind === 'model' && thumb ? (
        <div className={styles.cardModel}>
          <img src={thumb} alt="" draggable={false} />
          {ext && <span>{ext}</span>}
        </div>
      ) : (
        <div className={styles.cardTile} data-kind={kind}>
          <Icon size={40} strokeWidth={1.2} />
          {ext && <span>{ext}</span>}
          {kind === 'model' && !modelThumb && <em className={styles.cardHint}>готовим превью…</em>}
        </div>
      )}
      {file.version > 1 && <span className={styles.ver}>v{file.version}</span>}
      <div className={styles.cardInfo}>
        <div className={styles.cardTitle}>{file.title || file.name}</div>
        {file.description ? (
          <div className={styles.cardDesc}>{file.description}</div>
        ) : (
          <div className={styles.cardMeta}>
            {KIND_LABEL[kind]} · {formatBytes(file.size)}
            {author ? ` · ${author}` : ''}
          </div>
        )}
      </div>
    </button>
  );
}

// ======================================================================= просмотр
function FileModal({ file }: { file: HoloFile }) {
  const users = useStore((s) => s.users);
  const me = useStore((s) => s.me)!;
  const [tab, setTab] = useState<'versions' | 'comments'>('comments');
  const [versions, setVersions] = useState<FileVersion[]>([]);
  const [comments, setComments] = useState<FileComment[]>([]);
  const [previewVersion, setPreviewVersion] = useState<number | undefined>();
  const [comment, setComment] = useState('');
  const [title, setTitle] = useState(file.title);
  const [description, setDescription] = useState(file.description);
  const versionInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTitle(file.title);
    setDescription(file.description);
  }, [file.title, file.description]);

  useEffect(() => {
    api<FileVersion[]>('GET', `/api/files/${file.id}/versions`).then(setVersions).catch(() => {});
    setPreviewVersion(undefined);
  }, [file.id, file.version]);

  useEffect(() => {
    api<FileComment[]>('GET', `/api/files/${file.id}/comments`).then(setComments).catch(() => {});
    const onComment = (e: Event) => {
      const c: FileComment = (e as CustomEvent<HoloEvent>).detail.payload.comment;
      if (c.fileId === file.id) setComments((l) => (l.some((x) => x.id === c.id) ? l : [...l, c]));
    };
    eventBus.addEventListener('file.comment', onComment);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) close();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      eventBus.removeEventListener('file.comment', onComment);
      window.removeEventListener('keydown', onKey);
    };
  }, [file.id]);

  const close = () => useStore.setState({ selectedFileId: null });
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const saveMeta = () =>
    run(async () => {
      if (title.trim() === file.title && description.trim() === file.description) return;
      const r = await api<{ file: HoloFile }>('PATCH', `/api/files/${file.id}`, { title, description });
      upsertFile(r.file);
    });

  const rename = () =>
    run(async () => {
      const name = await askText('Имя файла', file.name, 'Сохранить');
      if (name && name !== file.name) upsertFile((await api<{ file: HoloFile }>('PATCH', `/api/files/${file.id}`, { name })).file);
    });

  const remove = () =>
    run(async () => {
      if (await confirmAction(`Удалить «${file.title || file.name}»?`, 'Элемент переместится в корзину у обоих участников — его можно будет вернуть.', 'В корзину')) {
        await api('DELETE', `/api/files/${file.id}`);
        close();
      }
    });

  const sendToChat = () =>
    run(async () => {
      await api('POST', `/api/channels/${DM_CHANNEL}/messages`, { fileId: file.id, text: file.title || '' });
      toast('Отправлено в чат', 'info');
    });

  const restore = (version: number) =>
    run(async () => {
      await api('POST', `/api/files/${file.id}/restore`, { version });
      toast(`Версия v${version} восстановлена как новая`, 'info');
    });

  const addComment = () =>
    run(async () => {
      const text = comment.trim();
      if (!text) return;
      const c = await api<FileComment>('POST', `/api/files/${file.id}/comments`, { text });
      setComments((l) => (l.some((x) => x.id === c.id) ? l : [...l, c]));
      setComment('');
    });

  const author = users[file.updatedBy ?? 0];

  return (
    <div className={styles.modalBackdrop} onMouseDown={close}>
      <div className={styles.modal} onMouseDown={(e) => e.stopPropagation()}>
        <div
          className={styles.modalPreview}
          onClick={() => {
            if (fileKind(file) !== 'image' || previewVersion) return;
            const imgs = Object.values(useStore.getState().files)
              .filter((f) => fileKind(f) === 'image')
              .sort((a, b) => b.id - a.id);
            openImageViewer(imgs, Math.max(0, imgs.findIndex((f) => f.id === file.id)));
          }}
          style={fileKind(file) === 'image' ? { cursor: 'zoom-in' } : undefined}
          title={fileKind(file) === 'image' ? 'Открыть на весь экран' : undefined}
        >
          {fileKind(file) === 'model' ? <ModelViewer file={file} /> : <FilePreview file={file} version={previewVersion} large />}
          {previewVersion && <div className={styles.previewBadge}>Просмотр v{previewVersion}</div>}
        </div>

        <aside className={styles.modalSide}>
          <div className={styles.modalTop}>
            <span className={styles.kindBadge}>{KIND_LABEL[fileKind(file)]}</span>
            <button className="btn ghost sm icon" onClick={close} title="Закрыть (Esc)">
              <X size={18} />
            </button>
          </div>

          <input
            className={styles.titleInput}
            value={title}
            placeholder="Без названия — добавьте"
            onChange={(e) => setTitle(e.target.value)}
            onBlur={saveMeta}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
          <textarea
            className={styles.descInput}
            value={description}
            rows={3}
            placeholder="Описание (необязательно)"
            onChange={(e) => setDescription(e.target.value)}
            onBlur={saveMeta}
          />

          <div className={styles.meta}>
            <button className={styles.fileName} onClick={rename} title="Переименовать файл">
              {file.name} <Pencil size={12} />
            </button>
            <div className="faint">
              {formatBytes(file.size)} · v{file.version} · {formatDateTime(file.updatedAt)}
              {author ? ` · ${author.nickname}` : ''}
            </div>
          </div>

          <div className={styles.actions}>
            <button className="btn sm primary" onClick={() => window.holo.download(file.id, file.name, previewVersion)}>
              <Download size={15} /> Скачать
            </button>
            <button className="btn sm" onClick={() => versionInput.current?.click()} title="Загрузить новую версию">
              <Upload size={15} /> Версия
            </button>
            <button className="btn sm icon" onClick={sendToChat} title="Отправить в чат">
              <Send size={15} />
            </button>
            <button className="btn sm icon danger" onClick={remove} title="Удалить">
              <Trash2 size={15} />
            </button>
            <input
              ref={versionInput}
              type="file"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) uploadOne(f, { scope: 'library', fileId: file.id });
              }}
            />
          </div>

          <div className={styles.tabs}>
            <button className={cx(tab === 'comments' && styles.tabOn)} onClick={() => setTab('comments')}>
              <MessageSquare size={14} /> Комментарии <span className="faint">{comments.length}</span>
            </button>
            <button className={cx(tab === 'versions' && styles.tabOn)} onClick={() => setTab('versions')}>
              <History size={14} /> Версии <span className="faint">{versions.length}</span>
            </button>
          </div>

          <div className={styles.tabBody}>
            {tab === 'versions' &&
              versions.map((v) => (
                <div key={v.version} className={cx(styles.version, previewVersion === v.version && styles.versionOn)}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <strong>v{v.version}</strong>
                    {v.version === file.version && <span className={styles.current}>текущая</span>}
                    <div className="faint" style={{ fontSize: 12 }}>
                      {users[v.userId ?? 0]?.nickname ?? '—'} · {timeAgo(v.createdAt)} · {formatBytes(v.size)}
                      {v.note && <div>{v.note}</div>}
                    </div>
                  </div>
                  {v.version !== file.version && (
                    <>
                      <button className="btn sm ghost" onClick={() => setPreviewVersion(previewVersion === v.version ? undefined : v.version)}>
                        {previewVersion === v.version ? 'Скрыть' : 'Смотреть'}
                      </button>
                      <button className="btn sm" onClick={() => restore(v.version)}>
                        Вернуть
                      </button>
                    </>
                  )}
                </div>
              ))}

            {tab === 'comments' && (
              <div className={styles.comments}>
                {comments.map((c) => {
                  const u = users[c.userId];
                  return (
                    <div key={c.id} className={styles.comment}>
                      {u && <Avatar user={u} size={28} />}
                      <div>
                        <div className={styles.commentHead}>
                          <strong>{u?.nickname ?? '—'}</strong> <span className="faint">{timeAgo(c.createdAt)}</span>
                        </div>
                        <div className="selectable">{c.text}</div>
                      </div>
                    </div>
                  );
                })}
                {!comments.length && <div className="faint">Комментариев пока нет.</div>}
              </div>
            )}
          </div>
          {tab === 'comments' && (
            <div className={styles.commentInput}>
              <Avatar user={me} size={28} />
              <input
                className="input"
                placeholder="Комментарий…"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addComment()}
              />
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

