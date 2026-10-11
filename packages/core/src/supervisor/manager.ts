import { EventEmitter } from 'node:events';
import { generateArma3Profile, generateBasicCfg, generateBeServerCfg, generateServerCfg } from '../config/generators.js';
import { type Host, type TailHandle, processMatches } from '../host/types.js';
import { generateSystemdUnit } from '../host/systemd.js';
import { buildHeadlessLaunch, buildServerLaunch } from '../launch/commandLine.js';
import { type ResolvedPaths, pathLib, resolvePaths } from '../launch/paths.js';
import { type ServerProfile, effectiveRconPort } from '../model/profile.js';
import type { Notifier, NotifyEvent } from '../notify/discord.js';
import { BattlEyeRcon, type RconPlayer, type RconState } from '../rcon/battleye.js';
import { type Issue, hasBlockingIssues, validateProfile } from '../validate.js';
import { dueWarning, formatWarning, nextOccurrence } from './scheduler.js';

export type ServerStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'restarting' | 'crashed' | 'updating';
export type ManagerMode = 'direct' | 'systemd';

export interface StatusInfo {
  status: ServerStatus;
  mode: ManagerMode;
  pid?: number;
  startedAt?: number;
  /** Bu oturumdaki otomatik restart sayısı */
  autoRestarts: number;
  headless: { index: number; alive: boolean }[];
  nextScheduledRestart?: number;
  rcon: RconState;
  players: number;
  lastError?: string;
}

export interface LogLine {
  t: number;
  source: string;
  line: string;
}

export interface Notice {
  level: 'info' | 'warning' | 'error';
  message: { tr: string; en: string };
}

export interface ManagerEvents {
  status: [StatusInfo];
  log: [LogLine[]];
  rconMessage: [string];
  players: [RconPlayer[]];
  notice: [Notice];
}

export interface ManagerOptions {
  profile: ServerProfile;
  host: Host;
  /** Aynı makinedeki diğer profiller (port çakışması kontrolü) */
  otherProfiles?: () => ServerProfile[];
  /** SSH ile bağlanılan Linux'ta systemd kullan (varsayılan: true) */
  useSystemd?: boolean;
  /** systemd servisinin çalışacağı kullanıcı (boşsa SSH kullanıcısı / root) */
  serviceUser?: string;
  /** RCON'a bağlanılacak adres (profilde yoksa). SSH host'larında sunucu adresi. */
  defaultRconHost?: string;
  notifier?: Notifier | null;
  /** Zamanlı restartta SteamCMD güncellemesi */
  updater?: (profile: ServerProfile, log: (line: string) => void) => Promise<void>;
  timers?: Partial<{
    monitorMs: number;
    schedulerMs: number;
    runningAfterMs: number;
    rconDelayMs: number;
    playersMs: number;
    stopTimeoutMs: number;
    rptWaitMs: number;
  }>;
}

interface DirectState {
  pid: number;
  startedAt: number;
  executable: string;
  headless: { index: number; pid: number }[];
}

