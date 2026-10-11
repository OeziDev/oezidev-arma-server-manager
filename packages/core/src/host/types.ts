import type { HostOs } from '../launch/paths.js';

export interface DirEntry {
  name: string;
  isDir: boolean;
  isSymlink: boolean;
  size: number;
  mtimeMs: number;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** timeoutMs aşıldı: süreç (grubu) öldürüldü, `code` null döner */
  timedOut?: boolean;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  /** stdin'e yazılacak veri */
  input?: string;
  /** Girdi yazıldıktan sonra stdin kapatılsın (istem bekleyen programlar EOF alıp çıksın) */
  closeStdin?: boolean;
}

export interface StreamingProcess {
  /** Uzak/yerel süreç kimliği (biliniyorsa) */
  readonly pid: Promise<number | undefined>;
  onData(cb: (chunk: string, stream: 'stdout' | 'stderr') => void): void;
  write(data: string): void;
  kill(): Promise<void>;
  /** Çıkış kodu */
  wait(): Promise<number | null>;
}

export interface WriteFileOptions {
  /**
   * Dosya izinleri (ör. 0o600: şifre içeren server.cfg / beserver_x64.cfg başkaları tarafından okunmasın).
   * Verilmezse eski davranış: 0o666 & umask. Windows'ta yok sayılır.
   */
  mode?: number;
}

export interface DetachedOptions {
  cwd: string;
  /** stdout + stderr bu dosyaya eklenir */
  logFile: string;
  env?: Record<string, string>;
  /** Windows: sunucunun konsol penceresi görünsün mü */
  showWindow?: boolean;
}

export interface ProcessInfo {
  pid: number;
  alive: boolean;
  /** Çalıştırılabilir dosya adı (küçük harf), PID yeniden kullanımını ayırt etmek için */
  image?: string;
  /** Linux süreç adı (en fazla 15 karakter; betiklerde betik adı) */
  comm?: string;
  /** Tam komut satırı (istenirse) */
  commandLine?: string;
}

/** Windows yolu mu? (C:\yol, \\sunucu\pay, ters bölü içeren ya da .exe) */
function looksWindows(executablePath: string, marker?: string): boolean {
  return /^[a-z]:[\\/]|\\/i.test(executablePath) || /\.exe$/i.test(executablePath) || (!!marker && /\\|=[a-z]:/i.test(marker));
}

/**
 * Komut satırını/işareti karşılaştırma için normalleştirir.
 * Windows: küçük harf, / -> \, tırnaklar atılır (yollarda " olamaz), çift ayraçlar teklenir.
 * Her iki sistemde de sınırdan (boşluk, tırnak, son) hemen önceki sondaki ayraç atılır:
 * "-profiles=C:\yol\" ile "-profiles=C:\yol" aynı sayılır.
 */
