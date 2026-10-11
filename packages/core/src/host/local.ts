import { spawn as cpSpawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { HostOs } from '../launch/paths.js';
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
import { followWithRestart } from './follow.js';

const isWin = process.platform === 'win32';

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
      this.systemd = createSystemdApi((file, args) => this.exec(file, args), (p, d) => this.writeFile(p, d), (p) => this.remove(p));
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

  async writeFile(p: string, data: string | Buffer): Promise<void> {
    await fsp.mkdir(path.dirname(p), { recursive: true });
    const tmp = `${p}.${randomBytes(4).toString('hex')}.tmp`;
    await fsp.writeFile(tmp, data);
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
    await fsp.symlink(target, linkPath, isWin ? 'junction' : 'dir');
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
      const child = cpSpawn(file, args, {
        cwd: opts.cwd,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (c: string) => {
        if (stdout.length < 64 * 1024 * 1024) stdout += c;
      });
      child.stderr.on('data', (c: string) => {
        if (stderr.length < 16 * 1024 * 1024) stderr += c;
      });
      child.on('error', (err) => {
        if (timer) clearTimeout(timer);
        resolve({ code: -1, stdout, stderr: stderr + err.message });
      });
      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
      if (opts.timeoutMs) {
        timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs);
      }
      child.stdin.on('error', () => undefined); // süreç girdiyi okumadan çıkarsa EPIPE
      if (opts.input !== undefined) child.stdin.end(opts.input);
      else child.stdin.end();
    });
  }

  spawn(file: string, args: string[], opts: ExecOptions = {}): StreamingProcess {
    const child = cpSpawn(file, args, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const listeners: ((chunk: string, stream: 'stdout' | 'stderr') => void)[] = [];
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => listeners.forEach((l) => l(c, 'stdout')));
    child.stderr.on('data', (c: string) => listeners.forEach((l) => l(c, 'stderr')));
    const exit = new Promise<number | null>((resolve) => {
      child.on('error', (err) => {
        listeners.forEach((l) => l(`${err.message}\n`, 'stderr'));
        resolve(-1);
      });
      child.on('close', (code) => resolve(code));
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
        if (child.exitCode === null && child.pid) await this.killProcess(child.pid, { force: true }).catch(() => undefined);
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
      const line = res.stdout.split(/\r?\n/).find((l) => l.startsWith('"'));
      if (!line) return { pid, alive: false };
      const image = line.split('","')[0]?.replace(/^"/, '').toLowerCase();
      let commandLine: string | undefined;
      if (opts.commandLine) {
        const ps = await this.exec(
          'powershell',
          ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${Math.trunc(pid)}").CommandLine`],
          { timeoutMs: 20000 },
        );
        if (ps.code === 0) commandLine = ps.stdout.trim();
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
      await this.exec('taskkill', ['/PID', String(pid), '/T', ...(opts.force ? ['/F'] : [])]);
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

  tail(p: string, onLines: (lines: string[]) => void, opts: TailOptions = {}): TailHandle {
    let stopped = false;
    let offset = -1;
    const splitter = new LineSplitter();
    let timer: NodeJS.Timeout | undefined;

    // Çok baytlı UTF-8 karakterler (ğ, ş...) okuma sınırında bölünmesin
    let decoder = new StringDecoder('utf8');
    const readRange = async (start: number, end: number): Promise<string> => {
      const fh = await fsp.open(p, 'r');
      try {
        const len = end - start;
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, start);
        return decoder.write(buf);
      } finally {
        await fh.close();
      }
    };

    const tick = async () => {
      if (stopped) return;
      try {
        const st = await fsp.stat(p).catch(() => null);
        if (st) {
          if (offset < 0 && opts.fromStart) {
            offset = 0;
            const end = Math.min(st.size, 4 * 1024 * 1024);
            if (end > 0) {
              const lines = splitter.push(await readRange(0, end));
              offset = end;
              if (lines.length) onLines(lines);
            }
          } else if (offset < 0) {
            // İlk okuma: son N satır
            const n = opts.initialLines ?? 200;
            const start = Math.max(0, st.size - 256 * 1024);
            const text = st.size > 0 ? await readRange(start, st.size) : '';
            let lines = text.split(/\r?\n/);
            if (start > 0) lines = lines.slice(1);
            if (lines.length && lines[lines.length - 1] === '') lines.pop();
            if (n > 0 && lines.length) onLines(lines.slice(-n));
            offset = st.size;
          } else if (st.size < offset) {
            offset = 0; // dosya kesildi/yeniden oluşturuldu
            decoder = new StringDecoder('utf8');
          } else if (st.size > offset) {
            const end = Math.min(st.size, offset + 4 * 1024 * 1024);
            const text = await readRange(offset, end);
            offset = end;
            const lines = splitter.push(text);
            if (lines.length) onLines(lines);
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
