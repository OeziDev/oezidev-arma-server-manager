/**
 * Düşük FPS uyarısı: FPS `belowFps` altında art arda `minutes` dakika kalırsa (en az 3 örnek) bir kez uyarır.
 * FPS eşiğin üstünde (>= belowFps) 2 dakika kalınca yeniden kurulur.
 * Aynı sunucu için iki uyarı arasında en az FPS_ALERT_COOLDOWN_MS (30 dk) olur; reset() bu süreyi sıfırlamaz
 * (yeniden başlatma uyarı yağmuruna yol açmasın).
 */

export interface FpsAlertConfig {
  belowFps: number;
  /** 0: kapalı */
  minutes: number;
  /** İki uyarı arası en az süre (ms); varsayılan FPS_ALERT_COOLDOWN_MS */
  cooldownMs?: number;
}

export type FpsAlertEvent = { kind: 'alert'; avgFps: number; minFps: number; sinceMs: number } | { kind: 'recovered' };

export const FPS_RECOVER_MS = 2 * 60_000;
export const FPS_ALERT_COOLDOWN_MS = 30 * 60_000;
const MIN_SAMPLES = 3;

export class FpsAlertTracker {
  /** Düşük FPS serisi: başlangıç zamanı ve örnekler */
  private low: { t: number; fps: number }[] = [];
  private lastT = 0;
  private alerted = false;
  private highSince: number | null = null;
  private lastAlertAt = Number.NEGATIVE_INFINITY;

  get active(): boolean {
    return this.alerted;
  }

  reset(): void {
    this.low = [];
    this.lastT = 0;
    this.alerted = false;
    this.highSince = null;
  }

  /** Yeni FPS örneği; uyarı ya da düzelme olursa olayı döner. */
  update(t: number, fps: number, cfg: FpsAlertConfig): FpsAlertEvent | null {
    if (cfg.minutes <= 0) {
      this.reset();
      return null;
    }
    const windowMs = cfg.minutes * 60_000;
    // Uzun veri boşluğu (mod yüklenmedi, sunucu durdu...): seri kopar
    if (this.lastT && t - this.lastT > Math.max(windowMs, FPS_RECOVER_MS)) {
      this.low = [];
      this.highSince = null;
    }
    this.lastT = t;
    if (fps < cfg.belowFps) {
      this.low.push({ t, fps });
      this.highSince = null;
      const cooldown = cfg.cooldownMs ?? FPS_ALERT_COOLDOWN_MS;
      if (!this.alerted && this.low.length >= MIN_SAMPLES && t - this.low[0]!.t >= windowMs && t - this.lastAlertAt >= cooldown) {
        this.alerted = true;
        this.lastAlertAt = t;
        const recent = this.low.filter((x) => x.t >= t - windowMs);
        const avg = recent.reduce((a, x) => a + x.fps, 0) / recent.length;
        return { kind: 'alert', avgFps: Math.round(avg * 10) / 10, minFps: Math.min(...recent.map((x) => x.fps)), sinceMs: this.low[0]!.t };
      }
      // Bellek büyümesin: pencereden eski örneklerin sadece ilki (seri başlangıcı) gerekir
      if (this.low.length > 2000) this.low.splice(1, this.low.length - 1000);
      return null;
    }
    this.low = [];
    if (!this.alerted) return null;
    this.highSince ??= t;
    if (t - this.highSince >= FPS_RECOVER_MS) {
      this.alerted = false;
      this.highSince = null;
      return { kind: 'recovered' };
    }
    return null;
  }
}
