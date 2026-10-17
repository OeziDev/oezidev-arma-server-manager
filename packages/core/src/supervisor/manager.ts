import { EventEmitter } from 'node:events';
import { generateArma3Profile, generateBasicCfg, generateBeServerCfg, generateServerCfg } from '../config/generators.js';
import { type Host, type TailHandle, processMatches } from '../host/types.js';
import { generateSystemdUnit } from '../host/systemd.js';
import { appendServerModToExtraArgs, buildHeadlessLaunch, buildServerLaunch } from '../launch/commandLine.js';
import { type HostOs, type ResolvedPaths, pathLib, resolvePaths } from '../launch/paths.js';
import { type ServerProfile, effectiveRconPort } from '../model/profile.js';
import type { Notifier, NotifyEvent } from '../notify/discord.js';
import { DiscordStatusUpdater } from '../notify/discordStatus.js';
import { FpsAlertTracker } from '../monitor/fpsAlert.js';
import { type MetricSample, type MetricsJSON, MetricsStore } from '../monitor/metrics.js';
import { MONITOR_MOD_FOLDER, MONITOR_SCRIPT_INTERVAL_SEC, ensureMonitorMod } from '../monitor/monitorMod.js';
import { type PerfSample, PERF_TAG, parsePerfLine } from '../monitor/perf.js';
import { BattlEyeRcon, type RconPlayer, type RconState } from '../rcon/battleye.js';
import { type Issue, hasBlockingIssues, validateProfile } from '../validate.js';
import { formatWarning, nextOccurrence, planWarning } from './scheduler.js';

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
  /** Makineye ulaşılamıyor (SSH koptu vb.) */
  unreachable?: boolean;
  /** Son performans ölçümü (izleme açıksa): FPS @oezi_monitor'dan, CPU/RAM süreçlerden */
  perf?: { fps?: number; cpu?: number; memMB?: number; ai?: number; t: number };
}

export interface LogLine {
  /** Profil içinde artan sıra numarası (arayüzde tekrarları ayıklamak için) */
  seq: number;
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
  /** Her yeni birleşik performans örneği (sampleSec'te bir) */
  metrics: [MetricSample];
  /** Discord durum mesajı yeniden gönderildi: profile.discordStatus.messageId'ye kaydedilmeli */
  discordStatusMessageId: [string];
}

export interface ManagerOptions {
  profile: ServerProfile;
  host: Host;
  /** Aynı makinedeki diğer profiller (port çakışması kontrolü) */
  otherProfiles?: () => ServerProfile[];
  /** SSH ile bağlanılan Linux'ta systemd kullan (varsayılan: true) */
  useSystemd?: boolean;
  /** systemd servisinin çalışacağı kullanıcı (boşsa root) */
  serviceUser?: string;
  /** RCON'a bağlanılacak adres (profilde yoksa). SSH host'larında sunucu adresi. */
  defaultRconHost?: string;
  notifier?: Notifier | null;
  /** Zamanlı restartta SteamCMD güncellemesi */
  updater?: (profile: ServerProfile, log: (line: string) => void) => Promise<void>;
  /** Uygulamanın kaydettiği performans geçmişi (MetricsStore.toJSON çıktısı) */
  metrics?: MetricsJSON | null;
  /** Discord durum mesajı yeni kimlik aldı (profile kaydetmek için; 'discordStatusMessageId' olayı da yayılır) */
  onDiscordStatusMessageId?: (id: string) => void;
  /** Discord durum mesajının dili */
  discordStatusLang?: 'tr' | 'en';
  /** Testler için (Discord durum mesajı) */
  fetchImpl?: typeof fetch;
  timers?: Partial<{
    monitorMs: number;
    schedulerMs: number;
    /** RCON ve log yoksa (hazır olduğu anlaşılamıyorsa) bu süre sonra "çalışıyor" sayılır */
    runningAfterMs: number;
    rconDelayMs: number;
    playersMs: number;
    stopTimeoutMs: number;
    /** Kullanılmıyor (eski ayar; .rpt dosyası artık süresiz aranır) */
    rptWaitMs: number;
    /** Windows: yeni .rpt dosyası için klasörün yeniden listelenme aralığı */
    rptPollMs: number;
    /** Ölü sayılmadan önce art arda kaç "yok" okuması gerekir */
    deadConfirmations: number;
    /** Başlatırken "ErrorMessage:" görüldükten sonra hazır olması için tanınan süre */
    errorMessageGraceMs: number;
    /** Performans ölçüm aralığı; 0 ise profile.monitoring.sampleSec */
    perfMs: number;
    /** Süreç CPU/RAM ölçüm aralığı; 0 ise processStatIntervalMs(os, sampleSec) */
    procStatMs: number;
    /** Duyuru aralığı; 0 ise profile.announcements.intervalMin */
    announceMs: number;
  }>;
}

/**
 * Süreç CPU/RAM ölçüm aralığı (ms). Windows'ta her ölçüm bir PowerShell çalıştırır (pahalı): en az 30 sn.
 * Aradaki birleşik örnekler son ölçümü yeniden kullanır; FPS @oezi_monitor'dan ayrıca gelir.
 */
export function processStatIntervalMs(os: HostOs, sampleSec: number): number {
  return (os === 'windows' ? Math.max(30, sampleSec) : sampleSec) * 1000;
}

interface DirectState {
  pid: number;
  startedAt: number;
  executable: string;
  /** Komut satırında aranacak işaret (aynı exe ile çalışan diğer sunuculardan ayırmak için) */
  marker?: string;
  /** marker: başlatıldığı andaki işaret (profil yolları sonradan değişse de doğru süreç kapatılsın) */
  headless: { index: number; pid: number; marker?: string }[];
}

/** Sunucu başlatılırken kullanılan RCON ayarları (BattlEye bunları bir sonraki başlatmaya kadar kullanır) */
interface RconSnapshot {
  enabled: boolean;
  host: string;
  port: number;
  password: string;
}

interface ReadyNotify {
  event: NotifyEvent;
  title: string;
  description: string;
}

type CrashKind = 'exit' | 'fatal' | 'timeout';
type TailKind = 'new' | 'attach' | 'resume';

export class ValidationFailedError extends Error {
  constructor(readonly issues: Issue[]) {
    super('Profilde başlatmayı engelleyen hatalar var: ' + issues.filter((i) => i.severity === 'error').map((i) => i.message.tr).join(' | '));
    this.name = 'ValidationFailedError';
  }
}

/** Süreç durumu sorgulanamadı: kapatıldığından emin olunamadı */
class ProcessQueryError extends Error {
  constructor(
    readonly pid: number,
    cause: unknown,
  ) {
    super(`PID ${pid} sorgulanamadı: ${(cause as Error)?.message ?? String(cause)}`);
    this.name = 'ProcessQueryError';
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const MAX_LOG = 3000;
const HC_MAX_RESTARTS_PER_HOUR = 6;
/** Sunucunun oyunculara hazır olduğunu gösteren log satırları */
const READY_RES = [/Host identity created/i, /BattlEye Server: Initialized/i];
/**
 * Ölümcül hata satırları. Windows'ta Arma bu durumda bir mesaj kutusu açar ve süreç arkada açık
 * kalır; bu yüzden süreç "yaşıyor" diye çalışıyor sanılmamalı.
 * - Bizim ürettiğimiz config dosyalarındaki sözdizimi hatası kesin ölümcüldür:
 *   "File C:\...\server.cfg, line 107: .regularCheck: Member already defined."
 *   Mod/görev config'lerindeki aynı biçimli satırlar (Missing ';' vb.) zararsız uyarılardır, sayılmaz.
 * - "ErrorMessage:" çoğu zaman ölümcüldür ama her zaman değil: önce uyarılır, sunucu ardından
 *   ERROR_MESSAGE_GRACE_MS içinde hazır olmazsa başlatma başarısız sayılır.
 */
const CFG_ERROR_RE = /^\s*(?:\d+:\d+:\d+(?:\.\d+)?\s+)?File (.+?), line \d+: /;
const ERROR_MESSAGE_RE = /\bErrorMessage:/;
const ERROR_MESSAGE_GRACE_MS = 60_000;
/** journald zamanı VPS saatine göre karşılaştırır; uzak saat bilinmiyorsa bu kadar geriden başla */
const JOURNAL_MARGIN_SEC = 120;

const fmtTime = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

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
  private hcRestarts = new Map<number, number[]>();
  private hcTimers: NodeJS.Timeout[] = [];
  private monitorTimer: NodeJS.Timeout | null = null;
  private schedulerTimer: NodeJS.Timeout | null = null;
  private runningTimer: NodeJS.Timeout | null = null;
  private startTimeoutTimer: NodeJS.Timeout | null = null;
  private rconTimer: NodeJS.Timeout | null = null;
  private playersTimer: NodeJS.Timeout | null = null;
  private tails: TailHandle[] = [];
  private tailsGeneration = -1;
  private logBuffer: LogLine[] = [];
  private logSeq = 0;
  private busy: Promise<void> | null = null;
  private monitoring = false;
  private deadStreak = 0;
  private lastError: string | undefined;
  private unreachable = false;
  private lastLoggedError = { text: '', at: 0 };
  private scheduledFor: number | null = null;
  private warningsSent = new Set<number>();
  private scheduleNote: { at: number; what: string } | null = null;
  private playerCount = 0;
  private attached = false;
  rcon: BattlEyeRcon | null = null;
  private disposed = false;
  /** stop/start/restart/dispose ile artar: süren çökme işlemi kullanıcının isteğini ezmesin */
  private opGen = 0;
  /** Her başlatma/durdurmada artar: eski çalıştırmanın HC zamanlayıcıları/başlatmaları geçersiz olur */
  private runId = 0;
  /** "starting" durumunda hazır olma sinyali (RCON girişi / log satırı) bekleniyor */
  private awaitingReady = false;
  private readyNotify: ReadyNotify | null = null;
  /** Çökme işlemi sürüyor (izleme bu sırada müdahale etmez) */
  private crashToken: object | null = null;
  /** Bu çalıştırmada görülen ölümcül hata (otomatik restart yapılmaz) */
  private fatalDetail: string | null = null;
  /** Süreç kapandıktan hemen sonra gelen hata satırları da yakalansın */
  private lateFatalUntil = 0;
  private errorMessageTimer: NodeJS.Timeout | null = null;
  private startTimeoutSec = 0;
  private recentServerLines: string[] = [];
  /** Durdurma doğrulanamadı: süreç kapandığında "durdu" say (çökme sayma) */
  private stopPending = false;
  private rconCfg: RconSnapshot | null = null;
  /** Windows: başlatmadan önce klasörlerde var olan .rpt dosyaları (eski çalıştırmanın logu izlenmesin) */
  private rptSnapshot = new Map<string, Set<string>>();
  /* performans izleme */
  private readonly metricsStore: MetricsStore;
  private lastPerf: PerfSample | undefined;
  private currentPerf: StatusInfo['perf'];
  private perfTimer: NodeJS.Timeout | null = null;
  private perfSampling = false;
  /** Son süreç CPU/RAM ölçümü (aradaki örneklerde yeniden kullanılır) */
  private lastProcStat: { t: number; cpu?: number; memMB?: number } | null = null;
  private readonly fpsAlert = new FpsAlertTracker();
  /** -serverMod birleştirme bilgisi bir kez loglansın */
  private serverModMergeLogged = false;
  /** Son deploy'da @oezi_monitor yazılabildi mi (yazılamadıysa mod komut satırına eklenmez) */
  private monitorModOk = true;
  private lastPlayers: RconPlayer[] = [];
  private readonly statusUpdater: DiscordStatusUpdater;
  private announceTimer: NodeJS.Timeout | null = null;
  private announceIndex = 0;

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
      rptPollMs: 2000,
      deadConfirmations: 2,
      errorMessageGraceMs: ERROR_MESSAGE_GRACE_MS,
      perfMs: 0,
      procStatMs: 0,
      announceMs: 0,
      ...opts.timers,
    };
    this.schedulerTimer = setInterval(() => void this.schedulerTick(), this.t.schedulerMs);
    this.metricsStore = opts.metrics ? MetricsStore.fromJSON(opts.metrics) : new MetricsStore();
    this.statusUpdater = new DiscordStatusUpdater({
      source: this,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      lang: opts.discordStatusLang ?? 'tr',
      log: (line) => this.appLog(line),
      onWarning: (m) => {
        if (!this.disposed) this.notice('warning', m.tr, m.en);
      },
      onMessageId: (id) => {
        if (this.disposed) return;
        try {
          opts.onDiscordStatusMessageId?.(id);
        } catch (err) {
          this.appLog(`Discord mesaj kimliği kaydedilemedi: ${(err as Error).message}`);
        }
        this.emit('discordStatusMessageId', id);
      },
    });
    // Güncelleyici ilk attach (ya da ilk durum değişikliği) sonrası başlar: açılışta çalışan sunucu için "Kapalı" yazmasın
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

