import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Issue, ServerProfile } from '../../shared/api';
import type { Route } from '../App';
import { DraftContext, setPath } from '../components/draft';
import { Button, FormContext, StatusMark, useConfirm } from '../components/ui';
import { Sweep, TypeTitle, useChangeCount } from '../components/motion';
import { useI18n } from '../i18n';
import { api, attempt, draftGuard, errorText, formatDuration, formatMem, fpsClass, hostLabel, toast, useStore } from '../state';
import { OverviewTab } from '../tabs/OverviewTab';
import { ConfigTab, type ConfigSection } from '../tabs/ConfigTab';
import { MissionsTab } from '../tabs/MissionsTab';
import { ModsTab } from '../tabs/ModsTab';
import { LaunchTab } from '../tabs/LaunchTab';
import { ConsoleTab } from '../tabs/ConsoleTab';
import { PlayersTab } from '../tabs/PlayersTab';
import { SteamTab } from '../tabs/SteamTab';
import { FilesTab } from '../tabs/FilesTab';
import { PerformanceTab } from '../tabs/PerformanceTab';
import { BackupsTab } from '../tabs/BackupsTab';

export type TabId = 'overview' | 'performance' | 'config' | 'missions' | 'mods' | 'launch' | 'console' | 'players' | 'steam' | 'files' | 'backups';
const TABS: TabId[] = ['overview', 'performance', 'config', 'missions', 'mods', 'launch', 'console', 'players', 'steam', 'files', 'backups'];

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
  if (head === 'monitoring' || (head === 'notifications' && sub === 'onPerformance')) return { tab: 'performance' };
  if (head === 'backup') return { tab: 'backups' };
  return { tab: 'launch' };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** Derin eşitlik (anahtar sırasından bağımsız) */
export function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    return ka.length === kb.length && ka.every((k) => same(a[k], b[k]));
  }
  return false;
}
const hasId = (v: unknown): v is { id: string } => isObj(v) && typeof v.id === 'string';

/**
 * Üç yönlü birleştirme: base = düzenlemeye başlanan kayıtlı sürüm, mine = taslak, theirs = arka planda
 * değişmiş güncel kayıt (ör. Workshop senkronu mod yollarını yazdı). Kullanıcının değiştirmediği her şey
 * güncel kayıttan, değiştirdiği her şey taslaktan alınır; id taşıyan dizi öğeleri (modlar, görevler) tek tek birleşir.
 */
export function merge3(base: unknown, mine: unknown, theirs: unknown): unknown {
  if (same(mine, base)) return theirs;
  if (same(theirs, base) || same(mine, theirs)) return mine;
  if (isObj(base) && isObj(mine) && isObj(theirs)) {
    const out: Record<string, unknown> = {};
    for (const k of new Set([...Object.keys(theirs), ...Object.keys(mine)])) {
      if (!(k in mine)) {
        // Kullanıcı sildiyse silinmiş kalsın; güncel kayıtta yeni eklendiyse al
        if (!(k in base)) out[k] = theirs[k];
        continue;
      }
      out[k] = k in theirs ? merge3(base[k], mine[k], theirs[k]) : mine[k];
    }
    return out;
  }
  if (Array.isArray(base) && Array.isArray(mine) && Array.isArray(theirs) && [...base, ...mine, ...theirs].every(hasId)) {
    const b = new Map(base.map((x) => [x.id, x]));
    const th = new Map(theirs.map((x) => [x.id, x]));
    return mine.map((x) => (b.has(x.id) && th.has(x.id) ? merge3(b.get(x.id), x, th.get(x.id)) : x));
  }
  return mine;
}

