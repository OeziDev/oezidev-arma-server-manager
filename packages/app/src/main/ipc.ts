import { BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import fs from 'node:fs';
import { z } from 'zod';
import { fetchCollectionItems, fetchWorkshopDetails, parseLauncherPreset } from '@oezi/arma-core';
import type { AppSettings, HostConfig } from '../shared/api.js';
import { channel } from '../shared/api.js';
import { AppServices, UserError } from './services.js';
import type { Store } from './store.js';

const Id = z.string().min(1).max(128);
const Text = z.string().max(5_000_000);

const HostSchema = z.object({
  id: z.string().max(128).default(''),
  name: z.string().max(200).default(''),
  host: z.string().min(1).max(255),
  port: z.coerce.number().int().min(1).max(65535).default(22),
  username: z.string().min(1).max(100),
  authMethod: z.enum(['password', 'key']),
  privateKeyPath: z.string().max(1000).default(''),
  fingerprint: z.string().max(200).default(''),
  useSudo: z.boolean().default(false),
  useSystemd: z.boolean().default(true),
  serviceUser: z.string().max(100).regex(/^[a-z_][a-z0-9_-]*$|^$/i, 'Geçersiz kullanıcı adı').default(''),
  steamcmdPath: z.string().max(1000).default(''),
  password: z.string().max(1000).optional(),
  passphrase: z.string().max(1000).optional(),
});

const SettingsSchema = z.object({
  language: z.enum(['tr', 'en']),
  minimizeToTray: z.boolean(),
  localSteamcmdPath: z.string().max(1000),
  steamUsername: z.string().max(100),
  steamPassword: z.string().max(1000).optional(),
  clearSteamPassword: z.boolean().optional(),
});

const EXTERNAL_ALLOW = [/^https:\/\/discord\.gg\//, /^https:\/\/(www\.)?discord\.com\//, /^https:\/\/steamcommunity\.com\//, /^https:\/\/community\.bistudio\.com\//, /^https:\/\/github\.com\//];

type Handler = (...args: unknown[]) => unknown;

export function registerIpc(opts: { services: AppServices; store: Store; getWindow: () => BrowserWindow | null; version: string; onSettingsChanged: (s: AppSettings) => void }) {
  const { services: s, store } = opts;
  const picked = new Set<string>();

  const handle = (area: string, method: string, fn: Handler) => {
    ipcMain.handle(channel(area, method), async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      const win = opts.getWindow();
      if (!win || event.sender !== win.webContents) return { ok: false, error: 'Yetkisiz istek' };
      try {
        return { ok: true, value: await fn(...args) };
      } catch (err) {
        const e = err as Error & { code?: string; issues?: unknown };
        if (!(err instanceof UserError)) console.error(`[ipc ${area}.${method}]`, err);
        let message = e.message;
        if (err instanceof z.ZodError) message = 'Geçersiz veri: ' + err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
        return { ok: false, error: message, ...(e.code ? { code: e.code } : {}), ...(e.issues ? { issues: e.issues } : {}) };
      }
    });
  };

  /* app */
  handle('app', 'info', () => ({
    version: opts.version,
    platform: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux',
    insecureSecrets: store.insecureSecrets,
    dataDir: store.dir,
  }));
  handle('app', 'getSettings', () => store.getSettings());
  handle('app', 'saveSettings', (raw) => {
    const saved = store.saveSettings(SettingsSchema.parse(raw) as AppSettings);
    opts.onSettingsChanged(saved);
    return saved;
  });
  handle('app', 'openExternal', async (raw) => {
    const url = z.string().url().parse(raw);
    if (!EXTERNAL_ALLOW.some((re) => re.test(url))) throw new UserError('Bu bağlantı açılamaz');
    await shell.openExternal(url);
  });
  handle('app', 'pickFile', async (raw) => {
    const o = z.object({ title: z.string().optional(), filters: z.array(z.object({ name: z.string(), extensions: z.array(z.string()) })).optional() }).parse(raw ?? {});
    const win = opts.getWindow()!;
    const res = await dialog.showOpenDialog(win, { title: o.title ?? 'Dosya seç', properties: ['openFile'], ...(o.filters ? { filters: o.filters } : {}) });
    const file = res.canceled ? null : res.filePaths[0] ?? null;
    if (file) picked.add(file);
    return file;
  });
  handle('app', 'pickFolder', async (raw) => {
    const o = z.object({ title: z.string().optional() }).parse(raw ?? {});
    const res = await dialog.showOpenDialog(opts.getWindow()!, { title: o.title ?? 'Klasör seç', properties: ['openDirectory', 'createDirectory'] });
    return res.canceled ? null : res.filePaths[0] ?? null;
  });
  handle('app', 'saveFile', async (raw) => {
    const o = z.object({ title: z.string().optional(), defaultName: z.string(), content: Text }).parse(raw);
    const res = await dialog.showSaveDialog(opts.getWindow()!, { title: o.title ?? 'Kaydet', defaultPath: o.defaultName });
    if (res.canceled || !res.filePath) return false;
    await fs.promises.writeFile(res.filePath, o.content, 'utf8');
    return true;
  });
  handle('app', 'readPickedFile', async (raw) => {
    const file = z.string().parse(raw);
    if (!picked.has(file)) throw new UserError('Bu dosya okunamaz (önce seçilmeli)');
    const st = await fs.promises.stat(file);
    if (st.size > 5 * 1024 * 1024) throw new UserError('Dosya çok büyük (en fazla 5 MB)');
    return fs.promises.readFile(file, 'utf8');
  });

  /* hosts */
  handle('hosts', 'list', () => s.listHosts());
  handle('hosts', 'save', (raw) => s.saveHost(HostSchema.parse(raw) as HostConfig));
  handle('hosts', 'remove', (id) => s.removeHost(Id.parse(id)));
  handle('hosts', 'test', (raw) => s.testHost(HostSchema.parse(raw) as HostConfig));
  handle('hosts', 'browse', (id, dir) => s.browse(Id.parse(id), z.string().max(4096).parse(dir ?? '')));

  /* profiles */
  handle('profiles', 'list', () => s.listSummaries());
  handle('profiles', 'get', (id) => s.getProfile(Id.parse(id)));
  handle('profiles', 'create', (raw) => s.createProfile(z.record(z.string(), z.unknown()).parse(raw)));
  handle('profiles', 'save', (raw) => s.saveProfile(raw));
  handle('profiles', 'remove', (id) => s.removeProfile(Id.parse(id)));
  handle('profiles', 'duplicate', (id) => s.duplicateProfile(Id.parse(id)));
  handle('profiles', 'validate', (raw) => s.validate(raw));
  handle('profiles', 'preview', (raw) => s.preview(raw));
  handle('profiles', 'importServerCfg', (base, text) => s.importServerCfg(base, Text.parse(text)));
  handle('profiles', 'importArma3Profile', (base, text) => s.importArma3Profile(base, Text.parse(text)));
  handle('profiles', 'exportJson', (id) => s.exportJson(Id.parse(id)));
  handle('profiles', 'importJson', (text) => s.importJson(Text.parse(text)));

  /* server */
  handle('server', 'start', (id) => s.manager(Id.parse(id)).start());
  handle('server', 'stop', (id) => s.manager(Id.parse(id)).stop());
  handle('server', 'restart', (id, update) => s.manager(Id.parse(id)).restart({ update: !!update, reason: 'Elle yeniden başlatma' }));
  handle('server', 'deploy', (id) => s.manager(Id.parse(id)).deploy());
  handle('server', 'status', (id) => s.manager(Id.parse(id)).getStatus());
  handle('server', 'logs', (id) => s.manager(Id.parse(id)).getLogBuffer());

  /* missions / mods */
  handle('missions', 'scan', (id) => s.scanMissions(Id.parse(id)));
  handle('missions', 'upload', async (id) => {
    const res = await dialog.showOpenDialog(opts.getWindow()!, { title: 'Görev dosyası (.pbo)', properties: ['openFile'], filters: [{ name: 'Arma görevi', extensions: ['pbo'] }] });
    if (res.canceled || !res.filePaths[0]) return null;
    return s.uploadMission(Id.parse(id), res.filePaths[0]);
  });
  handle('mods', 'scan', (id) => s.scanMods(Id.parse(id)));

  /* rcon */
  const PlayerId = z.coerce.number().int().min(-1).max(1000);
  const Reason = z.string().max(300).default('');
  handle('rcon', 'command', (id, cmd) => s.rcon(Id.parse(id)).command(z.string().max(1000).parse(cmd)));
  handle('rcon', 'players', (id) => s.rconPlayers(Id.parse(id)));
  handle('rcon', 'bans', (id) => s.rcon(Id.parse(id)).bans());
  handle('rcon', 'say', async (id, msg, pid) => void (await s.rcon(Id.parse(id)).say(z.string().min(1).max(500).parse(msg), pid === undefined ? -1 : PlayerId.parse(pid))));
  handle('rcon', 'kick', async (id, pid, reason) => void (await s.rcon(Id.parse(id)).kick(PlayerId.parse(pid), Reason.parse(reason))));
  handle('rcon', 'ban', async (id, pid, minutes, reason) =>
    void (await s.rcon(Id.parse(id)).ban(PlayerId.parse(pid), z.coerce.number().int().min(0).parse(minutes), Reason.parse(reason))),
  );
  handle('rcon', 'addBan', async (id, v, minutes, reason) =>
    void (await s.rcon(Id.parse(id)).addBan(z.string().max(64).parse(v), z.coerce.number().int().min(0).parse(minutes), Reason.parse(reason))),
  );
  handle('rcon', 'removeBan', async (id, banId) => void (await s.rcon(Id.parse(id)).removeBan(z.coerce.number().int().min(0).parse(banId))));
  handle('rcon', 'setLock', async (id, locked) => void (await (locked ? s.rcon(Id.parse(id)).lock() : s.rcon(Id.parse(id)).unlock())));
  handle('rcon', 'reconnect', (id) => s.reconnectRcon(Id.parse(id)));

  /* steam */
  const Ids = z.array(z.string().regex(/^\d+$/)).max(500);
  handle('steam', 'updateServer', (id) => s.updateServerJob(Id.parse(id)));
  handle('steam', 'syncWorkshop', (id, ids) => s.syncWorkshopJob(Id.parse(id), ids === undefined ? undefined : Ids.parse(ids)));
  handle('steam', 'removeWorkshopMod', (id, folder) => s.removeWorkshopMod(Id.parse(id), z.string().regex(/^@[^/\\]+$/).parse(folder)));
  handle('steam', 'workshopInfo', (ids) => fetchWorkshopDetails(Ids.parse(ids)));
  handle('steam', 'collection', (cid) => fetchCollectionItems(z.string().regex(/^\d+$/).parse(cid)));
  handle('steam', 'parsePreset', (html) => parseLauncherPreset(Text.parse(html)));
  handle('steam', 'installSteamCmd', (hostId, dir) => s.installSteamCmdJob(Id.parse(hostId), z.string().min(1).max(1000).parse(dir)));
  handle('steam', 'fixSteamClient', (id) => s.fixSteamClient(Id.parse(id)));
  handle('steam', 'answerGuard', (jobId, code) => s.answerGuard(Id.parse(jobId), code === null ? null : z.string().max(20).parse(code)));
  handle('steam', 'cancel', (jobId) => s.cancelJob(Id.parse(jobId)));
  handle('steam', 'jobs', () => s.listJobs());

  /* notify */
  handle('notify', 'test', (id) => s.testNotification(Id.parse(id)));
}