  private get hcUnits(): string[] {
    return Array.from({ length: this.profile.headless.count }, (_, i) => this.hcUnitName(i + 1));
  }

  /** Bu profilin süreçlerini aynı makinedeki diğer Arma süreçlerinden ayıran işaret */
  private markerFor(hcIndex?: number): string {
    const rp = this.paths;
    return `-profiles=${hcIndex ? rp.headlessProfilesDir(hcIndex) : rp.profilesDir}`;
  }

  getProfile(): ServerProfile {
    return this.profile;
  }

  private rconSnapshotFrom(p: ServerProfile): RconSnapshot {
    return {
      enabled: p.rcon.enabled && p.security.battlEye && !!p.rcon.password,
      host: p.rcon.connectHost || this.opts.defaultRconHost || '127.0.0.1',
      port: effectiveRconPort(p),
      password: p.rcon.password,
    };
  }

  /** Sunucu süreci var (ya da olması bekleniyor) */
  private isActive(): boolean {
    return this.status !== 'stopped' && this.status !== 'crashed';
  }

  /** Yeni ayarlar bir sonraki başlatmada uygulanır; zamanlayıcı hemen güncellenir. */
  updateProfile(p: ServerProfile) {
    const prev = this.profile;
    this.profile = p;
    // Uyarı kayıtları sadece restart saatleri değişince sıfırlanır (her kaydetmede aynı uyarı tekrar gitmesin)
    if (JSON.stringify(prev.supervisor.scheduledRestarts) !== JSON.stringify(p.supervisor.scheduledRestarts)) {
      this.scheduledFor = null;
      this.warningsSent.clear();
      this.refreshSchedule(new Date());
    }
    if (JSON.stringify(prev.announcements) !== JSON.stringify(p.announcements)) {
      this.announceIndex = 0;
      if (this.status === 'running') this.startAnnouncements();
    }
    if (prev.monitoring.sampleSec !== p.monitoring.sampleSec || prev.monitoring.enabled !== p.monitoring.enabled) {
      if (this.perfTimer) this.startPerf();
    }
    if (prev.monitoring.fpsAlertBelow !== p.monitoring.fpsAlertBelow || prev.monitoring.fpsAlertMinutes !== p.monitoring.fpsAlertMinutes) this.fpsAlert.reset();
    if (JSON.stringify({ ...prev.discordStatus, messageId: '' }) !== JSON.stringify({ ...p.discordStatus, messageId: '' }) || prev.notifications.discordWebhook !== p.notifications.discordWebhook) {
      this.statusUpdater.resetBackoff();
      this.statusUpdater.poke();
    }
    const before = this.rconSnapshotFrom(prev);
    const after = this.rconSnapshotFrom(p);
    // Sunucu çalışmıyorsa bir sonraki başlatma yeni ayarları alır
    if (!this.isActive()) this.rconCfg = null;
    else if (this.rconCfg) {
      // BattlEye şifre/port/açık-kapalı ayarını sadece başlarken okur: çalışırken eskisiyle devam et
      if (before.password !== after.password || before.port !== after.port || before.enabled !== after.enabled) {
        this.notice(
          'info',
          'RCON ayarları sunucu yeniden başlatılınca geçerli olur; o zamana kadar eski ayarlar kullanılıyor.',
          'RCON settings take effect after the server is restarted; the old settings stay in use until then.',
        );
      }
      // Bağlanılacak adres sadece uygulamayı ilgilendirir: hemen uygula
      if (after.host !== this.rconCfg.host) {
        this.rconCfg = { ...this.rconCfg, host: after.host };
        if (this.rcon) {
          this.stopRcon();
          this.startRcon(0);
        }
      }
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
      ...(this.unreachable ? { unreachable: true } : {}),
      ...(this.currentPerf && this.isActive() ? { perf: { ...this.currentPerf } } : {}),
    };
  }

  /** Son RCON oyuncu listesi */
  getPlayers(): RconPlayer[] {
    return this.lastPlayers.slice();
  }

  /** @oezi_monitor'un son performans satırı */
  getLastPerf(): PerfSample | undefined {
    return this.lastPerf ? { ...this.lastPerf } : undefined;
  }

  /** Performans geçmişi (sinceMs: Unix ms; verilmezse hepsi, en fazla 24 saat) */
  getMetrics(sinceMs?: number): MetricSample[] {
    return this.metricsStore.query(sinceMs);
  }

  /** Kaydetmek için performans geçmişi (ServerManager seçeneği `metrics` ile geri yüklenir) */
  metricsSnapshot(): MetricsJSON {
    return this.metricsStore.toJSON();
  }

  /** Discord durum mesajını hemen güncelle (yoksa oluştur). Kapalıysa bir şey yapmaz; hata fırlatabilir. */
  refreshDiscordStatus(): Promise<void> {
    this.statusUpdater.resetBackoff();
    return this.statusUpdater.update();
  }

  getLogBuffer(): LogLine[] {
    return this.logBuffer.slice();
  }

  private setStatus(s: ServerStatus) {
    if (this.status === s) return;
    const prev = this.status;
    this.status = s;
    if (s === 'running') this.startAnnouncements();
    else if (prev === 'running') this.stopAnnouncements();
    if (s === 'stopped' || s === 'crashed') {
      this.currentPerf = undefined;
      this.lastPlayers = [];
    }
    this.kickStatusUpdater();
    // "starting" dışına çıkınca hazır olma beklemesi biter
    if (s !== 'starting') {
      this.clearReadiness();
      this.readyNotify = null;
    }
    this.emitStatus();
  }

  private emitStatus() {
    if (this.disposed) return;
    this.emit('status', this.getStatus());
  }

  private appLog(line: string) {
    this.pushLog('app', [line]);
  }

  /** Aynı hata satırını dakikada en fazla bir kez logla (bağlantı koptuğunda log taşmasın) */
  private appLogThrottled(line: string) {
    const now = Date.now();
    if (this.lastLoggedError.text === line && now - this.lastLoggedError.at < 60_000) return;
    this.lastLoggedError = { text: line, at: now };
    this.appLog(line);
  }

  private pushLog(source: string, lines: string[]) {
    const t = Date.now();
    // @oezi_monitor satırları konsolu doldurmasın: performans verisi olarak işlenir, loga yazılmaz
    let shown = lines;
    if (source === 'server' && lines.some((l) => l.includes(PERF_TAG))) {
      shown = [];
      for (const line of lines) {
        const perf = line.includes(PERF_TAG) ? parsePerfLine(line, t) : null;
        if (perf) this.lastPerf = perf;
        else shown.push(line);
      }
    }
    if (!shown.length) {
      this.inspectServerLines(lines);
      return;
    }
    const items = shown.map((line) => ({ seq: ++this.logSeq, t, source, line }));
    this.logBuffer.push(...items);
    if (this.logBuffer.length > MAX_LOG) this.logBuffer.splice(0, this.logBuffer.length - MAX_LOG);
    this.emit('log', items);
    if (source === 'server') this.inspectServerLines(lines);
  }

  /** Performans uyarısı Discord'a (notifications.onPerformance açıksa) */
  private notifyPerformance(title: string, description: string) {
    const n = this.opts.notifier;
    if (!n || !this.profile.notifications.onPerformance) return;
    let p: Promise<void>;
    try {
      p = n.notify('performance', title, description);
    } catch (err) {
      p = Promise.reject(err);
    }
    void Promise.resolve(p).catch((err) => this.appLog(`Discord bildirimi gönderilemedi: ${(err as Error)?.message ?? err}`));
  }

  private notice(level: Notice['level'], tr: string, en: string) {
    this.emit('notice', { level, message: { tr, en } });
    this.appLog(`[${level}] ${tr}`);
  }

  /** Discord bildirimi: başlat/durdur akışını asla bekletmez (ateşle ve unut). */
  private notify(event: NotifyEvent, title: string, description = ''): void {
    const n = this.opts.notifier;
    const prefs = this.profile.notifications;
    const allowed =
      (event === 'start' && prefs.onStart) ||
      (event === 'stop' && prefs.onStop) ||
      ((event === 'crash' || event === 'restart') && prefs.onCrash) ||
      (event === 'update' && prefs.onUpdate) ||
      event === 'info';
    if (!n || !allowed) return;
    let p: Promise<void>;
    try {
      p = n.notify(event, title, description);
    } catch (err) {
      p = Promise.reject(err);
    }
    void Promise.resolve(p).catch((err) => this.appLog(`Discord bildirimi gönderilemedi: ${(err as Error)?.message ?? err}`));
  }

