/**
 * Zamanlı yedek denetimi: 30 sn'de bir çağrılır, o dakikaya denk gelen yedek saatlerini döner.
 * Aynı gün + aynı saat için yalnızca bir kez döner (dakika içinde iki tur olsa da).
 * Uygulama o dakikada kapalıysa yedek sonradan alınmaz (telafi yok).
 */

const pad = (n: number) => String(n).padStart(2, '0');

export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export class BackupScheduleTracker {
  /** "<profil>|<gün>|<HH:MM>" -> çalıştırıldı */
  private done = new Set<string>();

  /** Bu profil için şimdi başlatılması gereken saatler (döndürülenler "yapıldı" olarak işaretlenir) */
  due(profileId: string, times: string[], now: Date): string[] {
    const hm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const day = dayKey(now);
    const out: string[] = [];
    for (const t of new Set(times)) {
      if (t !== hm) continue;
      const key = `${profileId}|${day}|${t}`;
      if (this.done.has(key)) continue;
      this.done.add(key);
      out.push(t);
    }
    this.prune(day);
    return out;
  }

  /** Bugünden başka günlere ait kayıtları at (bellek büyümesin) */
  private prune(today: string) {
    for (const k of this.done) if (k.split('|')[1] !== today) this.done.delete(k);
  }

  forget(profileId: string) {
    for (const k of this.done) if (k.startsWith(`${profileId}|`)) this.done.delete(k);
  }
}
