import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dueWarning, nextOccurrence, planWarning } from '../src/supervisor/scheduler.js';

/**
 * Yaz saati geçişi: Europe/Berlin'de 29 Mart 2026 02:00 → 03:00 (02:30 yok).
 * Test işçisinde (worker) process.env.TZ değiştirmek saat dilimini değiştirmeyebilir;
 * bu yüzden hesap TZ=Europe/Berlin ile ayrı bir node sürecinde yapılır.
 */
function inBerlin(cases: { times: string[]; now: number[] }[]): number[][] {
  const mod = pathToFileURL(fileURLToPath(new URL('../src/supervisor/scheduler.ts', import.meta.url))).href;
  const script = `
    const m = await import(${JSON.stringify(mod)});
    const cases = ${JSON.stringify(cases)};
    const out = cases.map((c) => {
      const d = m.nextOccurrence(c.times, new Date(...c.now));
      return [d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()];
    });
    out.push([new Date(2026, 2, 29, 2, 30).getHours()]);
    console.log(JSON.stringify(out));`;
  const stdout = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script], {
    env: { ...process.env, TZ: 'Europe/Berlin' },
    encoding: 'utf8',
  });
  return JSON.parse(stdout.trim().split('\n').pop()!);
}

describe('zamanlayıcı: yaz saati', () => {
  it('var olmayan 02:30 sadece o gün kayar; sonraki günler yine 02:30', () => {
    const r = inBerlin([
      // Geçişten önceki gün öğlen: sıradaki 29 Mart 02:30 → yerel saatte 03:30'a kayar
      { times: ['02:30'], now: [2026, 2, 28, 12, 0] },
      // Geçiş günü 04:00: sıradaki 30 Mart 02:30 olmalı (eski hata: 03:30)
      { times: ['02:30'], now: [2026, 2, 29, 4, 0] },
      // Geçiş günü 01:00: önce 03:30 (02:30 yerine), 06:00 değil
      { times: ['02:30', '06:00'], now: [2026, 2, 29, 1, 0] },
      // Kış saatine dönüş (25 Ekim 2026): 02:30 iki kez yaşanır
      { times: ['02:30'], now: [2026, 9, 25, 1, 0] },
      // Ertesi gün normal
      { times: ['02:30'], now: [2026, 9, 25, 4, 0] },
    ]);
    // TZ gerçekten uygulandı mı (02:30 yok → 03:00'dan sonra)
    expect(r.pop()).toEqual([3]);
    expect(r).toEqual([
      [2, 29, 3, 30],
      [2, 30, 2, 30],
      [2, 29, 3, 30],
      [9, 25, 2, 30],
      [9, 26, 2, 30],
    ]);
  });

  it('gün sonu / ay sonu', () => {
    expect(nextOccurrence(['00:05'], new Date(2026, 11, 31, 23, 59))).toEqual(new Date(2027, 0, 1, 0, 5));
    expect(nextOccurrence(['12:00'], new Date(2026, 1, 28, 12, 0))).toEqual(new Date(2026, 2, 1, 12, 0));
  });
});

describe('zamanlayıcı: uyarı planı', () => {
  it('planWarning kümeyi değiştirmez; işaretlemeyi çağıran yapar', () => {
    const next = new Date(2026, 9, 11, 18, 0);
    const sent = new Set<number>();
    const plan = planWarning(next, new Date(2026, 9, 11, 17, 52, 30), [15, 10, 5, 1], sent);
    expect(plan).toEqual({ minutes: 8, marks: [15, 10] });
    expect(sent.size).toBe(0);
    // Gönderilemedi: sonraki turda yine gönderilmeli
    expect(planWarning(next, new Date(2026, 9, 11, 17, 53), [15, 10, 5, 1], sent)).toEqual({ minutes: 7, marks: [15, 10] });
    plan!.marks.forEach((m) => sent.add(m));
    expect(planWarning(next, new Date(2026, 9, 11, 17, 53), [15, 10, 5, 1], sent)).toBeNull();
    // eski API aynı davranır
    expect(dueWarning(next, new Date(2026, 9, 11, 17, 59, 30), [15, 10, 5, 1], sent)).toBe(1);
    expect(sent).toEqual(new Set([15, 10, 5, 1]));
  });
});
