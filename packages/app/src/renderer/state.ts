import { useSyncExternalStore } from 'react';
import type {
  AppEvent,
  AppInfo,
  AppSettings,
  HostConfig,
  JobInfo,
  LogLine,
  MetricSample,
  OeziApi,
  RconPlayer,
  ServerSummary,
  StatusInfo,
  UpdateState,
} from '../shared/api';

declare global {
  interface Window {
    oezi: OeziApi;
  }
}

export const api: OeziApi = window.oezi;

export interface Toast {
  id: number;
  level: 'info' | 'success' | 'warning' | 'error';
  text: string;
  who?: string;
}

export interface ChatItem {
  t: number;
  message: string;
}

/** Arayüzde üretilen (RCON komutu / yanıtı) konsol satırı; sunucu tamponunda yoktur, seq taşımaz. */
export interface LocalLogLine {
  t: number;
  source: 'app';
  line: string;
}

export interface State {
  ready: boolean;
  info: AppInfo | null;
  settings: AppSettings | null;
  update: UpdateState | null;
  summaries: ServerSummary[];
  statuses: Record<string, StatusInfo>;
  /** Sunucudan gelen satırlar (seq'e göre sıralı, tekrarsız) */
  logs: Record<string, LogLine[]>;
  /** Arayüzün kendi eklediği satırlar (RCON komutları ve yanıtları) */
  localLogs: Record<string, LocalLogLine[]>;
  players: Record<string, RconPlayer[]>;
  chat: Record<string, ChatItem[]>;
  jobs: Record<string, JobInfo>;
  hosts: HostConfig[];
  toasts: Toast[];
  /** Canlı gelen performans örnekleri (profil başına, sınırlı); geçmiş server.metrics ile yüklenir */
  metrics: Record<string, MetricSample[]>;
  /** Oyuncu geçmişi her değiştiğinde artar (arayüz yeniden yükler) */
  historyRev: Record<string, number>;
}

let state: State = {
  ready: false,
  info: null,
  settings: null,
  update: null,
  summaries: [],
  statuses: {},
  logs: {},
  localLogs: {},
  players: {},
  chat: {},
  jobs: {},
  hosts: [],
  toasts: [],
  metrics: {},
  historyRev: {},
};

const listeners = new Set<() => void>();
export function getState(): State {
  return state;
}
export function setState(patch: Partial<State> | ((s: State) => Partial<State>)) {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  listeners.forEach((l) => l());
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}
export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

