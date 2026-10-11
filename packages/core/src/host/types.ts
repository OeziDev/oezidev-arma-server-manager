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
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  /** stdin'e yazılacak veri */
  input?: string;
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
}

export interface TailHandle {
  stop(): void;
}

export interface TailOptions {
  /** Başlangıçta gösterilecek son satır sayısı */
  initialLines?: number;
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
  /** Atomik yazar (geçici dosya + yeniden adlandırma), üst klasörleri oluşturur. */
  writeFile(path: string, data: string | Buffer): Promise<void>;
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
  processInfo(pid: number): Promise<ProcessInfo>;
  killProcess(pid: number, opts?: { force?: boolean }): Promise<void>;
  tail(path: string, onLines: (lines: string[]) => void, opts?: TailOptions): TailHandle;

  /** Linux'ta systemd varsa (ve yetki yeterliyse) */
  readonly systemd?: SystemdApi;
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
