import { Logo } from '../components/Logo';
import { ProfileEditor } from '../components/ProfileEditor';
import { logout } from '../store';
import type { Me } from '../types';
import styles from './Login.module.css';

/** Первый вход: выбор ника и аватара. */
export function Onboarding({ me }: { me: Me }) {
  return (
    <div className={styles.page}>
      <div className={styles.drag} />
      <div className={styles.glow} />
      <div className={styles.card} style={{ width: 540 }}>
        <div className={styles.brand}>
          <Logo size={40} />
          <div>
            <h1 style={{ fontSize: 24 }}>Добро пожаловать</h1>
            <p className="muted">Выберите ник и аватар — их увидит ваш напарник.</p>
          </div>
        </div>
        <ProfileEditor me={me} submitLabel="Продолжить" onSaved={() => {}} />
        <button className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={logout}>
          Выйти из аккаунта
        </button>
      </div>
    </div>
  );
}