let toastId = 0;
export function toast(level: Toast['level'], text: string, who?: string) {
  const id = ++toastId;
  setState((s) => ({ toasts: [...s.toasts.slice(-4), { id, level, text, ...(who ? { who } : {}) }] }));
  const ms = level === 'error' ? 9000 : 4500;
  setTimeout(() => dismissToast(id), ms);
}
export function dismissToast(id: number) {
  setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Bir işlemi çalıştır; hata olursa bildirim göster. */
export async function attempt<T>(fn: () => Promise<T>, okText?: string): Promise<T | undefined> {
  try {
    const v = await fn();
    if (okText) toast('success', okText);
    return v;
  } catch (err) {
    toast('error', errorText(err));
    return undefined;
  }
}

/** Başarılıysa true döner (void dönen işlemler için). */
export async function tryRun(fn: () => Promise<unknown>, okText?: string): Promise<boolean> {
  try {
    await fn();
    if (okText) toast('success', okText);
    return true;
  } catch (err) {
    toast('error', errorText(err));
    return false;
  }
}

export async function refreshSummaries() {
  const summaries = await api.profiles.list();
  setState((s) => {
    const statuses = { ...s.statuses };
    for (const x of summaries) statuses[x.id] = x.status;
    return { summaries, statuses };
  });
}

export async function refreshHosts() {
  setState({ hosts: await api.hosts.list() });
}

const MAX_LOG = 5000;
/** Canlı performans örneği üst sınırı (10 sn aralıkla ~11 saat) */
export const MAX_LIVE_METRICS = 4000;
const MAX_LOCAL_LOG = 500;

/** Yeni satırları seq'e göre ekle; zaten olanları atla. */
function appendLogs(prev: LogLine[], lines: LogLine[]): LogLine[] {
  if (!lines.length) return prev;
  const last = prev[prev.length - 1];
  let fresh = lines;
  if (last) {
    // seq geriye gittiyse sunucu yöneticisi yeniden oluşturulmuş demektir (sayaç sıfırlandı): olduğu gibi ekle
    const reset = lines[0]!.seq < last.seq && lines.every((l) => l.seq <= last.seq) && lines[0]!.seq <= 1;
    if (!reset) fresh = lines.filter((l) => l.seq > last.seq);
  }
  if (!fresh.length) return prev;
  const next = prev.concat(fresh);
  return next.length > MAX_LOG ? next.slice(-MAX_LOG) : next;
}

/** Arayüzün kendi ürettiği satırları ekle (RCON komutu ve yanıtı). */
export function pushLocalLog(profileId: string, text: string) {
  const t = Date.now();
  const items: LocalLogLine[] = text.split('\n').map((line) => ({ t, source: 'app', line }));
  setState((s) => {
    const next = [...(s.localLogs[profileId] ?? []), ...items];
    return { localLogs: { ...s.localLogs, [profileId]: next.length > MAX_LOCAL_LOG ? next.slice(-MAX_LOCAL_LOG) : next } };
  });
}

export function startEventLoop(lang: () => 'tr' | 'en') {
  return api.onEvent((e: AppEvent) => {
    switch (e.type) {
      case 'status':
        setState((s) => ({ statuses: { ...s.statuses, [e.profileId]: e.status } }));
        break;
      case 'log':
        setState((s) => {
          const prev = s.logs[e.profileId] ?? [];
          const next = appendLogs(prev, e.lines);
          return next === prev ? {} : { logs: { ...s.logs, [e.profileId]: next } };
        });
        break;
      case 'players':
        setState((s) => ({ players: { ...s.players, [e.profileId]: e.players } }));
        break;
      case 'rconMessage':
        setState((s) => {
          const prev = s.chat[e.profileId] ?? [];
          return { chat: { ...s.chat, [e.profileId]: [...prev.slice(-499), { t: e.t, message: e.message }] } };
        });
        break;
      case 'notice': {
        const name = state.summaries.find((x) => x.id === e.profileId)?.name;
        toast(e.notice.level === 'error' ? 'error' : e.notice.level === 'warning' ? 'warning' : 'info', e.notice.message[lang()], name);
        break;
      }
      case 'job':
        setState((s) => ({ jobs: { ...s.jobs, [e.job.id]: e.job } }));
        break;
      case 'profiles-changed':
        void refreshSummaries();
        break;
      case 'hosts-changed':
        void refreshHosts();
        break;
      case 'settings-changed':
        setState({ settings: e.settings });
        break;
      case 'update':
        setState({ update: e.update });
        break;
      case 'metrics':
        setState((s) => {
          const prev = s.metrics[e.profileId] ?? [];
          const last = prev[prev.length - 1];
          if (last && e.sample.t <= last.t) return {};
          const next = prev.length >= MAX_LIVE_METRICS ? [...prev.slice(-(MAX_LIVE_METRICS - 1)), e.sample] : [...prev, e.sample];
          return { metrics: { ...s.metrics, [e.profileId]: next } };
        });
        break;
      case 'history-changed':
        setState((s) => ({ historyRev: { ...s.historyRev, [e.profileId]: (s.historyRev[e.profileId] ?? 0) + 1 } }));
        break;
    }
  });
}

const logsLoaded = new Set<string>();

/** Sunucunun log tamponunu profil başına bir kez yükle; sonrası olaylarla gelir. */
export async function loadLogs(profileId: string) {
  if (logsLoaded.has(profileId)) return;
  logsLoaded.add(profileId);
  let lines: LogLine[];
  try {
    lines = await api.server.logs(profileId);
  } catch {
    logsLoaded.delete(profileId);
    return;
  }
  setState((s) => {
    const existing = s.logs[profileId] ?? [];
    // Tampon, istek sırasında olaylarla gelenleri de içerebilir: seq'e göre birleştir
    const sorted = [...lines].sort((a, b) => a.seq - b.seq);
    const last = sorted[sorted.length - 1];
    const tail = last ? existing.filter((l) => l.seq > last.seq) : existing;
    return { logs: { ...s.logs, [profileId]: sorted.concat(tail).slice(-MAX_LOG) } };
  });
}

/** Arayüzde açık sunucunun kaydedilmemiş taslağı (App'teki gezinme koruması için). */
export interface DraftGuard {
  dirty: boolean;
  save: () => Promise<boolean>;
  discard: () => void;
}
export const draftGuard: { current: DraftGuard | null } = { current: null };

export function hostLabel(hostId: string, hosts: HostConfig[], localLabel: string): string {
  if (hostId === 'local') return localLabel;
  const h = hosts.find((x) => x.id === hostId);
  return h ? h.name || `${h.username}@${h.host}` : '?';
}

export function formatDuration(ms: number, lang: 'tr' | 'en'): string {
  if (ms <= 0) return '-';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const u = lang === 'tr' ? { d: 'g', h: 's', m: 'dk' } : { d: 'd', h: 'h', m: 'm' };
  if (d) return `${d}${u.d} ${h}${u.h}`;
  if (h) return `${h}${u.h} ${m}${u.m}`;
  return `${m}${u.m} ${s % 60}${lang === 'tr' ? 'sn' : 's'}`;
}

export function formatTime(t: number): string {
  const d = new Date(t);
  return d.toTimeString().slice(0, 8);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** "12 sa 30 dk" / "12 h 30 min" */
export function formatPlaytime(ms: number, lang: 'tr' | 'en'): string {
  const totalMin = Math.floor(Math.max(0, ms) / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const u = lang === 'tr' ? { h: 'sa', m: 'dk' } : { h: 'h', m: 'min' };
  if (totalMin < 1) return lang === 'tr' ? '< 1 dk' : '< 1 min';
  if (h === 0) return `${m} ${u.m}`;
  return `${h} ${u.h} ${m} ${u.m}`;
}

/** Kısa tarih + saat (yerel) */
export function formatDateTime(t: number, lang: 'tr' | 'en'): string {
  return new Date(t).toLocaleString(lang === 'tr' ? 'tr-TR' : 'en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** MB -> "850 MB" / "2.1 GB" */
export function formatMem(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

/** FPS renk sınıfı: >= 30 iyi, 15-30 uyarı, < 15 kötü */
export function fpsClass(fps: number | undefined): '' | 'ok' | 'warn' | 'bad' {
  if (fps === undefined) return '';
  return fps >= 30 ? 'ok' : fps >= 15 ? 'warn' : 'bad';
}