function normalizeForMatch(s: string, windows: boolean): string {
  if (windows) {
    return s
      .toLowerCase()
      .replace(/\//g, '\\')
      .replace(/"/g, '')
      .replace(/\\{2,}/g, '\\')
      .replace(/\\(?=\s|$)/g, '');
  }
  return s.replace(/\/{2,}/g, '/').replace(/\/(?=["'\s]|$)/g, '');
}

/**
 * İşaret komut satırında TAM bir argüman olarak geçiyor mu?
 * Önünde: satır başı, boşluk veya tırnak. Arkasında: satır sonu, tırnak ya da boşluk + yeni argüman (-...) / satır sonu.
 * Böylece "-profiles=/p" işareti "-profiles=/p/hc1"i, "hc1" işareti "hc10"u, ".../57-alay" ".../57-alay-test"i eşlemez.
 */
export function commandLineHasMarker(commandLine: string, marker: string, windows = false): boolean {
  const line = normalizeForMatch(commandLine, windows).trim();
  const m = normalizeForMatch(marker, windows).trim();
  if (!m) return true;
  for (let i = line.indexOf(m); i >= 0; i = line.indexOf(m, i + 1)) {
    const before = i === 0 ? '' : line[i - 1]!;
    if (before !== '' && !/[\s"']/.test(before)) continue;
    const rest = line.slice(i + m.length);
    if (rest === '' || /^["']/.test(rest) || /^\s+(?:$|[-"'])/.test(rest)) return true;
  }
  return false;
}

/** PID'deki süreç bizim başlattığımız çalıştırılabilir dosya mı? (PID yeniden kullanımına karşı) */
export function processMatches(info: ProcessInfo, executablePath: string, marker?: string): boolean {
  if (!info.alive) return false;
  const base = executablePath.split(/[\\/]/).pop()!.toLowerCase();
  const nameOk = (!info.image && !info.comm) || info.image === base || (info.comm !== undefined && info.comm === base.slice(0, 15));
  if (!nameOk) return false;
  // Aynı makinede birden fazla sunucu aynı exe ile çalışır: komut satırındaki işaret (ör. -profiles=...) ayırt eder.
  // Düz alt dize araması yetmez (sunucu işareti HC'leri, hc1 hc10'u eşlerdi): argüman sınırı aranır.
  if (marker && info.commandLine !== undefined) return commandLineHasMarker(info.commandLine, marker, looksWindows(executablePath, marker));
  return true;
}

export interface TailHandle {
  stop(): void;
}

export interface TailOptions {
  /** Başlangıçta gösterilecek son satır sayısı */
  initialLines?: number;
  /** Dosyayı baştan oku (yeni başlatılan sunucunun logu için; ilk satırlar kaçmasın) */
  fromStart?: boolean;
}

export interface SystemdStatus {
  activeState: string; // active | inactive | failed | activating | deactivating
  subState: string;
  mainPid: number;
  restarts: number;
  /** Unix ms; çalışmıyorsa 0 */
  startedAt: number;
  exists: boolean;
}

export interface SystemdApi {
  unitPath(name: string): string;
  writeUnit(name: string, content: string): Promise<void>;
  removeUnit(name: string): Promise<void>;
  daemonReload(): Promise<void>;
  action(action: 'start' | 'stop' | 'restart' | 'enable' | 'disable' | 'reset-failed', ...units: string[]): Promise<void>;
  /** Başlatmayı beklemeden kuyruğa al (ExecStartPre gecikmesi olan servisler için) */
  startNoBlock(...units: string[]): Promise<void>;
  status(name: string): Promise<SystemdStatus>;
}

/**
 * Sunucunun çalıştığı makine. Yerel bilgisayar ya da SSH ile bağlanılan bir Linux sunucusu.
 * Bütün dosya ve süreç işlemleri buradan geçer; üst katmanlar hangisi olduğunu bilmez.
 */
export interface Host {
  readonly id: string;
  readonly kind: 'local' | 'ssh';
  readonly label: string;
  /** connect() sonrasında kesinleşir */
  readonly os: HostOs;

  connect(): Promise<void>;
  close(): Promise<void>;
  isConnected(): boolean;

  readFile(path: string): Promise<Buffer>;
  readText(path: string): Promise<string>;
  /** Atomik yazar (geçici dosya + yeniden adlandırma), üst klasörleri oluşturur. `opts.mode` ile izin verilebilir (ör. 0o600). */
  writeFile(path: string, data: string | Buffer, opts?: WriteFileOptions): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<{ isDir: boolean; size: number; mtimeMs: number } | null>;
  list(path: string): Promise<DirEntry[]>;
  mkdirp(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string, opts?: { recursive?: boolean }): Promise<void>;
  copyFile(from: string, to: string): Promise<void>;
  /** Klasör bağlantısı: Windows'ta junction (yönetici izni gerekmez), Linux'ta symlink. */
  linkDir(target: string, linkPath: string): Promise<void>;
  readLink(path: string): Promise<string | null>;
  /** Bu bilgisayardaki bir dosyayı host'a kopyalar. */
  upload(localPath: string, remotePath: string): Promise<void>;

  exec(file: string, args: string[], opts?: ExecOptions): Promise<ExecResult>;
  spawn(file: string, args: string[], opts?: ExecOptions): StreamingProcess;
  startDetached(file: string, args: string[], opts: DetachedOptions): Promise<number>;
  /** Süreç yoksa alive:false döner; sorgunun kendisi başarısız olursa hata fırlatır. */
  processInfo(pid: number, opts?: { commandLine?: boolean }): Promise<ProcessInfo>;
  killProcess(pid: number, opts?: { force?: boolean }): Promise<void>;
  tail(path: string, onLines: (lines: string[]) => void, opts?: TailOptions): TailHandle;
  /**
   * Uzun süren bir komutun (journalctl -f gibi) stdout satırlarını takip eder.
   * Komut beklenmedik şekilde biterse (bağlantı koptu vb.) `resumeArgs` ile yeniden başlatılır.
   */
  followCommand(file: string, args: string[], onLines: (lines: string[]) => void, opts?: { resumeArgs?: string[]; privileged?: boolean }): TailHandle;

  /** Linux'ta systemd varsa (ve yetki yeterliyse) */
  readonly systemd?: SystemdApi;
  /** Her başarılı (yeniden) bağlantıda artar; uzun süreli akışların yenilenmesi için */
  readonly generation: number;
  /**
   * Host'un saatine göre şu anki zaman (Unix ms). Yerelde Date.now(); SSH'ta uzak `date` (gecikmenin yarısı eklenir).
   * journalctl --since gibi uzak saatle karşılaştırılan değerler için (VPS saati kayık olabilir).
   */
  getRemoteTime?(): Promise<number>;
}

export class HostError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'HostError';
  }
}

/** Satır arabelleği: parçalı gelen veriyi tam satırlara böler. */
export class LineSplitter {
  private buf = '';
  push(chunk: string): string[] {
    this.buf += chunk;
    const parts = this.buf.split(/\r?\n/);
    this.buf = parts.pop() ?? '';
    return parts;
  }
  flush(): string[] {
    const rest = this.buf;
    this.buf = '';
    return rest ? [rest] : [];
  }
}
