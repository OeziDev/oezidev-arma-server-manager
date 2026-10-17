/**
 * Süreç CPU / RAM ölçümü için yardımcılar (host'lardan bağımsız, saf hesap).
 * CPU yüzdesi bütün makinenin kapasitesine göredir (0-100): 8 çekirdekte tek çekirdeği dolduran süreç ~%12.5.
 */

export interface ProcessStat {
  pid: number;
  /** Son ölçümden bu yana makine kapasitesine göre CPU kullanımı (0-100) */
  cpuPercent: number;
  /** Fiziksel bellek (Linux RSS, Windows WorkingSet) MB */
  memMB: number;
}

/** /proc/<pid>/stat satırından gereken alanlar */
export interface LinuxProcSample {
  pid: number;
  /** utime + stime (clock tick) */
  ticks: number;
  /** Süreç başlangıç zamanı (clock tick): PID yeniden kullanıldıysa farklı olur */
  startTime: number;
  rssPages: number;
}

/** "pid (comm) S ppid ..." biçimini çözer; zombi/bozuksa null. comm boşluk ve parantez içerebilir. */
export function parseProcPidStat(text: string): LinuxProcSample | null {
  const close = text.lastIndexOf(')');
  if (close < 0) return null;
  const pid = Number(text.slice(0, text.indexOf('(')).trim());
  const f = text.slice(close + 2).trim().split(/\s+/);
  // f[0] = alan 3 (state); alan n -> f[n-3]
  if (f.length < 22 || !Number.isFinite(pid)) return null;
  if (f[0] === 'Z' || f[0] === 'X') return null;
  const utime = Number(f[11]);
  const stime = Number(f[12]);
  const startTime = Number(f[19]);
  const rssPages = Number(f[21]);
  if (![utime, stime, startTime, rssPages].every(Number.isFinite)) return null;
  return { pid, ticks: utime + stime, startTime, rssPages };
}

/** /proc/stat "cpu  user nice system idle iowait irq softirq steal guest guest_nice" → toplam tick (guest user'a dahil) */
export function parseProcStatTotal(text: string): number | null {
  const line = text.split('\n').find((l) => /^cpu\s/.test(l));
  if (!line) return null;
  const v = line.trim().split(/\s+/).slice(1, 9).map(Number);
  if (!v.length || !v.every(Number.isFinite)) return null;
  return v.reduce((a, b) => a + b, 0);
}

/** Bu kadar süredir sorulmayan pid'lerin önceki ölçümü unutulur */
const STALE_MS = 10 * 60_000;

/**
 * Linux: iki ölçüm arasındaki farktan CPU% (tüm çekirdeklerin toplam tick'ine göre).
 * Önceki ölçüm pid başına tutulur: aynı host'u paylaşan birden fazla sunucu birbirinin ölçümünü bozmaz.
 */
export class LinuxCpuTracker {
  private prev = new Map<number, { s: LinuxProcSample | null; total: number; seen: number }>();

  /** Bu pid'ler için önceki ölçüm var mı (yoksa kısa bekleyip ikinci ölçüm alınır). Olmayan süreçler de "ölçüldü" sayılır. */
  hasBaseline(pids: number[]): boolean {
    return pids.every((p) => this.prev.has(p));
  }

  update(total: number, samples: LinuxProcSample[], pageSize: number, requested: number[] = samples.map((s) => s.pid), now = Date.now()): ProcessStat[] {
    const out: ProcessStat[] = [];
    const byPid = new Map(samples.map((s) => [s.pid, s]));
    for (const pid of new Set([...requested, ...byPid.keys()])) {
      const s = byPid.get(pid) ?? null;
      const old = this.prev.get(pid);
      this.prev.set(pid, { s, total, seen: now });
      if (!s) continue;
      let cpu = 0;
      const dTotal = old ? total - old.total : 0;
      if (old?.s && old.s.startTime === s.startTime && dTotal > 0) cpu = Math.max(0, Math.min(100, ((s.ticks - old.s.ticks) / dTotal) * 100));
      out.push({ pid, cpuPercent: round1(cpu), memMB: round1((s.rssPages * pageSize) / 1048576) });
    }
    for (const [pid, v] of this.prev) if (now - v.seen > STALE_MS) this.prev.delete(pid);
    return out;
  }
}

