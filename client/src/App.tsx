import { Loader2 } from 'lucide-react';
import { useEffect } from 'react';
import { ImageViewer } from './components/ImageViewer';
import { Overlays } from './components/Overlays';
import { Sidebar } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import { TopBar } from './components/TopBar';
import { Charts } from './pages/Charts';
import { Chat } from './pages/Chat';
import { Docs } from './pages/Docs';
import { HistoryPage } from './pages/History';
import { Home } from './pages/Home';
import { Library } from './pages/Library';
import { Login } from './pages/Login';
import { Onboarding } from './pages/Onboarding';
import { Settings } from './pages/Settings';
import { Structures } from './pages/Structures';
import { Trash } from './pages/Trash';
import { askLibrary, boot, connectBridge, useStore } from './store';
import { uploadOne } from './upload';
import { formatBytes } from './util';
import styles from './App.module.css';

export function App() {
  const phase = useStore((s) => s.phase);
  const me = useStore((s) => s.me);
  const page = useStore((s) => s.page);
  const loaded = useStore((s) => s.loaded);
  const chatVisited = useStore((s) => !!s.visited.chat);

  useEffect(() => {
    const off = connectBridge();
    boot();
    // Файл скачан со страницы ИИ → предложить сохранить его в библиотеку.
    const offDl = window.holo.on('holo:downloaded', async ({ path, name, size }: { path: string; name: string; size: number }) => {
      if (useStore.getState().phase !== 'app') return;
      const form = await askLibrary({
        fileName: `${name} · ${formatBytes(size || 0)}`,
        title: 'Файл скачан. Сохранить в библиотеку?',
        message: 'Он уже лежит в «Загрузки/Holo». В библиотеке его увидит и напарник.',
      });
      if (form) uploadOne(null, { localPath: path, name, scope: 'library', ...form });
    });
    return () => {
      off();
      offDl();
    };
  }, []);

  if (phase === 'boot') {
    return (
      <div className={styles.center}>
        <Loader2 className="spin faint" />
      </div>
    );
  }

  if (phase === 'login' || !me) {
    return (
      <>
        <Login />
        <Overlays />
      </>
    );
  }

  if (me.needsSetup) {
    return (
      <>
        <Onboarding me={me} />
        <Overlays />
      </>
    );
  }

  return (
    <div className={styles.app}>
      <Sidebar />
      <main className={styles.main}>
        <TopBar />
        <div className={styles.content}>
          {!loaded ? (
            <div className={styles.center}>
              <Loader2 className="spin faint" />
            </div>
          ) : (
            <>
              {page === 'home' && <Home />}
              {page === 'library' && <Library />}
              {page === 'docs' && <Docs />}
              {page === 'charts' && <Charts />}
              {page === 'structures' && <Structures />}
              {page === 'history' && <HistoryPage />}
              {page === 'trash' && <Trash />}
              {page === 'settings' && <Settings />}
              {/* Чат с ИИ-страницами держим смонтированным — сессии не перезагружаются */}
              {(chatVisited || page === 'chat') && <Chat visible={page === 'chat'} />}
            </>
          )}
        </div>
      </main>
      <StatusBar />
      <ImageViewer />
      <Overlays />
    </div>
  );
}
