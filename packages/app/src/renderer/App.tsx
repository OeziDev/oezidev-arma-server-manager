import { useEffect, useMemo, useState } from 'react';
import { I18nContext, makeT, type Lang } from './i18n';
import { api, getState, refreshHosts, refreshSummaries, setState, startEventLoop, useStore } from './state';
import { Sidebar } from './views/Sidebar';
import { ServerView, type TabId } from './views/ServerView';
import { HostsView } from './views/HostsView';
import { SettingsView } from './views/SettingsView';
import { Welcome } from './views/Welcome';
import { NewServerDialog } from './views/NewServerDialog';
import { Toasts } from './components/Toasts';
import { JobsPanel } from './components/JobsPanel';

export type Route = { view: 'welcome' } | { view: 'server'; id: string; tab: TabId } | { view: 'hosts' } | { view: 'settings' };

export function App() {
  const settings = useStore((s) => s.settings);
  const summaries = useStore((s) => s.summaries);
  const ready = useStore((s) => s.ready);
  const lang: Lang = settings?.language ?? 'tr';
  const i18n = useMemo(() => ({ lang, t: makeT(lang) }), [lang]);
  const [route, setRoute] = useState<Route>({ view: 'welcome' });
  const [newOpen, setNewOpen] = useState(false);

  useEffect(() => {
    const off = startEventLoop(() => getState().settings?.language ?? 'tr');
    void (async () => {
      const [info, s] = await Promise.all([api.app.info(), api.app.getSettings()]);
      setState({ info, settings: s });
      await Promise.all([refreshSummaries(), refreshHosts()]);
      const jobs = await api.steam.jobs();
      setState({ jobs: Object.fromEntries(jobs.map((j) => [j.id, j])), ready: true });
      const first = getState().summaries[0];
      if (first) setRoute({ view: 'server', id: first.id, tab: 'overview' });
    })();
    return off;
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  // Seçili sunucu silinirse karşılama ekranına dön
  useEffect(() => {
    if (route.view === 'server' && ready && !summaries.some((s) => s.id === route.id)) {
      const first = summaries[0];
      setRoute(first ? { view: 'server', id: first.id, tab: 'overview' } : { view: 'welcome' });
    }
  }, [summaries, route, ready]);

  return (
    <I18nContext.Provider value={i18n}>
      <div className="shell">
        <Sidebar route={route} onNavigate={setRoute} onNew={() => setNewOpen(true)} />
        <main className="main">
          {!ready ? null : route.view === 'server' ? (
            <ServerView key={route.id} id={route.id} tab={route.tab} onTab={(tab) => setRoute({ ...route, tab })} onNavigate={setRoute} />
          ) : route.view === 'hosts' ? (
            <HostsView />
          ) : route.view === 'settings' ? (
            <SettingsView />
          ) : (
            <Welcome onNew={() => setNewOpen(true)} onHosts={() => setRoute({ view: 'hosts' })} />
          )}
        </main>
      </div>
      {newOpen && (
        <NewServerDialog
          onClose={() => setNewOpen(false)}
          onCreated={(id) => {
            setNewOpen(false);
            setRoute({ view: 'server', id, tab: 'config' });
          }}
          onAddHost={() => {
            setNewOpen(false);
            setRoute({ view: 'hosts' });
          }}
        />
      )}
      <JobsPanel />
      <Toasts />
    </I18nContext.Provider>
  );
}
