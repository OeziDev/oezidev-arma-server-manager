import { spawn as cpSpawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { HostOs } from '../launch/paths.js';
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
import os from 'node:os';
import {
  LinuxCpuTracker,
  type LinuxProcSample,
  type ProcessStat,
  WindowsCpuTracker,
  parseProcPidStat,
  parseProcStatTotal,
  parseWinProcessStats,
  winProcessStatsScript,
} from '../monitor/procstat.js';

const isWin = process.platform === 'win32';

/** Süreç çıktıktan sonra boruların kapanması için en fazla bu kadar beklenir (yetim alt süreç boruyu tutuyorsa) */
const CLOSE_GRACE_MS = 5000;

/**
 * Linux'ta exec/spawn ile başlatılan süreçler kendi süreç grubunda (detached) çalışır; öldürürken
 * bütün grup hedeflenir (steamcmd.sh -> linux32/steamcmd gibi alt süreçler kalmasın).
 * Uygulama kapanırken hâlâ çalışanlar da temizlenir.
 */
const liveGroups = new Set<number>();
let exitHookInstalled = false;
function trackGroup(pid: number | undefined): void {
  if (isWin || !pid) return;
  liveGroups.add(pid);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once('exit', () => {
      for (const g of liveGroups) {
        try {
          process.kill(-g, 'SIGKILL');
        } catch {
          /* zaten yok */
        }
      }
    });
  }
}

/* ---------------- Windows süreç sorgusu ---------------- */

/**
 * Windows PowerShell 5.1 boruya OEM kod sayfasıyla yazar; Node UTF-8 okur. "C:\Users\Halit Özcan\..." gibi
 * yollar bozulur ve -profiles işareti hiç eşleşmezdi. Bu yüzden komut satırı UTF-8 baytlarının base64'ü
 * olarak (saf ASCII) yazdırılır ve Node tarafında çözülür. Betik -EncodedCommand ile (UTF-16LE base64) verilir:
 * tırnak/kaçış sorunu da kalmaz.
 */
export function winCommandLineScript(pid: number): string {
  const n = Math.trunc(pid);
  return (
    `$ErrorActionPreference='Stop';` +
    `try{$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${n}'}catch{$p=Get-WmiObject Win32_Process -Filter 'ProcessId=${n}'};` +
    `if($p -and $p.CommandLine){'B64:'+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$p.CommandLine))}else{'NONE'}`
  );
}

export function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** winCommandLineScript çıktısını çözer; komut satırı bilinmiyorsa undefined. */
export function parseWinCommandLineOutput(stdout: string): string | undefined {
  const m = /B64:([A-Za-z0-9+/=]+)/.exec(stdout.replace(/\u0000/g, ''));
  if (!m) return undefined;
  const text = Buffer.from(m[1]!, 'base64').toString('utf8').trim();
  return text || undefined;
}

/* ---------------- log satırları ---------------- */

const utf8Strict = new TextDecoder('utf-8', { fatal: true });
const ansiDecoder = ((): { decode(b: Uint8Array): string } => {
  try {
    // Türkçe Windows'ta ANSI kod sayfası 1254 (ş, ğ, ı); ICU yoksa latin1/1252
    return new TextDecoder('windows-1254');
  } catch {
    return new TextDecoder('latin1');
  }
})();

/** Log satırını çözer: önce UTF-8, geçersiz bayt dizisi varsa Windows ANSI (cp1254/cp1252). */
export function decodeLogLine(buf: Buffer): string {
  let end = buf.length;
  if (end > 0 && buf[end - 1] === 0x0d) end--;
  const b = buf.subarray(0, end);
  try {
    return utf8Strict.decode(b);
  } catch {
    return ansiDecoder.decode(b);
  }
}

/**
 * Bayt düzeyinde satır bölücü: yarım satırı (ve yarım çok baytlı karakteri) bayt olarak saklar,
 * tamamlanan her satırı ayrı ayrı çözer (bir satırın kodlaması diğerini bozmaz).
 */
