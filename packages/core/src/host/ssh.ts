import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import ssh2 from 'ssh2';
import type { ClientChannel, ConnectConfig, SFTPWrapper } from 'ssh2';
import type { HostOs } from '../launch/paths.js';
import { quotePosixArg } from '../launch/commandLine.js';
import {
  type DetachedOptions,
  type DirEntry,
  type ExecOptions,
  type ExecResult,
  type Host,
  HostError,
  LineSplitter,
  type ProcessInfo,
  type StreamingProcess,
  type SystemdApi,
  type TailHandle,
  type TailOptions,
} from './types.js';
import { createSystemdApi } from './systemd.js';

const { Client } = ssh2;
const posix = path.posix;

export interface SshHostConfig {
  id: string;
  label?: string;
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKey?: string | Buffer;
  passphrase?: string;
  /** Kayıtlı sunucu parmak izi ("SHA256:..."). Boşsa ilk bağlantıda öğrenilir. */
  expectedFingerprint?: string;
  /** root değilse komutları "sudo -n" ile çalıştır (systemd, /etc yazımı için) */
  useSudo?: boolean;
  readyTimeoutMs?: number;
}

export function fingerprintOf(key: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

function sh(file: string, args: string[]): string {
  return [file, ...args].map(quotePosixArg).join(' ');
}

/** SSH ile bağlanılan Linux sunucusu. */
export class SshHost implements Host {
  readonly kind = 'ssh' as const;
  readonly id: string;
  readonly label: string;
  private _os: HostOs = 'linux';
  private client: InstanceType<typeof Client> | null = null;
  private sftpConn: SFTPWrapper | null = null;
  private connected = false;
  private connecting: Promise<void> | null = null;
  private isRoot = false;
  /** Bağlantıda görülen parmak izi (kaydedilmesi için) */
  fingerprint = '';
  readonly systemd?: SystemdApi;

  constructor(private readonly cfg: SshHostConfig) {
    this.id = cfg.id;
    this.label = cfg.label ?? `${cfg.username}@${cfg.host}`;
    this.systemd = createSystemdApi(
      (file, args) => this.exec(file, args, { privileged: true } as ExecOptions),
      (p, d) => this.writePrivileged(p, d),
      (p) => this.removePrivileged(p),
    );
  }

  get os(): HostOs {
    return this._os;
  }

  isConnected(): boolean {
    return this.connected;
  }

  connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = this.doConnect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async doConnect(): Promise<void> {
    const client = new Client();
    let mismatch: string | null = null;
    const config: ConnectConfig = {
      host: this.cfg.host,
      port: this.cfg.port ?? 22,
      username: this.cfg.username,
      readyTimeout: this.cfg.readyTimeoutMs ?? 15000,
      keepaliveInterval: 15000,
      keepaliveCountMax: 4,
      hostVerifier: (key: Buffer) => {
        const fp = fingerprintOf(key);
        this.fingerprint = fp;
        if (this.cfg.expectedFingerprint && this.cfg.expectedFingerprint !== fp) {
          mismatch = fp;
          return false;
        }
        return true;
      },
    };
    if (this.cfg.privateKey) {
      config.privateKey = this.cfg.privateKey;
      if (this.cfg.passphrase) config.passphrase = this.cfg.passphrase;
    }
    if (this.cfg.password) config.password = this.cfg.password;

    await new Promise<void>((resolve, reject) => {
      client
        .once('ready', () => resolve())
        .once('error', (err: Error & { level?: string }) => {
          if (mismatch) {
            reject(
              new HostError(
                `Sunucu kimliği değişmiş! Beklenen ${this.cfg.expectedFingerprint}, gelen ${mismatch}. Sunucuyu yeniden kurmadıysan bağlanma (araya giren biri olabilir).`,
                'host_key_mismatch',
              ),
            );
          } else if (err.level === 'client-authentication') {
            reject(new HostError('SSH girişi reddedildi: kullanıcı adı, şifre veya anahtar hatalı.', 'auth_failed'));
          } else {
            reject(new HostError(`SSH bağlantısı kurulamadı: ${err.message}`, 'connect_failed'));
          }
        })
        .connect(config);
    });
    client.on('close', () => {
      this.connected = false;
      this.sftpConn = null;
      this.client = null;
    });
    client.on('error', () => {
      /* bağlantı sonrası hatalar 'close' ile ele alınır */
    });
    this.client = client;
    this.connected = true;

    const uname = await this.exec('uname', ['-s']);
    if (uname.code !== 0 || !/linux/i.test(uname.stdout)) {
      await this.close();
      throw new HostError('Uzak sunucu Linux değil. Windows sunucular için uygulamayı o makineye kurup yerel olarak kullan.', 'unsupported_os');
    }
    this._os = 'linux';
    const id = await this.exec('id', ['-u']);
    this.isRoot = id.stdout.trim() === '0';
  }

  async close(): Promise<void> {
    const c = this.client;
    this.connected = false;
    this.sftpConn = null;
    this.client = null;
    if (c) c.end();
  }

  private requireClient(): InstanceType<typeof Client> {
    if (!this.client || !this.connected) throw new HostError('SSH bağlantısı yok', 'not_connected');
    return this.client;
  }

  private async sftp(): Promise<SFTPWrapper> {
    if (this.sftpConn) return this.sftpConn;
    const client = this.requireClient();
    this.sftpConn = await new Promise<SFTPWrapper>((resolve, reject) =>
      client.sftp((err, s) => (err ? reject(new HostError(`SFTP açılamadı: ${err.message}`, 'sftp_failed')) : resolve(s))),
    );
    this.sftpConn.on('close', () => {
      this.sftpConn = null;
    });
    return this.sftpConn;
  }

  private withPrivilege(cmd: string, privileged: boolean): string {
    if (!privileged || this.isRoot || !this.cfg.useSudo) return cmd;
    return `sudo -n sh -c ${quotePosixArg(cmd)}`;
  }

  private buildCommand(file: string, args: string[], opts: ExecOptions & { privileged?: boolean } = {}): string {
    let cmd = sh(file, args);
    if (opts.env) {
      const envs = Object.entries(opts.env).map(([k, val]) => `${k}=${quotePosixArg(val)}`);
      cmd = `env ${envs.join(' ')} ${cmd}`;
    }
    if (opts.cwd) cmd = `cd ${quotePosixArg(opts.cwd)} && ${cmd}`;
    return this.withPrivilege(cmd, !!opts.privileged);
  }

  private openExec(command: string, pty = false): Promise<ClientChannel> {
    const client = this.requireClient();
    return new Promise((resolve, reject) =>
      client.exec(command, pty ? { pty: true } : {}, (err, stream) =>
        err ? reject(new HostError(`Komut çalıştırılamadı: ${err.message}`, 'exec_failed')) : resolve(stream),
      ),
    );
  }

  async runShell(command: string, opts: { timeoutMs?: number; input?: string } = {}): Promise<ExecResult> {
    const stream = await this.openExec(command);
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timer: NodeJS.Timeout | undefined;
      stream.setEncoding('utf8');
      stream.stderr.setEncoding('utf8');
      stream.on('data', (c: string) => {
        if (stdout.length < 64 * 1024 * 1024) stdout += c;
      });
      stream.stderr.on('data', (c: string) => {
        if (stderr.length < 16 * 1024 * 1024) stderr += c;
      });
      stream.on('close', (code: number | null) => {
        if (timer) clearTimeout(timer);
        resolve({ code: code ?? null, stdout, stderr });
      });
      if (opts.timeoutMs) {
        timer = setTimeout(() => {
          stderr += '\n[zaman aşımı]';
          stream.close();
        }, opts.timeoutMs);
      }
      if (opts.input !== undefined) stream.end(opts.input);
      else stream.end();
    });
  }

  exec(file: string, args: string[], opts: ExecOptions & { privileged?: boolean } = {}): Promise<ExecResult> {
    return this.runShell(this.buildCommand(file, args, opts), opts);
  }

  private async check(file: string, args: string[], what: string, privileged = false): Promise<ExecResult> {
    const res = await this.exec(file, args, { privileged } as ExecOptions);
    if (res.code !== 0) throw new HostError(`${what}: ${(res.stderr || res.stdout).trim() || 'bilinmeyen hata'}`, 'command_failed');
    return res;
  }

  /* ---------------- dosyalar ---------------- */

  async readFile(p: string): Promise<Buffer> {
    const s = await this.sftp();
    return new Promise((resolve, reject) =>
      s.readFile(p, (err: Error | null | undefined, data: Buffer) =>
        err ? reject(new HostError(`${p} okunamadı: ${err.message}`, 'read_failed')) : resolve(data),
      ),
    );
  }

  async readText(p: string): Promise<string> {
    return (await this.readFile(p)).toString('utf8');
  }

  async writeFile(p: string, data: string | Buffer): Promise<void> {
    await this.mkdirp(posix.dirname(p));
    const s = await this.sftp();
    const tmp = `${p}.${randomBytes(4).toString('hex')}.tmp`;
    await new Promise<void>((resolve, reject) =>
      s.writeFile(tmp, data, (err: Error | null | undefined) =>
        err ? reject(new HostError(`${p} yazılamadı: ${err.message}`, 'write_failed')) : resolve(),
      ),
    );
    await this.check('mv', ['-f', tmp, p], `${p} yazılamadı`);
  }

  private async writePrivileged(p: string, data: string): Promise<void> {
    if (this.isRoot || !this.cfg.useSudo) return this.writeFile(p, data);
    const tmp = `/tmp/oezi-${randomBytes(6).toString('hex')}`;
    await this.writeFile(tmp, data);
    await this.check('install', ['-m', '644', tmp, p], `${p} yazılamadı`, true);
    await this.exec('rm', ['-f', tmp]);
  }

  private async removePrivileged(p: string): Promise<void> {
    this.assertSafe(p);
    await this.check('rm', ['-f', p], `${p} silinemedi`, true);
  }

  async exists(p: string): Promise<boolean> {
    return (await this.exec('test', ['-e', p])).code === 0;
  }

  async stat(p: string) {
    const res = await this.exec('stat', ['-L', '-c', '%F\t%s\t%Y', p]);
    if (res.code !== 0) return null;
    const [type, size, mtime] = res.stdout.trim().split('\t');
    return { isDir: type === 'directory', size: Number(size) || 0, mtimeMs: (Number(mtime) || 0) * 1000 };
  }

  async list(p: string): Promise<DirEntry[]> {
    // GNU find: %y kendi türü, %Y bağlantı hedefinin türü
    const res = await this.exec('find', [p, '-mindepth', '1', '-maxdepth', '1', '-printf', '%f\\t%y\\t%Y\\t%s\\t%T@\\n']);
    if (res.code !== 0) throw new HostError(`${p} listelenemedi: ${res.stderr.trim()}`, 'list_failed');
    return res.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name = '', own, target, size, mtime] = line.split('\t');
        return {
          name,
          isDir: target === 'd',
          isSymlink: own === 'l',
          size: Number(size) || 0,
          mtimeMs: Math.round((Number(mtime) || 0) * 1000),
        };
      });
  }

  async mkdirp(p: string): Promise<void> {
    await this.check('mkdir', ['-p', p], `${p} oluşturulamadı`);
  }

  async rename(from: string, to: string): Promise<void> {
    await this.check('mv', ['-f', '-T', from, to], `${from} taşınamadı`);
  }

  private assertSafe(p: string): void {
    const norm = posix.normalize(p);
    if (!posix.isAbsolute(norm) || norm.split('/').filter(Boolean).length < 2) {
      throw new HostError(`Güvenlik nedeniyle bu yol silinmez: ${p}`, 'unsafe_path');
    }
  }

  async remove(p: string, opts: { recursive?: boolean } = {}): Promise<void> {
    this.assertSafe(p);
    // Sembolik bağlantıysa sadece bağlantıyı sil
    const isLink = (await this.exec('test', ['-L', p])).code === 0;
    if (isLink || !opts.recursive) {
      await this.check('rm', ['-f', p], `${p} silinemedi`);
      return;
    }
    await this.check('rm', ['-rf', '--one-file-system', p], `${p} silinemedi`);
  }

  async copyFile(from: string, to: string): Promise<void> {
    await this.mkdirp(posix.dirname(to));
    await this.check('cp', ['-f', from, to], `${from} kopyalanamadı`);
  }

  async linkDir(target: string, linkPath: string): Promise<void> {
    await this.mkdirp(posix.dirname(linkPath));
    const isLink = (await this.exec('test', ['-L', linkPath])).code === 0;
    if (!isLink && (await this.exists(linkPath))) {
      throw new HostError(`${linkPath} zaten var ve bir bağlantı değil`, 'exists');
    }
    await this.check('ln', ['-sfnT', target, linkPath], `${linkPath} bağlantısı oluşturulamadı`);
  }

  async readLink(p: string): Promise<string | null> {
    const res = await this.exec('readlink', [p]);
    return res.code === 0 ? res.stdout.trim() : null;
  }

  async upload(localPath: string, remotePath: string): Promise<void> {
    await this.mkdirp(posix.dirname(remotePath));
    const s = await this.sftp();
    const tmp = `${remotePath}.${randomBytes(4).toString('hex')}.tmp`;
    await new Promise<void>((resolve, reject) =>
      s.fastPut(localPath, tmp, (err: Error | null | undefined) =>
        err ? reject(new HostError(`Yükleme başarısız: ${err.message}`, 'upload_failed')) : resolve(),
      ),
    );
    await this.check('mv', ['-f', tmp, remotePath], 'Yükleme tamamlanamadı');
  }

  /* ---------------- süreçler ---------------- */

  spawn(file: string, args: string[], opts: ExecOptions = {}): StreamingProcess {
    // Uzak PID'i öğrenmek için önce $$ yazdırılır, sonra komut exec ile aynı süreçte çalışır.
    const inner = this.buildCommand(file, args, { ...opts, cwd: undefined });
    const cdPart = opts.cwd ? `cd ${quotePosixArg(opts.cwd)} && ` : '';
    const command = `sh -c ${quotePosixArg(`echo __OEZI_PID__$$; ${cdPart}exec ${inner}`)}`;
    const listeners: ((chunk: string, stream: 'stdout' | 'stderr') => void)[] = [];
    let resolvePid!: (pid: number | undefined) => void;
    const pid = new Promise<number | undefined>((r) => (resolvePid = r));
    let channel: ClientChannel | null = null;
    let pidSeen = false;
    let pending = '';
    const exit = this.openExec(command).then(
      (stream) =>
        new Promise<number | null>((resolve) => {
          channel = stream;
          stream.setEncoding('utf8');
          stream.stderr.setEncoding('utf8');
          stream.on('data', (c: string) => {
            if (!pidSeen) {
              pending += c;
              const nl = pending.indexOf('\n');
              if (nl < 0) return;
              const first = pending.slice(0, nl);
              const m = /__OEZI_PID__(\d+)/.exec(first);
              pidSeen = true;
              resolvePid(m ? Number(m[1]) : undefined);
              c = pending.slice(nl + 1);
              pending = '';
              if (!c) return;
            }
            listeners.forEach((l) => l(c, 'stdout'));
          });
          stream.stderr.on('data', (c: string) => listeners.forEach((l) => l(c, 'stderr')));
          stream.on('close', (code: number | null) => {
            if (!pidSeen) resolvePid(undefined);
            resolve(code ?? null);
          });
          if (opts.input !== undefined) stream.write(opts.input);
        }),
      (err: Error) => {
        resolvePid(undefined);
        listeners.forEach((l) => l(`${err.message}\n`, 'stderr'));
        return -1;
      },
    );
    return {
      pid,
      onData: (cb) => listeners.push(cb),
      write: (d) => {
        if (channel) channel.write(d);
      },
      kill: async () => {
        const p = await pid;
        if (p) await this.exec('kill', ['-KILL', String(p)]).catch(() => undefined);
        (channel as ClientChannel | null)?.close();
      },
      wait: () => exit,
    };
  }

  async startDetached(file: string, args: string[], opts: DetachedOptions): Promise<number> {
    if (!(await this.exists(file))) throw new HostError(`Çalıştırılabilir dosya bulunamadı: ${file}`, 'not_found');
    await this.mkdirp(posix.dirname(opts.logFile));
    const envPart = opts.env ? 'env ' + Object.entries(opts.env).map(([k, val]) => `${k}=${quotePosixArg(val)}`).join(' ') + ' ' : '';
    // Dikkat: "a && b &" tüm alt kabuğu arka plana atar ve SSH kanalını açık tutar; bu yüzden ";" kullanılır.
    const cmd = `cd ${quotePosixArg(opts.cwd)} || exit 1; nohup setsid ${envPart}${sh(file, args)} >> ${quotePosixArg(opts.logFile)} 2>&1 < /dev/null & echo $!`;
    const res = await this.runShell(cmd);
    const pid = Number(res.stdout.trim().split('\n').pop());
    if (res.code !== 0 || !pid) throw new HostError(`Sunucu başlatılamadı: ${res.stderr.trim()}`, 'spawn_failed');
    // setsid fork ederse $! ara süreci gösterir; gerçek süreci bul.
    await new Promise((r) => setTimeout(r, 300));
    const child = await this.exec('pgrep', ['-P', String(pid)]);
    const info = await this.processInfo(pid);
    if (!info.alive && child.code === 0) {
      const c = Number(child.stdout.trim().split('\n')[0]);
      if (c) return c;
    }
    return pid;
  }

  async processInfo(pid: number): Promise<ProcessInfo> {
    if (!pid || pid <= 0) return { pid, alive: false };
    const res = await this.runShell(
      `s=$(cat /proc/${pid}/stat 2>/dev/null) || exit 1; echo "$s" | sed 's/.*) //' | cut -d' ' -f1; basename "$(readlink /proc/${pid}/exe 2>/dev/null)"`,
    );
    if (res.code !== 0) return { pid, alive: false };
    const [state, image] = res.stdout.trim().split('\n');
    if (state === 'Z' || state === 'X') return { pid, alive: false };
    return { pid, alive: true, ...(image ? { image: image.toLowerCase() } : {}) };
  }

  async killProcess(pid: number, opts: { force?: boolean } = {}): Promise<void> {
    const sig = opts.force ? '-KILL' : '-TERM';
    // setsid ile başlatıldığı için süreç grubu lideri: grubu hedefle
    const res = await this.exec('kill', [sig, '--', `-${pid}`]);
    if (res.code !== 0) await this.exec('kill', [sig, String(pid)]);
  }

  tail(p: string, onLines: (lines: string[]) => void, opts: TailOptions = {}): TailHandle {
    const proc = this.spawn('tail', ['-n', String(opts.initialLines ?? 200), '-F', p]);
    const splitter = new LineSplitter();
    let buffered: string[] = [];
    let timer: NodeJS.Timeout | null = null;
    proc.onData((chunk, stream) => {
      if (stream === 'stderr') return; // "tail: file truncated" vb.
      buffered.push(...splitter.push(chunk));
      if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          const lines = buffered;
          buffered = [];
          if (lines.length) onLines(lines);
        }, 200);
      }
    });
    return {
      stop: () => {
        if (timer) clearTimeout(timer);
        void proc.kill();
      },
    };
  }
}
