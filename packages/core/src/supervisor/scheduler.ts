/** Günlük zamanlı restart hesapları (saf fonksiyonlar, test edilebilir). */

/** "HH:MM" listesinden şimdiden sonraki ilk zaman (yerel saat). */
export function nextOccurrence(times: string[], now: Date): Date | null {
  let best: Date | null = null;
  for (const t of times) {
    const m = /^(\d{2}):(\d{2})$/.exec(t);
    if (!m) continue;
    const candidate = new Date(now);
    candidate.setHours(Number(m[1]), Number(m[2]), 0, 0);
    if (candidate.getTime() <= now.getTime()) candidate.setDate(candidate.getDate() + 1);
    if (!best || candidate < best) best = candidate;
  }
  return best;
}

/**
 * Şu an gönderilmesi gereken uyarı. Uygulama geç açıldıysa kaçırılan uyarıların
 * hepsi değil, sadece en yakını gönderilir (oyuncular art arda mesaj almasın).
 * Gönderilmesi gerekenler `sent` kümesine eklenir.
 */
export function dueWarning(next: Date, now: Date, warnMinutes: number[], sent: Set<number>): number | null {
  const remainingMs = next.getTime() - now.getTime();
  if (remainingMs <= 0) return null;
  const remainingMin = remainingMs / 60_000;
  let due: number | null = null;
  for (const m of [...warnMinutes].sort((a, b) => b - a)) {
    if (remainingMin <= m && !sent.has(m)) {
      sent.add(m);
      due = m;
    }
  }
  return due === null ? null : Math.max(1, Math.ceil(remainingMin));
}

export function formatWarning(template: string, minutes: number): string {
  return template.replace(/\{minutes\}/g, String(minutes));
}