export class ByteLineSplitter {
  private parts: Buffer[] = [];
  private len = 0;
  constructor(private readonly maxLine = 1024 * 1024) {}

  push(chunk: Buffer): string[] {
    const out: string[] = [];
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(0x0a, start);
      if (nl < 0) break;
      const piece = chunk.subarray(start, nl);
      out.push(decodeLogLine(this.len ? Buffer.concat([...this.parts, piece]) : piece));
      this.parts = [];
      this.len = 0;
      start = nl + 1;
    }
    if (start < chunk.length) {
      const rest = Buffer.from(chunk.subarray(start));
      this.parts.push(rest);
      this.len += rest.length;
      if (this.len >= this.maxLine) out.push(...this.flush());
    }
    return out;
  }

  /** Bekleyen yarım satır var mı? */
  get hasPartial(): boolean {
    return this.len > 0;
  }

  flush(): string[] {
    if (!this.len) return [];
    const line = decodeLogLine(Buffer.concat(this.parts));
    this.reset();
    return [line];
  }

  reset(): void {
    this.parts = [];
    this.len = 0;
  }
}

/** Uygulamanın çalıştığı bilgisayar. */
export class LocalHost implements Host {
  readonly id = 'local';
  readonly kind = 'local' as const;
  readonly label: string;
  readonly os: HostOs = isWin ? 'windows' : 'linux';
  readonly systemd?: SystemdApi;
  readonly generation = 1;

  constructor(opts: { label?: string; enableSystemd?: boolean } = {}) {
    this.label = opts.label ?? 'Bu bilgisayar';
    if (!isWin && opts.enableSystemd) {
      this.systemd = createSystemdApi((file, args, o) => this.exec(file, args, o), (p, d) => this.writeFile(p, d), (p) => this.remove(p));
    }
  }

  async connect(): Promise<void> {}
  async close(): Promise<void> {}
  isConnected(): boolean {
    return true;
  }

  readFile(p: string): Promise<Buffer> {
    return fsp.readFile(p);
  }
  readText(p: string): Promise<string> {
    return fsp.readFile(p, 'utf8');
  }

  async writeFile(p: string, data: string | Buffer, opts: WriteFileOptions = {}): Promise<void> {
    await fsp.mkdir(path.dirname(p), { recursive: true });
    const tmp = `${p}.${randomBytes(4).toString('hex')}.tmp`;
    if (opts.mode !== undefined && !isWin) {
      // Dosya baştan kısıtlı izinle oluşturulur (umask sadece daraltır), sonra kesin değer chmod ile verilir
      await fsp.writeFile(tmp, data, { mode: opts.mode });
      await fsp.chmod(tmp, opts.mode);
    } else {
      await fsp.writeFile(tmp, data);
    }
    // Windows'ta antivirüs geçici dosyayı tararken rename EPERM/EBUSY verebilir: birkaç kez dene
    for (let attempt = 0; ; attempt++) {
      try {
        await fsp.rename(tmp, p);
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (attempt < 8 && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
          await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
          continue;
        }
        await fsp.rm(tmp, { force: true });
        throw err;
      }
    }
  }

  async exists(p: string): Promise<boolean> {
    try {
      await fsp.access(p);
      return true;
    } catch {
      return false;
    }
  }

  async stat(p: string) {
    try {
      const s = await fsp.stat(p);
      return { isDir: s.isDirectory(), size: s.size, mtimeMs: s.mtimeMs };
    } catch {
      return null;
    }
  }

  async list(p: string): Promise<DirEntry[]> {
    const dirents = await fsp.readdir(p, { withFileTypes: true });
    const out: DirEntry[] = [];
    for (const d of dirents) {
      const full = path.join(p, d.name);
      let isDir = d.isDirectory();
      let size = 0;
      let mtimeMs = 0;
      try {
        const s = await fsp.stat(full); // sembolik bağlantıyı takip eder
        isDir = s.isDirectory();
        size = s.size;
        mtimeMs = s.mtimeMs;
      } catch {
        /* kırık bağlantı */
      }
      out.push({ name: d.name, isDir, isSymlink: d.isSymbolicLink(), size, mtimeMs });
    }
    return out;
  }

