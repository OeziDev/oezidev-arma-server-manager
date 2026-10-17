/** @oezi_monitor modunun RPT'ye yazdığı performans satırları. */

export const PERF_TAG = '[OEZI-PERF]';

export interface PerfSample {
  /** Satırın okunduğu an (bu bilgisayarın saati, Unix ms) */
  t: number;
  fps: number;
  fpsMin: number;
  players: number;
  ai: number;
  groups: number;
  vehicles: number;
  /** Ceset + enkaz sayısı (allDead); temizlik ihtiyacının göstergesi */
  objects?: number;
  /** Görev süresi (sn, `time`) */
  time?: number;
  mission: string;
  world: string;
}

const PERF_RE = /\[OEZI-PERF\]\s*(\{.*\})/;

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);

/**
 * "[OEZI-PERF] {...}" içeren log satırını çözer; değilse ya da JSON bozuksa null.
 * diag_log metni tırnaklı yazarsa ("..."" ikilenmiş tırnak) o biçim de kabul edilir.
 */
export function parsePerfLine(line: string, t = Date.now()): PerfSample | null {
  if (!line.includes(PERF_TAG)) return null;
  const m = PERF_RE.exec(line);
  if (!m) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(m[1]!);
  } catch {
    try {
      raw = JSON.parse(m[1]!.replace(/""/g, '"'));
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const fps = num(o.fps);
  if (fps === undefined) return null;
  const objects = num(o.objects);
  const time = num(o.time);
  return {
    t,
    fps,
    fpsMin: num(o.fpsMin) ?? fps,
    players: num(o.players) ?? 0,
    ai: num(o.ai) ?? 0,
    groups: num(o.groups) ?? 0,
    vehicles: num(o.vehicles) ?? 0,
    ...(objects !== undefined ? { objects } : {}),
    ...(time !== undefined ? { time } : {}),
    mission: typeof o.mission === 'string' ? o.mission : '',
    world: typeof o.world === 'string' ? o.world : '',
  };
}
