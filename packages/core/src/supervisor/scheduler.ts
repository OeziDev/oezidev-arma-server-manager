/** Günlük zamanlı restart hesapları (saf fonksiyonlar, test edilebilir). */

/**
 * "HH:MM" listesinden şimdiden sonraki ilk zaman (yerel saat).
 * Her aday gün için tarih yeniden kurulur (new Date(y, m, d + k, hh, mm)): yaz saatine geçiş
 * günü var olmayan 02:30 o gün 03:30'a kayar ama sonraki günler yine 02:30 olur.
 */
export function nextOccurrence(times: string[], now: Date): Date | null {
  let best: Date | null = null;
  for (const t of times) {
    const m = /^(\d{2}):(\d{2})$/.exec(t);
    if (!m) continue;
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    for (let k = 0; k <= 2; k++) {
      const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + k, hh, mm, 0, 0);
      if (candidate.getTime() <= now.getTime()) continue;
      if (!best || candidate < best) best = candidate;
      break;
    }
  }
  return best;
}

/**
 * Şu an gönderilmesi gereken uyarı ve gönderildiğinde "gönderildi" sayılacak eşikler.
 * Uygulama geç açıldıysa kaçırılan uyarıların hepsi değil, sadece en yakını gönderilir
 * (oyuncular art arda mesaj almasın). `sent` değiştirilmez: çağıran, mesaj gerçekten
 * gönderildikten sonra `marks`'ı ekler (gönderilemezse bir sonraki turda yeniden denenir).
 */
export function planWarning(next: Date, now: Date, warnMinutes: number[], sent: ReadonlySet<number>): { minutes: number; marks: number[] } | null {
  const remainingMs = next.getTime() - now.getTime();
  if (remainingMs <= 0) return null;
  const remainingMin = remainingMs / 60_000;
  const marks: number[] = [];
  for (const m of [...warnMinutes].sort((a, b) => b - a)) {
    if (remainingMin <= m && !sent.has(m)) marks.push(m);
  }
  return marks.length ? { minutes: Math.max(1, Math.ceil(remainingMin)), marks } : null;
}

/**
 * planWarning'in eski biçimi: gönderilmesi gerekenleri hemen `sent` kümesine ekler.
 */
export function dueWarning(next: Date, now: Date, warnMinutes: number[], sent: Set<number>): number | null {
  const plan = planWarning(next, now, warnMinutes, sent);
  if (!plan) return null;
  plan.marks.forEach((m) => sent.add(m));
  return plan.minutes;
}

export function formatWarning(template: string, minutes: number): string {
  return template.replace(/\{minutes\}/g, String(minutes));
}
