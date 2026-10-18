import type {
  WriteFileOptions,
  DetachedOptions,
  DirEntry,
  ExecOptions,
  ExecResult,
  Host,
  HostOs,
  ProcessInfo,
  SshHost,
  StreamingProcess,
  SystemdApi,
  SystemdStatus,
  TailHandle,
  TailOptions,
} from '@oezi/arma-core';

/**
 * SSH makinesi için tembel sarmalayıcı: asıl SshHost ilk kullanımda kurulur.
 * Kurulum başarısız olursa (anahtar dosyası geçici olarak okunamıyor vb.) hata o işleme döner ve
 * bir sonraki connect()/işlemde yeniden denenir. Böylece SSH profili hiçbir zaman yerel makineye düşmez.
 */
export class LazySshHost implements Host {
  readonly kind = 'ssh' as const;
  readonly systemd: SystemdApi;
  private inner: SshHost | null = null;

  constructor(
    readonly id: string,
    private readonly fallbackLabel: string,
    private readonly factory: () => SshHost,
  ) {
    const sd = (): SystemdApi => {
      const s = this.get().systemd;
      if (!s) throw new Error('systemd kullanılamıyor');
      return s;
    };
    this.systemd = {
      unitPath: (name: string) => sd().unitPath(name),
      writeUnit: (name: string, content: string) => this.call(() => sd().writeUnit(name, content)),
      removeUnit: (name: string) => this.call(() => sd().removeUnit(name)),
      daemonReload: () => this.call(() => sd().daemonReload()),
      action: (action, ...units: string[]) => this.call(() => sd().action(action, ...units)),
      startNoBlock: (...units: string[]) => this.call(() => sd().startNoBlock(...units)),
      status: (name: string): Promise<SystemdStatus> => this.call(() => sd().status(name)),
    };
  }

  /** Asıl bağlantı nesnesi (kurulamazsa hata fırlatır; sonraki çağrıda tekrar dener) */
  get(): SshHost {
    if (!this.inner) this.inner = this.factory();
    return this.inner;
  }

  /** Kurulmuşsa asıl bağlantı nesnesi */
  peek(): SshHost | null {
    return this.inner;
  }

  private call<T>(fn: (h: SshHost) => Promise<T>): Promise<T> {
    try {
      return fn(this.get());
    } catch (err) {
      return Promise.reject(err);
    }
  }

  get label(): string {
    return this.inner?.label ?? this.fallbackLabel;
  }

  get os(): HostOs {
    return this.inner?.os ?? 'linux';
  }

  get generation(): number {
    return this.inner?.generation ?? 0;
  }

  isConnected(): boolean {
    return this.inner?.isConnected() ?? false;
  }

  connect(): Promise<void> {
    return this.call((h) => h.connect());
  }

  async close(): Promise<void> {
    await this.inner?.close();
  }

  readFile(p: string): Promise<Buffer> {
    return this.call((h) => h.readFile(p));
  }
  readText(p: string): Promise<string> {
    return this.call((h) => h.readText(p));
  }
  writeFile(p: string, data: string | Buffer, opts?: WriteFileOptions): Promise<void> {
    return this.call((h) => h.writeFile(p, data, opts));
  }

  getRemoteTime(): Promise<number> {
    return this.call((h) => h.getRemoteTime());
  }
  udpPortOwners(ports: number[]): Promise<{ port: number; pid?: number; process?: string }[]> {
    return this.call((h) => h.udpPortOwners(ports));
  }
  exists(p: string): Promise<boolean> {
    return this.call((h) => h.exists(p));
  }
  stat(p: string): Promise<{ isDir: boolean; size: number; mtimeMs: number } | null> {
    return this.call((h) => h.stat(p));
  }
  list(p: string): Promise<DirEntry[]> {
    return this.call((h) => h.list(p));
  }
  mkdirp(p: string): Promise<void> {
    return this.call((h) => h.mkdirp(p));
  }
  rename(from: string, to: string): Promise<void> {
    return this.call((h) => h.rename(from, to));
  }
  remove(p: string, opts?: { recursive?: boolean }): Promise<void> {
    return this.call((h) => h.remove(p, opts));
  }
  copyFile(from: string, to: string): Promise<void> {
    return this.call((h) => h.copyFile(from, to));
  }
  linkDir(target: string, linkPath: string): Promise<void> {
    return this.call((h) => h.linkDir(target, linkPath));
  }
  readLink(p: string): Promise<string | null> {
    return this.call((h) => h.readLink(p));
  }
  upload(localPath: string, remotePath: string): Promise<void> {
    return this.call((h) => h.upload(localPath, remotePath));
  }
  exec(file: string, args: string[], opts?: ExecOptions): Promise<ExecResult> {
    return this.call((h) => h.exec(file, args, opts));
  }
  spawn(file: string, args: string[], opts?: ExecOptions): StreamingProcess {
    return this.get().spawn(file, args, opts);
  }
  startDetached(file: string, args: string[], opts: DetachedOptions): Promise<number> {
    return this.call((h) => h.startDetached(file, args, opts));
  }
  processInfo(pid: number, opts?: { commandLine?: boolean }): Promise<ProcessInfo> {
    return this.call((h) => h.processInfo(pid, opts));
  }
  killProcess(pid: number, opts?: { force?: boolean }): Promise<void> {
    return this.call((h) => h.killProcess(pid, opts));
  }
  tail(p: string, onLines: (lines: string[]) => void, opts?: TailOptions): TailHandle {
    return this.get().tail(p, onLines, opts);
  }
  followCommand(file: string, args: string[], onLines: (lines: string[]) => void, opts?: { resumeArgs?: string[]; privileged?: boolean }): TailHandle {
    return this.get().followCommand(file, args, onLines, opts);
  }
}