/** Windows: Get-Process CPU süresi (ms) farkı / (geçen süre x mantıksal çekirdek). */
export class WindowsCpuTracker {
  private prev = new Map<number, { cpuMs: number | null; at: number }>();
  /** Çift okuma (0,5 sn arayla) yapılmış pid'ler: her PowerShell çağrısı pahalı, pid başına en fazla bir kez */
  private primed = new Set<number>();

  hasBaseline(pids: number[]): boolean {
    return pids.every((p) => this.prev.has(p));
  }

  /**
   * Önceki ölçümü olmayan ve daha önce hiç çift okunmamış pid var mı. Varsa bu pid'ler "çift okundu" işaretlenir;
   * önceki ölçüm sonradan kaybolsa da (uzun ara) ikinci kez 500 ms'lik ek çağrı yapılmaz, o tur CPU 0 görünür.
   */
  needsPrime(pids: number[]): boolean {
    const missing = pids.filter((p) => !this.prev.has(p) && !this.primed.has(p));
    if (!missing.length) return false;
    if (this.primed.size > 1000) this.primed.clear();
    for (const p of missing) this.primed.add(p);
    return true;
  }

  update(
    rows: { pid: number; cpuMs: number; workingSet: number }[],
    at: number,
    cores: number,
    requested: number[] = rows.map((r) => r.pid),
  ): ProcessStat[] {
    const out: ProcessStat[] = [];
    const byPid = new Map(rows.map((r) => [r.pid, r]));
    for (const pid of new Set([...requested, ...byPid.keys()])) {
      const r = byPid.get(pid);
      const old = this.prev.get(pid);
      this.prev.set(pid, { cpuMs: r ? r.cpuMs : null, at });
      if (!r) continue;
      let cpu = 0;
      const dt = old ? at - old.at : 0;
      if (old && old.cpuMs !== null && dt > 0 && r.cpuMs >= old.cpuMs) {
        cpu = Math.max(0, Math.min(100, ((r.cpuMs - old.cpuMs) / (dt * Math.max(1, cores))) * 100));
      }
      out.push({ pid, cpuPercent: round1(cpu), memMB: round1(r.workingSet / 1048576) });
    }
    for (const [pid, v] of this.prev) if (at - v.at > STALE_MS) this.prev.delete(pid);
    return out;
  }
}

/** PowerShell: "PID CPUms WorkingSet64" satırları (sayılar tam sayı; kültür ayarından etkilenmez) */
export function winProcessStatsScript(pids: number[]): string {
  const list = pids.map((p) => Math.trunc(p)).filter((p) => p > 0).join(',');
  return (
    `$ErrorActionPreference='SilentlyContinue';` +
    `Get-Process -Id ${list} | ForEach-Object { '{0} {1} {2}' -f $_.Id, [long]$_.TotalProcessorTime.TotalMilliseconds, [long]$_.WorkingSet64 }`
  );
}

export function parseWinProcessStats(stdout: string): { pid: number; cpuMs: number; workingSet: number }[] {
  const rows: { pid: number; cpuMs: number; workingSet: number }[] = [];
  for (const line of stdout.replace(/\u0000/g, '').split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), cpuMs: Number(m[2]), workingSet: Number(m[3]) });
  }
  return rows;
}

/**
 * Uzak Linux için tek kabuk komutu: /proc/stat'ın cpu satırı, sayfa boyutu ve her pid için "P <stat satırı>".
 * Olmayan süreçler sessizce atlanır.
 */
export function linuxProcessStatsCommand(pids: number[]): string {
  const list = pids.map((p) => Math.trunc(p)).filter((p) => p > 0).join(' ');
  return `head -n1 /proc/stat; echo "PAGESIZE $(getconf PAGESIZE 2>/dev/null || echo 4096)"; for p in ${list}; do s=$(cat /proc/$p/stat 2>/dev/null) && echo "P $s"; done; true`;
}

export function parseLinuxProcessStatsOutput(stdout: string): { total: number | null; pageSize: number; samples: LinuxProcSample[] } {
  const lines = stdout.split('\n');
  const total = parseProcStatTotal(lines.find((l) => /^cpu\s/.test(l)) ?? '');
  const ps = Number(/^PAGESIZE\s+(\d+)/m.exec(stdout)?.[1]);
  const samples = lines
    .filter((l) => l.startsWith('P '))
    .map((l) => parseProcPidStat(l.slice(2)))
    .filter((s): s is LinuxProcSample => !!s);
  return { total, pageSize: Number.isFinite(ps) && ps > 0 ? ps : 4096, samples };
}

const round1 = (n: number) => Math.round(n * 10) / 10;