  /** Aynı anda tek işlem (başlat/durdur/restart) */
  private exclusive(fn: () => Promise<void>): Promise<void> {
    if (this.busy) return Promise.reject(new Error('Sunucu şu an başka bir işlem yapıyor, lütfen bekle'));
    const p = fn().finally(() => {
      if (this.busy === p) this.busy = null;
    });
    this.busy = p;
    return p;
  }

  /** stop()/start()/dispose() bu işlemden sonra çağrıldıysa devam etme */
  private cancelled(gen: number): boolean {
    return this.disposed || gen !== this.opGen;
  }

  /* ---------------- dağıtım ---------------- */

  validate(): Issue[] {
    return validateProfile(this.profile, this.host.os, this.opts.otherProfiles?.() ?? []);
  }

  /** Şifre içeren dosyalar: Linux'ta sadece sahibi okuyabilsin (host destekliyorsa) */
  private async writeSecret(file: string, content: string) {
    // Servis başka bir kullanıcıyla çalışıyorsa (User=) dosyayı okuyamaz hale getirme
    if (this.host.os === 'linux' && !this.opts.serviceUser) {
      await this.host.writeFile(file, content, { mode: 0o600 });
      return;
    }
    await this.host.writeFile(file, content);
  }

  /** Config dosyalarını (ve gerekirse systemd servislerini) sunucuya yazar. */
  async deploy(): Promise<string[]> {
    await this.host.connect();
    const p = this.profile;
    const rp = this.paths;
    const L = pathLib(this.host.os);
    const written: string[] = [];
    const write = async (file: string, content: string, secret = false) => {
      if (secret) await this.writeSecret(file, content);
      else await this.host.writeFile(file, content);
      written.push(file);
    };
    await write(rp.serverCfg, generateServerCfg(p), true);
    await write(rp.basicCfg, generateBasicCfg(p));
    const profileText = generateArma3Profile(p);
    for (const file of rp.arma3Profiles) await write(file, profileText);
    if (p.security.battlEye) {
      await this.host.mkdirp(rp.beDir);
      // BattlEye başlarken cfg'yi *_active_*.cfg olarak yeniden adlandırır; eskileri temizle.
      for (const e of await this.host.list(rp.beDir).catch(() => [])) {
        if (/^beserver(_x64)?_active_.*\.cfg$/i.test(e.name)) await this.host.remove(L.join(rp.beDir, e.name)).catch(() => undefined);
      }
      await write(rp.beCfg, generateBeServerCfg(p), true);
      await this.copyBattlEyeLibrary(rp).catch((err) => this.appLog(`BattlEye kütüphanesi kopyalanamadı: ${(err as Error).message}`));
    }
    for (let i = 1; i <= p.headless.count; i++) await this.host.mkdirp(rp.headlessProfilesDir(i));
    await this.deployMonitorMod(rp);

    if (this.mode === 'systemd') {
      const sd = this.host.systemd!;
      const server = buildServerLaunch(this.launchProfile(), this.host.os, rp);
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
          identifier: this.unitName.replace(/\.service$/, ''),
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
              // HC'ler kendi başına sık sık yeniden bağlanabilir; sınırı daha geniş tut
              startLimitBurst: Math.max(10, p.supervisor.maxRestartsPerHour * 2),
              description: `Arma 3 - ${p.name} headless ${i} (OeziDev)`,
              executable: hc.executable,
              args: hc.args,
              identifier: name.replace(/\.service$/, ''),
              restart: 'always',
              partOf: this.unitName,
              startDelaySec: p.headless.startDelaySec,
            }),
          );
          written.push(sd.unitPath(name));
        } else if (await this.host.exists(sd.unitPath(name))) {
          await sd.action('stop', name).catch(() => undefined);
          await sd.action('disable', name).catch(() => undefined);
          await sd.removeUnit(name);
        }
      }
      await sd.daemonReload();
    }
    this.appLog(`Config dosyaları yazıldı (${written.length} dosya)`);
    return written;
  }

  /** İzleme açıksa @oezi_monitor'u sunucu klasörüne yaz (değiştiyse). Yazılamazsa mod olmadan devam edilir. */
  private async deployMonitorMod(rp: ResolvedPaths) {
    const m = this.profile.monitoring;
    if (!m.enabled) return;
    try {
      const res = await ensureMonitorMod(this.host, rp.serverDir);
      this.monitorModOk = true;
      if (res.changed) this.appLog(`Performans izleme modu yazıldı: ${res.folder}`);
    } catch (err) {
      this.monitorModOk = false;
      this.appLog(`Performans izleme modu (${MONITOR_MOD_FOLDER}) yazılamadı, onsuz başlatılıyor: ${(err as Error)?.message ?? err}`);
    }
  }

  /** Başlatma için profil: izleme açıksa -serverMod listesine @oezi_monitor eklenir (zaten varsa tekrar eklenmez). */
  private launchProfile(): ServerProfile {
    const p = this.profile;
    if (!p.monitoring.enabled || !this.monitorModOk) return p;
    const has = p.launch.serverMods.some((m) => m.enabled && m.path.trim().split(/[\\/]/).filter(Boolean).pop()?.toLowerCase() === MONITOR_MOD_FOLDER);
    if (has) return p;
    // Ek parametrelerde kendi -serverMod= varsa ikinci bir -serverMod üretme (Arma birini yok sayar): mevcut değere ekle
    let merged: string | null = null;
    try {
      merged = appendServerModToExtraArgs(p.launch.extraArgs, MONITOR_MOD_FOLDER);
    } catch (err) {
      this.appLog(`Ek parametreler okunamadı, ${MONITOR_MOD_FOLDER} eklenmedi: ${(err as Error).message}`);
      return p;
    }
    if (merged !== null) {
      if (merged !== p.launch.extraArgs && !this.serverModMergeLogged) {
        this.serverModMergeLogged = true;
        this.appLog(`Ek parametrelerde -serverMod= var: ${MONITOR_MOD_FOLDER} oradaki listeye eklendi`);
      }
      return { ...p, launch: { ...p.launch, extraArgs: merged } };
    }
    return {
      ...p,
      launch: {
        ...p.launch,
        serverMods: [...p.launch.serverMods, { id: 'oezi-monitor', path: MONITOR_MOD_FOLDER, enabled: true, displayName: 'OeziDev Monitor', source: 'local' as const }],
      },
    };
  }

  /**
   * -bepath ile verilen klasörde sadece cfg olursa BattlEye kütüphanesini bulamayabilir:
   * sunucu klasöründeki BEServer_x64.dll / beserver_x64.so'yu oraya kopyala (değiştiyse).
   */
  private async copyBattlEyeLibrary(rp: ResolvedPaths) {
    const L = pathLib(this.host.os);
    const base = L.basename(rp.beCfg).replace(/\.cfg$/i, '').toLowerCase();
    const want = `${base}.${this.host.os === 'windows' ? 'dll' : 'so'}`;
    const srcDirEntry = (await this.host.list(rp.serverDir)).find((e) => e.isDir && /^battleye$/i.test(e.name));
    if (!srcDirEntry) return;
    const srcDir = L.join(rp.serverDir, srcDirEntry.name);
    const norm = (x: string) => (this.host.os === 'windows' ? x.toLowerCase() : x).replace(/[\\/]+$/, '');
    if (norm(srcDir) === norm(rp.beDir)) return;
    const src = (await this.host.list(srcDir)).find((e) => !e.isDir && e.name.toLowerCase() === want);
    if (!src) return;
    const dest = L.join(rp.beDir, src.name);
    const st = await this.host.stat(dest).catch(() => null);
    if (st && !st.isDir && st.size === src.size && st.mtimeMs >= src.mtimeMs) return;
    await this.host.copyFile(L.join(srcDir, src.name), dest);
    this.appLog(`BattlEye kütüphanesi kopyalandı: ${dest}`);
  }

  /* ---------------- başlat / durdur ---------------- */

  start(): Promise<void> {
    return this.exclusive(async () => {
      this.opGen++;
      // Uygulama açılışında makineye ulaşılamadıysa, önce çalışan bir sunucu var mı bak (çift başlatma olmasın)
      if (!this.attached) {
        await this.attachInner();
        if (this.disposed) return;
        if (this.status === 'running' || this.status === 'starting') return;
      }
      await this.doStart({ event: 'start', title: 'Sunucu başlatıldı', description: '' });
    });
  }

  stop(): Promise<void> {
    return this.exclusive(async () => {
      this.opGen++;
      if (!this.attached) await this.attachInner().catch(() => undefined);
      if (this.disposed) return;
      await this.doStop('manual');
    });
  }

  restart(opts: { update?: boolean; reason?: string } = {}): Promise<void> {
    return this.exclusive(async () => {
      this.opGen++;
      // Önce makineye ulaşılabildiğini doğrula: #shutdown gidip sonra systemctl/deploy başarısız olursa sunucu kapalı kalır
      try {
        await this.host.connect();
        await this.isServerAlive();
      } catch (err) {
        const msg = (err as Error).message;
        this.notice('error', `Yeniden başlatma iptal edildi: makineye ulaşılamıyor (${msg})`, `Restart aborted: the machine is unreachable (${msg})`);
        throw err;
      }
      if (this.disposed) return;
      this.setStatus('restarting');
      await this.doStop(opts.reason ?? 'restart', true);
      if (this.disposed) return;
      if (opts.update && this.opts.updater) {
        this.setStatus('updating');
        try {
          await this.opts.updater(this.profile, (l) => this.appLog(l));
          this.notify('update', 'Güncellendi', 'Sunucu ve modlar güncellendi.');
        } catch (err) {
          // Güncelleme başarısız olsa bile sunucu kapalı kalmasın
          this.notice('error', `Güncelleme başarısız, sunucu güncellenmeden başlatılıyor: ${(err as Error).message}`, `Update failed, starting without update: ${(err as Error).message}`);
        }
        if (this.disposed) return;
      }
      await this.doStart({ event: 'restart', title: 'Yeniden başlatıldı', description: opts.reason ?? '' });
    });
  }

  /** readyNotify: sunucu hazır olunca gönderilecek Discord bildirimi (otomatik restartta yok) */
  private async doStart(readyNotify: ReadyNotify | null): Promise<void> {
    if (this.status === 'running' || this.status === 'starting') return;
    this.clearHcTimers();
    this.lastError = undefined;
    const issues = this.validate();
    if (hasBlockingIssues(issues)) {
      this.lastError = 'validation';
      this.setStatus('stopped');
      throw new ValidationFailedError(issues);
    }
    this.runId++;
    this.fatalDetail = null;
    this.lateFatalUntil = 0;
    this.recentServerLines = [];
    this.stopPending = false;
    this.rconCfg = this.rconSnapshotFrom(this.profile);
    this.fpsAlert.reset();
    this.lastPerf = undefined;
    this.lastProcStat = null;
    this.currentPerf = undefined;
    this.setStatus('starting');
    this.deadStreak = 0;
    try {
      await this.deploy();
      if (this.disposed) return;
      const rp = this.paths;
      if (this.mode === 'systemd') {
        const sd = this.host.systemd!;
        await sd.action('reset-failed', this.unitName, ...this.hcUnits).catch(() => undefined);
        if (this.disposed) return;
        await sd.action('start', this.unitName);
        if (this.disposed) return;
        // Sunucu VPS yeniden başlarsa da açılsın (headless client'lar dahil)
        await sd.action('enable', this.unitName, ...this.hcUnits).catch((err) => this.appLog(`systemctl enable: ${(err as Error).message}`));
        const st = await sd.status(this.unitName);
        if (this.disposed) return;
        this.systemdRestarts = st.restarts;
        this.startedAt = st.startedAt || Date.now();
      } else {
        await this.rotateLogs();
        await this.snapshotRpts();
        if (this.disposed) return;
        const spec = buildServerLaunch(this.launchProfile(), this.host.os, rp);
        spec.warnings.forEach((w) => this.appLog(w));
        this.appLog(`Başlatılıyor: ${spec.executable} ${spec.args.map((a) => (/^-password=/i.test(a) ? '-password=***' : a)).join(' ')}`);
        const pid = await this.host.startDetached(spec.executable, spec.args, {
          cwd: spec.cwd,
          logFile: rp.stdoutLog,
          showWindow: this.profile.launch.showConsoleWindow,
        });
        this.startedAt = Date.now();
        this.direct = { pid, startedAt: this.startedAt, executable: spec.executable, marker: this.markerFor(), headless: [] };
        await this.saveState();
        if (this.disposed) return;
      }
      this.attached = true;
      this.readyNotify = readyNotify;
      this.startTails('new');
      this.startMonitor();
      this.startRcon(this.t.rconDelayMs);
      this.armReadiness();
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

  /** Windows: başlatmadan önce var olan .rpt dosyalarını not et; sadece yeni oluşan izlensin. */
  private async snapshotRpts() {
    this.rptSnapshot.clear();
    if (this.host.os !== 'windows') return;
    const rp = this.paths;
    const dirs = [rp.rptDir, ...Array.from({ length: this.profile.headless.count }, (_, i) => rp.headlessProfilesDir(i + 1))];
    for (const dir of dirs) {
      const entries = await this.host.list(dir).catch(() => []);
      this.rptSnapshot.set(dir, new Set(entries.filter((e) => !e.isDir && /\.rpt$/i.test(e.name)).map((e) => e.name)));
    }
  }

  /* ---------------- hazır olma / ölümcül hata ---------------- */

  /**
   * "starting" → "running" geçişi: RCON girişi başarılı olunca ya da sunucu logunda
   * "Host identity created" / "BattlEye Server: Initialized" görülünce. RCON ve log yoksa eski
   * sabit süre kullanılır. startTimeoutSec içinde hazır olmazsa başlatma başarısız sayılır.
   */
  private armReadiness() {
    if (this.disposed) return;
    this.clearReadiness();
    if (this.status !== 'starting') return;
    this.awaitingReady = true;
    const rc = this.rconCfg ?? this.rconSnapshotFrom(this.profile);
    const logAvailable = !this.profile.launch.noLogs;
    if (!rc.enabled && !logAvailable) {
      this.runningTimer = setTimeout(() => this.markReady('süre doldu; RCON ve log yok'), this.t.runningAfterMs);
    }
    const sec = this.profile.supervisor.startTimeoutSec ?? 300;
    this.startTimeoutSec = sec;
    if (sec > 0) {
      const runId = this.runId;
      this.startTimeoutTimer = setTimeout(() => void this.onStartTimeout(sec, runId), sec * 1000);
    }
  }

  private clearReadiness() {
    this.awaitingReady = false;
    if (this.errorMessageTimer) clearTimeout(this.errorMessageTimer);
    this.errorMessageTimer = null;
    if (this.runningTimer) clearTimeout(this.runningTimer);
    if (this.startTimeoutTimer) clearTimeout(this.startTimeoutTimer);
    this.runningTimer = null;
    this.startTimeoutTimer = null;
  }

  private markReady(source: string) {
    if (!this.awaitingReady || this.status !== 'starting' || this.fatalDetail || this.crashToken || this.disposed) return;
    const n = this.readyNotify;
    const runId = this.runId;
    this.setStatus('running');
    this.appLog(`Sunucu hazır (${source})`);
    if (n) this.notify(n.event, n.title, n.description);
    this.startHeadlessClients(runId);
  }

  /** Satırdaki dosya bizim ürettiğimiz config'lerden biri mi (server.cfg, basic.cfg, *.Arma3Profile) */
  private isOwnConfigFile(file: string): boolean {
    const base = file.trim().replace(/^["']|["']$/g, '').split(/[\\/]/).pop()?.toLowerCase() ?? '';
    const rp = this.paths;
    const own = [rp.serverCfg, rp.basicCfg, ...rp.arma3Profiles].map((f) => f.split(/[\\/]/).pop()!.toLowerCase());
    return own.includes(base) || base.endsWith('.arma3profile');
  }

  private inspectServerLines(lines: string[]) {
    const lateWindow = Date.now() < this.lateFatalUntil;
    // Ölümcül hata yalnızca başlatma sırasında (ya da süreç kapandıktan hemen sonra) aranır.
    // Çalışan bir sunucuya bağlanırken tekrar okunan eski satırlar sunucuyu öldürmemeli.
    if (!this.awaitingReady && !lateWindow) return;
    for (const line of lines) {
      const prev = this.recentServerLines.filter((l) => l.trim()).slice(-2);
      this.recentServerLines.push(line);
      if (this.recentServerLines.length > 6) this.recentServerLines.splice(0, this.recentServerLines.length - 6);
      const detail = [...prev, line].join('\n');
      const cfg = CFG_ERROR_RE.exec(line);
      if (cfg && this.isOwnConfigFile(cfg[1]!)) {
        this.onFatal(detail);
        continue;
      }
      if (ERROR_MESSAGE_RE.test(line)) {
        if (lateWindow && !this.awaitingReady) this.onFatal(detail);
        else this.onErrorMessage(detail);
        continue;
      }
      if (this.awaitingReady) {
        this.touchStartTimeout();
        if (READY_RES.some((re) => re.test(line))) this.markReady('log');
      }
    }
  }

  /** "ErrorMessage:" görüldü: hemen öldürme, kısa süre içinde hazır olmazsa başarısız say. */
  private onErrorMessage(detail: string) {
    if (this.errorMessageTimer || this.fatalDetail) return;
    this.lastError = detail;
    this.emitStatus();
    this.notice('warning', `Sunucu logunda hata: ${detail}`, `Error in server log: ${detail}`);
    const runId = this.runId;
    this.errorMessageTimer = setTimeout(() => {
      this.errorMessageTimer = null;
      if (this.disposed || runId !== this.runId || !this.awaitingReady || this.status !== 'starting') return;
      this.onFatal(detail);
    }, this.t.errorMessageGraceMs);
  }

  /** Başlatma zaman aşımı "hazır olmadan bu kadar süre sessiz kalma" demektir: log geldikçe yeniden kurulur. */
  private touchStartTimeout() {
    if (!this.startTimeoutTimer || !this.startTimeoutSec) return;
    clearTimeout(this.startTimeoutTimer);
    const runId = this.runId;
    const sec = this.startTimeoutSec;
    this.startTimeoutTimer = setTimeout(() => void this.onStartTimeout(sec, runId), sec * 1000);
  }

  private onFatal(detail: string) {
    if (this.disposed) return;
    if (this.status === 'starting' || this.status === 'running') {
      if (this.fatalDetail) return;
      this.fatalDetail = detail;
      void this.handleCrash('fatal', detail);
      return;
    }
    // Süreç kendi kapandı (Linux) ve izleme bunu hata satırından önce gördü
    if ((this.status === 'stopped' || this.status === 'crashed') && Date.now() < this.lateFatalUntil && !this.crashToken) {
      this.lateFatalUntil = 0;
      this.fatalDetail = detail;
      this.lastError = detail;
      this.notice('error', `Sunucu hata vererek kapandı: ${detail}`, `Server exited with a fatal error: ${detail}`);
      this.notify('crash', 'Sunucu hata verdi', detail);
      this.setStatus('crashed');
      this.emitStatus();
    }
  }

  private async onStartTimeout(sec: number, runId: number) {
    this.startTimeoutTimer = null;
    if (this.disposed || runId !== this.runId || !this.awaitingReady || this.status !== 'starting' || this.crashToken) return;
    let alive: boolean;
    try {
      alive = await this.isServerAlive();
    } catch {
      // Sorgulanamadı: biraz sonra tekrar dene
      if (runId === this.runId && this.awaitingReady && !this.disposed) {
        this.startTimeoutTimer = setTimeout(() => void this.onStartTimeout(sec, runId), 10_000);
      }
      return;
    }
    // Süreç yoksa izleme (çökme) halleder
    if (!alive || runId !== this.runId || !this.awaitingReady || this.status !== 'starting' || this.disposed) return;
    const last = [...this.recentServerLines].reverse().find((l) => l.trim());
    const tr = `Sunucu hazır olmadan ${sec} sn boyunca log yazmadı (takıldı ya da bir hata penceresi açık)${last ? `\nSon satır: ${last}` : ''}`;
    const en = `Server wrote no log for ${sec} s before becoming ready (stuck or an error dialog is open)${last ? `\nLast line: ${last}` : ''}`;
    await this.handleCrash('timeout', tr, en);
  }

  /* ---------------- headless client'lar ---------------- */

  private clearHcTimers() {
    this.hcTimers.forEach(clearTimeout);
    this.hcTimers = [];
  }

  /** Sunucu hazır olduktan sonra headless client'ları başlat */
  private startHeadlessClients(runId: number) {
    if (this.disposed || this.profile.headless.count <= 0) return;
    if (this.mode === 'direct') {
      this.scheduleHeadless(runId);
      return;
    }
    // systemd: HC'ler ExecStartPre ile bekler; kuyruğa al, bekleme
    void this.host
      .systemd!.startNoBlock(...this.hcUnits)
      .catch((err) =>
        this.notice('warning', `Headless client'lar başlatılamadı: ${(err as Error).message}`, `Headless clients failed to start: ${(err as Error).message}`),
      );
  }

  private scheduleHeadless(runId: number) {
    const p = this.profile;
    if (this.disposed || this.mode !== 'direct' || p.headless.count <= 0) return;
    const t = setTimeout(() => {
      this.hcTimers = this.hcTimers.filter((x) => x !== t);
      if (runId !== this.runId || this.disposed) return;
      for (let i = 1; i <= p.headless.count; i++) void this.startHeadless(i, runId);
    }, p.headless.startDelaySec * 1000);
    this.hcTimers.push(t);
  }

  private async startHeadless(index: number, runId: number) {
    const d = this.direct;
    if (this.disposed || !d || runId !== this.runId || (this.status !== 'running' && this.status !== 'starting')) return;
    const marker = this.markerFor(index);
    // Aynı indeksteki eski HC hâlâ çalışıyorsa önce kapat (çift HC olmasın)
    const old = d.headless.find((h) => h.index === index);
    if (old) {
      try {
        await this.killAndWait(old.pid, old.marker ?? marker, d.executable);
      } catch (err) {
        this.appLog(`Headless client ${index}: eski süreç doğrulanamadı, yenisi başlatılmadı (${(err as Error).message})`);
        return;
      }
      if (this.disposed || runId !== this.runId || this.direct !== d) return;
    }
    const rp = this.paths;
    const spec = buildHeadlessLaunch(this.profile, this.host.os, index, rp);
    try {
      const pid = await this.host.startDetached(spec.executable, spec.args, {
        cwd: spec.cwd,
        logFile: rp.headlessStdoutLog(index),
        showWindow: false,
      });
      if (runId !== this.runId || this.direct !== d) {
        // Bu arada sunucu çöktü/durdu: yeni HC sahipsiz kalmasın
        await this.host.killProcess(pid, { force: true }).catch(() => undefined);
        return;
      }
      d.headless = d.headless.filter((h) => h.index !== index).concat({ index, pid, marker });
      // Önce kaydet (uygulama kapanırsa HC sahipsiz kalmasın), sonra bildir
      await this.saveState().catch((err) => this.appLog(`Durum dosyası yazılamadı: ${(err as Error).message}`));
      this.hcAlive.set(index, true);
      this.appLog(`Headless client ${index} başlatıldı (PID ${pid})`);
      this.emitStatus();
    } catch (err) {
      this.notice('warning', `Headless client ${index} başlatılamadı: ${(err as Error).message}`, `Headless client ${index} failed to start: ${(err as Error).message}`);
    }
  }

  /* ---------------- durdurma ---------------- */

  private async doStop(reason: string, partOfRestart = false): Promise<void> {
    const d = this.direct;
    if (this.status === 'stopped' && !d && this.mode === 'direct') return;
    this.runId++;
    this.clearHcTimers();
    this.setStatus(partOfRestart ? 'restarting' : 'stopping');
    this.stopMonitor();

    // 1) Nazik kapatma: RCON #shutdown (Altis Life gibi görevler veriyi kaydedebilsin)
    const graceMs = this.profile.supervisor.gracefulShutdownSec * 1000;
    if (graceMs > 0 && this.rcon?.state === 'connected') {
      try {
        await this.rcon.shutdown();
        this.appLog('RCON ile #shutdown gönderildi');
      } catch {
        this.appLog('#shutdown onayı gelmedi; yine de kapanması bekleniyor');
      }
      // Onay gelmese bile komut sunucuya ulaşmış olabilir: süreyi bekle
      await this.waitUntilStopped(graceMs).catch(() => undefined);
      if (this.disposed) return;
    }
    this.stopRcon();

    // 2) Süreci durdur
    if (this.mode === 'systemd') {
      const sd = this.host.systemd!;
      await sd.action('stop', this.unitName, ...this.hcUnits).catch((err) => this.appLog(`systemctl stop: ${(err as Error).message}`));
      if (this.disposed) return;
      if (!partOfRestart) await sd.action('disable', this.unitName, ...this.hcUnits).catch(() => undefined);
    } else if (d) {
      const failures: string[] = [];
      const remaining: DirectState['headless'] = [];
      for (const hc of d.headless) {
        try {
          await this.killAndWait(hc.pid, hc.marker ?? this.markerFor(hc.index), d.executable);
        } catch (err) {
          failures.push((err as Error).message);
          remaining.push(hc);
        }
        if (this.disposed) return;
      }
      try {
        await this.killAndWait(d.pid, d.marker, d.executable);
      } catch (err) {
        failures.push((err as Error).message);
      }
      if (this.disposed) return;
      if (failures.length) {
        // Kapatıldığı doğrulanamadı: kaydı silme, "durdu" gösterme (sahipsiz süreç kalmasın)
        d.headless = remaining;
        this.direct = d;
        this.stopPending = true;
        await this.saveState().catch(() => undefined);
        this.startMonitor();
        this.startRcon(0);
        this.setStatus('running');
        const msg = failures.join('; ');
        this.notice(
          'error',
          `Sunucunun kapandığı doğrulanamadı, durdurulmamış olabilir: ${msg}`,
          `Could not verify that the server stopped; it may still be running: ${msg}`,
        );
        throw new Error(`Sunucunun kapandığı doğrulanamadı; tekrar dene (${msg})`);
      }
      this.direct = null;
      await this.host.remove(this.paths.stateFile).catch(() => undefined);
    }
    this.stopPending = false;
    this.hcAlive.clear();
    this.stopTails();
    this.startedAt = 0;
    this.playerCount = 0;
    if (!partOfRestart) {
      this.setStatus('stopped');
      this.notify('stop', 'Sunucu durduruldu', reason === 'manual' ? '' : reason);
    }
  }

  /**
   * PID gerçekten bu profilin süreci mi (komut satırı işaretiyle)? Sonra kapat.
   * Süreç sorgulanamazsa ProcessQueryError fırlatır (yanlış süreci öldürme ya da "durdu" sanma).
   */
  private async killAndWait(pid: number, marker: string | undefined, executable?: string) {
    const exe = executable ?? this.direct?.executable ?? this.paths.executable;
    const alive = async () => processMatches(await this.host.processInfo(pid, { commandLine: !!marker }), exe, marker);
    try {
      if (!(await alive())) return;
    } catch (err) {
      throw new ProcessQueryError(pid, err);
    }
    await this.host.killProcess(pid).catch(() => undefined);
    const until = Date.now() + this.t.stopTimeoutMs;
    while (Date.now() < until) {
      if (!(await alive().catch(() => true))) return;
      await sleep(300);
    }
    this.appLog(`PID ${pid} kapanmadı, zorla sonlandırılıyor`);
    await this.host.killProcess(pid, { force: true }).catch(() => undefined);
    await sleep(500);
  }

  /** Ölümcül hata: nazik kapatma beklemeden zorla kapat (Windows'ta hata penceresi kibar kapatmaya cevap vermez) */
  private async forceKill(pid: number, marker: string | undefined, executable: string) {
    const alive = async () => processMatches(await this.host.processInfo(pid, { commandLine: !!marker }), executable, marker);
    try {
      if (!(await alive())) return;
    } catch (err) {
      // Az önce logunu okuduğumuz süreç: PID'nin bu arada başkasına geçmesi pratikte olmaz
      this.appLog(`PID ${pid} sorgulanamadı (${(err as Error).message}); yine de zorla kapatılıyor`);
    }
    await this.host.killProcess(pid, { force: true }).catch((err) => this.appLog(`PID ${pid} kapatılamadı: ${(err as Error).message}`));
    const until = Date.now() + this.t.stopTimeoutMs;
    while (Date.now() < until) {
      if (!(await alive().catch(() => true))) return;
      await sleep(300);
    }
    this.appLog(`PID ${pid} zorla kapatma sonrası hâlâ çalışıyor`);
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
    const d = this.direct;
    if (!d) return false;
    return processMatches(await this.host.processInfo(d.pid), d.executable);
  }

  /** Durdurma doğrulanamamıştı; süreç artık yok: durdu say */
  private async finalizePendingStop() {
    const d = this.direct;
    if (d) {
      for (const hc of d.headless) await this.killAndWait(hc.pid, hc.marker ?? this.markerFor(hc.index), d.executable).catch(() => undefined);
    }
    if (this.direct !== d) return;
    this.direct = null;
    this.stopPending = false;
    await this.host.remove(this.paths.stateFile).catch(() => undefined);
    this.stopRcon();
    this.hcAlive.clear();
    this.stopTails();
    this.startedAt = 0;
    this.playerCount = 0;
    this.setStatus('stopped');
    this.appLog('Sunucu kapandı');
  }

  /* ---------------- takip (attach) ---------------- */

  /** Uygulama açıldığında zaten çalışan sunucuyu bul ve takip etmeye başla. */
  attach(): Promise<void> {
    // Başlat/durdur sürerken ya da zaten takip ediliyorsa bir şey yapma (çift izleme olmasın)
    if (this.attached || this.busy || this.disposed) return Promise.resolve();
    return this.exclusive(() => this.attachInner());
  }

  /** Discord durum güncelleyicisini başlat (ilk seferde) ya da hemen güncellemeye dürt */
  private kickStatusUpdater() {
    if (this.disposed) return;
    if (this.statusUpdater.isRunning) this.statusUpdater.poke();
    else this.statusUpdater.start();
  }

  private async attachInner(): Promise<void> {
    await this.attachBody();
    // Durum artık gerçek: Discord durum mesajı bundan sonra güncellenebilir
    if (this.attached && !this.disposed && !this.statusUpdater.isRunning) this.statusUpdater.start();
  }

  private async attachBody(): Promise<void> {
    try {
      await this.host.connect();
    } catch (err) {
      this.unreachable = true;
      this.emitStatus();
      throw err;
    }
    if (this.disposed) return;
    this.unreachable = false;
    if (this.mode === 'systemd') {
      const st = await this.host.systemd!.status(this.unitName);
      if (this.disposed) return;
      this.attached = true;
      if (!st.exists || (st.activeState !== 'active' && st.activeState !== 'activating')) {
        this.setStatus('stopped');
        return;
      }
      this.systemdRestarts = st.restarts;
      this.startedAt = st.startedAt || Date.now();
      this.setStatus(st.activeState === 'active' ? 'running' : st.subState === 'auto-restart' ? 'restarting' : 'starting');
    } else {
      const state = await this.loadState();
      if (this.disposed) return;
      if (!state) {
        this.attached = true;
        this.setStatus('stopped');
        return;
      }
      const info = await this.host.processInfo(state.pid, { commandLine: !!state.marker });
      if (this.disposed) return;
      this.attached = true;
      if (!processMatches(info, state.executable, state.marker)) {
        await this.host.remove(this.paths.stateFile).catch(() => undefined);
        this.setStatus('stopped');
        return;
      }
      this.direct = state;
      this.startedAt = state.startedAt;
      for (const hc of state.headless) {
        const hi = await this.host.processInfo(hc.pid, { commandLine: true }).catch(() => ({ pid: hc.pid, alive: false }));
        this.hcAlive.set(hc.index, processMatches(hi, state.executable, hc.marker ?? this.markerFor(hc.index)));
      }
      if (this.disposed) return;
      this.setStatus('running');
    }
    this.fatalDetail = null;
    this.recentServerLines = [];
    this.rconCfg = this.rconSnapshotFrom(this.profile);
    this.appLog('Çalışan sunucu bulundu, takip ediliyor');
    this.startTails('attach');
    this.startMonitor();
    this.startRcon(0);
    // systemd servisi henüz "activating" ise hazır olmasını bekle (yoksa "starting"de kalır)
    if (this.status === 'starting') {
      this.readyNotify = null;
      this.armReadiness();
    }
  }

  private async saveState() {
    if (!this.direct) return;
    await this.host.writeFile(this.paths.stateFile, JSON.stringify(this.direct, null, 2));
  }

  private async loadState(): Promise<DirectState | null> {
    let text: string;
    try {
      text = await this.host.readText(this.paths.stateFile);
    } catch (err) {
      if (await this.host.exists(this.paths.stateFile)) throw err; // okuma hatası: "durdu" sanma
      return null;
    }
    try {
      const raw = JSON.parse(text) as DirectState;
      if (typeof raw.pid !== 'number' || typeof raw.executable !== 'string') return null;
      return { ...raw, headless: Array.isArray(raw.headless) ? raw.headless : [] };
    } catch {
      return null;
    }
  }

  /* ---------------- izleme ---------------- */

  private startMonitor() {
    if (this.disposed) return;
    this.stopMonitor();
    this.monitorTimer = setInterval(() => void this.monitorTick(), this.t.monitorMs);
    this.startPerf();
  }

  private stopMonitor() {
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.monitorTimer = null;
    this.stopPerf();
  }

  /* ---------------- performans izleme ---------------- */

  private startPerf() {
    if (this.disposed) return;
    this.stopPerf();
    const ms = this.t.perfMs > 0 ? this.t.perfMs : this.profile.monitoring.sampleSec * 1000;
    this.perfTimer = setInterval(() => void this.perfTick(), ms);
  }

  private stopPerf() {
    if (this.perfTimer) clearInterval(this.perfTimer);
    this.perfTimer = null;
  }

  /** Sunucu + headless client PID'leri (systemd: servislerin MainPID'i) */
  private async monitoredPids(): Promise<number[]> {
    if (this.mode === 'systemd') {
      const sd = this.host.systemd!;
      const units = [this.unitName, ...this.hcUnits];
      const out: number[] = [];
      for (const u of units) {
        const st = await sd.status(u).catch(() => null);
        if (st && st.mainPid > 0 && st.activeState === 'active') out.push(st.mainPid);
      }
      return out;
    }
    const d = this.direct;
    if (!d) return [];
    return [d.pid, ...d.headless.filter((h) => this.hcAlive.get(h.index)).map((h) => h.pid)];
  }

  /** Tek ölçüm: CPU/RAM + son @oezi_monitor satırı → birleşik örnek, FPS uyarısı */
  private async perfTick() {
    if (this.perfSampling || this.disposed || this.unreachable) return;
    const m = this.profile.monitoring;
    if (!m.enabled || (this.status !== 'running' && this.status !== 'starting')) return;
    this.perfSampling = true;
    try {
      let cpu: number | undefined;
      let memMB: number | undefined;
      const now = Date.now();
      const tickMs = this.t.perfMs > 0 ? this.t.perfMs : m.sampleSec * 1000;
      const procMs = this.t.procStatMs > 0 ? this.t.procStatMs : processStatIntervalMs(this.host.os, m.sampleSec);
      // Zamanlayıcı kayması için biraz tolerans: 10 sn'lik tikte 30 sn'lik ölçüm 3. tikte yapılsın
      const reuse = this.lastProcStat && now - this.lastProcStat.t < procMs - Math.min(1000, tickMs / 2);
      if (reuse) {
        cpu = this.lastProcStat!.cpu;
        memMB = this.lastProcStat!.memMB;
      } else if (typeof this.host.processStats === 'function') {
        const pids = await this.monitoredPids();
        if (pids.length) {
          try {
            const stats = await this.host.processStats(pids);
            if (stats.length) {
              cpu = Math.round(stats.reduce((a, x) => a + x.cpuPercent, 0) * 10) / 10;
              memMB = Math.round(stats.reduce((a, x) => a + x.memMB, 0));
              this.lastProcStat = { t: now, cpu, memMB };
            }
          } catch (err) {
            this.appLogThrottled(`Süreç CPU/RAM ölçülemedi: ${(err as Error).message}`);
          }
        }
      }
      if (this.disposed || (this.status !== 'running' && this.status !== 'starting')) return;
      this.recordSample(Date.now(), cpu, memMB);
    } finally {
      this.perfSampling = false;
    }
  }

  /** Birleşik örneği kaydet ve yay (test için ayrı) */
  private recordSample(t: number, cpu?: number, memMB?: number) {
    const m = this.profile.monitoring;
    // FPS satırı mod'dan sabit aralıkla gelir: örnekleme daha sıksa bile o aralığa göre taze say
    const freshMs = (this.t.perfMs > 0 ? Math.max(this.t.perfMs, 1000) : Math.max(m.sampleSec, MONITOR_SCRIPT_INTERVAL_SEC) * 1000) * 2.5;
    const perf = this.lastPerf && t - this.lastPerf.t <= freshMs ? this.lastPerf : undefined;
    if (!perf && cpu === undefined && memMB === undefined) return;
    const sample: MetricSample = {
      t,
      ...(perf ? { fps: perf.fps, fpsMin: perf.fpsMin, players: perf.players, ai: perf.ai, groups: perf.groups, vehicles: perf.vehicles } : {}),
      ...(cpu !== undefined ? { cpu } : {}),
      ...(memMB !== undefined ? { memMB } : {}),
    };
    this.metricsStore.push(sample);
    this.currentPerf = {
      t,
      ...(sample.fps !== undefined ? { fps: sample.fps } : {}),
      ...(cpu !== undefined ? { cpu } : {}),
      ...(memMB !== undefined ? { memMB } : {}),
      ...(sample.ai !== undefined ? { ai: sample.ai } : {}),
    };
    this.emit('metrics', sample);
    this.emitStatus();
    if (sample.fps !== undefined) this.checkFps(t, sample.fps);
  }

  private checkFps(t: number, fps: number) {
    const m = this.profile.monitoring;
    const ev = this.fpsAlert.update(t, fps, { belowFps: m.fpsAlertBelow, minutes: m.fpsAlertMinutes });
    if (!ev) return;
    if (ev.kind === 'alert') {
      const tr = `Sunucu FPS'i ${m.fpsAlertMinutes} dakikadır ${m.fpsAlertBelow} altında (ortalama ${ev.avgFps}, en düşük ${ev.minFps})`;
      const en = `Server FPS has been below ${m.fpsAlertBelow} for ${m.fpsAlertMinutes} minutes (average ${ev.avgFps}, lowest ${ev.minFps})`;
      this.notice('warning', tr, en);
      this.notifyPerformance('Düşük sunucu FPS', tr);
    } else {
      this.appLog(`Sunucu FPS'i düzeldi (${m.fpsAlertBelow} ve üstü)`);
    }
  }

  /* ---------------- duyurular ---------------- */

  private startAnnouncements() {
    this.stopAnnouncements();
    if (this.disposed) return;
    const a = this.profile.announcements;
    if (!a.enabled || !a.messages.some((x) => x.trim())) return;
    const ms = this.t.announceMs > 0 ? this.t.announceMs : a.intervalMin * 60_000;
    this.announceTimer = setInterval(() => void this.announceTick(), ms);
  }

  private stopAnnouncements() {
    if (this.announceTimer) clearInterval(this.announceTimer);
    this.announceTimer = null;
  }

  /** Sıradaki duyuruyu RCON ile herkese gönder (sırayla, boşlar atlanır) */
  private async announceTick() {
    const a = this.profile.announcements;
    if (this.disposed || !a.enabled || this.status !== 'running' || this.rcon?.state !== 'connected') return;
    const msgs = a.messages.map((x) => x.trim()).filter(Boolean);
    if (!msgs.length) return;
    const i = this.announceIndex % msgs.length;
    try {
      await this.rcon.say(msgs[i]!);
      this.announceIndex = i + 1;
    } catch (err) {
      this.appLogThrottled(`Duyuru gönderilemedi: ${(err as Error).message}`);
    }
  }

  private async monitorTick() {
    if (this.monitoring || this.disposed) return;
    this.monitoring = true;
    try {
      // SSH koptuysa yeniden bağlan (SshHost.connect bağlıysa hiçbir şey yapmaz)
      try {
        await this.host.connect();
        if (this.unreachable) {
          this.unreachable = false;
          this.appLog('Makineye yeniden bağlanıldı');
          this.emitStatus();
        }
      } catch (err) {
        if (!this.unreachable) {
          this.unreachable = true;
          this.emitStatus();
        }
        this.appLogThrottled(`Makineye ulaşılamıyor: ${(err as Error).message}`);
        return;
      }
      if (this.disposed) return;
      // Bağlantı yenilendiyse log takibini de yenile
      if (this.tails.length && this.host.generation !== this.tailsGeneration) this.startTails('resume');
      if (this.mode === 'systemd') await this.monitorSystemd();
      else await this.monitorDirect();
    } catch (err) {
      this.appLogThrottled(`İzleme hatası: ${(err as Error).message}`);
    } finally {
      this.monitoring = false;
    }
  }

  private async monitorDirect() {
    const d = this.direct;
    if (!d || this.busy || this.crashToken) return;
    // processInfo hata fırlatırsa (sorgu başarısız) ölü sayılmaz; üst katman loglar.
    const alive = processMatches(await this.host.processInfo(d.pid), d.executable);
    if (this.direct !== d || this.busy || this.crashToken || this.disposed) return;
    if (alive) {
      this.deadStreak = 0;
    } else if (this.stopPending) {
      await this.finalizePendingStop();
      return;
    } else if (this.status === 'running' || this.status === 'starting') {
      // Tek bir okuma yetmez: art arda N kez yoksa çöktü say
      this.deadStreak++;
      if (this.deadStreak >= this.t.deadConfirmations) {
        this.deadStreak = 0;
        await this.handleCrash('exit');
      }
      return;
    }
    let changed = false;
    for (const hc of d.headless) {
      let hcAlive: boolean;
      try {
        hcAlive = processMatches(await this.host.processInfo(hc.pid), d.executable);
      } catch {
        continue;
      }
      if (this.direct !== d || this.disposed) return;
      if (this.hcAlive.get(hc.index) !== hcAlive) {
        this.hcAlive.set(hc.index, hcAlive);
        changed = true;
      }
      if (!hcAlive && this.status === 'running' && this.profile.supervisor.autoRestart && !this.stopPending) {
        const now = Date.now();
        const hist = (this.hcRestarts.get(hc.index) ?? []).filter((x) => now - x < 3600_000);
        const last = hist[hist.length - 1] ?? 0;
        if (hist.length < HC_MAX_RESTARTS_PER_HOUR && now - last > 15_000) {
          hist.push(now);
          this.hcRestarts.set(hc.index, hist);
          this.appLog(`Headless client ${hc.index} kapanmış, yeniden başlatılıyor`);
          await this.startHeadless(hc.index, this.runId);
        } else if (hist.length >= HC_MAX_RESTARTS_PER_HOUR) {
          this.appLogThrottled(`Headless client ${hc.index} çok sık kapanıyor; otomatik yeniden başlatma durduruldu`);
        }
      }
    }
    if (changed) this.emitStatus();
  }

  private async monitorSystemd() {
    if (this.busy || this.crashToken) return;
    const sd = this.host.systemd!;
    const st = await sd.status(this.unitName);
    if (this.busy || this.crashToken || this.disposed) return;
    if (this.systemdRestarts >= 0 && st.restarts > this.systemdRestarts) {
      this.autoRestarts += st.restarts - this.systemdRestarts;
      this.notice('warning', 'Sunucu çöktü, systemd yeniden başlattı', 'Server crashed and was restarted by systemd');
      this.notify('crash', 'Sunucu çöktü', 'systemd otomatik olarak yeniden başlattı.');
    }
    this.systemdRestarts = st.restarts;
    let changed = false;
    for (let i = 1; i <= this.profile.headless.count; i++) {
      const hs = await sd.status(this.hcUnitName(i)).catch(() => null);
      if (!hs) continue;
      const alive = hs.activeState === 'active';
      if (this.hcAlive.get(i) !== alive) {
        this.hcAlive.set(i, alive);
        changed = true;
      }
    }
    if (this.busy || this.crashToken || this.disposed) return;
    const prev = this.status;
    if (st.activeState === 'active') {
      if (st.startedAt) this.startedAt = st.startedAt;
      if (prev === 'starting') {
        // Hazır olma sinyali beklenmiyorsa (ör. eski sürümden kalma durum) servis yeterince süredir aktifse çalışıyor say
        if (!this.awaitingReady && Date.now() - (this.startedAt || Date.now()) >= this.t.runningAfterMs) this.setStatus('running');
      } else if (prev !== 'running') {
        this.setStatus('running');
        if (!this.rcon) this.startRcon(this.t.rconDelayMs);
      }
    } else if (st.activeState === 'activating' && st.subState === 'auto-restart') {
      this.setStatus('restarting');
    } else if (st.activeState === 'failed') {
      if (prev !== 'crashed') {
        this.notice('error', 'Sunucu çöktü ve systemd yeniden başlatmayı bıraktı (çok fazla çökme).', 'Server crashed and systemd gave up restarting (too many crashes).');
        this.notify('crash', 'Sunucu çöktü', 'Çok fazla çökme: otomatik restart durdu.');
      }
      this.stopRcon();
      this.setStatus('crashed');
    } else if (st.activeState === 'inactive' && (prev === 'running' || prev === 'starting')) {
      this.stopRcon();
      if (this.fatalDetail) {
        await this.handleCrash('fatal', this.fatalDetail);
        return;
      }
      this.setStatus('stopped');
      this.lateFatalUntil = Date.now() + 10_000;
      this.appLog('Sunucu kapandı');
    }
    if (changed) this.emitStatus();
  }

  /**
   * Çökme / ölümcül hata / başlatma zaman aşımı.
   * - exit: süreç beklenmedik şekilde kapandı → (açıksa) otomatik restart
   * - fatal: logda ölümcül hata → zorla kapat, otomatik restart YOK (aynı hata tekrarlanır)
   * - timeout: startTimeoutSec içinde hazır olmadı → zorla kapat, otomatik restart sayılır
   */
  private async handleCrash(kind: CrashKind, detail?: string, detailEn?: string) {
    if (this.crashToken || this.disposed) return;
    const token = {};
    this.crashToken = token;
    try {
      await this.handleCrashInner(token, kind, detail, detailEn);
    } finally {
      if (this.crashToken === token) this.crashToken = null;
    }
  }

  private async handleCrashInner(token: object, kind: CrashKind, detail?: string, detailEn?: string) {
    const gen = this.opGen;
    if (this.busy) {
      // Başlatma bitene kadar bekle (durdurma/restart ise o çalıştırma zaten bitti)
      const runId = this.runId;
      await this.busy.catch(() => undefined);
      if (this.cancelled(gen) || runId !== this.runId || (this.status !== 'starting' && this.status !== 'running')) return;
    }
    // Bu çalıştırmanın HC zamanlayıcıları ve süren HC başlatmaları geçersiz
    this.runId++;
    this.clearHcTimers();
    this.clearReadiness();
    this.stopRcon();
    if (kind === 'exit') {
      this.notice('error', 'Sunucu beklenmedik şekilde kapandı (çöktü)', 'Server stopped unexpectedly (crashed)');
    } else if (kind === 'fatal') {
      this.lastError = detail;
      this.notice('error', `Sunucu hata verdi, kapatılıyor: ${detail}`, `Server reported a fatal error, shutting it down: ${detail}`);
    } else {
      this.lastError = detail;
      this.notice('error', detail ?? 'Sunucu hazır olmadı', detailEn ?? detail ?? 'Server was not ready');
    }
    this.emitStatus();

    // Süreçleri kapat
    const d = this.direct;
    if (this.mode === 'direct' && d) {
      if (kind !== 'exit') await this.forceKill(d.pid, d.marker, d.executable);
      if (this.cancelled(gen)) return;
      // Headless client'ları da kapat (önce gerçekten bizim süreçlerimiz mi kontrol et)
      for (const hc of d.headless) {
        await this.killAndWait(hc.pid, hc.marker ?? this.markerFor(hc.index), d.executable).catch((err) => this.appLog(`Headless client ${hc.index}: ${(err as Error).message}`));
        if (this.cancelled(gen)) return;
      }
    } else if (this.mode === 'systemd' && kind !== 'exit') {
      await this.host.systemd!.action('stop', this.unitName, ...this.hcUnits).catch((err) => this.appLog(`systemctl stop: ${(err as Error).message}`));
      if (this.cancelled(gen)) return;
    }
    this.hcAlive.clear();

    // Süreç kapanırken gelen hata satırı da hesaba katılsın
    const fatal = this.fatalDetail;
    if (fatal && kind !== 'fatal') {
      this.lastError = fatal;
      this.notice('error', `Sunucu hata vererek kapandı: ${fatal}`, `Server exited with a fatal error: ${fatal}`);
    }
    const sup = this.profile.supervisor;
    const now = Date.now();
    this.restartHistory = this.restartHistory.filter((t) => now - t < 3600_000);
    const title = fatal ? 'Sunucu hata verdi' : kind === 'timeout' ? 'Sunucu hazır olmadı' : 'Sunucu çöktü';
    const text = fatal ?? (kind === 'timeout' ? detail : undefined);
    if (!fatal && sup.autoRestart && this.restartHistory.length < sup.maxRestartsPerHour) {
      this.restartHistory.push(now);
      this.autoRestarts++;
      this.notify('crash', title, `${text ? `${text}\n` : ''}Otomatik yeniden başlatılıyor (${sup.restartDelaySec} sn).`);
      this.setStatus('restarting');
      this.direct = null;
      await sleep(sup.restartDelaySec * 1000);
      if (this.cancelled(gen) || this.status !== 'restarting') return;
      // Yeni çalıştırmanın ölümcül hatası yakalanabilsin
      if (this.crashToken === token) this.crashToken = null;
      try {
        await this.exclusive(() => this.doStart(null));
      } catch {
        if (!this.cancelled(gen) && (this.status === 'restarting' || this.status === 'stopped')) this.setStatus('crashed');
      }
    } else {
      this.notify(
        'crash',
        title,
        text ?? (sup.autoRestart ? 'Bir saatte çok fazla çökme: otomatik restart durduruldu.' : 'Otomatik restart kapalı.'),
      );
      if (!fatal && sup.autoRestart) {
        this.notice('error', 'Bir saat içinde çok fazla çökme: otomatik restart durduruldu.', 'Too many crashes within an hour: auto restart paused.');
      }
      this.direct = null;
      await this.host.remove(this.paths.stateFile).catch(() => undefined);
      if (this.cancelled(gen)) return;
      this.stopTails();
      if (!fatal) this.lateFatalUntil = Date.now() + 10_000;
      this.setStatus('crashed');
    }
  }

  /* ---------------- loglar ---------------- */

  private stopTails() {
    this.tails.forEach((t) => t.stop());
    this.tails = [];
  }

  private startTails(kind: TailKind) {
    if (this.disposed) return;
    this.stopTails();
    this.tailsGeneration = this.host.generation;
    const rp = this.paths;
    const count = this.profile.headless.count;
    if (this.mode === 'systemd') {
      // journald: dosya yolu/dönüşüm sorunları yok
      const since = kind === 'resume' ? Promise.resolve(0) : this.journalSince();
      this.tails.push(this.followJournal(this.unitName, 'server', 300, kind, since));
      for (let i = 1; i <= count; i++) this.tails.push(this.followJournal(this.hcUnitName(i), `hc${i}`, 50, kind, since));
      return;
    }
    if (this.host.os === 'windows') {
      this.tails.push(this.rptWatcher(rp.rptDir, 'server', kind));
      for (let i = 1; i <= count; i++) this.tails.push(this.rptWatcher(rp.headlessProfilesDir(i), `hc${i}`, kind));
    } else {
      const opts = kind === 'resume' ? { initialLines: 0 } : kind === 'attach' ? { initialLines: 300 } : { fromStart: true };
      this.tails.push(this.host.tail(rp.stdoutLog, (lines) => this.pushLog('server', lines), opts));
      for (let i = 1; i <= count; i++) {
        const hcOpts = kind === 'resume' ? { initialLines: 0 } : kind === 'attach' ? { initialLines: 50 } : { fromStart: true };
        this.tails.push(this.host.tail(rp.headlessStdoutLog(i), (lines) => this.pushLog(`hc${i}`, lines), hcOpts));
      }
    }
  }

  /** Uzak makine saati ile bu bilgisayarın saati arasındaki fark (ms). Bilinemiyorsa null. */
  private async remoteClockOffset(): Promise<number | null> {
    try {
      const t0 = Date.now();
      let remote: number;
      let at: number;
      if (typeof this.host.getRemoteTime === 'function') {
        // Host gecikmenin yarısını zaten ekliyor: dönüş anına göre karşılaştır
        remote = await this.host.getRemoteTime();
        at = Date.now();
      } else {
        const res = await this.host.exec('date', ['+%s%3N'], { timeoutMs: 10_000 });
        if (res.code !== 0) return null;
        remote = Number(res.stdout.trim());
        at = (t0 + Date.now()) / 2;
      }
      if (!Number.isFinite(remote) || remote <= 0) return null;
      if (remote < 1e11) remote *= 1000; // saniye döndüyse
      return remote - at;
    } catch {
      return null;
    }
  }

  /** journalctl --since değeri (saniye, VPS saatine göre): bu çalıştırmanın ilk satırları kaçmasın */
  private async journalSince(): Promise<number> {
    const base = this.startedAt || Date.now();
    const offset = await this.remoteClockOffset();
    if (offset !== null) return Math.floor((base + offset) / 1000) - 2;
    return Math.floor(base / 1000) - JOURNAL_MARGIN_SEC;
  }

  private followJournal(unit: string, source: string, initial: number, kind: TailKind, since: Promise<number>): TailHandle {
    let stopped = false;
    let inner: TailHandle | null = null;
    const base = ['-u', unit, '-f', '-o', 'cat', '--no-pager'];
    const resumeArgs = [...base, '-n', '0'];
    const begin = (args: string[]) => {
      if (stopped || this.disposed) return;
      inner = this.host.followCommand(
        'journalctl',
        args,
        (lines) => {
          if (!stopped) this.pushLog(source, lines);
        },
        { resumeArgs, privileged: true },
      );
    };
    if (kind === 'resume') begin(resumeArgs);
    else {
      void since.then((sec) => {
        // attach: sadece bu çalıştırmanın satırları (önceki çalıştırmanın hatası yeniden yakalanmasın), en fazla N satır
        begin(kind === 'attach' ? [...base, '--since', `@${sec}`, '-n', String(initial)] : [...base, '--since', `@${sec}`]);
      });
    }
    return {
      stop: () => {
        stopped = true;
        inner?.stop();
      },
    };
  }

  /**
   * Windows: Arma her başlatmada yeni bir .rpt dosyası açar.
   * - new: başlatmadan önceki listede olmayan ilk dosya beklenir (önceki çalıştırmanın logu izlenmez)
   * - attach/resume: en yenisi
   * Klasör düzenli olarak yeniden listelenir; daha yeni bir .rpt çıkarsa ona geçilir.
   */
  private rptWatcher(dir: string, source: string, kind: TailKind): TailHandle {
    const L = pathLib(this.host.os);
    let stopped = false;
    let inner: TailHandle | null = null;
    let current: string | null = null;
    const snapshot = kind === 'new' ? (this.rptSnapshot.get(dir) ?? new Set<string>()) : null;
    const known = new Set<string>();
    const loop = async () => {
      let first = true;
      while (!stopped && !this.disposed) {
        const entries = await this.host.list(dir).catch(() => null);
        if (stopped || this.disposed) break;
        if (entries) {
          const rpts = entries.filter((e) => !e.isDir && /\.rpt$/i.test(e.name) && !snapshot?.has(e.name));
          const candidates = current === null ? rpts : rpts.filter((e) => !known.has(e.name));
          rpts.forEach((e) => known.add(e.name));
          const pick = candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
          if (pick && pick.name !== current) {
            inner?.stop();
            const opts = first && kind === 'attach' ? { initialLines: 300 } : first && kind === 'resume' ? { initialLines: 0 } : { fromStart: true };
            inner = this.host.tail(L.join(dir, pick.name), (lines) => {
              if (!stopped) this.pushLog(source, lines);
            }, opts);
            if (current !== null) this.appLog(`${source}: yeni log dosyası izleniyor (${pick.name})`);
            current = pick.name;
            first = false;
          }
        }
        // Dosya bulunduktan sonra daha seyrek bak (yeni .rpt sadece süreç yeniden başlarsa çıkar)
        await sleep(current ? this.t.rptPollMs * 2.5 : this.t.rptPollMs);
      }
    };
    void loop();
    return {
      stop: () => {
        stopped = true;
        inner?.stop();
      },
    };
  }

  /* ---------------- RCON ---------------- */

  private startRcon(delayMs: number) {
    if (this.disposed) return;
    const c = this.rconCfg ?? this.rconSnapshotFrom(this.profile);
    if (!c.enabled) return;
    if (this.rconTimer) clearTimeout(this.rconTimer);
    this.rconTimer = setTimeout(() => {
      this.rconTimer = null;
      if (this.disposed) return;
      if (this.status !== 'running' && this.status !== 'starting') return;
      if (this.rcon) return;
      const rcon = new BattlEyeRcon({ host: c.host, port: c.port, password: c.password, reconnect: true, reconnectDelayMs: 10_000 });
      this.rcon = rcon;
      rcon.on('state', (s, reason) => {
        if (s === 'connected') {
          this.appLog(`RCON bağlandı (${c.host}:${c.port})`);
          this.markReady('RCON');
          void this.refreshPlayers();
        }
        if (s === 'disconnected' && reason && reason !== 'Kapatıldı') this.appLogThrottled(`RCON bağlantısı yok: ${reason}`);
        this.emitStatus();
      });
      rcon.on('message', (m) => this.emit('rconMessage', m));
      rcon.connect().catch((err) => {
        if ((err as { code?: string }).code === 'auth_failed') {
          this.notice('error', 'RCON şifresi kabul edilmedi', 'RCON password rejected');
        }
      });
      if (this.playersTimer) clearInterval(this.playersTimer);
      this.playersTimer = setInterval(() => void this.refreshPlayers(), this.t.playersMs);
    }, delayMs);
  }

  async refreshPlayers(): Promise<RconPlayer[]> {
    if (this.rcon?.state !== 'connected') return [];
    try {
      const players = await this.rcon.players();
      this.lastPlayers = players;
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

  /** Sıradaki restart zamanını hesapla (gerekirse) */
  private refreshSchedule(now: Date) {
    const sup = this.profile.supervisor;
    if (!sup.scheduledRestarts.length) {
      if (this.scheduledFor) {
        this.scheduledFor = null;
        this.emitStatus();
      }
      return;
    }
    if (!this.scheduledFor) {
      const next = nextOccurrence(sup.scheduledRestarts, now);
      this.scheduledFor = next ? next.getTime() : null;
      this.warningsSent.clear();
      this.emitStatus();
    }
  }

  /** Aynı restart için aynı açıklamayı bir kez logla */
  private scheduleLog(at: number, what: string, line: string) {
    if (this.scheduleNote?.at === at && this.scheduleNote.what === what) return;
    this.scheduleNote = { at, what };
    this.appLog(line);
  }

  private async schedulerTick(now = new Date()) {
    if (this.disposed) return;
    const nowMs = now.getTime();
    if (this.scheduledFor && nowMs >= this.scheduledFor + 60_000) {
      // Zamanı geçti ve yapılamadı (bilgisayar uykudaydı, makineye ulaşılamadı, başka işlem sürüyordu...)
      if (this.status !== 'stopped' && this.status !== 'crashed') {
        this.appLog(`Zamanlı restart (${fmtTime(this.scheduledFor)}) kaçırıldı (bilgisayar uykuda mıydı / makineye ulaşılamadı mı?); bir sonrakine geçiliyor`);
      }
      this.scheduledFor = null;
    }
    this.refreshSchedule(now);
    const at = this.scheduledFor;
    if (!at) return;
    const sup = this.profile.supervisor;

    // Uyarılar: sadece gerçekten gönderildiyse "gönderildi" say (RCON yeniden bağlanıyorsa sonraki turda tekrar dene)
    if (this.status === 'running' && nowMs < at) {
      const plan = planWarning(new Date(at), now, sup.warnMinutes, this.warningsSent);
      if (plan && this.rcon?.state === 'connected') {
        try {
          await this.rcon.say(formatWarning(sup.warnMessage, plan.minutes));
          if (this.scheduledFor === at) plan.marks.forEach((m) => this.warningsSent.add(m));
          this.appLog(`Restart uyarısı gönderildi (${plan.minutes} dk)`);
        } catch (err) {
          this.appLogThrottled(`Restart uyarısı gönderilemedi, tekrar denenecek: ${(err as Error).message}`);
        }
      }
    }
    if (nowMs < at || this.disposed) return;

    if (this.status === 'stopped' || this.status === 'crashed') {
      this.appLog(`Sunucu çalışmıyor; zamanlı restart (${fmtTime(at)}) atlandı`);
      this.scheduledFor = null;
      this.emitStatus();
      return;
    }
    if (this.busy || this.status !== 'running') {
      this.scheduleLog(at, 'busy', `Başka bir işlem sürüyor (${this.status}); zamanlı restart (${fmtTime(at)}) erteleniyor`);
      return;
    }
    if (this.unreachable) {
      this.scheduleLog(at, 'unreachable', `Makineye ulaşılamıyor; zamanlı restart (${fmtTime(at)}) erteleniyor`);
      return;
    }
    this.scheduledFor = null;
    this.appLog('Zamanlı restart başlıyor');
    await this.restart({ update: sup.updateOnScheduledRestart, reason: 'Zamanlı restart' }).catch((err) =>
      this.notice('error', `Zamanlı restart başarısız: ${(err as Error).message}`, `Scheduled restart failed: ${(err as Error).message}`),
    );
  }

  /** Test ve "şimdi kontrol et" için */
  runSchedulerTick(now?: Date) {
    return this.schedulerTick(now);
  }

  dispose() {
    this.disposed = true;
    this.opGen++;
    this.runId++;
    if (this.schedulerTimer) clearInterval(this.schedulerTimer);
    this.clearReadiness();
    this.clearHcTimers();
    this.stopMonitor();
    this.stopTails();
    this.stopRcon();
    this.stopAnnouncements();
    this.statusUpdater.stop();
    this.removeAllListeners();
  }
}
