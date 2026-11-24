import {
  ChevronDown, ChevronRight, CloudUpload, Download, File as FileIcon, FileAudio, FileCode2, FileText, FileVideo,
  Folder, FolderPlus, History, Loader2, MessageSquare, Pencil, Search, Send, Trash2, Type, Upload, X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, binaryText, binaryUrl, fileContentPath, useBinaryUrl } from '../api';
import { Avatar } from '../components/Avatar';
import { askText, confirmAction, eventBus, toast, useStore } from '../store';
import type { FileComment, FileVersion, HoloEvent, HoloFile } from '../types';
import { collectDropped, uploadOne, useUploads } from '../upload';
import { baseName, cx, fileKind, formatBytes, formatDateTime, joinPath, parentOf, timeAgo, type FileKind } from '../util';
import styles from './Resources.module.css';

const KIND_ICON: Record<FileKind, typeof FileIcon> = {
  image: FileIcon,
  audio: FileAudio,
  video: FileVideo,
  text: FileText,
  code: FileCode2,
  font: Type,
  other: FileIcon,
};

const THUMB_LIMIT = 15 * 1024 * 1024;

export function Resources() {
  const folders = useStore((s) => s.folders);
  const files = useStore((s) => s.files);
  const folder = useStore((s) => s.resourceFolder);
  const selectedId = useStore((s) => s.selectedFileId);
  const [query, setQuery] = useState('');
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const jobs = useUploads((s) => s.jobs);

  const fileList = useMemo(() => Object.values(files).sort((a, b) => a.name.localeCompare(b.name)), [files]);
  const selected = selectedId ? files[selectedId] : undefined;

  const subfolders = folders.filter((f) => parentOf(f) === folder);
  const visibleFiles = query.trim()
    ? fileList.filter((f) => f.path.toLowerCase().includes(query.trim().toLowerCase()))
    : fileList.filter((f) => f.folder === folder);

  const openFolder = (p: string) => useStore.setState({ resourceFolder: p, selectedFileId: null });
  const select = (f: HoloFile) => useStore.setState({ selectedFileId: f.id });

  const uploadAll = async (items: { file: File; rel: string }[]) => {
    for (const { file, rel } of items) await uploadOne(file, joinPath(folder, rel));
  };

  const newFolder = async () => {
    const name = await askText(folder ? `Новая папка в ${folder}/` : 'Новая папка', '', 'Создать');
    if (!name) return;
    try {
      const r = await api<{ path: string }>('POST', '/api/folders', { path: joinPath(folder, name) });
      openFolder(r.path);
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const deleteFolder = async () => {
    const count = fileList.filter((f) => f.folder === folder || f.folder.startsWith(folder + '/')).length;
    const ok = await confirmAction(
      `Удалить папку «${baseName(folder)}»?`,
      count ? `Вместе с ней будут удалены файлы: ${count}. Это увидит и второй участник.` : 'Папка пустая.',
    );
    if (!ok) return;
    try {
      await api('DELETE', `/api/folders?path=${encodeURIComponent(folder)}`);
      openFolder(parentOf(folder));
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const crumbs = folder ? folder.split('/') : [];

  return (
    <div
      className={styles.page}
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
        collectDropped(e.dataTransfer).then(uploadAll);
      }}
    >
      {/* ---------- дерево ---------- */}
      <section className={cx('card', styles.tree)}>
        <div className={styles.treeHead}>
          <span>Файлы проекта</span>
          <button className="btn ghost sm icon" title="Новая папка" onClick={newFolder}>
            <FolderPlus size={16} />
          </button>
        </div>
        <div className={styles.treeBody}>
          <button className={cx(styles.treeRow, folder === '' && !selected && styles.treeActive)} onClick={() => openFolder('')}>
            <Folder size={16} className={styles.folderIcon} />
            <span>Проект</span>
          </button>
          <TreeLevel path="" depth={1} folders={folders} files={fileList} />
        </div>
      </section>

      {/* ---------- список ---------- */}
      <section className={cx('card', styles.list)}>
        <div className={styles.listHead}>
          <div className={styles.crumbs}>
            <button onClick={() => openFolder('')}>Проект</button>
            {crumbs.map((c, i) => (
              <span key={i} className={styles.crumb}>
                <ChevronRight size={14} className="faint" />
                <button onClick={() => openFolder(crumbs.slice(0, i + 1).join('/'))}>{c}</button>
              </span>
            ))}
          </div>
          <div className={styles.tools}>
            <div className={styles.search}>
              <Search size={15} className="faint" />
              <input value={query} placeholder="Поиск по хранилищу" onChange={(e) => setQuery(e.target.value)} />
              {query && (
                <button className={styles.clear} onClick={() => setQuery('')}>
                  <X size={14} />
                </button>
              )}
            </div>
            {folder && (
              <button className="btn sm ghost icon danger" title="Удалить папку" onClick={deleteFolder}>
                <Trash2 size={16} />
              </button>
            )}
            <button className="btn sm" onClick={newFolder}>
              <FolderPlus size={15} /> Папка
            </button>
            <button className="btn sm primary" onClick={() => inputRef.current?.click()}>
              <Upload size={15} /> Загрузить
            </button>
            <input
              ref={inputRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                const list = Array.from(e.target.files || []).map((file) => ({ file, rel: file.name }));
                e.target.value = '';
                uploadAll(list);
              }}
            />
          </div>
        </div>

        <div className={styles.grid}>
          {!query &&
            subfolders.map((p) => (
              <button key={p} className={styles.folderCard} onDoubleClick={() => openFolder(p)} onClick={() => openFolder(p)}>
                <Folder size={30} className={styles.folderIcon} />
                <span>{baseName(p)}</span>
                <span className="faint">{fileList.filter((f) => f.folder === p).length} файл(ов)</span>
              </button>
            ))}
          {visibleFiles.map((f) => (
            <FileCard key={f.id} file={f} active={f.id === selectedId} onClick={() => select(f)} showPath={!!query} />
          ))}
        </div>

        {!visibleFiles.length && (query || !subfolders.length) && (
          <div className="empty">
            <CloudUpload size={40} strokeWidth={1.3} />
            {query ? 'Ничего не найдено' : 'Перетащите сюда файлы или папки — они сразу появятся у напарника'}
          </div>
        )}

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
            <CloudUpload size={46} strokeWidth={1.3} />
            <div>Отпустите, чтобы загрузить в {folder ? `${folder}/` : 'корень проекта'}</div>
          </div>
        )}
      </section>

      {/* ---------- детали ---------- */}
      {selected && <Details key={selected.id} file={selected} />}
    </div>
  );
}

