import { KeyRound, Loader2, LogIn, UserPlus } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Logo } from '../components/Logo';
import { enterApp, useStore } from '../store';
import styles from './Login.module.css';

export function Login() {
  const savedUrl = useStore((s) => s.serverUrl);
  const [serverUrl, setServerUrl] = useState(savedUrl || 'https://holo-phi-pied.vercel.app');
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [setupOpen, setSetupOpen] = useState(false);
  const [code, setCode] = useState('');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Если на сервере ещё есть свободный аккаунт — показываем регистрацию по коду.
  useEffect(() => {
    let alive = true;
    const t = setTimeout(async () => {
      const r = await window.holo.setupInfo(serverUrl);
      if (!alive) return;
      const open = !!(r.ok && r.data?.open);
      setSetupOpen(open);
      if (open && r.data?.users === 0) setMode('register');
      if (!open) setMode('login');
    }, 400);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [serverUrl]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (mode === 'register') {
      if (password.length < 8) return setError('Пароль — не короче 8 символов');
      if (password !== password2) return setError('Пароли не совпадают');
    }
    setBusy(true);
    const r =
      mode === 'login'
        ? await window.holo.login(serverUrl, login.trim(), password)
        : await window.holo.register(serverUrl, code.trim(), login.trim(), password);
    setBusy(false);
    if (!r.ok || !r.data) return setError(r.error || 'Не удалось войти');
    enterApp(r.data, serverUrl.trim().replace(/\/+$/, ''));
  };

  const canSubmit =
    !busy && !!login && !!password && (mode === 'login' || (!!code && !!password2));

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

        {setupOpen && (
          <div className={styles.tabs}>
            <button type="button" className={mode === 'login' ? styles.tabOn : ''} onClick={() => setMode('login')}>
              Вход
            </button>
            <button type="button" className={mode === 'register' ? styles.tabOn : ''} onClick={() => setMode('register')}>
              Новый аккаунт
            </button>
          </div>
        )}

        {mode === 'register' && (
          <label className={styles.field}>
            <span className="label">Код приглашения</span>
            <div className={styles.withIcon}>
              <KeyRound size={16} className="faint" />
              <input className="input" value={code} autoFocus onChange={(e) => setCode(e.target.value)} />
            </div>
          </label>
        )}
        <label className={styles.field}>
          <span className="label">Логин</span>
          <input
            className="input"
            value={login}
            autoFocus={mode === 'login'}
            placeholder={mode === 'register' ? 'латиница, цифры, _ . -' : ''}
            onChange={(e) => setLogin(e.target.value)}
          />
        </label>
        <label className={styles.field}>
          <span className="label">Пароль</span>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {mode === 'register' && (
          <label className={styles.field}>
            <span className="label">Пароль ещё раз</span>
            <input className="input" type="password" value={password2} onChange={(e) => setPassword2(e.target.value)} />
          </label>
        )}

        {error && <div className={styles.error}>{error}</div>}

        <button className="btn primary" style={{ height: 42 }} disabled={!canSubmit}>
          {busy ? <Loader2 size={17} className="spin" /> : mode === 'login' ? <LogIn size={17} /> : <UserPlus size={17} />}
          {mode === 'login' ? 'Войти' : 'Создать аккаунт'}
        </button>
        <p className={styles.note}>
          {setupOpen
            ? 'Аккаунтов всего два. Новый создаётся только по коду приглашения.'
            : 'Регистрация закрыта: оба аккаунта уже созданы.'}
        </p>
      </form>
    </div>
  );
}
