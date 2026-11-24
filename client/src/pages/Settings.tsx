import { LogOut } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { ProfileEditor } from '../components/ProfileEditor';
import { logout, refreshStats, useStore } from '../store';
import { cx, formatBytes } from '../util';
import styles from './Settings.module.css';

export function Settings() {
  const me = useStore((s) => s.me)!;
  const serverUrl = useStore((s) => s.serverUrl);
  const stats = useStore((s) => s.stats);
  const connection = useStore((s) => s.connection);

  const [turn, setTurn] = useState<boolean | null>(null);
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    refreshStats();
    window.holo.appVersion().then(setVersion).catch(() => {});
    api<{ turn: boolean }>('GET', '/api/call/ice')
      .then((r) => setTurn(r.turn))
      .catch(() => setTurn(false));
  }, []);

  return (
    <div className={styles.page}>
      <section className={cx('card', styles.section)}>
        <h2>Профиль</h2>
        <p className="muted">Ник и аватар видит второй участник. Изменения приходят ему мгновенно.</p>
        <ProfileEditor key={`${me.id}-${me.avatarVersion}`} me={me} />
      </section>

      <section className={cx('card', styles.section)}>
        <h2>Аккаунт и сервер</h2>
        <dl className={styles.list}>
          <dt>Версия Holo</dt>
          <dd>{version ?? '…'}</dd>
          <dt>Логин</dt>
          <dd>{me.login}</dd>
          <dt>Сервер</dt>
          <dd className="selectable">{serverUrl}</dd>
          <dt>Соединение</dt>
          <dd>{connection === 'online' ? 'Подключено (WebSocket)' : connection === 'connecting' ? 'Подключение…' : 'Нет связи'}</dd>
          <dt>Онлайн-статус</dt>
          <dd>
            Отправляется при входе и затем раз в {Math.round((stats?.presenceIntervalMs ?? 300_000) / 60_000)} мин. Сервер с той же
            периодичностью снимает статус с тех, кто не отметился. При выходе из приложения статус снимается сразу.
          </dd>
        </dl>
        <button className="btn danger" onClick={logout} style={{ alignSelf: 'flex-start' }}>
          <LogOut size={16} /> Выйти
        </button>
      </section>

      <section className={cx('card', styles.section)}>
        <h2>Звонки</h2>
        <dl className={styles.list}>
          <dt>Соединение</dt>
          <dd>Напрямую между компьютерами (WebRTC). Звук — Opus 96 кбит/с с шумо- и эхоподавлением.</dd>
          <dt>Ретранслятор (TURN)</dt>
          <dd>
            {turn === null
              ? 'Проверяем…'
              : turn
                ? 'Подключён — звонки пройдут даже через строгий NAT провайдера.'
                : 'Не подключён. Обычно звонки идут напрямую; если у кого-то из вас не соединяется — добавьте TURN.'}
          </dd>
          {turn === false && (
            <>
              <dt>Как добавить</dt>
              <dd>
                Cloudflare → Realtime → TURN Server → создать ключ. В Vercel → holo → Settings → Environment Variables
                добавить CF_TURN_KEY_ID и CF_TURN_KEY_API_TOKEN, затем Redeploy.
              </dd>
            </>
          )}
        </dl>
      </section>

      {stats && (
        <section className={cx('card', styles.section)}>
          <h2>Статистика · {stats.month}</h2>
          <dl className={styles.list}>
            <dt>Запросов к серверу</dt>
            <dd>{stats.ops.toLocaleString('ru-RU')} за месяц (без ограничений)</dd>
            <dt>Хранилище</dt>
            <dd>{formatBytes(stats.storageBytes)}</dd>
            <dt>Файлов / сообщений</dt>
            <dd>
              {stats.files} / {stats.messages}
            </dd>
          </dl>
        </section>
      )}
    </div>
  );
}