export function ServerView({ id, tab, onTab, onNavigate }: { id: string; tab: TabId; onTab: (t: TabId) => void; onNavigate: (r: Route, opts?: { force?: boolean }) => void }) {
  const { t, lang } = useI18n();
  const status = useStore((s) => s.statuses[id]);
  const hosts = useStore((s) => s.hosts);
  const summaries = useStore((s) => s.summaries);
  const jobActive = useStore((s) => Object.values(s.jobs).some((j) => j.profileId === id && (j.status === 'running' || j.status === 'waiting-input')));
  const [saved, setSaved] = useState<ServerProfile | null>(null);
  const [draft, setDraft] = useState<ServerProfile | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [issues, setIssues] = useState<Issue[]>([]);
  const [section, setSection] = useState<ConfigSection>('server');
  const [now, setNow] = useState(Date.now());
  const [epoch, setEpoch] = useState(0);
  const [invalid, setInvalid] = useState<Record<string, true>>({});
  const [hiddenError, setHiddenError] = useState<string | null>(null);
  const { confirm, node: confirmNode } = useConfirm();
  const statusChanges = useChangeCount(status?.status ?? 'stopped');
  const invalidCount = Object.keys(invalid).length;
  const draftDirty = useMemo(() => !!draft && !!saved && !same(draft, saved), [draft, saved]);
  const dirty = draftDirty || invalidCount > 0;
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  /** Taslağı dışarıdan değiştir: yerel metin alanları (sayı, liste) yeni değere döner */
  const replaceDraft = useCallback((p: ServerProfile) => {
    setDraft(p);
    setEpoch((e) => e + 1);
  }, []);

  const report = useCallback((key: string, bad: boolean) => {
    setInvalid((prev) => {
      if (bad === !!prev[key]) return prev;
      const next = { ...prev };
      if (bad) next[key] = true;
      else delete next[key];
      return next;
    });
  }, []);
  const form = useMemo(() => ({ report, epoch }), [report, epoch]);

  const load = useCallback(async () => {
    const p = await api.profiles.get(id);
    setSaved(p);
    replaceDraft(p);
  }, [id, replaceDraft]);

  useEffect(() => {
    void load().catch((e) => toast('error', errorText(e)));
  }, [load]);

  // Profil arka planda değiştiyse (ör. Workshop senkronu) ve düzenleme yoksa yeniden yükle.
  // Düzenleme varsa atlanır; Kaydet sırasında güncel kayıtla birleştirilir (merge3).
  useEffect(() => {
    if (saved && !dirtyRef.current) {
      void api.profiles
        .get(id)
        .then((p) => {
          if (!dirtyRef.current && !same(p, saved)) {
            setSaved(p);
            replaceDraft(p);
          }
        })
        .catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summaries]);

  // Ana süreç kaydedilmemiş değişiklikle çıkışta sorsun
  useEffect(() => {
    void api.app.setDirty(dirty).catch(() => undefined);
  }, [dirty]);
  useEffect(() => () => void api.app.setDirty(false).catch(() => undefined), []);

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
    if (!draft || !saved) return false;
    if (invalidCount > 0) {
      toast('error', t('common.localInvalid', { n: invalidCount }));
      return false;
    }
    try {
      // Düzenleme sırasında profil arka planda değiştiyse (Workshop senkronu vb.) üzerine yazma: birleştir
      let toSave: ServerProfile = draft;
      let base: ServerProfile = saved;
      const latest = await api.profiles.get(id).catch(() => null);
      let mergedIn = false;
      if (latest && !same(latest, saved)) {
        toSave = merge3(saved, draft, latest) as ServerProfile;
        base = latest;
        mergedIn = !same(toSave, draft);
      }
      const r = await api.profiles.save(toSave);
      if (r.errors.length || !r.profile) {
        if (base !== saved) {
          setSaved(base);
          replaceDraft(toSave);
        }
        setErrors(Object.fromEntries(r.errors.map((e) => [e.path, e.message])));
        toast('error', t('common.unsavedErrors', { n: r.errors.length }));
        const first = r.errors[0];
        if (first) goTo(first.path);
        return false;
      }
      setSaved(r.profile);
      replaceDraft(r.profile);
      setIssues(r.issues);
      toast('success', t('common.saved'));
      if (mergedIn) toast('info', t('common.mergedBackground'));
      return true;
    } catch (err) {
      toast('error', errorText(err));
      return false;
    }
  };

  const discard = () => {
    if (saved) replaceDraft(saved);
  };

  // App'teki gezinme koruması her zaman güncel kaydet/at işlevlerini görsün
  useEffect(() => {
    const g = { dirty, save, discard };
    draftGuard.current = g;
    return () => {
      if (draftGuard.current === g) draftGuard.current = null;
    };
  });

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
  const jobHint = jobActive ? t('job.activeHint') : undefined;
  const lastError = lang === 'en' && status?.lastErrorEn ? status.lastErrorEn : status?.lastError;

  const ensureSaved = async () => !dirty || (await save());

  const start = async () => {
    if (jobActive) return;
    if (!(await ensureSaved())) return;
    await attempt(() => api.server.start(id), t('action.started'));
  };

  const restart = async () => {
    if (jobActive) return;
    if (!(await confirm(t('action.restartConfirm', { name: saved.name })))) return;
    if (!(await ensureSaved())) return;
    await attempt(() => api.server.restart(id, false));
  };

  const ctx = { draft, set, update, errors, issues, dirty, ensureSaved, jobActive };

  return (
    <FormContext.Provider value={form}>
    <DraftContext.Provider value={ctx}>
      <header className="server-head">
        <div className="server-head-row">
          <StatusMark status={st} large />
          <h1 className="server-title" title={saved.name}>
            <TypeTitle text={saved.name} />
          </h1>
          <div className="head-actions">
            {jobActive && <span className="small warn head-hint">{t('job.activeShort')}</span>}
            {!running && !busy && (
              <Button kind="primary" onClick={start} disabled={jobActive} title={jobHint}>
                {t('action.start')}
              </Button>
            )}
            {running && (
              <>
                <Button onClick={restart} disabled={jobActive} title={jobHint}>
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
            <span key={statusChanges} className={`fact-value ${statusChanges ? 'pulse' : ''}`} data-s={st}>
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
          {running && status?.perf && (
            <button className="fact fact-link" onClick={() => onTab('performance')} title={t('tab.performance')}>
              <span className="fact-label">{t('head.perf')}</span>
              <span className="fact-value perf-inline">
                {status.perf.fps !== undefined && <span className={fpsClass(status.perf.fps)}>{Math.round(status.perf.fps)} FPS</span>}
                {status.perf.cpu !== undefined && <span>CPU {Math.round(status.perf.cpu)}%</span>}
                {status.perf.memMB !== undefined && <span>{formatMem(status.perf.memMB)}</span>}
              </span>
            </button>
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
      {lastError && hiddenError !== lastError && (
        <div className="error-box" role="alert">
          <div className="error-box-head">
            {/* Çalışırken (ör. Steam/BattlEye port uyarısı) "başlatılamadı" yazmasın */}
            <strong>{t(running && lastError !== 'validation' ? 'head.serverWarning' : 'head.lastError')}</strong>
            <span className="spacer" />
            {lastError === 'validation' && tab !== 'overview' && (
              <Button size="sm" onClick={() => onTab('overview')}>
                {t('head.showIssues')}
              </Button>
            )}
            <Button size="sm" kind="ghost" onClick={() => setHiddenError(lastError)}>
              {t('common.close')}
            </Button>
          </div>
          {lastError === 'validation' ? <div>{t('head.lastErrorValidation')}</div> : <pre className="error-box-text">{lastError}</pre>}
        </div>
      )}
      <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <Sweep key={tab} />
        {tab === 'console' ? (
          <div className="content flush">
            <ConsoleTab id={id} />
          </div>
        ) : (
          <div className="content" key={tab}>
            {tab === 'overview' && <OverviewTab id={id} profile={saved} issues={issues} errors={errors} onFix={goTo} onPerf={() => onTab('performance')} />}
            {tab === 'performance' && <PerformanceTab id={id} />}
            {tab === 'backups' && <BackupsTab id={id} />}
            {tab === 'config' && <ConfigTab section={section} onSection={setSection} />}
            {tab === 'missions' && <MissionsTab id={id} />}
            {tab === 'mods' && <ModsTab id={id} />}
            {tab === 'launch' && <LaunchTab id={id} />}
            {tab === 'players' && <PlayersTab id={id} />}
            {tab === 'steam' && <SteamTab id={id} />}
            {tab === 'files' && (
              <FilesTab
                id={id}
                onImported={replaceDraft}
                onDeleted={() => onNavigate({ view: 'welcome' }, { force: true })}
                onDuplicated={(newId) => onNavigate({ view: 'server', id: newId, tab: 'config' })}
              />
            )}
          </div>
        )}
        {dirty && (
          <div className="dirty-bar" role="region" aria-label={t('common.unsaved')}>
            <span className="msg">
              <strong>{t('common.unsaved')}</strong> {Object.keys(errors).length > 0 && <span className="bad"> {t('common.unsavedErrors', { n: Object.keys(errors).length })}</span>}
              {invalidCount > 0 && <span className="bad"> {t('common.localInvalid', { n: invalidCount })}</span>}
            </span>
            <Button kind="ghost" onClick={discard}>
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
    </FormContext.Provider>
  );
}