// ======================================================================= дерево
function TreeLevel({ path, depth, folders, files }: { path: string; depth: number; folders: string[]; files: HoloFile[] }) {
  const current = useStore((s) => s.resourceFolder);
  const selectedId = useStore((s) => s.selectedFileId);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const children = folders.filter((f) => parentOf(f) === path);
  const own = files.filter((f) => f.folder === path);

  return (
    <>
      {children.map((p) => {
        const isOpen = !collapsed[p];
        return (
          <div key={p}>
            <button
              className={cx(styles.treeRow, current === p && !selectedId && styles.treeActive)}
              style={{ paddingLeft: 8 + depth * 14 }}
              onClick={() => useStore.setState({ resourceFolder: p, selectedFileId: null })}
            >
              <span
                className={styles.caret}
                onClick={(e) => {
                  e.stopPropagation();
                  setCollapsed((c) => ({ ...c, [p]: isOpen }));
                }}
              >
                {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </span>
              <Folder size={16} className={styles.folderIcon} />
              <span>{baseName(p)}</span>
            </button>
            {isOpen && <TreeLevel path={p} depth={depth + 1} folders={folders} files={files} />}
          </div>
        );
      })}
      {own.map((f) => {
        const Icon = KIND_ICON[fileKind(f)];
        return (
          <button
            key={f.id}
            className={cx(styles.treeRow, selectedId === f.id && styles.treeActive)}
            style={{ paddingLeft: 8 + depth * 14 + 18 }}
            onClick={() => useStore.setState({ resourceFolder: f.folder, selectedFileId: f.id })}
          >
            <Icon size={15} className="faint" />
            <span>{f.name}</span>
          </button>
        );
      })}
    </>
  );
}

// ======================================================================= карточка
function FileCard({ file, active, onClick, showPath }: { file: HoloFile; active: boolean; onClick: () => void; showPath: boolean }) {
  const kind = fileKind(file);
  const thumb = useBinaryUrl(kind === 'image' && file.size < THUMB_LIMIT ? fileContentPath(file) : null);
  const Icon = KIND_ICON[kind];
  const users = useStore((s) => s.users);
  return (
    <button className={cx(styles.fileCard, active && styles.fileActive)} onClick={onClick} title={file.path}>
      <div className={styles.thumb} data-kind={kind}>
        {thumb ? <img src={thumb} alt="" draggable={false} /> : <Icon size={30} strokeWidth={1.4} />}
        {file.version > 1 && <span className={styles.ver}>v{file.version}</span>}
      </div>
      <div className={styles.fileName}>{file.name}</div>
      <div className={styles.fileMeta}>
        {showPath ? file.folder || '/' : `${formatBytes(file.size)} · ${users[file.updatedBy ?? 0]?.nickname ?? ''}`}
      </div>
    </button>
  );
}

// ======================================================================= превью
function Preview({ file, version }: { file: HoloFile; version?: number }) {
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

  if (error) return <div className={styles.previewEmpty}>{error}</div>;
  if (kind === 'image') return url ? <img className={styles.previewImg} src={url} alt="" /> : <PreviewLoading />;
  if (kind === 'audio') return url ? <audio className={styles.previewAudio} src={url} controls /> : <PreviewLoading />;
  if (kind === 'video') return url ? <video className={styles.previewImg} src={url} controls /> : <PreviewLoading />;
  if (kind === 'text' || kind === 'code') {
    return text !== null ? <pre className={cx(styles.previewText, 'selectable')}>{text}</pre> : <PreviewLoading />;
  }
  if (kind === 'font') {
    return fontFamily ? (
      <div className={styles.previewFont} style={{ fontFamily }}>
        <div style={{ fontSize: 34 }}>Aa Бб Вв</div>
        <div>Съешь же ещё этих мягких французских булок.</div>
        <div>The quick brown fox jumps over the lazy dog 0123456789</div>
      </div>
    ) : (
      <PreviewLoading />
    );
  }
  return (
    <div className={styles.previewEmpty}>
      <FileIcon size={36} strokeWidth={1.3} />
      Предпросмотр недоступен
    </div>
  );
}

const PreviewLoading = () => (
  <div className={styles.previewEmpty}>
    <Loader2 className="spin" />
  </div>
);

// ======================================================================= панель деталей
function Details({ file }: { file: HoloFile }) {
  const users = useStore((s) => s.users);
  const me = useStore((s) => s.me)!;
  const activeChannel = useStore((s) => s.activeChannel);
  const channels = useStore((s) => s.channels);
  const [tab, setTab] = useState<'info' | 'versions' | 'comments'>('info');
  const [versions, setVersions] = useState<FileVersion[]>([]);
  const [comments, setComments] = useState<FileComment[]>([]);
  const [previewVersion, setPreviewVersion] = useState<number | undefined>();
  const [comment, setComment] = useState('');

  useEffect(() => {
    api<FileVersion[]>('GET', `/api/files/${file.id}/versions`).then(setVersions).catch(() => {});
    setPreviewVersion(undefined);
  }, [file.id, file.version]);

  useEffect(() => {
    api<FileComment[]>('GET', `/api/files/${file.id}/comments`).then(setComments).catch(() => {});
    const onComment = (e: Event) => {
      const c: FileComment = (e as CustomEvent<HoloEvent>).detail.payload.comment;
      if (c.fileId === file.id) setComments((list) => (list.some((x) => x.id === c.id) ? list : [...list, c]));
    };
    eventBus.addEventListener('file.comment', onComment);
    return () => eventBus.removeEventListener('file.comment', onComment);
  }, [file.id]);

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const rename = () =>
    run(async () => {
      const p = await askText('Переименовать или переместить', file.path, 'Сохранить');
      if (p && p !== file.path) await api('PATCH', `/api/files/${file.id}`, { path: p });
    });

  const remove = () =>
    run(async () => {
      if (await confirmAction(`Удалить «${file.name}»?`, 'Файл исчезнет у обоих участников.')) {
        await api('DELETE', `/api/files/${file.id}`);
      }
    });

  const sendToChat = () =>
    run(async () => {
      await api('POST', `/api/channels/${activeChannel}/messages`, { fileId: file.id, text: '' });
      toast(`Отправлено в #${channels.find((c) => c.id === activeChannel)?.name ?? activeChannel}`, 'info');
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
      setComments((list) => (list.some((x) => x.id === c.id) ? list : [...list, c]));
      setComment('');
    });

  const author = users[file.updatedBy ?? 0];

  return (
    <section className={cx('card', styles.details)}>
      <div className={styles.detailsHead}>
        <div className={styles.detailsTitle} title={file.path}>
          {file.name}
        </div>
        <button className="btn ghost sm icon" onClick={() => useStore.setState({ selectedFileId: null })}>
          <X size={16} />
        </button>
      </div>

      <div className={styles.preview}>
        <Preview file={file} version={previewVersion} />
        {previewVersion && <div className={styles.previewBadge}>Просмотр v{previewVersion}</div>}
      </div>

      <div className={styles.actions}>
        <button className="btn sm" onClick={() => window.holo.download(file.id, file.name, previewVersion)}>
          <Download size={15} /> Скачать
        </button>
        <button className="btn sm" onClick={sendToChat} title="Отправить в текущий канал чата">
          <Send size={15} /> В чат
        </button>
        <button className="btn sm icon" title="Переименовать / переместить" onClick={rename}>
          <Pencil size={15} />
        </button>
        <button className="btn sm icon danger" title="Удалить" onClick={remove}>
          <Trash2 size={15} />
        </button>
      </div>

      <div className={styles.tabs}>
        <button className={cx(tab === 'info' && styles.tabActive)} onClick={() => setTab('info')}>
          Инфо
        </button>
        <button className={cx(tab === 'versions' && styles.tabActive)} onClick={() => setTab('versions')}>
          <History size={14} /> Версии <span className="faint">{versions.length}</span>
        </button>
        <button className={cx(tab === 'comments' && styles.tabActive)} onClick={() => setTab('comments')}>
          <MessageSquare size={14} /> <span className="faint">{comments.length}</span>
        </button>
      </div>

      <div className={styles.tabBody}>
        {tab === 'info' && (
          <dl className={styles.info}>
            <dt>Путь</dt>
            <dd className="selectable">{file.path}</dd>
            <dt>Размер</dt>
            <dd>{formatBytes(file.size)}</dd>
            <dt>Тип</dt>
            <dd>{file.mime}</dd>
            <dt>Версия</dt>
            <dd>v{file.version}</dd>
            <dt>Изменён</dt>
            <dd>
              {formatDateTime(file.updatedAt)}
              {author && ` · ${author.nickname}`}
            </dd>
          </dl>
        )}

        {tab === 'versions' &&
          versions.map((v) => (
            <div key={v.version} className={cx(styles.version, previewVersion === v.version && styles.versionActive)}>
              <div className={styles.versionMain}>
                <strong>v{v.version}</strong>
                {v.version === file.version && <span className={styles.current}>текущая</span>}
                <div className="faint" style={{ fontSize: 12 }}>
                  {users[v.userId ?? 0]?.nickname ?? '—'} · {timeAgo(v.createdAt)} · {formatBytes(v.size)}
                  {v.note && <div>{v.note}</div>}
                </div>
              </div>
              {v.version !== file.version && (
                <div className={styles.versionBtns}>
                  <button className="btn sm ghost" onClick={() => setPreviewVersion(previewVersion === v.version ? undefined : v.version)}>
                    {previewVersion === v.version ? 'Скрыть' : 'Смотреть'}
                  </button>
                  <button className="btn sm" onClick={() => restore(v.version)}>
                    Вернуть
                  </button>
                </div>
              )}
            </div>
          ))}

        {tab === 'comments' && (
          <div className={styles.comments}>
            {comments.map((c) => {
              const u = users[c.userId];
              return (
                <div key={c.id} className={styles.comment}>
                  {u && <Avatar user={u} size={26} />}
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
            <div className={styles.commentInput}>
              <Avatar user={me} size={26} />
              <input
                className="input"
                placeholder="Комментарий к ресурсу…"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addComment()}
              />
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
