import { FileText, Lock, Share2, Trash2, Users } from 'lucide-react';
import { api } from '../api';
import { createBoard, deleteBoard, STATUS_TEXT, useBoardEditor } from '../boards';
import { useRef } from 'react';
import { BoardList } from '../components/BoardList';
import { MonoAiButton } from '../components/MonoAi';
import { confirmAction, toast, upsertBoard, useStore } from '../store';
import type { Board, DocData } from '../types';
import { cx, formatDateTime } from '../util';
import styles from './Editors.module.css';

export function Docs() {
  const me = useStore((s) => s.me)!;
  const openId = useStore((s) => s.openBoard.doc);
  const board = useStore((s) => (openId ? s.boards[openId] : undefined)) as Board<DocData> | undefined;

  const create = async () => {
    try {
      await createBoard<DocData>('doc', 'Новый документ', { text: '' }, true);
    } catch (e) {
      toast((e as Error).message);
    }
  };

  return (
    <div className={cx(styles.page, 'page-enter')}>
      <BoardList
        kind="doc"
        title="Документы"
        newLabel="Новый"
        icon={<FileText size={17} />}
        onCreate={create}
        tabs={[
          { id: 'mine', label: 'Мои', filter: (b) => b.private && b.ownerId === me.id },
          { id: 'shared', label: 'Общие', filter: (b) => !b.private },
        ]}
      />
      {board ? (
        <DocEditor key={board.id} board={board} />
      ) : (
        <section className={cx('card', styles.placeholder)}>
          <FileText size={52} strokeWidth={1.1} />
          <h2>Документы</h2>
          <p>
            Заметки, спецификации, TODO. Новый документ — личный: его видите только вы. Кнопка «Сделать общим» отправит его
            напарнику, и дальше вы будете редактировать его вместе.
          </p>
          <button className="btn primary" onClick={create}>
            Создать документ
          </button>
        </section>
      )}
    </div>
  );
}

function DocEditor({ board }: { board: Board<DocData> }) {
  const users = useStore((s) => s.users);
  const { draft, update, status, saveNow } = useBoardEditor<DocData>(board);
  const textRef = useRef<HTMLTextAreaElement>(null);
  if (!draft) return null;
  const words = draft.data.text.trim() ? draft.data.text.trim().split(/\s+/).length : 0;

  const share = async () => {
    const ok = await confirmAction(
      'Сделать документ общим?',
      'Его увидит и сможет редактировать напарник. Вернуть документ в личные будет нельзя.',
      'Сделать общим',
    );
    if (!ok) return;
    try {
      await saveNow();
      const b = await api<Board>('PATCH', `/api/boards/${board.id}`, { shared: true });
      upsertBoard(b);
      toast('Документ теперь общий', 'info');
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const remove = async () => {
    if (!(await confirmAction(`Удалить «${board.title}»?`, 'Документ переместится в корзину — его можно будет вернуть.', 'В корзину'))) return;
    try {
      await deleteBoard(board);
    } catch (e) {
      toast((e as Error).message);
    }
  };

  return (
    <section className={cx('card', styles.editor)}>
      <div className={styles.toolbar}>
        <span className={cx(styles.scope, !board.private && styles.scopeShared)}>
          {board.private ? <Lock size={13} /> : <Users size={13} />}
          {board.private ? 'Личный' : 'Общий'}
        </span>
        <span className={cx(styles.status, styles[status])}>{STATUS_TEXT[status]}</span>
        <div className={styles.spacer} />
        {board.private && (
          <button className="btn sm" onClick={share}>
            <Share2 size={15} /> Сделать общим
          </button>
        )}
        <button className="btn sm icon ghost danger" onClick={remove} title="Удалить">
          <Trash2 size={16} />
        </button>
        <MonoAiButton
          title={draft.title}
          text={draft.data.text}
          textarea={textRef}
          onInsert={(at, piece) => {
            const t = draft.data.text;
            update({ data: { text: t.slice(0, at) + piece + t.slice(at) } });
          }}
        />
      </div>
      <div className={styles.docBody}>
        <input
          className={styles.docTitle}
          value={draft.title}
          placeholder="Без названия"
          onChange={(e) => update({ title: e.target.value })}
        />
        <div className={styles.docMeta}>
          Изменён {formatDateTime(board.updatedAt)}
          {users[board.updatedBy ?? 0] ? ` · ${users[board.updatedBy ?? 0].nickname}` : ''} · слов: {words}
        </div>
        <textarea
          ref={textRef}
          className={styles.docText}
          value={draft.data.text}
          placeholder="Начните писать…"
          spellCheck={false}
          onChange={(e) => update({ data: { text: e.target.value } })}
          onKeyDown={(e) => {
            if (e.key === 'Tab') {
              e.preventDefault();
              const t = e.currentTarget;
              const { selectionStart: s, selectionEnd: en, value } = t;
              update({ data: { text: value.slice(0, s) + '  ' + value.slice(en) } });
              requestAnimationFrame(() => t.setSelectionRange(s + 2, s + 2));
            }
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
              e.preventDefault();
              saveNow();
            }
          }}
        />
      </div>
    </section>
  );
}
