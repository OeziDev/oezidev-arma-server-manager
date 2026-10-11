import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Issue, ServerProfile } from '../../shared/api';
import type { Route } from '../App';
import { DraftContext, setPath } from '../components/draft';
import { Button, StatusMark, useConfirm } from '../components/ui';
import { useI18n } from '../i18n';
import { api, attempt, errorText, formatDuration, hostLabel, toast, useStore } from '../state';
import { OverviewTab } from '../tabs/OverviewTab';
import { ConfigTab, type ConfigSection } from '../tabs/ConfigTab';
import { MissionsTab } from '../tabs/MissionsTab';
import { ModsTab } from '../tabs/ModsTab';
import { LaunchTab } from '../tabs/LaunchTab';
import { ConsoleTab } from '../tabs/ConsoleTab';
import { PlayersTab } from '../tabs/PlayersTab';
import { SteamTab } from '../tabs/SteamTab';
import { FilesTab } from '../tabs/FilesTab';

export type TabId = 'overview' | 'config' | 'missions' | 'mods' | 'launch' | 'console' | 'players' | 'steam' | 'files';
const TABS: TabId[] = ['overview', 'config', 'missions', 'mods', 'launch', 'console', 'players', 'steam', 'files'];

/** Bir alan yolunun hangi sekme/bölümde düzenlendiği */
export function locate(path: string): { tab: TabId; section?: ConfigSection } {
  const [head, sub] = path.split('.');
  if (head === 'paths' || head === 'network' || head === 'name' || head === 'hostId') return { tab: 'config', section: 'server' };
  if (head === 'general') return { tab: 'config', section: 'general' };
  if (head === 'security') return { tab: 'config', section: sub && /^(on|double)/.test(sub) ? 'scripts' : 'security' };
  if (head === 'voting' || head === 'von') return { tab: 'config', section: 'voting' };
  if (head === 'connection') return { tab: 'config', section: 'connection' };
  if (head === 'difficulty') return { tab: 'config', section: 'difficulty' };
  if (head === 'basic') return { tab: 'config', section: sub === 'extraBasicCfg' ? 'advanced' : 'network' };
  if (head === 'advanced') return { tab: 'config', section: 'advanced' };
  if (head === 'missions') return { tab: 'missions' };
  if (head === 'launch') return { tab: sub === 'mods' || sub === 'serverMods' ? 'mods' : 'launch' };
  if (head === 'steam') return { tab: 'steam' };
  return { tab: 'launch' };
}

