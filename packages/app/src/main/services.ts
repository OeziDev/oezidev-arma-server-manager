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
  firstRunSteamCmd,
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
  type WorkshopDownloadResult,
} from '@oezi/arma-core';
import type { AppEvent, HostConfig, HostTestResult, JobInfo, PreviewFiles, SaveResult, ServerSummary } from '../shared/api.js';
import { UserError } from './errors.js';
import { LazySshHost } from './lazyHost.js';
import type { Store } from './store.js';

export { UserError };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Sunucu "meşgul" sayılan durumlar (başlatma/durdurma/güncelleme sürüyor) */
const BUSY_STATUSES = new Set(['starting', 'stopping', 'restarting', 'updating']);
const isActive = (m: ServerManager | undefined) => !!m && !['stopped', 'crashed'].includes(m.getStatus().status);

function strongPassword(len = 20): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = randomBytes(len);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

/* ---------------- Uzun süren işler (SteamCMD) ---------------- */

interface JobScope {
  profileId?: string;
  hostId?: string;
  /** İşin dokunduğu sunucu klasörü (aynı klasörü kullanan sunucular başlatılamasın) */
  serverDir?: string;
}

class Job {
  readonly info: JobInfo;
  readonly abort = new AbortController();
  /** İş bitince (başarılı/başarısız/iptal) çözülür */
  done: Promise<void> = Promise.resolve();
  private guardResolver: ((code: string | null) => void) | null = null;
  private emitTimer: NodeJS.Timeout | null = null;

  constructor(
    title: string,
    readonly scope: JobScope,
    private readonly emit: (e: AppEvent) => void,
  ) {
    this.info = { id: randomUUID(), title, status: 'running', lines: [], startedAt: Date.now(), ...(scope.profileId ? { profileId: scope.profileId } : {}) };
    this.push();
  }

