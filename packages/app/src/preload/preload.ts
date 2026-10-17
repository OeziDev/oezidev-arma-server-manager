import { contextBridge, ipcRenderer } from 'electron';
import type { AppEvent, OeziApi } from '../shared/api.js';

const EVENT_CHANNEL = 'oezi:event';

async function call(area: string, method: string, ...args: unknown[]): Promise<unknown> {
  const res = (await ipcRenderer.invoke(`oezi:${area}:${method}`, ...args)) as { ok: boolean; value?: unknown; error?: string; code?: string; issues?: unknown };
  if (!res.ok) {
    const err = new Error(res.error ?? 'Bilinmeyen hata') as Error & { code?: string; issues?: unknown };
    if (res.code) err.code = res.code;
    if (res.issues) err.issues = res.issues;
    throw err;
  }
  return res.value;
}

type AreaApi = Record<string, (...args: unknown[]) => Promise<unknown>>;

function area(name: string, methods: string[]): AreaApi {
  return Object.fromEntries(methods.map((m) => [m, (...args: unknown[]) => call(name, m, ...args)]));
}

const api = {
  app: area('app', ['info', 'getSettings', 'saveSettings', 'openExternal', 'pickFile', 'pickFolder', 'saveFile', 'readPickedFile', 'copyText', 'setDirty', 'updateState', 'checkForUpdates', 'installUpdate']),
  hosts: area('hosts', ['list', 'save', 'remove', 'test', 'browse']),
  profiles: area('profiles', ['list', 'get', 'create', 'save', 'remove', 'duplicate', 'validate', 'preview', 'importServerCfg', 'importArma3Profile', 'exportJson', 'importJson']),
  server: area('server', ['start', 'stop', 'restart', 'deploy', 'status', 'logs', 'metrics']),
  backup: area('backup', ['run', 'list', 'delete', 'openFolder', 'next']),
  history: area('history', ['search', 'sessions', 'setNote', 'stats']),
  missions: area('missions', ['scan', 'upload']),
  mods: area('mods', ['scan']),
  rcon: area('rcon', ['command', 'players', 'bans', 'say', 'kick', 'ban', 'addBan', 'removeBan', 'setLock', 'reconnect', 'banEverywhere']),
  steam: area('steam', ['updateServer', 'syncWorkshop', 'workshopInfo', 'collection', 'parsePreset', 'installSteamCmd', 'fixSteamClient', 'answerGuard', 'cancel', 'jobs']),
  notify: area('notify', ['test', 'refreshStatus']),
  onEvent(cb: (e: AppEvent) => void) {
    const listener = (_: unknown, e: AppEvent) => cb(e);
    ipcRenderer.on(EVENT_CHANNEL, listener);
    return () => ipcRenderer.removeListener(EVENT_CHANNEL, listener);
  },
} as unknown as OeziApi;

contextBridge.exposeInMainWorld('oezi', api);