export function ServerView({ id, tab, onTab, onNavigate }: { id: string; tab: TabId; onTab: (t: TabId) => void; onNavigate: (r: Route) => void }) {
  const { t, lang } = useI18n();
  const status = useStore((s) => s.statuses[id]);
  const hosts = useStore((s) => s.hosts);
  const summaries = useStore((s) => s.summaries);
  const [saved, setSaved] = useState<ServerProfile | null>(null);
  const [draft, setDraft] = useState<ServerProfile | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [issues, setIssues] = useState<Issue[]>([]);
  const [section, setSection] = useState<ConfigSection>('server');
  const [now, setNow] = useState(Date.now());
  const { confirm, node: confirmNode } = useConfirm();
  const dirty = useMemo(() => !!draft && !!saved && JSON.stringify(draft) !== JSON.stringify(saved), [draft, saved]);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  const load = useCallback(async () => {
    const p = await api.profiles.get(id);
    setSaved(p);
    setDraft(p);
  }, [id]);

  useEffect(() => {
    void load().catch((e) => toast('error', errorText(e)));
  }, [load]);

  // Profil arka planda değiştiyse (ör. Workshop senkronu) ve düzenleme yoksa yeniden yükle
  useEffect(() => {
    if (saved && !dirtyRef.current) {
      void api.profiles.get(id).then((p) => {
        if (!dirtyRef.current && JSON.stringify(p) !== JSON.stringify(saved)) {
          setSaved(p);
          setDraft(p);
        }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summaries]);

  // Canlı doğrulama
  useEffect(() => {
    if (!draft) return;
    const h = setTimeout(async () => {
      try {
        const r = await api.profiles.validate(draft);
        setErrors(Object.fromEntries(r.errors.map((e) => [e.path, e.message])));
        setIssues(r.issues);
      } catch {
        /* yoksay */
      }
    }, 300);
    return () => clearTimeout(h);
  }, [draft]);

  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, []);

  const set = useCallback((path: string, value: unknown) => setDraft((d) => (d ? setPath(d, path, value) : d)), []);
  const update = useCallback((fn: (p: ServerProfile) => ServerProfile) => setDraft((d) => (d ? fn(d) : d)), []);

  const save = async (): Promise<boolean> => {
    if (!draft) return false;
    try {
      const r = await api.profiles.save(draft);
      if (r.errors.length || !r.profile) {
        setErrors(Object.fromEntries(r.errors.map((e) => [e.path, e.message])));
        toast('error', t('common.unsavedErrors', { n: r.errors.length }));
        const first = r.errors[0];
        if (first) goTo(first.path);
        return false;
      }
      setSaved(r.profile);
      setDraft(r.profile);
      setIssues(r.issues);
      toast('success', t('common.saved'));
      return true;
    } catch (err) {
      toast('error', errorText(err));
      return false;
    }
  };

  const goTo = (path: string) => {
    const loc = locate(path);
    if (loc.section) setSection(loc.section);
    onTab(loc.tab);
  };

  if (!draft || !saved) return <div className="content muted">{t('common.loading')}</div>;

  const st = status?.status ?? 'stopped';
  const running = st === 'running' || st === 'starting';
  const busy = st === 'stopping' || st === 'restarting' || st === 'updating';
  const machine = hostLabel(saved.hostId, hosts, t('common.local'));
  const hostAddr = saved.hostId === 'local' ? '127.0.0.1' : hosts.find((h) => h.id === saved.hostId)?.host ?? '?';
  const errorCount = Object.keys(errors).length + issues.filter((i) => i.severity === 'error').length;

  const start = async () => {
    if (dirty && !(await save())) return;
    await attempt(() => api.server.start(id), t('action.started'));
  };

  const ctx = { draft, set, update, errors, issues };

  return (
    <DraftContext.Provider value={ctx}>
      <header className="server-head">
        <div className="server-head-row">
          <StatusMark status={st} large />
          <h1 className="server-title" title={saved.name}>
            {saved.name}
          </h1>
          <div className="head-actions">
            {!running && !busy && (
              <Button kind="primary" onClick={start}>
                {t('action.start')}
              </Button>
            )}
            {running && (
              <>
                <Button
                  onClick={async () => {
                    if (await confirm(t('action.restartConfirm', { name: saved.name }))) await attempt(() => api.server.restart(id, false));
                  }}
                >
                  {t('action.restart')}
                </Button>
                <Button
                  kind="danger"
                  onClick={async () => {
                    if (await confirm(t('action.stopConfirm', { name: saved.name }), true)) await attempt(() => api.server.stop(id), t('action.stopped'));
                  }}
                >
                  {t('action.stop')}
                </Button>
              </>
            )}
            {busy && (
              <Button kind="danger" onClick={() => attempt(() => api.server.stop(id))}>
                {t('action.stop')}
              </Button>
            )}
          </div>
        </div>
        <div className="server-facts">
          <div className="fact">
            <span className="fact-label">{t('head.status')}</span>
            <span className="fact-value" data-s={st}>
              {t(`status.${st}`)}
            </span>
          </div>
          <div className="fact">
            <span className="fact-label">{t('head.uptime')}</span>
            <span className="fact-value">{status?.startedAt && running ? formatDuration(now - status.startedAt, lang) : '-'}</span>
          </div>
          <div className="fact">
            <span className="fact-label">{t('head.players')}</span>
            <span className="fact-value">
              {status?.rcon === 'connected' ? status.players : '-'} / {saved.general.maxPlayers}
            </span>
          </div>
          <div className="fact">
            <span className="fact-label">{t('head.address')}</span>
            <span className="fact-value">
              {hostAddr}:{saved.network.port}
            </span>
          </div>
          <div className="fact">
            <span className="fact-label">{t('head.machine')}</span>
            <span className="fact-value">{machine}</span>
          </div>
          <div className="fact">
            <span className="fact-label">{t('head.rcon')}</span>
            <span className="fact-value">{t(`rcon.${status?.rcon ?? 'disconnected'}`)}</span>
          </div>
          {status?.nextScheduledRestart && (
            <div className="fact">
              <span className="fact-label">{t('head.nextRestart')}</span>
              <span className="fact-value">{new Date(status.nextScheduledRestart).toTimeString().slice(0, 5)}</span>
            </div>
          )}
        </div>
        <div className="tabs" role="tablist">
          {TABS.map((x) => (
            <button key={x} role="tab" className="tab" aria-selected={tab === x} onClick={() => onTab(x)}>
              {t(`tab.${x}`)}
              {x === 'overview' && errorCount > 0 && <span className="dot" aria-hidden />}
            </button>
          ))}
        </div>
      </header>

      {status?.unreachable && (
        <div className="banner" data-level="error" style={{ margin: '12px 28px 0', maxWidth: 'none' }}>
          {t('head.unreachable')}
        </div>
      )}
      <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {tab === 'console' ? (
          <div className="content flush">
            <ConsoleTab id={id} />
          </div>
        ) : (
          <div className="content">
            {tab === 'overview' && <OverviewTab id={id} profile={saved} issues={issues} errors={errors} onFix={goTo} />}
            {tab === 'config' && <ConfigTab section={section} onSection={setSection} />}
            {tab === 'missions' && <MissionsTab id={id} />}
            {tab === 'mods' && <ModsTab id={id} dirty={dirty} onSave={save} />}
            {tab === 'launch' && <LaunchTab id={id} dirty={dirty} />}
            {tab === 'players' && <PlayersTab id={id} />}
            {tab === 'steam' && <SteamTab id={id} dirty={dirty} onSave={save} />}
            {tab === 'files' && (
              <FilesTab
                id={id}
                onImported={(p) => setDraft(p)}
                onDeleted={() => onNavigate({ view: 'welcome' })}
                onDuplicated={(newId) => onNavigate({ view: 'server', id: newId, tab: 'config' })}
              />
            )}
          </div>
        )}
        {dirty && (
          <div className="dirty-bar" role="region" aria-label={t('common.unsaved')}>
            <span className="msg">
              <strong>{t('common.unsaved')}</strong> {Object.keys(errors).length > 0 && <span className="bad"> {t('common.unsavedErrors', { n: Object.keys(errors).length })}</span>}
            </span>
            <Button kind="ghost" onClick={() => setDraft(saved)}>
              {t('common.discard')}
            </Button>
            <Button kind="primary" onClick={save}>
              {t('common.save')}
            </Button>
          </div>
        )}
      </div>
      {confirmNode}
    </DraftContext.Provider>
  );
}
