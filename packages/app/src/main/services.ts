import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import {
  DiscordNotifier,
  type Host,
  LocalHost,
  type LogLine,
  type Notifier,
  ServerManager,
  type ServerProfile,
  ServerProfileSchema,
  SshHost,
  type SteamCmdContext,
  SteamCmdError,
  buildHeadlessLaunch,
  buildServerLaunch,
  createProfile,
  downloadWorkshopItems,
  effectiveRconPort,
  ensureLinuxSteamClient,
  fetchWorkshopDetails,
  formatCommandLine,
  generateAll,
  generateSystemdUnit,
  importArma3Profile,
  importServerCfg,
  installSteamCmd,
  installWorkshopMod,
  isDiscordWebhook,
  maskSecrets,
  pathLib,
  resolvePaths,
  scanMissions,
  scanMods,
  slugify,
  uninstallWorkshopMod,
  updateServer,
  uploadMission,
  validateProfile,
  type HostOs,
} from '@oezi/arma-core';
import type { AppEvent, HostConfig, HostTestResult, JobInfo, PreviewFiles, SaveResult, ServerSummary } from '../shared/api.js';
import type { Store } from './store.js';

export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}

function strongPassword(len = 20): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = randomBytes(len);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

/* ---------------- Uzun süren işler (SteamCMD) ---------------- */

class Job {
  readonly info: JobInfo;
  readonly abort = new AbortController();
  private guardResolver: ((code: string | null) => void) | null = null;
  private emitTimer: NodeJS.Timeout | null = null;

  constructor(
    title: string,
    profileId: string | undefined,
    private readonly emit: (e: AppEvent) => void,
  ) {
    this.info = { id: randomUUID(), title, status: 'running', lines: [], startedAt: Date.now(), ...(profileId ? { profileId } : {}) };
    this.push();
  }

  line(text: string) {
    this.info.lines.push(text);
    if (this.info.lines.length > 2000) this.info.lines.splice(0, this.info.lines.length - 2000);
    this.schedule();
  }

  progress(p: number, label: string) {
    this.info.progress = p;
    this.info.progressLabel = label;
    this.schedule();
  }

  askGuard(): Promise<string | null> {
    this.info.status = 'waiting-input';
    this.push();
    return new Promise((resolve) => {
      this.guardResolver = (code) => {
        this.guardResolver = null;
        this.info.status = 'running';
        this.push();
        resolve(code);
      };
    });
  }

  answerGuard(code: string | null) {
    this.guardResolver?.(code);
  }

  finish(status: 'done' | 'failed' | 'cancelled', error?: string) {
    this.guardResolver?.(null);
    this.info.status = status;
    this.info.finishedAt = Date.now();
    if (error) this.info.error = error;
    this.push();
  }

  private schedule() {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.push();
    }, 300);
  }

  private push() {
    this.emit({ type: 'job', job: { ...this.info, lines: this.info.lines.slice(-400) } });
  }
}

/* ---------------- Servisler ---------------- */