  async mkdirp(p: string): Promise<void> {
    await fsp.mkdir(p, { recursive: true });
  }

  rename(from: string, to: string): Promise<void> {
    return fsp.rename(from, to);
  }

  async remove(p: string, opts: { recursive?: boolean } = {}): Promise<void> {
    if (!p || path.parse(path.resolve(p)).root === path.resolve(p)) {
      throw new HostError(`Kök klasör silinemez: ${p}`, 'unsafe_path');
    }
    const st = await fsp.lstat(p).catch(() => null);
    if (!st) return;
    if (st.isSymbolicLink() || (isWin && st.isDirectory() && (await this.readLink(p)) !== null)) {
      // Bağlantıyı sil, hedefe dokunma.
      await fsp.rm(p, { force: true }).catch(async () => fsp.rmdir(p));
      return;
    }
    await fsp.rm(p, { recursive: opts.recursive ?? false, force: true });
  }

  copyFile(from: string, to: string): Promise<void> {
    return fsp.mkdir(path.dirname(to), { recursive: true }).then(() => fsp.copyFile(from, to));
  }

  async linkDir(target: string, linkPath: string): Promise<void> {
    await fsp.mkdir(path.dirname(linkPath), { recursive: true });
    const existing = await fsp.lstat(linkPath).catch(() => null);
    if (existing) {
      const current = await this.readLink(linkPath);
      if (current !== null && path.resolve(current) === path.resolve(target)) return;
      if (current === null) throw new HostError(`${linkPath} zaten var ve bir bağlantı değil`, 'exists');
      await this.remove(linkPath);
    }
    try {
      await fsp.symlink(target, linkPath, isWin ? 'junction' : 'dir');
    } catch (err) {
      throw new HostError(
        `Klasör bağlantısı oluşturulamadı (${linkPath} -> ${target}): ${(err as Error).message}. Sunucu ve Workshop klasörü NTFS bir diskte olmalı.`,
        'link_failed',
      );
    }
  }

  async readLink(p: string): Promise<string | null> {
    try {
      return await fsp.readlink(p);
    } catch {
      return null;
    }
  }

  upload(localPath: string, remotePath: string): Promise<void> {
    return this.copyFile(localPath, remotePath);
  }

