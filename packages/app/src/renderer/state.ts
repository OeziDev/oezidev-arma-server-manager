import { useSyncExternalStore } from 'react';
import type {
  AppEvent,
  AppInfo,
  AppSettings,
  HostConfig,
  JobInfo,
  LogLine,
  OeziApi,
  RconPlayer,
  ServerSummary,
  StatusInfo,
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

export interface State {
  ready: boolean;
  info: AppInfo | null;
  settings: AppSettings | null;
  summaries: ServerSummary[];
  statuses: Record<string, StatusInfo>;
  logs: Record<string, LogLine[]>;
  players: Record<string, RconPlayer[]>;
  chat: Record<string, ChatItem[]>;
  jobs: Record<string, JobInfo>;
  hosts: HostConfig[];
  toasts: Toast[];
}

let state: State = {
  ready: false,
  info: null,
  settings: null,
  summaries: [],
  statuses: {},
  logs: {},
  players: {},
  chat: {},
  jobs: {},
  hosts: [],
  toasts: [],
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

const MAX_LOG = 3000;

export function startEventLoop(lang: () => 'tr' | 'en') {
  return api.onEvent((e: AppEvent) => {
    switch (e.type) {
      case 'status':
        setState((s) => ({ statuses: { ...s.statuses, [e.profileId]: e.status } }));
        break;
      case 'log':
        setState((s) => {
          const prev = s.logs[e.profileId] ?? [];
          const next = prev.concat(e.lines);
          return { logs: { ...s.logs, [e.profileId]: next.length > MAX_LOG ? next.slice(-MAX_LOG) : next } };
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
    }
  });
}

export async function loadLogs(profileId: string) {
  const lines = await api.server.logs(profileId);
  setState((s) => {
    const existing = s.logs[profileId] ?? [];
    // Olaylarla gelenleri kaybetmeden birleştir
    const last = lines[lines.length - 1];
    const tail = last ? existing.filter((l) => l.t > last.t) : existing;
    return { logs: { ...s.logs, [profileId]: lines.concat(tail).slice(-MAX_LOG) } };
  });
}

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
