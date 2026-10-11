import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { I18nContext, makeT, type Lang } from './i18n';
import { api, draftGuard, getState, refreshHosts, refreshSummaries, setState, startEventLoop, useStore } from './state';
import { Sidebar } from './views/Sidebar';
import { ServerView, type TabId } from './views/ServerView';
import { HostsView } from './views/HostsView';
import { SettingsView } from './views/SettingsView';
import { Welcome } from './views/Welcome';
import { NewServerDialog } from './views/NewServerDialog';
import { Toasts } from './components/Toasts';
import { JobsPanel } from './components/JobsPanel';
import { Button, Modal } from './components/ui';
import { ImportSummary, type ImportSummaryData } from './components/ImportSummary';

export type Route = { view: 'welcome' } | { view: 'server'; id: string; tab: TabId } | { view: 'hosts' } | { view: 'settings' };
export type Navigate = (r: Route, opts?: { force?: boolean }) => void;

export function App() {
  const settings = useStore((s) => s.settings);
  const summaries = useStore((s) => s.summaries);
  const ready = useStore((s) => s.ready);
  const lang: Lang = settings?.language ?? 'tr';
  const i18n = useMemo(() => ({ lang, t: makeT(lang) }), [lang]);
  const { t } = i18n;
  const [route, setRoute] = useState<Route>({ view: 'welcome' });
  const routeRef = useRef(route);
  routeRef.current = route;
  const [newOpen, setNewOpen] = useState(false);
  const [pending, setPending] = useState<Route | null>(null);
  const [importSummary, setImportSummary] = useState<ImportSummaryData | null>(null);

  /** Açık sunucudan ayrılırken kaydedilmemiş değişiklik varsa önce sor (Kaydet / At / Vazgeç). */
  const navigate: Navigate = useCallback((r, opts) => {
    const cur = routeRef.current;
    const leaving = cur.view === 'server' && !(r.view === 'server' && r.id === cur.id);
    if (!opts?.force && leaving && draftGuard.current?.dirty) {
      setPending(r);
      return;
    }
    setRoute(r);
  }, []);

  useEffect(() => {
    const off = startEventLoop(() => getState().settings?.language ?? 'tr');
    void (async () => {
      const [info, s] = await Promise.all([api.app.info(), api.app.getSettings()]);
      setState({ info, settings: s });
      void api.app
        .updateState()
        .then((update) => setState({ update }))
        .catch(() => undefined);
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

  const leave = (r: Route) => {
    setPending(null);
    setRoute(r);
  };

  return (
    <I18nContext.Provider value={i18n}>
      <div className="shell">
        <Sidebar route={route} onNavigate={navigate} onNew={() => setNewOpen(true)} />
        <main className="main">
          {!ready ? null : route.view === 'server' ? (
            <ServerView key={route.id} id={route.id} tab={route.tab} onTab={(tab) => setRoute({ ...route, tab })} onNavigate={navigate} />
          ) : route.view === 'hosts' ? (
            <HostsView />
          ) : route.view === 'settings' ? (
            <SettingsView />
          ) : (
            <Welcome onNew={() => setNewOpen(true)} onHosts={() => navigate({ view: 'hosts' })} />
          )}
        </main>
      </div>
      {newOpen && (
        <NewServerDialog
          onClose={() => setNewOpen(false)}
          onCreated={(id, summary) => {
            setNewOpen(false);
            navigate({ view: 'server', id, tab: 'config' });
            if (summary) setImportSummary(summary);
          }}
          onAddHost={() => {
            setNewOpen(false);
            navigate({ view: 'hosts' });
          }}
        />
      )}
      {importSummary && <ImportSummary data={importSummary} onClose={() => setImportSummary(null)} />}
      {pending && (
        <Modal
          title={t('nav.unsavedTitle')}
          onClose={() => setPending(null)}
          footer={
            <>
              <Button kind="ghost" onClick={() => setPending(null)}>
                {t('common.cancel')}
              </Button>
              <Button
                kind="danger"
                onClick={() => {
                  draftGuard.current?.discard();
                  leave(pending);
                }}
              >
                {t('nav.discard')}
              </Button>
              <Button
                kind="primary"
                onClick={async () => {
                  const target = pending;
                  // Kaydedilemezse (hatalı alan) sayfada kal: kaydet işlevi hatalı alana götürür
                  if (await draftGuard.current?.save()) leave(target);
                  else setPending(null);
                }}
              >
                {t('nav.save')}
              </Button>
            </>
          }
        >
          <p style={{ margin: '4px 0 8px' }}>{t('nav.unsavedText')}</p>
        </Modal>
      )}
      <JobsPanel />
      <Toasts />
    </I18nContext.Provider>
  );
}