  exec(file: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timer: NodeJS.Timeout | undefined;
      let grace: NodeJS.Timeout | undefined;
      let settled = false;
      const finish = (r: ExecResult) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (grace) clearTimeout(grace);
        if (child.pid) liveGroups.delete(child.pid);
        resolve(r);
      };
      const child = cpSpawn(file, args, {
        cwd: opts.cwd,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        windowsHide: true,
        // Linux: kendi süreç grubu; zaman aşımında bütün grup öldürülür
        detached: !isWin,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      trackGroup(child.pid);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (c: string) => {
        if (stdout.length < 64 * 1024 * 1024) stdout += c;
      });
      child.stderr.on('data', (c: string) => {
        if (stderr.length < 16 * 1024 * 1024) stderr += c;
      });
      child.on('error', (err) => finish({ code: -1, stdout, stderr: stderr + err.message }));
      child.on('close', (code) => finish({ code, stdout, stderr }));
      child.on('exit', (code) => {
        // Arka plana atılmış bir torun süreç boruyu açık tutarsa 'close' hiç gelmez: kısa süre sonra yine de bitir
        grace = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          finish({ code, stdout, stderr });
        }, CLOSE_GRACE_MS);
      });
      if (opts.timeoutMs) {
        timer = setTimeout(() => {
          if (child.pid) void this.killTree(child.pid);
          finish({ code: null, stdout, stderr: `${stderr}\n[zaman aşımı]`, timedOut: true });
        }, opts.timeoutMs);
      }
      child.stdin.on('error', () => undefined); // süreç girdiyi okumadan çıkarsa EPIPE
      if (opts.input !== undefined) child.stdin.end(opts.input);
      else child.stdin.end();
    });
  }

  /** Süreci ve bütün alt süreçlerini zorla öldürür (Linux: süreç grubu, Windows: taskkill /T /F). */
  private async killTree(pid: number): Promise<void> {
    if (isWin) {
      await this.exec('taskkill', ['/PID', String(pid), '/T', '/F'], { timeoutMs: 15000 }).catch(() => undefined);
      return;
    }
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* zaten yok */
      }
    }
  }

  spawn(file: string, args: string[], opts: ExecOptions = {}): StreamingProcess {
    const child = cpSpawn(file, args, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      windowsHide: true,
      // Linux: süreç grubu lideri olsun ki kill() alt süreçleri de (steamcmd.sh -> steamcmd) öldürsün
      detached: !isWin,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    trackGroup(child.pid);
    const listeners: ((chunk: string, stream: 'stdout' | 'stderr') => void)[] = [];
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => listeners.forEach((l) => l(c, 'stdout')));
    child.stderr.on('data', (c: string) => listeners.forEach((l) => l(c, 'stderr')));
    let closed = false;
    const exit = new Promise<number | null>((resolve) => {
      let grace: NodeJS.Timeout | undefined;
      const finish = (code: number | null) => {
        if (closed) return;
        closed = true;
        if (grace) clearTimeout(grace);
        if (child.pid) liveGroups.delete(child.pid);
        resolve(code);
      };
      child.on('error', (err) => {
        listeners.forEach((l) => l(`${err.message}\n`, 'stderr'));
        finish(-1);
      });
      child.on('close', (code) => finish(code));
      child.on('exit', (code) => {
        grace = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          finish(code);
        }, CLOSE_GRACE_MS);
      });
    });
    child.stdin.on('error', () => undefined);
    if (opts.closeStdin) child.stdin.end(opts.input ?? '');
    else if (opts.input !== undefined) child.stdin.write(opts.input);
    return {
      pid: Promise.resolve(child.pid),
      onData: (cb) => listeners.push(cb),
      write: (d) => {
        if (!child.stdin.destroyed) child.stdin.write(d);
      },
      kill: async () => {
        // exitCode'a bakılmaz: lider çıkmış olsa bile gruptaki alt süreçler boruyu tutabilir
        if (!closed && child.pid) await this.killTree(child.pid);
      },
      wait: () => exit,
    };
  }

  async startDetached(file: string, args: string[], opts: DetachedOptions): Promise<number> {
    if (!(await this.exists(file))) throw new HostError(`Çalıştırılabilir dosya bulunamadı: ${file}`, 'not_found');
    await fsp.mkdir(path.dirname(opts.logFile), { recursive: true });
    const fd = fs.openSync(opts.logFile, 'a');
    try {
      const child = cpSpawn(file, args, {
        cwd: opts.cwd,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        detached: true,
        stdio: ['ignore', fd, fd],
        windowsHide: !opts.showWindow,
      });
      const pid = await new Promise<number>((resolve, reject) => {
        child.once('error', (err) => reject(new HostError(`Süreç başlatılamadı: ${err.message}`, 'spawn_failed')));
        child.once('spawn', () => resolve(child.pid!));
      });
      child.unref();
      return pid;
    } finally {
      fs.closeSync(fd);
    }
  }

  async processInfo(pid: number, opts: { commandLine?: boolean } = {}): Promise<ProcessInfo> {
    if (!pid || pid <= 0) return { pid, alive: false };
    if (isWin) {
      const res = await this.exec('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { timeoutMs: 15000 });
      if (res.code !== 0) throw new HostError(`Süreç sorgulanamadı (tasklist): ${res.stderr.trim()}`, 'query_failed');
      // Bazı ortamlarda tasklist UTF-16 yazar: NUL karakterlerini at
      const line = res.stdout.replace(/\u0000/g, '').split(/\r?\n/).find((l) => l.startsWith('"'));
      if (!line) return { pid, alive: false };
      const image = line.split('","')[0]?.replace(/^"/, '').toLowerCase();
      let commandLine: string | undefined;
      if (opts.commandLine) {
        const ps = await this.exec(
          'powershell',
          ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShellCommand(winCommandLineScript(pid))],
          { timeoutMs: 20000 },
        );
        // PowerShell yoksa/başarısızsa komut satırı bilinmiyor say (boş string "başka süreç" anlamına gelmesin)
        if (ps.code === 0) commandLine = parseWinCommandLineOutput(ps.stdout);
      }
      return { pid, alive: true, ...(image ? { image } : {}), ...(commandLine !== undefined ? { commandLine } : {}) };
    }
    let stat: string;
    try {
      stat = await fsp.readFile(`/proc/${pid}/stat`, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ESRCH') return { pid, alive: false };
      throw new HostError(`Süreç sorgulanamadı: ${(err as Error).message}`, 'query_failed');
    }
    // "pid (comm) S ..." - comm parantez içinde, boşluk içerebilir
    const close = stat.lastIndexOf(')');
    const state = stat.slice(close + 2, close + 3);
    if (state === 'Z' || state === 'X') return { pid, alive: false };
    const exe = await fsp.readlink(`/proc/${pid}/exe`).catch(() => '');
    const comm = stat.slice(stat.indexOf('(') + 1, close);
    let commandLine: string | undefined;
    if (opts.commandLine) {
      commandLine = (await fsp.readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '')).split('\0').join(' ').trim();
    }
    return { pid, alive: true, image: (exe ? path.basename(exe) : comm).toLowerCase(), comm: comm.toLowerCase(), ...(commandLine !== undefined ? { commandLine } : {}) };
  }

  async killProcess(pid: number, opts: { force?: boolean } = {}): Promise<void> {
    if (isWin) {
      // Konsol uygulamaları WM_CLOSE almaz; Arma'yı nazikçe kapatmak için önce RCON #shutdown kullanılır.
      await this.exec('taskkill', ['/PID', String(pid), '/T', ...(opts.force ? ['/F'] : [])], { timeoutMs: 15000 });
      return;
    }
    const sig = opts.force ? 'SIGKILL' : 'SIGTERM';
    try {
      // detached başlatıldığı için süreç grubu lideri; grubu öldür (headless/alt süreçler dahil)
      process.kill(-pid, sig);
    } catch {
      try {
        process.kill(pid, sig);
      } catch {
        /* zaten yok */
      }
    }
  }

  followCommand(file: string, args: string[], onLines: (lines: string[]) => void, opts: { resumeArgs?: string[] } = {}): TailHandle {
    return followWithRestart((a) => this.spawn(file, a), args, opts.resumeArgs ?? args, onLines);
  }

  async getRemoteTime(): Promise<number> {
    return Date.now();
  }

  private linuxCpu = new LinuxCpuTracker();
  private winCpu = new WindowsCpuTracker();
  private pageSize: Promise<number> | null = null;

  /** Süreç CPU% / RAM: Windows'ta tek PowerShell çağrısı, Linux'ta /proc okuması (ilk çağrıda 0,5 sn ara ile iki ölçüm). */
  async processStats(pids: number[]): Promise<ProcessStat[]> {
    const list = [...new Set(pids.filter((p) => Number.isInteger(p) && p > 0))];
    if (!list.length) return [];
    if (isWin) {
      const read = async () => {
        const res = await this.exec('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShellCommand(winProcessStatsScript(list))], {
          timeoutMs: 20000,
        });
        return { rows: parseWinProcessStats(res.stdout), at: Date.now() };
      };
      if (!this.winCpu.hasBaseline(list)) {
        const first = await read();
        this.winCpu.update(first.rows, first.at, os.cpus().length, list);
        await new Promise((r) => setTimeout(r, 500));
      }
      const r = await read();
      return this.winCpu.update(r.rows, r.at, os.cpus().length, list);
    }
    this.pageSize ??= this.exec('getconf', ['PAGESIZE'], { timeoutMs: 5000 })
      .then((r) => Number(r.stdout.trim()) || 4096)
      .catch(() => 4096);
    const pageSize = await this.pageSize;
    const read = async () => {
      const total = parseProcStatTotal(await fsp.readFile('/proc/stat', 'utf8'));
      const samples: LinuxProcSample[] = [];
      for (const pid of list) {
        const text = await fsp.readFile(`/proc/${pid}/stat`, 'utf8').catch(() => null);
        const s = text ? parseProcPidStat(text) : null;
        if (s) samples.push(s);
      }
      if (total === null) throw new HostError('/proc/stat okunamadı', 'query_failed');
      return { total, samples };
    };
    if (!this.linuxCpu.hasBaseline(list)) {
      const first = await read();
      this.linuxCpu.update(first.total, first.samples, pageSize, list);
      await new Promise((r) => setTimeout(r, 500));
    }
    const r = await read();
    return this.linuxCpu.update(r.total, r.samples, pageSize, list);
  }

  tail(p: string, onLines: (lines: string[]) => void, opts: TailOptions = {}): TailHandle {
    let stopped = false;
    let offset = -1;
    let ino: number | undefined;
    // Bayt düzeyinde bölünür: yarım satır ve yarım çok baytlı karakter (ğ, ş...) bir sonraki okumaya kalır
    const splitter = new ByteLineSplitter();
    let timer: NodeJS.Timeout | undefined;
    const CHUNK = 4 * 1024 * 1024;

    const readRange = async (start: number, end: number): Promise<Buffer> => {
      const fh = await fsp.open(p, 'r');
      try {
        const buf = Buffer.alloc(end - start);
        // Kısa okuma olabilir (dosya bu arada kesildi vb.): sadece okunan baytlar kullanılır, NUL kalmaz
        const { bytesRead } = await fh.read(buf, 0, end - start, start);
        return buf.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }
    };

    const tick = async () => {
      if (stopped) return;
      try {
        const st = await fsp.stat(p).catch(() => null);
        if (st) {
          if (offset >= 0 && (st.size < offset || (ino !== undefined && st.ino !== ino))) {
            // Dosya kesildi/yeniden oluşturuldu: baştan oku, eski yarım satır yeni içeriğe yapışmasın
            offset = 0;
            splitter.reset();
          }
          ino = st.ino;
          if (offset < 0 && opts.fromStart) {
            offset = 0;
          } else if (offset < 0) {
            // İlk okuma: son N satır. Sondaki yarım satır gösterilmez, bölücüde bekler; tamamlanınca tek satır olarak gelir.
            const n = opts.initialLines ?? 200;
            const start = Math.max(0, st.size - 256 * 1024);
            let buf = st.size > 0 ? await readRange(start, st.size) : Buffer.alloc(0);
            offset = start + buf.length;
            if (start > 0) {
              // Pencerenin başındaki satır kesik: ilk satır sonuna kadar at
              const nl = buf.indexOf(0x0a);
              buf = nl >= 0 ? buf.subarray(nl + 1) : Buffer.alloc(0);
            }
            const lines = splitter.push(buf);
            if (stopped) return;
            if (n > 0 && lines.length) onLines(lines.slice(-n));
          }
          if (offset >= 0 && st.size > offset) {
            const buf = await readRange(offset, Math.min(st.size, offset + CHUNK));
            offset += buf.length;
            const lines = splitter.push(buf);
            if (lines.length && !stopped) onLines(lines);
          }
        }
      } catch {
        /* geçici okuma hatası: bir sonraki turda tekrar dene */
      }
      if (!stopped) timer = setTimeout(tick, 500);
    };
    void tick();
    return {
      stop: () => {
        stopped = true;
        if (timer) clearTimeout(timer);
      },
    };
  }
}
