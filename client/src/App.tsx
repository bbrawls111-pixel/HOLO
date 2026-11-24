import { Loader2 } from 'lucide-react';
import { useEffect } from 'react';
import { Overlays } from './components/Overlays';
import { Sidebar } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import { TopBar } from './components/TopBar';
import { AIWorkspace } from './pages/AIWorkspace';
import { Chat } from './pages/Chat';
import { HistoryPage } from './pages/History';
import { Home } from './pages/Home';
import { Login } from './pages/Login';
import { Onboarding } from './pages/Onboarding';
import { Placeholder } from './pages/Placeholder';
import { Resources } from './pages/Resources';
import { Settings } from './pages/Settings';
import { boot, connectBridge, useStore } from './store';
import styles from './App.module.css';

export function App() {
  const phase = useStore((s) => s.phase);
  const me = useStore((s) => s.me);
  const page = useStore((s) => s.page);
  const loaded = useStore((s) => s.loaded);

  useEffect(() => {
    const off = connectBridge();
    boot();
    return off;
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
              {page === 'resources' && <Resources />}
              {page === 'chat' && <Chat />}
              {page === 'history' && <HistoryPage />}
              {page === 'settings' && <Settings />}
              {page === 'charts' && <Placeholder kind="charts" />}
              {page === 'structures' && <Placeholder kind="structures" />}
              {page === 'docs' && <Placeholder kind="docs" />}
            </>
          )}
          {/* ИИ-страницы держим смонтированными, чтобы сессии не перезагружались при переключении */}
          <AIWorkspace visible={page === 'ai'} />
        </div>
      </main>
      <StatusBar />
      <Overlays />
    </div>
  );
}