export class AppServices {
  readonly local = new LocalHost();
  private ssh = new Map<string, SshHost>();
  private managers = new Map<string, ServerManager>();
  private jobs = new Map<string, Job>();
  private logBatches = new Map<string, LogLine[]>();
  private logTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: Store,
    private readonly emit: (e: AppEvent) => void,
  ) {}

  async init() {
    for (const p of this.store.listProfiles()) this.createManager(p);
    await Promise.all(
      [...this.managers.values()].map((m) =>
        m.attach().catch((err: Error) => {
          this.emit({ type: 'notice', profileId: m.getProfile().id, notice: { level: 'warning', message: { tr: `Sunucu durumu alınamadı: ${err.message}`, en: `Could not read server state: ${err.message}` } } });
        }),
      ),
    );
  }

  async shutdown() {
    for (const m of this.managers.values()) m.dispose();
    this.managers.clear();
    for (const h of this.ssh.values()) await h.close().catch(() => undefined);
    this.ssh.clear();
  }

  /* ---------------- host'lar ---------------- */

  getHost(hostId: string): Host {
    if (hostId === 'local') return this.local;
    let h = this.ssh.get(hostId);
    if (!h) {
      const cfg = this.store.getHost(hostId);
      if (!cfg) throw new UserError('Bu sunucunun bağlı olduğu makine silinmiş. Ayarlar > Makine bölümünden yeni bir makine seç.');
      h = this.makeSsh(cfg);
      this.ssh.set(hostId, h);
    }
    return h;
  }

  private makeSsh(cfg: HostConfig, overrideSecrets?: { password?: string; passphrase?: string }, expected = cfg.fingerprint): SshHost {
    const secrets = this.store.hostSecrets(cfg.id);
    const password = overrideSecrets?.password || secrets.password;
    const passphrase = overrideSecrets?.passphrase || secrets.passphrase;
    let privateKey: Buffer | undefined;
    if (cfg.authMethod === 'key') {
      if (!cfg.privateKeyPath) throw new UserError('SSH anahtar dosyası seçilmemiş');
      try {
        privateKey = fs.readFileSync(cfg.privateKeyPath);
      } catch {
        throw new UserError(`SSH anahtar dosyası okunamadı: ${cfg.privateKeyPath}`);
      }
    }
    return new SshHost({
      id: cfg.id,
      label: cfg.name || `${cfg.username}@${cfg.host}`,
      host: cfg.host,
      port: cfg.port || 22,
      username: cfg.username,
      ...(cfg.authMethod === 'password' && password ? { password } : {}),
      ...(privateKey ? { privateKey } : {}),
      ...(passphrase ? { passphrase } : {}),
      ...(expected ? { expectedFingerprint: expected } : {}),
      useSudo: cfg.useSudo,
    });
  }

  private hostOs(hostId: string): HostOs {
    if (hostId === 'local') return this.local.os;
    return 'linux';
  }

  listHosts(): HostConfig[] {
    return this.store.listHosts();
  }

  saveHost(h: HostConfig): HostConfig {
    if (!h.host.trim() || !h.username.trim()) throw new UserError('Adres ve kullanıcı adı gerekli');
    const cfg: HostConfig = {
      ...h,
      id: h.id || randomUUID(),
      name: h.name.trim() || `${h.username}@${h.host}`,
      port: Number(h.port) || 22,
    };
    const saved = this.store.saveHost(cfg);
    const old = this.ssh.get(saved.id);
    this.ssh.delete(saved.id);
    void old?.close();
    // Bu makinedeki sunucuları yeni bağlantıyla yeniden takip et
    for (const p of this.store.listProfiles().filter((x) => x.hostId === saved.id)) {
      this.managers.get(p.id)?.dispose();
      const m = this.createManager(p);
      void m.attach().catch(() => undefined);
    }
    this.emit({ type: 'hosts-changed' });
    return saved;
  }

  removeHost(id: string) {
    const users = this.store.listProfiles().filter((p) => p.hostId === id);
    if (users.length) throw new UserError(`Bu makineyi kullanan sunucular var: ${users.map((u) => u.name).join(', ')}`);
    void this.ssh.get(id)?.close();
    this.ssh.delete(id);
    this.store.removeHost(id);
    this.emit({ type: 'hosts-changed' });
  }

  async testHost(h: HostConfig): Promise<HostTestResult> {
    let host: SshHost;
    try {
      host = this.makeSsh({ ...h, id: h.id || 'test' }, { ...(h.password ? { password: h.password } : {}), ...(h.passphrase ? { passphrase: h.passphrase } : {}) }, '');
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    try {
      await host.connect();
      const changed = !!h.fingerprint && h.fingerprint !== host.fingerprint;
      const sd = await host.exec('sh', ['-c', 'command -v systemctl >/dev/null && [ -d /run/systemd/system ] && echo yes || echo no']);
      const id = await host.exec('id', ['-u']);
      return {
        ok: !changed,
        fingerprint: host.fingerprint,
        fingerprintChanged: changed,
        os: 'linux',
        isRoot: id.stdout.trim() === '0',
        hasSystemd: sd.stdout.trim() === 'yes',
        ...(changed ? { error: `Sunucu parmak izi değişmiş! Kayıtlı: ${h.fingerprint}, şimdi: ${host.fingerprint}` } : {}),
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message, ...(host.fingerprint ? { fingerprint: host.fingerprint } : {}) };
    } finally {
      await host.close();
    }
  }

  async browse(hostId: string, dir: string) {
    const host = this.getHost(hostId);
    await host.connect();
    let target = dir;
    if (!target) {
      target = host.kind === 'local' ? os.homedir() : (await host.exec('sh', ['-c', 'echo "$HOME"'])).stdout.trim() || '/';
    }
    const entries = (await host.list(target)).sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
    return { path: target, entries };
  }

  /* ---------------- yöneticiler ---------------- */

  private notifierFor(profileId: string): Notifier {
    return {
      notify: async (event, title, description) => {
        const p = this.store.getProfile(profileId);
        const hook = p?.notifications.discordWebhook ?? '';
        if (!p || !hook || !isDiscordWebhook(hook)) return;
        await new DiscordNotifier(hook, p.name).notify(event, title, description);
      },
    };
  }

  private createManager(p: ServerProfile): ServerManager {
    const host = this.getHostSafe(p.hostId);
    const cfg = p.hostId === 'local' ? undefined : this.store.getHost(p.hostId);
    const m = new ServerManager({
      profile: p,
      host,
      otherProfiles: () => this.store.listProfiles(),
      useSystemd: cfg ? cfg.useSystemd : false,
      ...(cfg?.serviceUser ? { serviceUser: cfg.serviceUser } : {}),
      defaultRconHost: cfg ? cfg.host : '127.0.0.1',
      notifier: this.notifierFor(p.id),
      updater: (profile, log) => this.runScheduledUpdate(profile, log),
    });
    const id = p.id;
    m.on('status', (status) => this.emit({ type: 'status', profileId: id, status }));
    m.on('notice', (notice) => this.emit({ type: 'notice', profileId: id, notice }));
    m.on('players', (players) => this.emit({ type: 'players', profileId: id, players }));
    m.on('rconMessage', (message) => this.emit({ type: 'rconMessage', profileId: id, message, t: Date.now() }));
    m.on('log', (lines) => this.queueLog(id, lines));
    this.managers.set(id, m);
    return m;
  }

  /** Makine silinmiş olsa da yönetici oluşturulabilsin (kullanıcı makineyi değiştirebilsin). */
  private getHostSafe(hostId: string): Host {
    try {
      return this.getHost(hostId);
    } catch {
      return this.local;
    }
  }

  private queueLog(id: string, lines: LogLine[]) {
    const batch = this.logBatches.get(id) ?? [];
    batch.push(...lines);
    if (batch.length > 2000) batch.splice(0, batch.length - 2000);
    this.logBatches.set(id, batch);
    if (!this.logTimer) {
      this.logTimer = setTimeout(() => {
        this.logTimer = null;
        for (const [pid, l] of this.logBatches) if (l.length) this.emit({ type: 'log', profileId: pid, lines: l });
        this.logBatches.clear();
      }, 250);
    }
  }

  manager(id: string): ServerManager {
    const m = this.managers.get(id);
    if (!m) throw new UserError('Sunucu bulunamadı');
    return m;
  }

  /* ---------------- profiller ---------------- */

  listSummaries(): ServerSummary[] {
    return this.store.listProfiles().map((p) => ({
      id: p.id,
      name: p.name,
      hostId: p.hostId,
      port: p.network.port,
      status: this.managers.get(p.id)?.getStatus() ?? { status: 'stopped', mode: 'direct', autoRestarts: 0, headless: [], rcon: 'disconnected', players: 0 },
    }));
  }

  getProfile(id: string): ServerProfile {
    const p = this.store.getProfile(id);
    if (!p) throw new UserError('Sunucu bulunamadı');
    return p;
  }

  createProfile(input: Record<string, unknown>): ServerProfile {
    const base = createProfile(input as Parameters<typeof createProfile>[0]);
    const os = this.hostOs(base.hostId);
    const L = pathLib(os);
    if (base.paths.serverDir && !base.paths.profilesDir) {
      const taken = new Set(this.store.listProfiles().map((p) => p.paths.profilesDir));
      let dir = L.join(base.paths.serverDir, 'oezi-profiles', slugify(base.name));
      for (let i = 2; taken.has(dir); i++) dir = L.join(base.paths.serverDir, 'oezi-profiles', `${slugify(base.name)}-${i}`);
      base.paths.profilesDir = dir;
    }
    if (!base.rcon.password) base.rcon.password = strongPassword(20);
    if (!base.general.passwordAdmin) base.general.passwordAdmin = strongPassword(16);
    // Aynı makinede port çakışmasın: 10'ar artır
    const ports = new Set(this.store.listProfiles().filter((p) => p.hostId === base.hostId).map((p) => p.network.port));
    while (ports.has(base.network.port)) base.network.port += 10;
    const saved = this.store.saveProfile(base);
    this.createManager(saved);
    this.emit({ type: 'profiles-changed' });
    return saved;
  }

  validate(raw: unknown): SaveResult {
    const res = ServerProfileSchema.safeParse(raw);
    if (!res.success) {
      return { errors: res.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })), issues: [] };
    }
    const p = res.data;
    return { profile: p, errors: [], issues: validateProfile(p, this.hostOs(p.hostId), this.store.listProfiles()) };
  }

  saveProfile(raw: unknown): SaveResult {
    const v = this.validate(raw);
    if (!v.profile) return v;
    const p = v.profile;
    const existing = this.store.getProfile(p.id);
    const m = this.managers.get(p.id);
    const running = m && !['stopped', 'crashed'].includes(m.getStatus().status);
    if (existing && existing.hostId !== p.hostId && running) {
      throw new UserError('Sunucu çalışırken makinesi değiştirilemez. Önce durdur.');
    }
    const saved = this.store.saveProfile(p);
    if (!m || existing?.hostId !== p.hostId) {
      m?.dispose();
      const nm = this.createManager(saved);
      void nm.attach().catch(() => undefined);
    } else {
      m.updateProfile(saved);
    }
    this.emit({ type: 'profiles-changed' });
    return { profile: saved, errors: [], issues: v.issues };
  }

  async removeProfile(id: string) {
    const m = this.managers.get(id);
    if (m && !['stopped', 'crashed'].includes(m.getStatus().status)) throw new UserError('Çalışan sunucu silinemez. Önce durdur.');
    if (m?.mode === 'systemd' && m.host.systemd) {
      try {
        await m.host.connect();
        for (const unit of [m.unitName, ...Array.from({ length: 16 }, (_, i) => m.hcUnitName(i + 1))]) {
          if (await m.host.exists(m.host.systemd.unitPath(unit))) await m.host.systemd.removeUnit(unit);
        }
        await m.host.systemd.daemonReload();
      } catch {
        /* makineye ulaşılamıyorsa sadece profili sil */
      }
    }
    m?.dispose();
    this.managers.delete(id);
    this.store.removeProfile(id);
    this.emit({ type: 'profiles-changed' });
  }

  duplicateProfile(id: string): ServerProfile {
    const src = this.getProfile(id);
    const copy = structuredClone(src) as Record<string, unknown> & ServerProfile;
    return this.createProfile({
      ...copy,
      id: randomUUID(),
      name: `${src.name} (kopya)`,
      paths: { ...src.paths, profilesDir: '' },
      network: { ...src.network, port: src.network.port + 10 },
      rcon: { ...src.rcon, port: 0, password: '' },
    });
  }

  preview(raw: unknown): PreviewFiles {
    const res = ServerProfileSchema.safeParse(raw);
    if (!res.success) return { error: res.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n') };
    const p = res.data;
    const os = this.hostOs(p.hostId);
    try {
      const files = generateAll(p);
      const out: PreviewFiles = { ...files };
      if (!p.paths.serverDir) return { ...out, error: 'Sunucu klasörü seçilmemiş; başlatma parametreleri gösterilemiyor.' };
      const rp = resolvePaths(p, os);
      const spec = buildServerLaunch(p, os, rp);
      out.commandLine = formatCommandLine({ executable: spec.executable, args: maskSecrets(spec.args) }, os);
      if (p.headless.count > 0) {
        const hc = buildHeadlessLaunch(p, os, 1, rp);
        out.headlessCommandLine = formatCommandLine({ executable: hc.executable, args: maskSecrets(hc.args) }, os);
      }
      const cfg = p.hostId === 'local' ? undefined : this.store.getHost(p.hostId);
      if (cfg?.useSystemd) {
        out.systemdUnit = generateSystemdUnit({
          description: `Arma 3 - ${p.name} (OeziDev)`,
          executable: spec.executable,
          args: spec.args,
          workingDirectory: rp.serverDir,
          logFile: rp.stdoutLog,
          ...(cfg.serviceUser ? { user: cfg.serviceUser } : {}),
          restart: p.supervisor.autoRestart ? 'on-failure' : 'no',
          restartSec: p.supervisor.restartDelaySec,
          startLimitBurst: p.supervisor.maxRestartsPerHour,
        });
      }
      out.paths = {
        executable: rp.executable,
        profilesDir: rp.profilesDir,
        serverCfg: rp.serverCfg,
        basicCfg: rp.basicCfg,
        arma3Profile: rp.arma3Profiles[0] ?? '',
        beCfg: rp.beCfg,
        missionsDir: rp.missionsDir,
        workshopDir: rp.workshopDir,
        log: os === 'windows' ? rp.rptDir : rp.stdoutLog,
      };
      return out;
    } catch (err) {
      return { error: (err as Error).message };
    }
  }

  importServerCfg(base: unknown, text: string) {
    const b = ServerProfileSchema.parse(base);
    const r = importServerCfg(text, b);
    return { profile: r.profile, issues: r.issues, unknownKeys: r.unknownKeys };
  }

  importArma3Profile(base: unknown, text: string) {
    const b = ServerProfileSchema.parse(base);
    const r = importArma3Profile(text, b);
    return { profile: r.profile, issues: r.issues, unknownKeys: r.unknownKeys };
  }

  exportJson(id: string): string {
    return this.store.exportProfile(id);
  }

  importJson(text: string): ServerProfile {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new UserError('Dosya geçerli bir JSON değil');
    }
    const obj = parsed as { format?: string; profile?: unknown };
    if (obj.format !== 'oezi-arma-profile' || !obj.profile) throw new UserError('Bu dosya bir OeziDev sunucu profili değil');
    const res = ServerProfileSchema.safeParse(obj.profile);
    if (!res.success) throw new UserError('Profil dosyası bozuk: ' + res.error.issues[0]?.message);
    const hostOk = res.data.hostId === 'local' || !!this.store.getHost(res.data.hostId);
    return this.createProfile({ ...res.data, id: randomUUID(), hostId: hostOk ? res.data.hostId : 'local', paths: { ...res.data.paths, profilesDir: '' } });
  }

  /* ---------------- görev / mod ---------------- */

  async scanMissions(id: string) {
    const p = this.getProfile(id);
    if (!p.paths.serverDir) throw new UserError('Önce sunucu klasörünü seç');
    const host = this.getHost(p.hostId);
    await host.connect();
    return scanMissions(host, p.paths.serverDir);
  }

  async uploadMission(id: string, localPath: string) {
    const p = this.getProfile(id);
    const host = this.getHost(p.hostId);
    await host.connect();
    return uploadMission(host, p.paths.serverDir, localPath);
  }

  async scanMods(id: string) {
    const p = this.getProfile(id);
    if (!p.paths.serverDir) throw new UserError('Önce sunucu klasörünü seç');
    const host = this.getHost(p.hostId);
    await host.connect();
    return scanMods(host, p.paths.serverDir);
  }

  /* ---------------- RCON ---------------- */

  rcon(id: string) {
    const r = this.manager(id).rcon;
    if (!r || r.state !== 'connected') throw new UserError('RCON bağlı değil. Sunucu çalışıyor ve BattlEye + RCON açık olmalı.');
    return r;
  }

  /** Oyuncu listesini yöneticiden al (başlıktaki oyuncu sayısı da güncellenir). */
  async rconPlayers(id: string) {
    const r = this.rcon(id);
    const players = await r.players();
    void this.manager(id).refreshPlayers();
    return players;
  }

  async reconnectRcon(id: string) {
    const m = this.manager(id);
    if (!m.rcon) throw new UserError('Sunucu çalışmıyor veya RCON kapalı');
    await m.rcon.connect();
  }

  /* ---------------- SteamCMD ---------------- */

  private steamCtx(hostId: string, job: Job | null): SteamCmdContext {
    const host = this.getHost(hostId);
    const settings = this.store.getSettings();
    const steamcmdPath = hostId === 'local' ? settings.localSteamcmdPath : this.store.getHost(hostId)?.steamcmdPath ?? '';
    if (!steamcmdPath) throw new UserError(hostId === 'local' ? 'SteamCMD yolu ayarlanmamış (Ayarlar > Steam).' : 'Bu makine için SteamCMD yolu ayarlanmamış (Makineler).');
    if (!settings.steamUsername) throw new UserError('Steam kullanıcı adı ayarlanmamış (Ayarlar > Steam). Arma 3 sunucusu ve Workshop için Arma 3 sahibi bir hesap gerekir.');
    return {
      host,
      steamcmdPath,
      credentials: { username: settings.steamUsername, password: this.store.steamPassword() },
      ...(job
        ? {
            onLine: (l: string) => job.line(l),
            onProgress: (p: number, label: string) => job.progress(p, label),
            askGuardCode: () => job.askGuard(),
            signal: job.abort.signal,
          }
        : { askGuardCode: async () => null }),
    };
  }

  private startJob(title: string, profileId: string | undefined, fn: (job: Job) => Promise<void>): string {
    const job = new Job(title, profileId, this.emit);
    this.jobs.set(job.info.id, job);
    void (async () => {
      try {
        await fn(job);
        job.finish(job.abort.signal.aborted ? 'cancelled' : 'done');
      } catch (err) {
        const e = err as Error;
        job.line(`HATA: ${e.message}`);
        job.finish(job.abort.signal.aborted || (err instanceof SteamCmdError && err.failure === 'aborted') ? 'cancelled' : 'failed', e.message);
      }
    })();
    return job.info.id;
  }

  updateServerJob(profileId: string): string {
    const p = this.getProfile(profileId);
    const m = this.manager(profileId);
    if (!['stopped', 'crashed'].includes(m.getStatus().status)) throw new UserError('Güncellemeden önce sunucuyu durdur (çalışan dosyalar güncellenemez).');
    if (!p.paths.serverDir) throw new UserError('Önce sunucu klasörünü seç');
    return this.startJob(`Sunucu güncelleme: ${p.name}`, profileId, async (job) => {
      const ctx = this.steamCtx(p.hostId, job);
      await ctx.host.connect();
      await updateServer(ctx, { installDir: p.paths.serverDir, appId: p.steam.appId, branch: p.steam.branch, branchPassword: p.steam.branchPassword, validate: p.steam.validate });
      job.line('Sunucu güncel.');
      if (ctx.host.os === 'linux') {
        const r = await ensureLinuxSteamClient(ctx.host, ctx.steamcmdPath);
        if (r === 'copied') job.line('steamclient.so ~/.steam/sdk64 klasörüne kopyalandı.');
      }
    });
  }

  syncWorkshopJob(profileId: string, onlyIds?: string[]): string {
    const p = this.getProfile(profileId);
    if (!p.paths.serverDir) throw new UserError('Önce sunucu klasörünü seç');
    return this.startJob(`Workshop modları: ${p.name}`, profileId, async (job) => {
      await this.syncWorkshop(p, this.steamCtx(p.hostId, job), (l) => job.line(l), onlyIds);
    });
  }

  /** Workshop modlarını indir/güncelle ve sunucuya bağla. Profildeki ad/yol bilgilerini günceller. */
  private async syncWorkshop(p: ServerProfile, ctx: SteamCmdContext, log: (l: string) => void, onlyIds?: string[]) {
    const host = ctx.host;
    await host.connect();
    const rp = resolvePaths(p, host.os);
    const all = [...p.launch.mods, ...p.launch.serverMods].filter((m) => m.source === 'workshop' && m.workshopId);
    const targets = onlyIds?.length ? all.filter((m) => onlyIds.includes(m.workshopId!)) : all;
    if (!targets.length) {
      log('Profilde Workshop modu yok.');
      return;
    }
    const ids = [...new Set(targets.map((m) => m.workshopId!))];
    let titles = new Map<string, string>();
    try {
      titles = new Map((await fetchWorkshopDetails(ids)).filter((i) => i.found).map((i) => [i.id, i.title]));
    } catch (err) {
      log(`Workshop bilgisi alınamadı (devam ediliyor): ${(err as Error).message}`);
    }
    log(`${ids.length} mod indiriliyor/güncelleniyor...`);
    const res = await downloadWorkshopItems(ctx, { workshopDir: rp.workshopDir, ids });
    const fresh = this.getProfile(p.id);
    let changed = false;
    for (const id of res.ok) {
      for (const list of [fresh.launch.mods, fresh.launch.serverMods]) {
        for (const mod of list.filter((m) => m.workshopId === id)) {
          const r = await installWorkshopMod(host, { serverDir: rp.serverDir, workshopDir: rp.workshopDir, id, folder: mod.path });
          log(`✓ ${titles.get(id) ?? id} -> ${r.folder}${r.keys.length ? ` (anahtar: ${r.keys.join(', ')})` : ''}`);
          if (mod.path !== r.folder) {
            mod.path = r.folder;
            changed = true;
          }
          const title = titles.get(id);
          if (title && mod.displayName !== title) {
            mod.displayName = title;
            changed = true;
          }
        }
      }
    }
    for (const f of res.failed) log(`✗ ${titles.get(f.id) ?? f.id}: ${f.message}`);
    if (changed) this.saveProfile(fresh);
    if (res.failed.length) throw new UserError(`${res.failed.length} mod indirilemedi`);
  }

  async removeWorkshopMod(profileId: string, folder: string) {
    const p = this.getProfile(profileId);
    const host = this.getHost(p.hostId);
    await host.connect();
    await uninstallWorkshopMod(host, p.paths.serverDir, folder);
  }

  /** Zamanlı restart sırasında: etkileşimsiz güncelleme */
  private async runScheduledUpdate(p: ServerProfile, log: (l: string) => void) {
    const ctx = { ...this.steamCtx(p.hostId, null), onLine: log };
    await ctx.host.connect();
    log('SteamCMD: sunucu güncelleniyor');
    await updateServer(ctx, { installDir: p.paths.serverDir, appId: p.steam.appId, branch: p.steam.branch, branchPassword: p.steam.branchPassword, validate: false });
    await this.syncWorkshop(p, ctx, log);
  }

  installSteamCmdJob(hostId: string, dir: string): string {
    return this.startJob('SteamCMD kurulumu', undefined, async (job) => {
      const host = this.getHost(hostId);
      await host.connect();
      job.line(`${dir} klasörüne kuruluyor...`);
      const path = await installSteamCmd(host, dir);
      job.line(`Kuruldu: ${path}`);
      if (hostId === 'local') {
        const s = this.store.getSettings();
        this.store.saveSettings({ ...s, localSteamcmdPath: path });
      } else {
        const cfg = this.store.getHost(hostId);
        if (cfg) this.store.saveHost({ ...cfg, steamcmdPath: path });
        this.emit({ type: 'hosts-changed' });
      }
      job.line('İlk çalıştırma (SteamCMD kendini güncelliyor)...');
      const proc = host.spawn(path, ['+quit']);
      proc.onData((c) => c.split(/\r?\n/).filter(Boolean).forEach((l) => job.line(l)));
      await proc.wait();
    });
  }

  async fixSteamClient(profileId: string): Promise<string> {
    const p = this.getProfile(profileId);
    const ctx = this.steamCtx(p.hostId, null);
    await ctx.host.connect();
    return ensureLinuxSteamClient(ctx.host, ctx.steamcmdPath);
  }

  answerGuard(jobId: string, code: string | null) {
    this.jobs.get(jobId)?.answerGuard(code);
  }

  cancelJob(jobId: string) {
    const j = this.jobs.get(jobId);
    if (!j) return;
    j.abort.abort();
    j.answerGuard(null);
  }

  listJobs(): JobInfo[] {
    return [...this.jobs.values()].map((j) => ({ ...j.info, lines: j.info.lines.slice(-400) }));
  }

  /* ---------------- bildirim ---------------- */

  async testNotification(profileId: string) {
    const p = this.getProfile(profileId);
    const hook = p.notifications.discordWebhook;
    if (!isDiscordWebhook(hook)) throw new UserError('Geçerli bir Discord webhook adresi gir (https://discord.com/api/webhooks/...)');
    await new DiscordNotifier(hook, p.name).notify('info', 'Test bildirimi', `Bildirimler çalışıyor. RCON portu: ${effectiveRconPort(p)}`);
  }
}
