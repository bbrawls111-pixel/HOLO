import { HardDrive, Wifi, WifiOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { formatBytes } from '../util';
import styles from './StatusBar.module.css';

export function StatusBar() {
  const connection = useStore((s) => s.connection);
  const stats = useStore((s) => s.stats);
  const serverUrl = useStore((s) => s.serverUrl);
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(t);
  }, []);

  return (
    <footer className={styles.bar}>
      <div className={styles.group}>
        {connection === 'online' ? <Wifi size={14} className={styles.ok} /> : <WifiOff size={14} className={styles.bad} />}
        <span>{connection === 'online' ? 'В сети' : connection === 'connecting' ? 'Подключение…' : 'Офлайн — переподключение'}</span>
        <span className="faint">{serverUrl.replace(/^https?:\/\//, '')}</span>
      </div>

      {stats && (
        <div className={styles.group} title="Общее хранилище проекта">
          <HardDrive size={14} className="faint" />
          <span className="faint">Библиотека</span>
          <span>
            {stats.files} файлов · {formatBytes(stats.storageBytes)}
          </span>
        </div>
      )}

      <div className={styles.clock}>
        <strong>{now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</strong>
        <span className="faint">{now.toLocaleDateString('ru-RU')}</span>
      </div>
    </footer>
  );
}
