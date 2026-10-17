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
  type ProcessInfo,
  type StreamingProcess,
  type SystemdApi,
  type TailHandle,
  type TailOptions,
  type WriteFileOptions,
} from './types.js';
import { createSystemdApi } from './systemd.js';
import { followWithRestart } from './follow.js';
import { LinuxCpuTracker, type ProcessStat, linuxProcessStatsCommand, parseLinuxProcessStatsOutput } from '../monitor/procstat.js';

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

/** spawn edilen uzak sürecin PID'ini bildiren ilk satır */
const PID_MARKER = '__OEZI_PID__';
const PID_LINE_RE = /^__OEZI_PID__(\d+)\r?$/;

/** Uzak `timeout` süresi: yerel zamanlayıcı önce dolsun, uzak taraf az sonra yine de öldürsün */
function remoteTimeoutSec(timeoutMs: number): number {
  return Math.max(1, Math.ceil(timeoutMs / 1000) + 1);
}

/** `date +%s%3N` / `date +%s` çıktısından Unix ms (GNU dışı date %3N'i desteklemeyebilir) */
export function parseRemoteDate(stdout: string): number | null {
  const lines = stdout.split('\n').map((l) => l.trim());
  if (lines[0] && /^\d{13}$/.test(lines[0])) return Number(lines[0]);
  const sec = lines.find((l) => /^\d{9,11}$/.test(l));
  return sec ? Number(sec) * 1000 : null;
}

interface ActiveRemote {
  pid: number;
  privileged: boolean;
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
  private _generation = 0;
  /** Uzun süreli akışlar (log takibi) için ayrı bağlantı: OpenSSH oturum sınırına (MaxSessions=10) takılmasın */
  private streamConn: SshHost | null = null;
  /** İlk bağlantıda öğrenilen parmak izi için geri çağrı (kaydetmek üzere) */
  onFingerprintLearned?: (fp: string) => void;
  /** spawn ile başlatılıp hâlâ çalışan uzak süreç grupları (kapatırken öldürülür; journalctl -f vb. kalmasın) */
  private readonly active = new Set<ActiveRemote>();

  get generation(): number {
    return this._generation;
  }