  get running(): boolean {
    return this.info.finishedAt === undefined;
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

const MISSING_HOST = 'Bu sunucunun bağlı olduğu makine silinmiş. Ayarlar > Makine bölümünden yeni bir makine seç.';
const MOD_FOLDER_RE = /^@[^/\\]+$/;

/** Çıkışta / güncellemede kullanıcıya sorulacak süren işler */
export interface ActiveWork {
  jobs: string[];
  busy: string[];
}

export class AppServices {
  readonly local = new LocalHost();
  private ssh = new Map<string, LazySshHost>();
  private managers = new Map<string, ServerManager>();
  private jobs = new Map<string, Job>();
  private logBatches = new Map<string, LogLine[]>();
  private logTimer: NodeJS.Timeout | null = null;
  /** Bu servis üzerinden başlatılmış ve süren sunucu işlemleri (başlat/durdur/restart/dağıt) */
  private managerOps = new Map<string, number>();
  /** Makine üzerinde süren kısa işlemler (Workshop temizliği vb.) */
  private hostOps = new Map<string, number>();
  /** SteamCMD kilitleri: aynı makine + aynı steamcmd için aynı anda tek çalıştırma */
  private steamLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly store: Store,
    private readonly emit: (e: AppEvent) => void,
  ) {}

  async init() {
    for (const p of this.store.listProfiles()) this.createManager(p);
    await Promise.all([...this.managers.values()].map((m) => this.attachWithRetry(m)));
  }

  /** Makineye ulaşılamıyorsa (VPS kapalı, ağ yok) 30 sn'de bir yeniden dene; bulunca takibe başla. */
  private async attachWithRetry(m: ServerManager, notify = true): Promise<void> {
    try {
      await m.attach();
    } catch (err) {
      if (notify) {
        const msg = (err as Error).message;
        this.emit({ type: 'notice', profileId: m.getProfile().id, notice: { level: 'warning', message: { tr: `Sunucu durumu alınamadı, tekrar denenecek: ${msg}`, en: `Could not read server state, will retry: ${msg}` } } });
      }
      setTimeout(() => {
        if (this.managers.get(m.getProfile().id) === m) void this.attachWithRetry(m, false);
      }, 30_000);
    }
  }

  /** Bağlantıları kapatır, takibi bırakır. Arma sunucuları DURDURULMAZ (ayrı süreç / systemd servisi). */
  async shutdown() {
    for (const m of this.managers.values()) m.dispose();
    this.managers.clear();
    const hosts = [...this.ssh.values()];
    this.ssh.clear();
    await Promise.all(hosts.map((h) => h.close().catch(() => undefined)));
  }

  /* ---------------- süren işler (çıkış / güncelleme) ---------------- */

  private runningJobs(): Job[] {
    return [...this.jobs.values()].filter((j) => j.running);
  }

  private isBusy(id: string, m = this.managers.get(id)): boolean {
    return (this.managerOps.get(id) ?? 0) > 0 || (!!m && BUSY_STATUSES.has(m.getStatus().status));
  }

  activeWork(): ActiveWork {
    const jobs = this.runningJobs().map((j) => j.info.title);
    const busy: string[] = [];
    for (const [id, m] of this.managers) if (this.isBusy(id, m)) busy.push(m.getProfile().name);
    for (const [hostId, n] of this.hostOps) if (n > 0) busy.push(`Workshop temizliği (${this.store.getHost(hostId)?.name ?? hostId})`);
    return { jobs, busy };
  }

  /** Bütün işleri iptal et ve bitmelerini bekle (en fazla timeoutMs) */
  async abortAllJobs(timeoutMs = 10_000): Promise<void> {
    const running = this.runningJobs();
    if (!running.length) return;
    for (const j of running) {
      j.abort.abort();
      j.answerGuard(null);
    }
    await Promise.race([Promise.allSettled(running.map((j) => j.done)), sleep(timeoutMs)]);
  }

  /** Güncelleme kurulumundan önce: iş yoksa yöneticileri bırak ve SSH bağlantılarını kapat (sunucular çalışmaya devam eder). */
  async prepareForUpdate(): Promise<void> {
    const w = this.activeWork();
    const all = [...w.jobs, ...w.busy];
    if (all.length) throw new UserError(`Önce devam eden işlerin bitmesini bekle: ${all.join(', ')}`);
    await this.shutdown();
  }

  /* ---------------- host'lar ---------------- */

  getHost(hostId: string): Host {
    if (hostId === 'local') return this.local;
    if (!this.store.getHost(hostId)) throw new UserError(MISSING_HOST);
    return this.sshHost(hostId);
  }

  /** SSH makinesi (tembel): kurulamazsa yerel makineye DÜŞMEZ, her işlemde yeniden denenir. */
  private sshHost(hostId: string): LazySshHost {
    let h = this.ssh.get(hostId);
    if (!h) {
      const cfg = this.store.getHost(hostId);
      const label = cfg ? cfg.name || `${cfg.username}@${cfg.host}` : hostId;
      h = new LazySshHost(hostId, label, () => {
        const c = this.store.getHost(hostId);
        if (!c) throw new UserError(MISSING_HOST);
        return this.makeSsh(c);
      });
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
    const host = new SshHost({
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
    if (!expected && cfg.id && cfg.id !== 'test') {
      // Test edilmeden kaydedilmiş makine: ilk bağlantıda parmak izini kaydet (sonra değişirse reddedilir)
      host.onFingerprintLearned = (fp) => {
        const current = this.store.getHost(cfg.id);
        if (current && !current.fingerprint) {
          try {
            this.store.saveHost({ ...current, fingerprint: fp });
            this.emit({ type: 'hosts-changed' });
          } catch (err) {
            console.error('Parmak izi kaydedilemedi:', err);
          }
        }
      };
    }
    return host;
  }

  private hostOs(hostId: string): HostOs {
    if (hostId === 'local') return this.local.os;
    return 'linux';
  }

  /** Servis kullanıcısı (Linux): boşsa ve SSH kullanıcısı root değilse SSH kullanıcısı */
  private linuxServiceUser(hostId: string): string | undefined {
    if (hostId === 'local') return undefined;
    const cfg = this.store.getHost(hostId);
    if (!cfg) return undefined;
    return cfg.serviceUser || (cfg.username !== 'root' ? cfg.username : undefined);
  }

  /** Makinede iş/meşgul sunucu varken bağlantıyı yeniden kurma */
  private assertHostIdle(hostId: string) {
    const job = this.runningJobs().find((j) => j.scope.hostId === hostId);
    if (job) throw new UserError(`Bu makinede devam eden bir iş var ("${job.info.title}"). Bitmesini bekle veya iptal et, sonra tekrar dene.`);
    if ((this.hostOps.get(hostId) ?? 0) > 0) throw new UserError('Bu makinede şu an bir işlem yapılıyor. Birkaç saniye sonra tekrar dene.');
    for (const p of this.store.listProfiles().filter((x) => x.hostId === hostId)) {
      if (this.isBusy(p.id)) throw new UserError(`"${p.name}" şu an bir işlem yapıyor (başlatma/durdurma/güncelleme). Bitince tekrar dene.`);
    }
  }

  private async withHostOp<T>(hostId: string, fn: () => Promise<T>): Promise<T> {
    this.hostOps.set(hostId, (this.hostOps.get(hostId) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      const n = (this.hostOps.get(hostId) ?? 1) - 1;
      if (n > 0) this.hostOps.set(hostId, n);
      else this.hostOps.delete(hostId);
    }
  }

  listHosts(): HostConfig[] {
    return this.store.listHosts();
  }

  saveHost(h: HostConfig): HostConfig {
    if (!h.host.trim() || !h.username.trim()) throw new UserError('Adres ve kullanıcı adı gerekli');
    if (h.id) this.assertHostIdle(h.id);
    const cfg: HostConfig = {
      ...h,
      id: h.id || randomUUID(),
      name: h.name.trim() || `${h.username}@${h.host}`,
      port: Number(h.port) || 22,
    };
    const saved = this.store.saveHost(cfg);
    const old = this.ssh.get(saved.id);
    this.ssh.delete(saved.id);
    void old?.close().catch(() => undefined);
    // Bu makinedeki sunucuları yeni bağlantıyla yeniden takip et
    for (const p of this.store.listProfiles().filter((x) => x.hostId === saved.id)) {
      this.managers.get(p.id)?.dispose();
      const m = this.createManager(p);
      void this.attachWithRetry(m, false);
    }
    this.emit({ type: 'hosts-changed' });
    return saved;
  }

  removeHost(id: string) {
    const users = this.store.listProfiles().filter((p) => p.hostId === id);
    if (users.length) throw new UserError(`Bu makineyi kullanan sunucular var: ${users.map((u) => u.name).join(', ')}`);
    this.assertHostIdle(id);
    this.store.removeHost(id);
    void this.ssh.get(id)?.close().catch(() => undefined);
    this.ssh.delete(id);
    this.emit({ type: 'hosts-changed' });
  }

  async testHost(h: HostConfig): Promise<HostTestResult> {
    let host: SshHost;
    try {
      // Kayıtlı parmak izi varsa el sıkışmada doğrulanır: değişmişse şifre gönderilmeden bağlantı kesilir
      host = this.makeSsh({ ...h, id: h.id || 'test' }, { ...(h.password ? { password: h.password } : {}), ...(h.passphrase ? { passphrase: h.passphrase } : {}) }, h.fingerprint || '');
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
      const e = err as Error & { code?: string };
      return { ok: false, error: e.message, ...(host.fingerprint ? { fingerprint: host.fingerprint } : {}), ...(e.code === 'host_key_mismatch' ? { fingerprintChanged: true } : {}) };
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
    // SSH profili hiçbir zaman yerel makineye düşmez: makine kurulamazsa işlemler hata verir, attachWithRetry tekrar dener
    const host: Host = p.hostId === 'local' ? this.local : this.sshHost(p.hostId);
    const cfg = p.hostId === 'local' ? undefined : this.store.getHost(p.hostId);
    const serviceUser = this.linuxServiceUser(p.hostId);
    const m = new ServerManager({
      profile: p,
      host,
      otherProfiles: () => this.store.listProfiles(),
      useSystemd: cfg ? cfg.useSystemd : false,
      // Servis kullanıcısı boşsa ve SSH kullanıcısı root değilse, sunucu o kullanıcıyla çalışsın (root değil)
      ...(serviceUser ? { serviceUser } : {}),
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

  private async managerOp<T>(id: string, fn: (m: ServerManager) => Promise<T>): Promise<T> {
    const m = this.manager(id);
    this.managerOps.set(id, (this.managerOps.get(id) ?? 0) + 1);
    try {
      return await fn(m);
    } finally {
      const n = (this.managerOps.get(id) ?? 1) - 1;
      if (n > 0) this.managerOps.set(id, n);
      else this.managerOps.delete(id);
    }
  }

  async startServer(id: string): Promise<void> {
    this.manager(id);
    this.assertNoJob(id);
    return this.managerOp(id, (m) => m.start());
  }

  async stopServer(id: string): Promise<void> {
    return this.managerOp(id, (m) => m.stop());
  }

  async restartServer(id: string, update: boolean): Promise<void> {
    const p = this.getProfile(id);
    this.manager(id);
    this.assertNoJob(id);
    if (update) this.assertDirNotRunning(p, '', 'Güncellemeli yeniden başlatmadan önce onu da durdur.', id);
    return this.managerOp(id, (m) => m.restart({ update, reason: 'Elle yeniden başlatma' }));
  }

  async deployServer(id: string): Promise<string[]> {
    this.manager(id);
    this.assertNoJob(id);
    return this.managerOp(id, (m) => m.deploy());
  }

  /* ---------------- iş çakışmaları ---------------- */

  private normDir(hostId: string, dir: string): string {
    let d = dir.trim().replace(/[\\/]+$/, '');
    if (this.hostOs(hostId) === 'windows') d = d.replace(/\//g, '\\').toLowerCase();
    return d;
  }

  private sameDir(hostA: string, dirA: string | undefined, hostB: string, dirB: string | undefined): boolean {
    if (hostA !== hostB || !dirA?.trim() || !dirB?.trim()) return false;
    return this.normDir(hostA, dirA) === this.normDir(hostB, dirB);
  }

  private jobFor(p: ServerProfile): Job | undefined {
    return this.runningJobs().find(
      (j) => j.scope.profileId === p.id || (!!j.scope.hostId && this.sameDir(j.scope.hostId, j.scope.serverDir, p.hostId, p.paths.serverDir)),
    );
  }

  /** Bu sunucu (veya aynı sunucu klasörü) için süren bir iş varsa reddet */
  private assertNoJob(profileId: string) {
    const p = this.store.getProfile(profileId);
    const job = p ? this.jobFor(p) : this.runningJobs().find((j) => j.scope.profileId === profileId);
    if (job) throw new UserError(`Bu sunucu için devam eden bir iş var ("${job.info.title}"). Bitmesini bekle veya iptal et.`);
  }

  /** Aynı makinede aynı sunucu klasörünü kullanan çalışan (veya meşgul) bir sunucu varsa reddet */
  private assertDirNotRunning(p: ServerProfile, selfMessage: string, otherSuffix: string, exceptId?: string) {
    for (const o of this.store.listProfiles()) {
      if (o.id === exceptId) continue;
      if (o.id !== p.id && !this.sameDir(o.hostId, o.paths.serverDir, p.hostId, p.paths.serverDir)) continue;
      const m = this.managers.get(o.id);
      if (!isActive(m) && !this.isBusy(o.id, m)) continue;
      throw new UserError(o.id === p.id ? selfMessage : `"${o.name}" aynı sunucu klasörünü kullanıyor ve çalışıyor. ${otherSuffix}`);
    }
  }

  /** Boş olmayan, mutlak sunucu klasörü */
  private requireServerDir(p: ServerProfile): string {
    const dir = p.paths.serverDir.trim();
    if (!dir) throw new UserError('Önce sunucu klasörünü seç');
    if (!pathLib(this.hostOs(p.hostId)).isAbsolute(dir)) throw new UserError(`Sunucu klasörü tam (mutlak) bir yol olmalı: ${dir}`);
    return dir;
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

  /**
   * Profili kaydet. Profilden çıkarılan Workshop modlarının @klasör bağlantısı ve anahtarları,
   * aynı klasörü kullanan başka profil onlara ihtiyaç duymuyorsa ve sunucu çalışmıyorsa sunucudan kaldırılır.
   * `cleanup: false`: iç kayıtlar (Workshop senkronu yolları güncellerken) temizlik yapmaz.
   */
  async saveProfile(raw: unknown, opts: { cleanup?: boolean } = {}): Promise<SaveResult> {
    const v = this.validate(raw);
    if (!v.profile) return v;
    const p = v.profile;
    const existing = this.store.getProfile(p.id);
    const m = this.managers.get(p.id);
    const running = isActive(m);
    if (existing && existing.hostId !== p.hostId && running) {
      throw new UserError('Sunucu çalışırken makinesi değiştirilemez. Önce durdur.');
    }
    if (existing && existing.hostId !== p.hostId && this.isBusy(p.id, m)) {
      throw new UserError('Sunucu şu an bir işlem yapıyor; makinesi değiştirilemez. Bitince tekrar dene.');
    }
    const saved = this.store.saveProfile(p);
    if (!m || existing?.hostId !== p.hostId) {
      m?.dispose();
      const nm = this.createManager(saved);
      void this.attachWithRetry(nm, false);
    } else {
      m.updateProfile(saved);
    }
    this.emit({ type: 'profiles-changed' });
    if (existing && opts.cleanup !== false) {
      try {
        await this.cleanupRemovedWorkshopMods(existing, saved);
      } catch (err) {
        const msg = (err as Error).message;
        this.notice(saved.id, 'error', `Kaldırılan Workshop modları temizlenemedi: ${msg}`, `Could not clean up removed Workshop mods: ${msg}`);
      }
    }
    return { profile: saved, errors: [], issues: v.issues };
  }

  private notice(profileId: string, level: 'info' | 'warning' | 'error', tr: string, en: string) {
    this.emit({ type: 'notice', profileId, notice: { level, message: { tr, en } } });
  }

  /** Profilden çıkarılan Workshop modlarının bağlantılarını ve anahtarlarını kaldır (güvenliyse). */
  private async cleanupRemovedWorkshopMods(oldP: ServerProfile, newP: ServerProfile): Promise<void> {
    // Makine veya klasör değiştiyse eski klasöre dokunma (kullanıcı taşımış olabilir)
    if (oldP.hostId !== newP.hostId || !this.sameDir(oldP.hostId, oldP.paths.serverDir, newP.hostId, newP.paths.serverDir)) return;
    const serverDir = newP.paths.serverDir.trim();
    if (!pathLib(this.hostOs(newP.hostId)).isAbsolute(serverDir)) return;
    const key = (f: string) => f.toLowerCase();
    const modsOf = (p: ServerProfile) => [...p.launch.mods, ...p.launch.serverMods];
    const stillUsed = new Set(modsOf(newP).map((m) => key(m.path)));
    const candidates = new Map<string, { folder: string; id: string }>();
    for (const m of modsOf(oldP)) {
      if (m.source !== 'workshop' || !m.workshopId || !MOD_FOLDER_RE.test(m.path)) continue;
      if (!stillUsed.has(key(m.path))) candidates.set(key(m.path), { folder: m.path, id: m.workshopId });
    }
    if (!candidates.size) return;

    const others = this.store.listProfiles().filter((o) => o.id !== newP.id && this.sameDir(o.hostId, o.paths.serverDir, newP.hostId, serverDir));
    const kept: string[] = [];
    for (const [k, c] of [...candidates]) {
      const user = others.find((o) => modsOf(o).some((m) => key(m.path) === k || (!!m.workshopId && m.workshopId === c.id)));
      if (user) {
        kept.push(`${c.folder} ("${user.name}")`);
        candidates.delete(k);
      }
    }
    if (kept.length) {
      this.notice(newP.id, 'info', `Kaldırılan modlar aynı klasörü kullanan başka sunucularda kayıtlı olduğu için diskte bırakıldı: ${kept.join(', ')}`, `Removed mods are still used by other servers sharing this folder and were kept: ${kept.join(', ')}`);
    }
    if (!candidates.size) return;
    const list = [...candidates.values()].map((c) => c.folder).join(', ');

    const running = [newP, ...others].find((o) => {
      const m = this.managers.get(o.id);
      return isActive(m) || this.isBusy(o.id, m);
    });
    if (running) {
      this.notice(
        newP.id,
        'warning',
        `"${running.name}" çalıştığı için kaldırılan Workshop modlarının bağlantısı ve anahtarları silinmedi: ${list}. Gerekirse sunucu durunca sunucu klasöründen elle silebilirsin.`,
        `"${running.name}" is running, so links and keys of the removed Workshop mods were kept: ${list}. You can delete them from the server folder manually once it is stopped.`,
      );
      return;
    }
    const job = this.jobFor(newP) ?? others.map((o) => this.jobFor(o)).find(Boolean);
    if (job) {
      this.notice(newP.id, 'warning', `Devam eden iş ("${job.info.title}") nedeniyle kaldırılan Workshop modları sunucudan silinmedi: ${list}.`, `Removed Workshop mods were not deleted from the server because a job is running ("${job.info.title}"): ${list}.`);
      return;
    }

    await this.withHostOp(newP.hostId, async () => {
      const host = this.getHost(newP.hostId);
      try {
        await host.connect();
      } catch (err) {
        const msg = (err as Error).message;
        this.notice(newP.id, 'error', `Kaldırılan Workshop modları sunucudan silinemedi (makineye bağlanılamadı): ${list}. ${msg}`, `Could not remove the deleted Workshop mods from the server (host unreachable): ${list}. ${msg}`);
        return;
      }
      const removed: string[] = [];
      const failed: string[] = [];
      for (const c of candidates.values()) {
        // Linux'ta bağlantılar küçük harfle oluşturulur
        const folder = host.os === 'linux' ? c.folder.toLowerCase() : c.folder;
        try {
          await uninstallWorkshopMod(host, serverDir, folder);
          removed.push(folder);
        } catch (err) {
          failed.push(`${folder}: ${(err as Error).message}`);
        }
      }
      if (removed.length) {
        this.notice(newP.id, 'info', `Kaldırılan Workshop modlarının bağlantısı ve anahtarları sunucudan silindi: ${removed.join(', ')}`, `Removed Workshop mods were unlinked and their keys deleted: ${removed.join(', ')}`);
      }
      if (failed.length) {
        this.notice(newP.id, 'error', `Bazı Workshop modları sunucudan kaldırılamadı: ${failed.join('; ')}`, `Some Workshop mods could not be removed from the server: ${failed.join('; ')}`);
      }
    });
  }

  async removeProfile(id: string) {
    const m = this.managers.get(id);
    if (m && !['stopped', 'crashed'].includes(m.getStatus().status)) throw new UserError('Çalışan sunucu silinemez. Önce durdur.');
    this.assertNoJob(id);
    if (this.isBusy(id, m)) throw new UserError('Sunucu şu an bir işlem yapıyor. Bitince tekrar dene.');
    if (m?.mode === 'systemd' && m.host.systemd) {
      try {
        await m.host.connect();
        for (const unit of [m.unitName, ...Array.from({ length: 16 }, (_, i) => m.hcUnitName(i + 1))]) {
          if (await m.host.exists(m.host.systemd.unitPath(unit))) await m.host.systemd.removeUnit(unit);
        }
        await m.host.systemd.daemonReload();
      } catch (err) {
        /* makineye ulaşılamıyorsa sadece profili sil */
        const msg = (err as Error).message;
        this.notice(id, 'warning', `systemd servisleri kaldırılamadı (makineye ulaşılamadı): ${msg}`, `Could not remove systemd units (host unreachable): ${msg}`);
      }
    }
    this.store.removeProfile(id);
    m?.dispose();
    this.managers.delete(id);
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
          ...(cfg.serviceUser ? { user: cfg.serviceUser } : cfg.username !== 'root' ? { user: cfg.username } : {}),
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
    // Paylaşılan bir profil başka bir programı çalıştıramasın: çalıştırılabilir dosya ve ek parametreler sıfırlanır
    return this.createProfile({
      ...res.data,
      id: randomUUID(),
      hostId: hostOk ? res.data.hostId : 'local',
      paths: { ...res.data.paths, profilesDir: '', executable: '' },
      launch: { ...res.data.launch, extraArgs: '', malloc: '' },
      headless: { ...res.data.headless, extraArgs: '' },
    });
  }

  /* ---------------- görev / mod ---------------- */

  async scanMissions(id: string) {
    const p = this.getProfile(id);
    const serverDir = this.requireServerDir(p);
    const host = this.getHost(p.hostId);
    await host.connect();
    return scanMissions(host, serverDir);
  }

  async uploadMission(id: string, localPath: string) {
    const p = this.getProfile(id);
    const serverDir = this.requireServerDir(p);
    const host = this.getHost(p.hostId);
    await host.connect();
    return uploadMission(host, serverDir, localPath);
  }

  async scanMods(id: string) {
    const p = this.getProfile(id);
    const serverDir = this.requireServerDir(p);
    const host = this.getHost(p.hostId);
    await host.connect();
    return scanMods(host, serverDir);
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
      // Etkileşimli işler 3 saat, zamanlı (gözetimsiz) güncellemeler 45 dk ile sınırlı
      timeoutMs: job ? 3 * 3600_000 : 45 * 60_000,
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

  private steamLockKey(host: Host, steamcmdPath: string): string {
    const p = host.os === 'windows' ? steamcmdPath.trim().replace(/\//g, '\\').toLowerCase() : steamcmdPath.trim();
    return `${host.id}|${p}`;
  }

  /**
   * Aynı makinede aynı SteamCMD ile tek seferde bir çalıştırma (SteamCMD kendi dosyalarını kilitler,
   * iki kopya birbirinin oturumunu/güncellemesini bozar). Sıradaki iş bekler; beklerken iptal edilebilir.
   */
  private async withSteamLock<T>(key: string, signal: AbortSignal | undefined, log: (l: string) => void, fn: () => Promise<T>): Promise<T> {
    const prev = this.steamLocks.get(key);
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const tail = (prev ?? Promise.resolve()).then(() => mine);
    this.steamLocks.set(key, tail);
    try {
      if (prev) {
        log('Aynı makinede başka bir SteamCMD işi sürüyor; bitmesi bekleniyor...');
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => reject(new SteamCmdError('İptal edildi', 'aborted'));
          if (signal?.aborted) return onAbort();
          signal?.addEventListener('abort', onAbort, { once: true });
          void prev.then(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
          });
        });
        log('Sıra geldi, SteamCMD başlatılıyor.');
      }
      return await fn();
    } finally {
      release();
      if (this.steamLocks.get(key) === tail) this.steamLocks.delete(key);
    }
  }

  private startJob(title: string, scope: JobScope, fn: (job: Job) => Promise<void>): string {
    const job = new Job(title, scope, this.emit);
    this.jobs.set(job.info.id, job);
    job.done = (async () => {
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
    this.manager(profileId);
    const serverDir = this.requireServerDir(p);
    this.assertNoJob(profileId);
    this.assertDirNotRunning(p, 'Güncellemeden önce sunucuyu durdur (çalışan dosyalar güncellenemez).', 'Güncellemeden önce onu da durdur.');
    return this.startJob(`Sunucu güncelleme: ${p.name}`, { profileId, hostId: p.hostId, serverDir }, async (job) => {
      const ctx = this.steamCtx(p.hostId, job);
      await ctx.host.connect();
      await this.withSteamLock(this.steamLockKey(ctx.host, ctx.steamcmdPath), job.abort.signal, (l) => job.line(l), () =>
        updateServer(ctx, { installDir: serverDir, appId: p.steam.appId, branch: p.steam.branch, branchPassword: p.steam.branchPassword, validate: p.steam.validate }),
      );
      job.line('Sunucu güncel.');
      if (ctx.host.os === 'linux') {
        const r = await ensureLinuxSteamClient(ctx.host, ctx.steamcmdPath, this.linuxServiceUser(p.hostId));
        if (r === 'copied') job.line('steamclient.so ~/.steam/sdk64 klasörüne kopyalandı.');
        if (r === 'missing') job.line('Uyarı: SteamCMD klasöründe steamclient.so bulunamadı (linux64/steamclient.so).');
      }
    });
  }

  syncWorkshopJob(profileId: string, onlyIds?: string[]): string {
    const p = this.getProfile(profileId);
    this.manager(profileId);
    const serverDir = this.requireServerDir(p);
    this.assertNoJob(profileId);
    this.assertDirNotRunning(
      p,
      'Modları güncellemeden önce sunucuyu durdur (çalışırken dosyalar kilitli olur, oyuncular imza hatası alır).',
      'Modları güncellemeden önce onu da durdur.',
    );
    return this.startJob(`Workshop modları: ${p.name}`, { profileId, hostId: p.hostId, serverDir }, async (job) => {
      await this.syncWorkshop(p, this.steamCtx(p.hostId, job), (l) => job.line(l), onlyIds);
    });
  }

  /**
   * @klasör adı seç: hedefte gerçek (bağlantı olmayan) bir klasör ya da başka bir şeyi gösteren bağlantı varsa
   * boş bir ad bul (@ad-2, @ad-3...); aynı Workshop öğesini gösteren bağlantı bizimdir, aynısı kullanılır.
   */
  private async pickModFolder(host: Host, serverDir: string, id: string, wanted: string): Promise<string> {
    if (!MOD_FOLDER_RE.test(wanted)) return wanted;
    const L = pathLib(host.os);
    const base = host.os === 'linux' ? wanted.toLowerCase() : wanted;
    for (let i = 1; i <= 50; i++) {
      const name = i === 1 ? wanted : `${base}-${i}`;
      const full = L.join(serverDir, host.os === 'linux' ? name.toLowerCase() : name);
      const link = await host.readLink(full);
      if (link !== null) {
        const last = link.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
        if (last === id) return name;
        continue;
      }
      if (!(await host.exists(full))) return name;
    }
    throw new Error(`${wanted} için boş bir klasör adı bulunamadı`);
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
    let res: WorkshopDownloadResult;
    let thrown: unknown = null;
    try {
      res = await this.withSteamLock(this.steamLockKey(host, ctx.steamcmdPath), ctx.signal, log, () => downloadWorkshopItems(ctx, { workshopDir: rp.workshopDir, ids }));
    } catch (err) {
      // Giriş hatası / iptal: o ana kadar inenler yine de bağlansın, sonra hata bildirilsin
      if (err instanceof SteamCmdError && err.partial) {
        res = err.partial;
        thrown = err;
        if (res.ok.length) log(`İndirme yarıda kaldı (${err.message}); inen ${res.ok.length} mod yine de bağlanıyor...`);
      } else {
        throw err;
      }
    }
    const fresh = this.getProfile(p.id);
    let changed = false;
    const linkErrors: string[] = [];
    for (const id of res.ok) {
      const name = titles.get(id) ?? id;
      for (const list of [fresh.launch.mods, fresh.launch.serverMods]) {
        for (const mod of list.filter((m) => m.workshopId === id)) {
          try {
            const folder = await this.pickModFolder(host, rp.serverDir, id, mod.path);
            if (folder !== mod.path) log(`"${mod.path}" sunucu klasöründe zaten var ve bu modun bağlantısı değil; "${folder}" kullanılıyor.`);
            const r = await installWorkshopMod(host, { serverDir: rp.serverDir, workshopDir: rp.workshopDir, id, folder });
            log(`✓ ${name} -> ${r.folder}${r.keys.length ? ` (anahtar: ${r.keys.join(', ')})` : ''}`);
            if (mod.path !== r.folder) {
              mod.path = r.folder;
              changed = true;
            }
            const title = titles.get(id);
            if (title && mod.displayName !== title) {
              mod.displayName = title;
              changed = true;
            }
          } catch (err) {
            const msg = (err as Error).message;
            linkErrors.push(`${name}: ${msg}`);
            log(`✗ ${name}: sunucuya bağlanamadı: ${msg}`);
          }
        }
      }
    }
    for (const f of res.failed) log(`✗ ${titles.get(f.id) ?? f.id}: ${f.message}`);
    if (res.stoppedBy) log(`İndirme durduruldu: ${res.stoppedBy.message}`);
    // Başarılı olan yol/ad değişiklikleri her durumda kaydedilsin
    if (changed) {
      try {
        const r = await this.saveProfile(fresh, { cleanup: false });
        if (r.errors.length) log(`Profil güncellenemedi: ${r.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
      } catch (err) {
        log(`Profil güncellenemedi: ${(err as Error).message}`);
        if (!thrown) thrown = err;
      }
    }
    if (thrown) throw thrown;
    const problems = res.failed.length + linkErrors.length;
    if (problems) {
      const parts = [res.failed.length ? `${res.failed.length} mod indirilemedi` : '', linkErrors.length ? `${linkErrors.length} mod bağlanamadı` : ''].filter(Boolean);
      throw new UserError(parts.join(', '));
    }
  }

  /** Zamanlı restart sırasında: etkileşimsiz güncelleme */
  private async runScheduledUpdate(p: ServerProfile, log: (l: string) => void) {
    const serverDir = this.requireServerDir(p);
    const job = this.jobFor(p);
    if (job) throw new UserError(`Devam eden bir iş var ("${job.info.title}"); güncelleme atlandı.`);
    this.assertDirNotRunning(p, '', 'Güncelleme atlandı.', p.id);
    const ctx = { ...this.steamCtx(p.hostId, null), onLine: log };
    await ctx.host.connect();
    log('SteamCMD: sunucu güncelleniyor');
    await this.withSteamLock(this.steamLockKey(ctx.host, ctx.steamcmdPath), undefined, log, () =>
      updateServer(ctx, { installDir: serverDir, appId: p.steam.appId, branch: p.steam.branch, branchPassword: p.steam.branchPassword, validate: false }),
    );
    await this.syncWorkshop(p, ctx, log);
  }

  installSteamCmdJob(hostId: string, rawDir: string): string {
    const dir = rawDir.trim();
    if (!dir) throw new UserError('SteamCMD için bir klasör seç');
    if (!pathLib(this.hostOs(hostId)).isAbsolute(dir)) throw new UserError(`SteamCMD klasörü tam (mutlak) bir yol olmalı: ${dir}`);
    this.getHost(hostId);
    return this.startJob('SteamCMD kurulumu', { hostId }, async (job) => {
      const host = this.getHost(hostId);
      await host.connect();
      const target = pathLib(host.os).join(dir, host.os === 'windows' ? 'steamcmd.exe' : 'steamcmd.sh');
      await this.withSteamLock(this.steamLockKey(host, target), job.abort.signal, (l) => job.line(l), async () => {
        job.line(`${dir} klasörüne kuruluyor...`);
        const path = await installSteamCmd(host, dir);
        job.line(`Kuruldu: ${path}`);
        if (hostId === 'local') {
          // settings-changed olayı Store üzerinden gönderilir
          this.store.saveSettings({ localSteamcmdPath: path });
        } else {
          const cfg = this.store.getHost(hostId);
          if (cfg) this.store.saveHost({ ...cfg, steamcmdPath: path });
          this.emit({ type: 'hosts-changed' });
        }
        job.line('İlk çalıştırma (SteamCMD kendini güncelliyor)...');
        await firstRunSteamCmd(host, path, { signal: job.abort.signal, onLine: (l) => job.line(l) });
        job.line('SteamCMD hazır.');
      });
    });
  }

  async fixSteamClient(profileId: string): Promise<string> {
    const p = this.getProfile(profileId);
    const ctx = this.steamCtx(p.hostId, null);
    await ctx.host.connect();
    return ensureLinuxSteamClient(ctx.host, ctx.steamcmdPath, this.linuxServiceUser(p.hostId));
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