export class ValidationFailedError extends Error {
  constructor(readonly issues: Issue[]) {
    super('Profilde başlatmayı engelleyen hatalar var: ' + issues.filter((i) => i.severity === 'error').map((i) => i.message.tr).join(' | '));
    this.name = 'ValidationFailedError';
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const MAX_LOG = 3000;

export class ServerManager extends EventEmitter<ManagerEvents> {
  private profile: ServerProfile;
  readonly host: Host;
  readonly mode: ManagerMode;
  private readonly t: Required<NonNullable<ManagerOptions['timers']>>;
  private status: ServerStatus = 'stopped';
  private direct: DirectState | null = null;
  private startedAt = 0;
  private systemdRestarts = -1;
  private autoRestarts = 0;
  private restartHistory: number[] = [];
  private hcAlive = new Map<number, boolean>();
  private hcTimers: NodeJS.Timeout[] = [];
  private monitorTimer: NodeJS.Timeout | null = null;
  private schedulerTimer: NodeJS.Timeout | null = null;
  private runningTimer: NodeJS.Timeout | null = null;
  private rconTimer: NodeJS.Timeout | null = null;
  private playersTimer: NodeJS.Timeout | null = null;
  private tails: TailHandle[] = [];
  private logBuffer: LogLine[] = [];
  private busy: Promise<void> | null = null;
  private monitoring = false;
  private lastError: string | undefined;
  private scheduledFor: number | null = null;
  private warningsSent = new Set<number>();
  private playerCount = 0;
  rcon: BattlEyeRcon | null = null;
  private disposed = false;

  constructor(private readonly opts: ManagerOptions) {
    super();
    this.profile = opts.profile;
    this.host = opts.host;
    this.mode = opts.host.kind === 'ssh' && opts.host.systemd && opts.useSystemd !== false ? 'systemd' : 'direct';
    this.t = {
      monitorMs: 3000,
      schedulerMs: 15000,
      runningAfterMs: 8000,
      rconDelayMs: 20000,
      playersMs: 15000,
      stopTimeoutMs: 15000,
      rptWaitMs: 120000,
      ...opts.timers,
    };
    this.schedulerTimer = setInterval(() => void this.schedulerTick(), this.t.schedulerMs);
  }

  /* ---------------- durum ---------------- */

  get paths(): ResolvedPaths {
    return resolvePaths(this.profile, this.host.os);
  }

  get unitName(): string {
    return `oezi-arma-${this.profile.id.replace(/[^A-Za-z0-9]/g, '').slice(0, 8)}.service`;
  }

  hcUnitName(i: number): string {
    return this.unitName.replace(/\.service$/, `-hc${i}.service`);
  }

  getProfile(): ServerProfile {
    return this.profile;
  }

  /** Yeni ayarlar bir sonraki başlatmada uygulanır; zamanlayıcı hemen güncellenir. */
  updateProfile(p: ServerProfile) {
    const rconChanged =
      p.rcon.password !== this.profile.rcon.password || effectiveRconPort(p) !== effectiveRconPort(this.profile) || p.rcon.connectHost !== this.profile.rcon.connectHost;
    this.profile = p;
    this.scheduledFor = null;
    this.warningsSent.clear();
    if (rconChanged && this.rcon) {
      this.stopRcon();
      if (this.status === 'running') this.startRcon(0);
    }
    this.emitStatus();
  }

  getStatus(): StatusInfo {
    const pid = this.direct?.pid;
    return {
      status: this.status,
      mode: this.mode,
      ...(pid ? { pid } : {}),
      ...(this.startedAt ? { startedAt: this.startedAt } : {}),
      autoRestarts: this.autoRestarts,
      headless: Array.from({ length: this.profile.headless.count }, (_, i) => ({ index: i + 1, alive: this.hcAlive.get(i + 1) ?? false })),
      ...(this.scheduledFor ? { nextScheduledRestart: this.scheduledFor } : {}),
      rcon: this.rcon?.state ?? 'disconnected',
      players: this.playerCount,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  getLogBuffer(): LogLine[] {
    return this.logBuffer.slice();
  }

  private setStatus(s: ServerStatus) {
    if (this.status === s) return;
    this.status = s;
    this.emitStatus();
  }

  private emitStatus() {
    this.emit('status', this.getStatus());
  }

  private appLog(line: string) {
    this.pushLog('app', [line]);
  }

  private pushLog(source: string, lines: string[]) {
    const t = Date.now();
    const items = lines.map((line) => ({ t, source, line }));
    this.logBuffer.push(...items);
    if (this.logBuffer.length > MAX_LOG) this.logBuffer.splice(0, this.logBuffer.length - MAX_LOG);
    this.emit('log', items);
  }

  private notice(level: Notice['level'], tr: string, en: string) {
    this.emit('notice', { level, message: { tr, en } });
    this.appLog(`[${level}] ${tr}`);
  }

  private async notify(event: NotifyEvent, title: string, description = '') {
    const n = this.opts.notifier;
    const prefs = this.profile.notifications;
    const allowed =
      (event === 'start' && prefs.onStart) ||
      (event === 'stop' && prefs.onStop) ||
      ((event === 'crash' || event === 'restart') && prefs.onCrash) ||
      (event === 'update' && prefs.onUpdate) ||
      event === 'info';
    if (!n || !allowed) return;
    try {
      await n.notify(event, title, description);
    } catch (err) {
      this.appLog(`Discord bildirimi gönderilemedi: ${(err as Error).message}`);
    }
  }

  /** Aynı anda tek işlem (başlat/durdur/restart) */
  private exclusive(fn: () => Promise<void>): Promise<void> {
    if (this.busy) return Promise.reject(new Error('Sunucu şu an başka bir işlem yapıyor, lütfen bekle'));
    const p = fn().finally(() => {
      this.busy = null;
    });
    this.busy = p;
    return p;
  }

  /* ---------------- dağıtım ---------------- */

  validate(): Issue[] {
    return validateProfile(this.profile, this.host.os, this.opts.otherProfiles?.() ?? []);
  }

  /** Config dosyalarını (ve gerekirse systemd servislerini) sunucuya yazar. */
  async deploy(): Promise<string[]> {
    await this.host.connect();
    const p = this.profile;
    const rp = this.paths;
    const L = pathLib(this.host.os);
    const written: string[] = [];
    const write = async (file: string, content: string) => {
      await this.host.writeFile(file, content);
      written.push(file);
    };
    await write(rp.serverCfg, generateServerCfg(p));
    await write(rp.basicCfg, generateBasicCfg(p));
    const profileText = generateArma3Profile(p);
    for (const file of rp.arma3Profiles) await write(file, profileText);
    if (p.security.battlEye) {
      await this.host.mkdirp(rp.beDir);
      // BattlEye başlarken cfg'yi *_active_*.cfg olarak yeniden adlandırır; eskileri temizle.
      for (const e of await this.host.list(rp.beDir).catch(() => [])) {
        if (/^beserver(_x64)?_active_.*\.cfg$/i.test(e.name)) await this.host.remove(L.join(rp.beDir, e.name)).catch(() => undefined);
      }
      await write(rp.beCfg, generateBeServerCfg(p));
    }
    for (let i = 1; i <= p.headless.count; i++) await this.host.mkdirp(rp.headlessProfilesDir(i));

    if (this.mode === 'systemd') {
      const sd = this.host.systemd!;
      const server = buildServerLaunch(p, this.host.os, rp);
      const common = {
        workingDirectory: rp.serverDir,
        ...(this.opts.serviceUser ? { user: this.opts.serviceUser } : {}),
        restartSec: p.supervisor.restartDelaySec,
        startLimitBurst: p.supervisor.maxRestartsPerHour,
        stopTimeoutSec: Math.max(30, p.supervisor.gracefulShutdownSec + 10),
      };
      await sd.writeUnit(
        this.unitName,
        generateSystemdUnit({
          ...common,
          description: `Arma 3 - ${p.name} (OeziDev)`,
          executable: server.executable,
          args: server.args,
          logFile: rp.stdoutLog,
          restart: p.supervisor.autoRestart ? 'on-failure' : 'no',
        }),
      );
      written.push(sd.unitPath(this.unitName));
      for (let i = 1; i <= 16; i++) {
        const name = this.hcUnitName(i);
        if (i <= p.headless.count) {
          const hc = buildHeadlessLaunch(p, this.host.os, i, rp);
          await sd.writeUnit(
            name,
            generateSystemdUnit({
              ...common,
              description: `Arma 3 - ${p.name} headless ${i} (OeziDev)`,
              executable: hc.executable,
              args: hc.args,
              logFile: rp.headlessStdoutLog(i),
              restart: 'always',
              partOf: this.unitName,
              startDelaySec: p.headless.startDelaySec,
            }),
          );
          written.push(sd.unitPath(name));
        } else if (await this.host.exists(sd.unitPath(name))) {
          await sd.action('stop', name).catch(() => undefined);
          await sd.removeUnit(name);
        }
      }
      await sd.daemonReload();
    }
    this.appLog(`Config dosyaları yazıldı (${written.length} dosya)`);
    return written;
  }

  /* ---------------- başlat / durdur ---------------- */

  start(): Promise<void> {
    return this.exclusive(() => this.doStart());
  }

  stop(): Promise<void> {
    return this.exclusive(() => this.doStop('manual'));
  }

  restart(opts: { update?: boolean; reason?: string } = {}): Promise<void> {
    return this.exclusive(async () => {
      this.setStatus('restarting');
      await this.doStop(opts.reason ?? 'restart', true);
      if (opts.update && this.opts.updater) {
        this.setStatus('updating');
        try {
          await this.opts.updater(this.profile, (l) => this.appLog(l));
          await this.notify('update', 'Güncellendi', 'Sunucu ve modlar güncellendi.');
        } catch (err) {
          this.notice('error', `Güncelleme başarısız: ${(err as Error).message}`, `Update failed: ${(err as Error).message}`);
        }
      }
      await this.doStart(true);
      await this.notify('restart', 'Yeniden başlatıldı', opts.reason ?? '');
    });
  }

  private async doStart(silent = false): Promise<void> {
    if (this.status === 'running' || this.status === 'starting') return;
    this.lastError = undefined;
    const issues = this.validate();
    if (hasBlockingIssues(issues)) {
      this.lastError = 'validation';
      this.setStatus('stopped');
      throw new ValidationFailedError(issues);
    }
    this.setStatus('starting');
    try {
      await this.rotateLogs();
      await this.deploy();
      const rp = this.paths;
      if (this.mode === 'systemd') {
        const sd = this.host.systemd!;
        await sd.action('reset-failed', this.unitName).catch(() => undefined);
        const hcUnits = Array.from({ length: this.profile.headless.count }, (_, i) => this.hcUnitName(i + 1));
        await sd.action('start', this.unitName);
        if (hcUnits.length) await sd.action('start', ...hcUnits);
        const st = await sd.status(this.unitName);
        this.systemdRestarts = st.restarts;
        this.startedAt = st.startedAt || Date.now();
      } else {
        const spec = buildServerLaunch(this.profile, this.host.os, rp);
        spec.warnings.forEach((w) => this.appLog(w));
        this.appLog(`Başlatılıyor: ${spec.executable} ${spec.args.map((a) => (/^-password=/i.test(a) ? '-password=***' : a)).join(' ')}`);
        const pid = await this.host.startDetached(spec.executable, spec.args, {
          cwd: spec.cwd,
          logFile: rp.stdoutLog,
          showWindow: this.profile.launch.showConsoleWindow,
        });
        this.startedAt = Date.now();
        this.direct = { pid, startedAt: this.startedAt, executable: spec.executable, headless: [] };
        await this.saveState();
        this.scheduleHeadless();
      }
      this.startTails(false);
      this.startMonitor();
      this.runningTimer = setTimeout(() => {
        if (this.status === 'starting') this.setStatus('running');
      }, this.t.runningAfterMs);
      this.startRcon(this.t.rconDelayMs);
      if (!silent) await this.notify('start', 'Sunucu başlatıldı');
    } catch (err) {
      this.lastError = (err as Error).message;
      this.setStatus('stopped');
      this.notice('error', `Sunucu başlatılamadı: ${(err as Error).message}`, `Server failed to start: ${(err as Error).message}`);
      throw err;
    }
  }

  private async rotateLogs() {
    const rp = this.paths;
    const files = [rp.stdoutLog, ...Array.from({ length: this.profile.headless.count }, (_, i) => rp.headlessStdoutLog(i + 1))];
    for (const f of files) {
      const st = await this.host.stat(f).catch(() => null);
      if (st && st.size > 0) await this.host.rename(f, `${f}.1`).catch(() => undefined);
    }
  }

  private scheduleHeadless() {
    const p = this.profile;
    if (this.mode !== 'direct' || p.headless.count <= 0) return;
    const t = setTimeout(() => {
      for (let i = 1; i <= p.headless.count; i++) void this.startHeadless(i);
    }, p.headless.startDelaySec * 1000);
    this.hcTimers.push(t);
  }

  private async startHeadless(index: number) {
    if (!this.direct || (this.status !== 'running' && this.status !== 'starting')) return;
    const rp = this.paths;
    const spec = buildHeadlessLaunch(this.profile, this.host.os, index, rp);
    try {
      const pid = await this.host.startDetached(spec.executable, spec.args, {
        cwd: spec.cwd,
        logFile: rp.headlessStdoutLog(index),
        showWindow: false,
      });
      this.direct.headless = this.direct.headless.filter((h) => h.index !== index).concat({ index, pid });
      this.hcAlive.set(index, true);
      await this.saveState();
      this.appLog(`Headless client ${index} başlatıldı (PID ${pid})`);
      this.emitStatus();
    } catch (err) {
      this.notice('warning', `Headless client ${index} başlatılamadı: ${(err as Error).message}`, `Headless client ${index} failed to start: ${(err as Error).message}`);
    }
  }

  private async doStop(reason: string, partOfRestart = false): Promise<void> {
    if (this.status === 'stopped' && !this.direct) return;
    this.setStatus(partOfRestart ? 'restarting' : 'stopping');
    this.stopMonitor();
    this.hcTimers.forEach(clearTimeout);
    this.hcTimers = [];
    if (this.runningTimer) clearTimeout(this.runningTimer);

    // 1) Nazik kapatma: RCON #shutdown
    const graceMs = this.profile.supervisor.gracefulShutdownSec * 1000;
    if (graceMs > 0 && this.rcon?.state === 'connected') {
      try {
        await this.rcon.shutdown();
        this.appLog('RCON ile #shutdown gönderildi');
        await this.waitUntilStopped(graceMs);
      } catch {
        /* RCON cevap vermedi: zorla kapatmaya geç */
      }
    }
    this.stopRcon();

    // 2) Süreci durdur
    if (this.mode === 'systemd') {
      const sd = this.host.systemd!;
      const units = [this.unitName, ...Array.from({ length: this.profile.headless.count }, (_, i) => this.hcUnitName(i + 1))];
      await sd.action('stop', ...units).catch((err) => this.appLog(`systemctl stop: ${(err as Error).message}`));
    } else if (this.direct) {
      for (const hc of this.direct.headless) await this.killAndWait(hc.pid);
      await this.killAndWait(this.direct.pid);
      this.direct = null;
      await this.host.remove(this.paths.stateFile).catch(() => undefined);
    }
    this.hcAlive.clear();
    this.stopTails();
    this.startedAt = 0;
    this.playerCount = 0;
    if (!partOfRestart) {
      this.setStatus('stopped');
      await this.notify('stop', 'Sunucu durduruldu', reason === 'manual' ? '' : reason);
    }
  }

  private async killAndWait(pid: number) {
    const exe = this.direct?.executable ?? this.paths.executable;
    const alive = async () => processMatches(await this.host.processInfo(pid), exe);
    if (!(await alive())) return;
    await this.host.killProcess(pid).catch(() => undefined);
    const until = Date.now() + this.t.stopTimeoutMs;
    while (Date.now() < until) {
      if (!(await alive())) return;
      await sleep(300);
    }
    this.appLog(`PID ${pid} kapanmadı, zorla sonlandırılıyor`);
    await this.host.killProcess(pid, { force: true }).catch(() => undefined);
    await sleep(500);
  }

  private async waitUntilStopped(timeoutMs: number) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (!(await this.isServerAlive())) return;
      await sleep(500);
    }
  }

  private async isServerAlive(): Promise<boolean> {
    if (this.mode === 'systemd') {
      const st = await this.host.systemd!.status(this.unitName);
      return st.activeState === 'active' || st.activeState === 'activating' || st.activeState === 'deactivating';
    }
    if (!this.direct) return false;
    return processMatches(await this.host.processInfo(this.direct.pid), this.direct.executable);
  }

  /** Uygulama açıldığında zaten çalışan sunucuyu bul ve takip etmeye başla. */
  async attach(): Promise<void> {
    await this.host.connect();
    if (this.mode === 'systemd') {
      const st = await this.host.systemd!.status(this.unitName);
      if (!st.exists || (st.activeState !== 'active' && st.activeState !== 'activating')) {
        this.setStatus('stopped');
        return;
      }
      this.systemdRestarts = st.restarts;
      this.startedAt = st.startedAt || Date.now();
      this.setStatus(st.activeState === 'active' ? 'running' : 'starting');
    } else {
      const state = await this.loadState();
      if (!state || !processMatches(await this.host.processInfo(state.pid), state.executable)) {
        if (state) await this.host.remove(this.paths.stateFile).catch(() => undefined);
        this.setStatus('stopped');
        return;
      }
      this.direct = state;
      this.startedAt = state.startedAt;
      for (const hc of state.headless) {
        this.hcAlive.set(hc.index, processMatches(await this.host.processInfo(hc.pid), state.executable));
      }
      this.setStatus('running');
    }
    this.appLog('Çalışan sunucu bulundu, takip ediliyor');
    this.startTails(true);
    this.startMonitor();
    this.startRcon(0);
  }

  private async saveState() {
    if (!this.direct) return;
    await this.host.writeFile(this.paths.stateFile, JSON.stringify(this.direct, null, 2));
  }

  private async loadState(): Promise<DirectState | null> {
    try {
      const raw = JSON.parse(await this.host.readText(this.paths.stateFile)) as DirectState;
      if (typeof raw.pid !== 'number' || typeof raw.executable !== 'string') return null;
      return { ...raw, headless: Array.isArray(raw.headless) ? raw.headless : [] };
    } catch {
      return null;
    }
  }

  /* ---------------- izleme ---------------- */

  private startMonitor() {
    this.stopMonitor();
    this.monitorTimer = setInterval(() => void this.monitorTick(), this.t.monitorMs);
  }

  private stopMonitor() {
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.monitorTimer = null;
  }

  private async monitorTick() {
    if (this.monitoring || this.disposed) return;
    this.monitoring = true;
    try {
      if (this.mode === 'systemd') await this.monitorSystemd();
      else await this.monitorDirect();
    } catch (err) {
      this.appLog(`İzleme hatası: ${(err as Error).message}`);
    } finally {
      this.monitoring = false;
    }
  }

  private async monitorDirect() {
    if (!this.direct || this.busy) return;
    const alive = processMatches(await this.host.processInfo(this.direct.pid), this.direct.executable);
    if (!alive && (this.status === 'running' || this.status === 'starting')) {
      await this.handleCrash();
      return;
    }
    let changed = false;
    for (const hc of this.direct.headless) {
      const hcAlive = processMatches(await this.host.processInfo(hc.pid), this.direct.executable);
      if (this.hcAlive.get(hc.index) !== hcAlive) {
        this.hcAlive.set(hc.index, hcAlive);
        changed = true;
      }
      if (!hcAlive && this.status === 'running' && this.profile.supervisor.autoRestart) {
        this.appLog(`Headless client ${hc.index} kapanmış, yeniden başlatılıyor`);
        await this.startHeadless(hc.index);
      }
    }
    if (changed) this.emitStatus();
  }

  private async monitorSystemd() {
    if (this.busy) return;
    const sd = this.host.systemd!;
    const st = await sd.status(this.unitName);
    if (this.systemdRestarts >= 0 && st.restarts > this.systemdRestarts) {
      this.autoRestarts += st.restarts - this.systemdRestarts;
      this.notice('warning', 'Sunucu çöktü, systemd yeniden başlattı', 'Server crashed and was restarted by systemd');
      void this.notify('crash', 'Sunucu çöktü', 'systemd otomatik olarak yeniden başlattı.');
      this.startTails(false);
    }
    this.systemdRestarts = st.restarts;
    let changed = false;
    for (let i = 1; i <= this.profile.headless.count; i++) {
      const hs = await sd.status(this.hcUnitName(i));
      const alive = hs.activeState === 'active';
      if (this.hcAlive.get(i) !== alive) {
        this.hcAlive.set(i, alive);
        changed = true;
      }
    }
    const prev = this.status;
    if (st.activeState === 'active') {
      if (st.startedAt) this.startedAt = st.startedAt;
      if (prev !== 'running' && prev !== 'starting') this.setStatus('running');
    } else if (st.activeState === 'activating' && st.subState === 'auto-restart') {
      this.setStatus('restarting');
    } else if (st.activeState === 'failed') {
      if (prev !== 'crashed') {
        this.notice('error', 'Sunucu çöktü ve systemd yeniden başlatmayı bıraktı (çok fazla çökme).', 'Server crashed and systemd gave up restarting (too many crashes).');
        void this.notify('crash', 'Sunucu çöktü', 'Çok fazla çökme: otomatik restart durdu.');
      }
      this.stopRcon();
      this.setStatus('crashed');
    } else if (st.activeState === 'inactive' && (prev === 'running' || prev === 'starting')) {
      this.stopRcon();
      this.setStatus('stopped');
      this.appLog('Sunucu kapandı');
    }
    if (changed) this.emitStatus();
  }

  private async handleCrash() {
    this.stopRcon();
    const now = Date.now();
    this.restartHistory = this.restartHistory.filter((t) => now - t < 3600_000);
    const sup = this.profile.supervisor;
    this.notice('error', 'Sunucu beklenmedik şekilde kapandı (çöktü)', 'Server stopped unexpectedly (crashed)');
    // headless client'ları da kapat
    if (this.direct) for (const hc of this.direct.headless) await this.host.killProcess(hc.pid).catch(() => undefined);
    this.hcAlive.clear();
    if (sup.autoRestart && this.restartHistory.length < sup.maxRestartsPerHour) {
      this.restartHistory.push(now);
      this.autoRestarts++;
      void this.notify('crash', 'Sunucu çöktü', `Otomatik yeniden başlatılıyor (${sup.restartDelaySec} sn).`);
      this.setStatus('restarting');
      this.direct = null;
      await sleep(sup.restartDelaySec * 1000);
      if (this.disposed || this.status !== 'restarting') return;
      try {
        await this.exclusive(() => this.doStart(true));
      } catch {
        this.setStatus('crashed');
      }
    } else {
      void this.notify('crash', 'Sunucu çöktü', sup.autoRestart ? 'Bir saatte çok fazla çökme: otomatik restart durduruldu.' : 'Otomatik restart kapalı.');
      if (sup.autoRestart) {
        this.notice('error', 'Bir saat içinde çok fazla çökme: otomatik restart durduruldu.', 'Too many crashes within an hour: auto restart paused.');
      }
      this.direct = null;
      await this.host.remove(this.paths.stateFile).catch(() => undefined);
      this.stopTails();
      this.setStatus('crashed');
    }
  }

  /* ---------------- loglar ---------------- */

  private stopTails() {
    this.tails.forEach((t) => t.stop());
    this.tails = [];
  }

  private startTails(attaching: boolean) {
    this.stopTails();
    const rp = this.paths;
    const initial = attaching ? 300 : 0;
    if (this.host.os === 'windows') {
      void this.tailNewestRpt(rp.rptDir, 'server', attaching);
      for (let i = 1; i <= this.profile.headless.count; i++) void this.tailNewestRpt(rp.headlessProfilesDir(i), `hc${i}`, attaching);
    } else {
      this.tails.push(this.host.tail(rp.stdoutLog, (lines) => this.pushLog('server', lines), { initialLines: initial, fromStart: !attaching }));
      for (let i = 1; i <= this.profile.headless.count; i++) {
        this.tails.push(this.host.tail(rp.headlessStdoutLog(i), (lines) => this.pushLog(`hc${i}`, lines), { initialLines: initial, fromStart: !attaching }));
      }
    }
  }

  /** Windows: Arma her başlatmada yeni bir .rpt dosyası açar; en yenisini bulup takip et. */
  private async tailNewestRpt(dir: string, source: string, attaching: boolean) {
    const L = pathLib(this.host.os);
    const since = attaching ? 0 : this.startedAt - 5000;
    const deadline = Date.now() + this.t.rptWaitMs;
    const myTails = this.tails;
    while (Date.now() < deadline && myTails === this.tails && !this.disposed) {
      const entries = await this.host.list(dir).catch(() => []);
      const rpts = entries.filter((e) => !e.isDir && /\.rpt$/i.test(e.name) && e.mtimeMs >= since).sort((a, b) => b.mtimeMs - a.mtimeMs);
      if (rpts[0]) {
        if (myTails !== this.tails) return;
        this.tails.push(this.host.tail(L.join(dir, rpts[0].name), (lines) => this.pushLog(source, lines), attaching ? { initialLines: 300 } : { fromStart: true }));
        return;
      }
      await sleep(2000);
    }
  }

  /* ---------------- RCON ---------------- */

  private startRcon(delayMs: number) {
    const p = this.profile;
    if (!p.rcon.enabled || !p.security.battlEye || !p.rcon.password) return;
    if (this.rconTimer) clearTimeout(this.rconTimer);
    this.rconTimer = setTimeout(() => {
      this.rconTimer = null;
      if (this.status !== 'running' && this.status !== 'starting') return;
      const host = p.rcon.connectHost || this.opts.defaultRconHost || '127.0.0.1';
      const rcon = new BattlEyeRcon({ host, port: effectiveRconPort(p), password: p.rcon.password, reconnect: true, reconnectDelayMs: 10_000 });
      this.rcon = rcon;
      rcon.on('state', (s, reason) => {
        if (s === 'connected') {
          this.appLog(`RCON bağlandı (${host}:${effectiveRconPort(p)})`);
          void this.refreshPlayers();
        }
        if (s === 'disconnected' && reason && reason !== 'Kapatıldı') this.appLog(`RCON bağlantısı yok: ${reason}`);
        this.emitStatus();
      });
      rcon.on('message', (m) => this.emit('rconMessage', m));
      rcon.connect().catch((err) => {
        if ((err as { code?: string }).code === 'auth_failed') {
          this.notice('error', 'RCON şifresi kabul edilmedi', 'RCON password rejected');
        }
      });
      this.playersTimer = setInterval(() => void this.refreshPlayers(), this.t.playersMs);
    }, delayMs);
  }

  async refreshPlayers(): Promise<RconPlayer[]> {
    if (this.rcon?.state !== 'connected') return [];
    try {
      const players = await this.rcon.players();
      if (this.playerCount !== players.length) {
        this.playerCount = players.length;
        this.emitStatus();
      }
      this.emit('players', players);
      return players;
    } catch {
      return [];
    }
  }

  private stopRcon() {
    if (this.rconTimer) clearTimeout(this.rconTimer);
    if (this.playersTimer) clearInterval(this.playersTimer);
    this.rconTimer = null;
    this.playersTimer = null;
    if (this.rcon) {
      this.rcon.removeAllListeners();
      this.rcon.close();
      this.rcon = null;
    }
  }

  /* ---------------- zamanlı restart ---------------- */

  private async schedulerTick(now = new Date()) {
    const sup = this.profile.supervisor;
    if (!sup.scheduledRestarts.length) {
      if (this.scheduledFor) {
        this.scheduledFor = null;
        this.emitStatus();
      }
      return;
    }
    if (!this.scheduledFor || this.scheduledFor < now.getTime() - 60_000) {
      const next = nextOccurrence(sup.scheduledRestarts, now);
      this.scheduledFor = next ? next.getTime() : null;
      this.warningsSent.clear();
      this.emitStatus();
    }
    if (!this.scheduledFor || this.status !== 'running') return;
    const next = new Date(this.scheduledFor);
    const minutes = dueWarning(next, now, sup.warnMinutes, this.warningsSent);
    if (minutes !== null && this.rcon?.state === 'connected') {
      await this.rcon.say(formatWarning(sup.warnMessage, minutes)).catch(() => undefined);
      this.appLog(`Restart uyarısı gönderildi (${minutes} dk)`);
    }
    if (now.getTime() >= this.scheduledFor && !this.busy) {
      this.scheduledFor = null;
      this.appLog('Zamanlı restart başlıyor');
      await this.restart({ update: sup.updateOnScheduledRestart, reason: 'Zamanlı restart' }).catch((err) =>
        this.notice('error', `Zamanlı restart başarısız: ${(err as Error).message}`, `Scheduled restart failed: ${(err as Error).message}`),
      );
    }
  }

  /** Test ve "şimdi kontrol et" için */
  runSchedulerTick(now?: Date) {
    return this.schedulerTick(now);
  }

  dispose() {
    this.disposed = true;
    if (this.schedulerTimer) clearInterval(this.schedulerTimer);
    if (this.runningTimer) clearTimeout(this.runningTimer);
    this.hcTimers.forEach(clearTimeout);
    this.stopMonitor();
    this.stopTails();
    this.stopRcon();
    this.removeAllListeners();
  }
}
