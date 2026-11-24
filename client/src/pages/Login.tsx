import { Loader2, LogIn } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Logo } from '../components/Logo';
import { enterApp, useStore } from '../store';
import styles from './Login.module.css';

export function Login() {
  const savedUrl = useStore((s) => s.serverUrl);
  const [serverUrl, setServerUrl] = useState(savedUrl || 'http://localhost:4000');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    const r = await window.holo.login(serverUrl, login.trim(), password);
    setBusy(false);
    if (!r.ok || !r.data) return setError(r.error || 'Не удалось войти');
    enterApp(r.data, serverUrl.trim().replace(/\/+$/, ''));
  };

  return (
    <div className={styles.page}>
      <div className={styles.drag} />
      <div className={styles.glow} />
      <form className={styles.card} onSubmit={submit}>
        <div className={styles.brand}>
          <Logo size={44} />
          <div>
            <h1>Holo</h1>
            <p className="muted">Dev workspace. For you and your partner.</p>
          </div>
        </div>

        <label className={styles.field}>
          <span className="label">Сервер</span>
          <input className="input" value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} />
        </label>
        <label className={styles.field}>
          <span className="label">Логин</span>
          <input className="input" value={login} autoFocus onChange={(e) => setLogin(e.target.value)} />
        </label>
        <label className={styles.field}>
          <span className="label">Пароль</span>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>

        {error && <div className={styles.error}>{error}</div>}

        <button className="btn primary" style={{ height: 42 }} disabled={busy || !login || !password}>
          {busy ? <Loader2 size={17} className="spin" /> : <LogIn size={17} />}
          Войти
        </button>
        <p className={styles.note}>Регистрация закрыта: аккаунты создаются на сервере.</p>
      </form>
    </div>
  );
}
