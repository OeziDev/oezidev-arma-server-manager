/**
 * Sunucu başına performans geçmişi (bellekte). Son 1 saat tam çözünürlükte, daha eskisi dakikada bir
 * noktaya indirgenir; 24 saatten eskisi atılır. toJSON()/fromJSON() ile uygulama diske kaydedebilir.
 */

export interface MetricSample {
  /** Unix ms */
  t: number;
  fps?: number;
  fpsMin?: number;
  players?: number;
  ai?: number;
  groups?: number;
  vehicles?: number;
  /** Sunucu + headless client süreçlerinin toplam CPU'su, makine kapasitesine göre % (0-100) */
  cpu?: number;
  /** Sunucu + headless client toplam RAM (MB) */
  memMB?: number;
}

export interface MetricsJSON {
  v: 1;
  samples: MetricSample[];
}

export interface MetricsOptions {
  /** Saklama süresi (varsayılan 24 saat) */
  retentionMs?: number;
  /** Bu süreden yeni örnekler olduğu gibi tutulur (varsayılan 1 saat) */
  fullResMs?: number;
  /** Daha eski örneklerin birleştirildiği aralık (varsayılan 1 dakika) */
  bucketMs?: number;
}

const FIELDS = ['fps', 'fpsMin', 'players', 'ai', 'groups', 'vehicles', 'cpu', 'memMB'] as const;
type Field = (typeof FIELDS)[number];

interface Bucket {
  key: number;
  sums: Partial<Record<Field, number>>;
  counts: Partial<Record<Field, number>>;
  /** fpsMin için en küçük, players için en büyük değer tutulur (ortalama yerine) */
  extreme: Partial<Record<Field, number>>;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export class MetricsStore {
  private readonly retentionMs: number;
  private readonly fullResMs: number;
  private readonly bucketMs: number;
  /** Dakikalık (indirgenmiş) noktalar, zamana göre sıralı */
  private minutes: MetricSample[] = [];
  /** Doldurulmakta olan dakika */
  private acc: Bucket | null = null;
  /** Son fullResMs içindeki ham örnekler */
  private recent: MetricSample[] = [];

  constructor(opts: MetricsOptions = {}) {
    this.retentionMs = opts.retentionMs ?? 24 * 3600_000;
    this.fullResMs = opts.fullResMs ?? 3600_000;
    this.bucketMs = opts.bucketMs ?? 60_000;
  }

  get size(): number {
    return this.minutes.length + (this.acc ? 1 : 0) + this.recent.length;
  }

  push(sample: MetricSample): void {
    if (!Number.isFinite(sample.t)) return;
    const s = clean(sample);
    const last = this.recent[this.recent.length - 1];
    if (last && s.t < last.t) {
      // Saat geri gitti (ya da sırasız yükleme): sıralı ekle
      const i = this.recent.findIndex((x) => x.t > s.t);
      this.recent.splice(i < 0 ? this.recent.length : i, 0, s);
    } else this.recent.push(s);
    this.compact(this.recent[this.recent.length - 1]!.t);
  }

  /** sinceMs (Unix ms) ve sonrasındaki noktalar, eskiden yeniye */
  query(sinceMs = 0): MetricSample[] {
    const all = [...this.minutes, ...(this.acc ? [materialize(this.acc, this.bucketMs)] : []), ...this.recent];
    return sinceMs > 0 ? all.filter((s) => s.t >= sinceMs) : all;
  }

  latest(): MetricSample | undefined {
    return this.recent[this.recent.length - 1] ?? (this.acc ? materialize(this.acc, this.bucketMs) : this.minutes[this.minutes.length - 1]);
  }

  clear(): void {
    this.minutes = [];
    this.acc = null;
    this.recent = [];
  }

  toJSON(): MetricsJSON {
    return { v: 1, samples: this.query() };
  }

  static fromJSON(data: unknown, opts: MetricsOptions = {}, now = Date.now()): MetricsStore {
    const store = new MetricsStore(opts);
    const samples = (data as Partial<MetricsJSON> | null)?.samples;
    if (!Array.isArray(samples)) return store;
    const minT = now - store.retentionMs;
    samples
      .filter((s): s is MetricSample => !!s && typeof s === 'object' && Number.isFinite((s as MetricSample).t) && (s as MetricSample).t >= minT)
      .sort((a, b) => a.t - b.t)
      .forEach((s) => store.push(s));
    return store;
  }

  private compact(newest: number) {
    const cutoff = newest - this.fullResMs;
    let n = 0;
    while (n < this.recent.length && this.recent[n]!.t < cutoff) n++;
    if (n > 0) {
      for (const s of this.recent.splice(0, n)) this.addToBucket(s);
    }
    // Doldurulan dakika tamamen geçtiyse kapat
    if (this.acc && (this.acc.key + 1) * this.bucketMs <= cutoff) {
      this.minutes.push(materialize(this.acc, this.bucketMs));
      this.acc = null;
    }
    const minT = newest - this.retentionMs;
    let d = 0;
    while (d < this.minutes.length && this.minutes[d]!.t < minT) d++;
    if (d > 0) this.minutes.splice(0, d);
  }

  private addToBucket(s: MetricSample) {
    const key = Math.floor(s.t / this.bucketMs);
    if (this.acc && this.acc.key !== key) {
      if (key < this.acc.key) {
        // Sırasız eski örnek: kendi noktası olarak ekle
        this.minutes.push(s);
        this.minutes.sort((a, b) => a.t - b.t);
        return;
      }
      this.minutes.push(materialize(this.acc, this.bucketMs));
      this.acc = null;
    }
    const b = (this.acc ??= { key, sums: {}, counts: {}, extreme: {} });
    for (const f of FIELDS) {
      const v = s[f];
      if (v === undefined) continue;
      b.sums[f] = (b.sums[f] ?? 0) + v;
      b.counts[f] = (b.counts[f] ?? 0) + 1;
      if (f === 'fpsMin') b.extreme[f] = Math.min(b.extreme[f] ?? Infinity, v);
      if (f === 'players') b.extreme[f] = Math.max(b.extreme[f] ?? -Infinity, v);
    }
  }
}

function clean(s: MetricSample): MetricSample {
  const out: MetricSample = { t: s.t };
  for (const f of FIELDS) {
    const v = s[f];
    if (typeof v === 'number' && Number.isFinite(v)) out[f] = v;
  }
  return out;
}

function materialize(b: Bucket, bucketMs: number): MetricSample {
  const out: MetricSample = { t: b.key * bucketMs };
  for (const f of FIELDS) {
    const c = b.counts[f];
    if (!c) continue;
    out[f] = f === 'fpsMin' || f === 'players' ? b.extreme[f]! : round1(b.sums[f]! / c);
  }
  return out;
}