  constructor(private readonly cfg: SshHostConfig) {
    this.id = cfg.id;
    this.label = cfg.label ?? `${cfg.username}@${cfg.host}`;
    this.systemd = createSystemdApi(
      (file, args, o) => this.exec(file, args, { ...o, privileged: true }),
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

    // ssh2, readyTimeout sonrasında ikinci bir 'error' ("Connection lost before handshake") yayabilir:
    // dinleyici yoksa Electron ana sürecinde yakalanmamış istisna olur. Kalıcı dinleyici bağlantıdan ÖNCE eklenir.
    let ready = false;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (err: HostError) => {
        if (settled) return;
        settled = true;
        try {
          client.end();
        } catch {
          /* zaten kapalı */
        }
        reject(err);
      };
      client.on('error', (err: Error & { level?: string }) => {
        if (ready || settled) return; // bağlantı sonrası hatalar 'close' ile ele alınır
        if (mismatch) {
          fail(
            new HostError(
              `Sunucu kimliği değişmiş! Beklenen ${this.cfg.expectedFingerprint}, gelen ${mismatch}. Sunucuyu yeniden kurmadıysan bağlanma (araya giren biri olabilir).`,
              'host_key_mismatch',
            ),
          );
        } else if (err.level === 'client-authentication') {
          fail(new HostError('SSH girişi reddedildi: kullanıcı adı, şifre veya anahtar hatalı.', 'auth_failed'));
        } else {
          fail(new HostError(`SSH bağlantısı kurulamadı: ${err.message}`, 'connect_failed'));
        }
      });
      client.on('close', () => {
        if (!ready) {
          fail(new HostError('SSH bağlantısı kurulamadı: bağlantı kapandı', 'connect_failed'));
          return;
        }
        // Eski bir istemcinin geç gelen 'close' olayı yeni bağlantıyı silmesin
        if (this.client === client) {
          this.connected = false;
          this.sftpConn = null;
          this.client = null;
        }
      });
      client.once('ready', () => {
        if (settled) {
          client.end();
          return;
        }
        settled = true;
        ready = true;
        resolve();
      });
      try {
        client.connect(config);
      } catch (err) {
        // ör. özel anahtar ayrıştırılamadı (eşzamanlı fırlatır)
        fail(new HostError(`SSH bağlantısı kurulamadı: ${(err as Error).message}`, 'connect_failed'));
      }
    });
    this.client = client;
    this.connected = true;
    this._generation++;
    if (!this.cfg.expectedFingerprint && this.fingerprint) {
      // İlk bağlantı: parmak izini sabitle (TOFU); sonraki bağlantılarda değişirse reddedilir
      this.cfg.expectedFingerprint = this.fingerprint;
      this.onFingerprintLearned?.(this.fingerprint);
    }

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
    if (this.streamConn) {
      await this.streamConn.close();
      this.streamConn = null;
    }
    if (this.active.size && this.connected) {
      // Kanal kapanınca uzak süreç ölmez (pty yok, SIGHUP gitmez): takip edilen grupları öldür, en fazla 5 sn bekle
      const kills = [...this.active].map((a) => this.killGroup(a.pid, a.privileged));
      await Promise.race([Promise.allSettled(kills), new Promise((r) => setTimeout(r, 5000))]);
    }
    this.active.clear();
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
    const conn = this.sftpConn;
    conn.on('close', () => {
      if (this.sftpConn === conn) this.sftpConn = null;
    });
    conn.on('error', () => {
      if (this.sftpConn === conn) this.sftpConn = null;
    });
    return conn;
  }

  /** Bu komut gerçekten sudo ile mi çalışacak? */
  private usesSudo(privileged: boolean): boolean {
    return privileged && !this.isRoot && !!this.cfg.useSudo;
  }

  private withPrivilege(cmd: string, privileged: boolean): string {
    if (!this.usesSudo(privileged)) return cmd;
    return `sudo -n sh -c ${quotePosixArg(cmd)}`;
  }

  private buildCommand(file: string, args: string[], opts: ExecOptions & { privileged?: boolean } = {}): string {
    let cmd = sh(file, args);
    if (opts.env) {
      const envs = Object.entries(opts.env).map(([k, val]) => `${k}=${quotePosixArg(val)}`);
      cmd = `env ${envs.join(' ')} ${cmd}`;
    }
    // Uzak tarafta da süre sınırı: kanal kapansa/bağlantı kopsa bile süreç (grubu) öldürülür.
    // sudo'nun İÇİNDE olmalı: kullanıcı yetkisiyle root süreçleri öldürülemez.
    if (opts.timeoutMs) cmd = `timeout -s KILL ${remoteTimeoutSec(opts.timeoutMs)} ${cmd}`;
    if (opts.cwd) cmd = `cd ${quotePosixArg(opts.cwd)} && ${cmd}`;
    return this.withPrivilege(cmd, !!opts.privileged);
  }

  private openExec(command: string, pty = false): Promise<ClientChannel> {
    const client = this.requireClient();
    return new Promise((resolve, reject) => {
      try {
        client.exec(command, pty ? { pty: true } : {}, (err, stream) =>
          err ? reject(new HostError(`Komut çalıştırılamadı: ${err.message}`, 'exec_failed')) : resolve(stream),
        );
      } catch (err) {
        reject(new HostError(`Komut çalıştırılamadı: ${(err as Error).message}`, 'exec_failed'));
      }
    });
  }

  /**
   * Kabuk komutu çalıştırır. `timeoutMs` verilirse komut uzakta `timeout -s KILL` ile sarılır ve süre dolunca
   * hemen { code: null, timedOut: true } döner (kanal kapatılır, KILL sinyali gönderilir).
   */
  async runShell(command: string, opts: { timeoutMs?: number; input?: string } = {}): Promise<ExecResult> {
    const cmd = opts.timeoutMs ? `timeout -s KILL ${remoteTimeoutSec(opts.timeoutMs)} sh -c ${quotePosixArg(command)}` : command;
    return this.runRaw(cmd, opts);
  }

  private async runRaw(command: string, opts: { timeoutMs?: number; input?: string } = {}): Promise<ExecResult> {
    const stream = await this.openExec(command);
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timer: NodeJS.Timeout | undefined;
      let settled = false;
      const finish = (r: ExecResult) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(r);
      };
      stream.setEncoding('utf8');
      stream.stderr.setEncoding('utf8');
      stream.on('error', () => undefined);
      stream.stderr.on('error', () => undefined);
      stream.on('data', (c: string) => {
        if (stdout.length < 64 * 1024 * 1024) stdout += c;
      });
      stream.stderr.on('data', (c: string) => {
        if (stderr.length < 16 * 1024 * 1024) stderr += c;
      });
      stream.on('close', (code: number | null) => finish({ code: code ?? null, stdout, stderr }));
      if (opts.timeoutMs) {
        timer = setTimeout(() => {
          // Kanalı kapatmak uzak süreci durdurmaz; asıl öldürme uzak `timeout` ile olur. Beklemeden dön.
          try {
            stream.signal('KILL');
          } catch {
            /* desteklenmiyor */
          }
          try {
            stream.close();
          } catch {
            /* zaten kapalı */
          }
          finish({ code: null, stdout, stderr: `${stderr}\n[zaman aşımı]`, timedOut: true });
        }, opts.timeoutMs);
      }
      if (opts.input !== undefined) stream.end(opts.input);
      else stream.end();
    });
  }

  exec(file: string, args: string[], opts: ExecOptions & { privileged?: boolean } = {}): Promise<ExecResult> {
    return this.runRaw(this.buildCommand(file, args, opts), opts);
  }

  private cpuTracker = new LinuxCpuTracker();

  /** Süreç CPU% / RAM: tek kabuk komutuyla /proc/stat + /proc/<pid>/stat (ilk çağrıda 0,5 sn ara ile iki ölçüm). */
  async processStats(pids: number[]): Promise<ProcessStat[]> {
    const list = [...new Set(pids.filter((p) => Number.isInteger(p) && p > 0))];
    if (!list.length) return [];
    const read = async () => {
      const res = await this.runShell(linuxProcessStatsCommand(list), { timeoutMs: 15000 });
      if (res.code !== 0) throw new HostError(`Süreç bilgisi okunamadı: ${res.stderr.trim() || 'bağlantı yok'}`, 'query_failed');
      const out = parseLinuxProcessStatsOutput(res.stdout);
      if (out.total === null) throw new HostError('/proc/stat okunamadı', 'query_failed');
      return { ...out, total: out.total };
    };
    if (!this.cpuTracker.hasBaseline(list)) {
      const first = await read();
      this.cpuTracker.update(first.total, first.samples, first.pageSize, list);
      await new Promise((r) => setTimeout(r, 500));
    }
    const r = await read();
    return this.cpuTracker.update(r.total, r.samples, r.pageSize, list);
  }

  /** Host saatine göre şu an (Unix ms); ağ gecikmesinin yarısı eklenir. */
  async getRemoteTime(): Promise<number> {
    const t0 = Date.now();
    const res = await this.runShell('date +%s%3N; date +%s', { timeoutMs: 15000 });
    const t1 = Date.now();
    const remote = res.code === 0 ? parseRemoteDate(res.stdout) : null;
    if (remote === null) throw new HostError(`Sunucu saati okunamadı: ${(res.stderr || res.stdout).trim() || 'cevap yok'}`, 'query_failed');
    return remote + Math.round((t1 - t0) / 2);
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

  async writeFile(p: string, data: string | Buffer, opts: WriteFileOptions = {}): Promise<void> {
    await this.mkdirp(posix.dirname(p));
    const s = await this.sftp();
    const tmp = `${p}.${randomBytes(4).toString('hex')}.tmp`;
    const fail = (err: Error) => new HostError(`${p} yazılamadı: ${err.message}`, 'write_failed');
    try {
      await new Promise<void>((resolve, reject) =>
        // mode verilirse dosya baştan bu izinle açılır (şifreli cfg bir an bile herkese açık olmasın)
        s.writeFile(tmp, data, opts.mode !== undefined ? { mode: opts.mode } : {}, (err: Error | null | undefined) =>
          err ? reject(fail(err)) : resolve(),
        ),
      );
      if (opts.mode !== undefined) {
        // sftp-server umask'ı uygulayabilir: kesin değeri ayrıca ver
        await new Promise<void>((resolve, reject) =>
          s.chmod(tmp, opts.mode!, (err: Error | null | undefined) => (err ? reject(fail(err)) : resolve())),
        );
      }
    } catch (err) {
      await this.exec('rm', ['-f', tmp]).catch(() => undefined);
      throw err;
    }
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
    const res = await this.exec('find', ['-H', p, '-mindepth', '1', '-maxdepth', '1', '-printf', '%f\\t%y\\t%Y\\t%s\\t%T@\\n']);
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

  /** Uzak süreç grubunu öldürür (sudo ile başlatıldıysa sudo ile). */
  private async killGroup(pid: number, privileged: boolean, signal: '-KILL' | '-TERM' = '-KILL'): Promise<void> {
    const n = Math.trunc(pid);
    if (!(n > 1)) return;
    // Kabuğun yerleşik kill'i (procps'siz sistemlerde de var); grup yoksa tek süreç. Tek gidiş-dönüş.
    // Not: dash'in kill'i "--" kabul etmez; "kill -SIG -PGID" hem dash hem bash'te çalışır.
    const cmd = this.withPrivilege(`kill ${signal} -${n} 2>/dev/null || kill ${signal} ${n}`, privileged);
    await this.runRaw(`sh -c ${quotePosixArg(cmd)}`, { timeoutMs: 15000 });
  }

  spawn(file: string, args: string[], opts: ExecOptions & { privileged?: boolean } = {}): StreamingProcess {
    // Uzak PID'i öğrenmek için önce $$ yazdırılır, sonra komut exec ile aynı süreçte çalışır.
    // setsid: süreç kendi grubunun lideri olur; kill() bütün grubu (alt süreçler dahil) öldürür.
    // -w: setsid çatallanırsa da çıkış kodu korunur.
    const privileged = this.usesSudo(!!opts.privileged);
    const inner = this.buildCommand(file, args, { ...opts, cwd: undefined, privileged: false, timeoutMs: undefined });
    const cdPart = opts.cwd ? `cd ${quotePosixArg(opts.cwd)} || exit 127; ` : '';
    const script = `echo ${PID_MARKER}$$; ${cdPart}exec ${inner}`;
    const q = quotePosixArg(script);
    // Çok eski util-linux'ta -w yok: o zaman setsid'siz çalıştır (kill tek sürece düşer)
    const launcher = `if setsid -w true 2>/dev/null; then exec setsid -w sh -c ${q}; else exec sh -c ${q}; fi`;
    const command = this.withPrivilege(`sh -c ${quotePosixArg(launcher)}`, !!opts.privileged);
    const listeners: ((chunk: string, stream: 'stdout' | 'stderr') => void)[] = [];
    let resolvePid!: (pid: number | undefined) => void;
    const pid = new Promise<number | undefined>((r) => (resolvePid = r));
    let channel: ClientChannel | null = null;
    let pidSeen = false;
    let pending = '';
    let entry: ActiveRemote | null = null;
    let exited = false;
    const emit = (c: string, s: 'stdout' | 'stderr') => {
      if (c) listeners.forEach((l) => l(c, s));
    };
    const exit = this.openExec(command).then(
      (stream) =>
        new Promise<number | null>((resolve) => {
          channel = stream;
          stream.setEncoding('utf8');
          stream.stderr.setEncoding('utf8');
          stream.on('error', () => undefined);
          stream.stderr.on('error', () => undefined);
          stream.on('data', (c: string) => {
            if (!pidSeen) {
              pending += c;
              const nl = pending.indexOf('\n');
              if (nl < 0 && pending.length < 64) return;
              pidSeen = true;
              const first = nl < 0 ? pending : pending.slice(0, nl);
              const m = PID_LINE_RE.exec(first);
              if (m) {
                const n = Number(m[1]);
                resolvePid(n);
                if (!exited) {
                  entry = { pid: n, privileged };
                  this.active.add(entry);
                }
                c = pending.slice(nl + 1);
              } else {
                // İşaret satırı yok (ör. sudo hatası): hiçbir çıktı yutulmasın
                resolvePid(undefined);
                c = pending;
              }
              pending = '';
            }
            emit(c, 'stdout');
          });
          stream.stderr.on('data', (c: string) => emit(c, 'stderr'));
          stream.on('close', (code: number | null) => {
            exited = true;
            if (entry) this.active.delete(entry);
            if (!pidSeen) {
              pidSeen = true;
              resolvePid(undefined);
              const m = PID_LINE_RE.exec(pending.replace(/\n$/, ''));
              if (!m) emit(pending, 'stdout');
              pending = '';
            }
            resolve(code ?? null);
          });
          if (opts.closeStdin) stream.end(opts.input ?? '');
          else if (opts.input !== undefined) stream.write(opts.input);
        }),
      (err: Error) => {
        resolvePid(undefined);
        emit(`${err.message}\n`, 'stderr');
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
        if (p && !exited && this.connected) await this.killGroup(p, privileged).catch(() => undefined);
        const ch = channel as ClientChannel | null;
        if (ch && !exited) {
          try {
            ch.signal('KILL');
          } catch {
            /* desteklenmiyor */
          }
          try {
            ch.close();
          } catch {
            /* zaten kapalı */
          }
        }
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

  async processInfo(pid: number, opts: { commandLine?: boolean } = {}): Promise<ProcessInfo> {
    if (!pid || pid <= 0) return { pid, alive: false };
    const n = Math.trunc(pid);
    // Süreç sorgu sırasında ölebilir: her okuma ayrı kontrol edilir, kaybolursa "ölü" (7) sayılır, sorgu hatası değil
    const cmd = opts.commandLine ? `; l=$( { tr '\\0' ' ' < /proc/${n}/cmdline; } 2>/dev/null) || exit 7; echo "$l"` : '';
    const res = await this.runShell(
      `s=$(cat /proc/${n}/stat 2>/dev/null) || exit 7; echo "$s" | sed 's/.*) //' | cut -d' ' -f1; basename "$(readlink /proc/${n}/exe 2>/dev/null)"; c=$(cat /proc/${n}/comm 2>/dev/null) || exit 7; echo "$c"${cmd}`,
      { timeoutMs: 20000 },
    );
    if (res.code === 7) return { pid, alive: false };
    // Bağlantı koptuysa (kod null) ya da başka bir hata: "öldü" sanma
    if (res.code !== 0) throw new HostError(`Süreç sorgulanamadı: ${res.stderr.trim() || 'bağlantı yok'}`, 'query_failed');
    const [state, image, comm, commandLine] = res.stdout.split('\n').map((x) => x.trim());
    if (state === 'Z' || state === 'X') return { pid, alive: false };
    return {
      pid,
      alive: true,
      ...(image ? { image: image.toLowerCase() } : {}),
      ...(comm ? { comm: comm.toLowerCase() } : {}),
      ...(opts.commandLine ? { commandLine: commandLine ?? '' } : {}),
    };
  }

  async killProcess(pid: number, opts: { force?: boolean } = {}): Promise<void> {
    // setsid ile başlatıldığı için süreç grubu lideri: grubu hedefle
    await this.killGroup(pid, false, opts.force ? '-KILL' : '-TERM');
  }

  private streamHost(): SshHost {
    if (!this.streamConn) {
      this.streamConn = new SshHost({ ...this.cfg, id: `${this.id}:stream` });
    }
    return this.streamConn;
  }

  followCommand(file: string, args: string[], onLines: (lines: string[]) => void, opts: { resumeArgs?: string[]; privileged?: boolean } = {}): TailHandle {
    const sh = this.streamHost();
    // Ana bağlantıda öğrenilen parmak izi akış bağlantısında da zorunlu olsun
    if (this.cfg.expectedFingerprint) sh.cfg.expectedFingerprint = this.cfg.expectedFingerprint;
    const lazySpawn = (a: string[]): StreamingProcess => {
      let inner: StreamingProcess | null = null;
      const listeners: ((chunk: string, stream: 'stdout' | 'stderr') => void)[] = [];
      const ready = sh
        .connect()
        .then(() => {
          inner = sh.spawn(file, a, { privileged: !!opts.privileged });
          listeners.forEach((l) => inner!.onData(l));
          return inner;
        })
        .catch(() => null);
      return {
        pid: ready.then((p) => (p ? p.pid : undefined)),
        onData: (cb) => {
          listeners.push(cb);
          if (inner) inner.onData(cb);
        },
        write: (d) => inner?.write(d),
        kill: async () => {
          const p = await ready;
          await p?.kill();
        },
        wait: async () => {
          const p = await ready;
          return p ? p.wait() : -1;
        },
      };
    };
    return followWithRestart(lazySpawn, args, opts.resumeArgs ?? args, onLines);
  }

  tail(p: string, onLines: (lines: string[]) => void, opts: TailOptions = {}): TailHandle {
    const first = ['-n', opts.fromStart ? '+1' : String(opts.initialLines ?? 200), '-F', p];
    return this.followCommand('tail', first, onLines, { resumeArgs: ['-n', '0', '-F', p] });
  }
}
