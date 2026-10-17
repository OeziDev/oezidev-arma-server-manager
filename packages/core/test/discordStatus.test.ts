import { describe, expect, it } from 'vitest';
import { createProfile } from '../src/model/profile.js';
import { DiscordStatusUpdater, fitPlayerList } from '../src/notify/discordStatus.js';
import type { StatusInfo } from '../src/supervisor/manager.js';

const HOOK = 'https://discord.com/api/webhooks/123456/abc-DEF_ghi';

function fakeFetch(responses: (() => Response)[]) {
  const calls: { url: string; method: string; body: any; at: number }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: String(init.method), body: JSON.parse(String(init.body)), at: Date.now() });
    const next = responses.shift() ?? (() => new Response(JSON.stringify({ id: '1' }), { status: 200 }));
    return next();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function source(over: Partial<StatusInfo> = {}, messageId = '') {
  let profile = createProfile({
    name: 'Altis Life #1',
    general: { maxPlayers: 80, hostname: 'ArmaTürk Altis Life' },
    notifications: { discordWebhook: HOOK },
    discordStatus: { enabled: true, intervalSec: 60, showPlayers: true, messageId },
  });
  const now = Date.now();
  const status: StatusInfo = {
    status: 'running',
    mode: 'direct',
    startedAt: now - (2 * 3600_000 + 15 * 60_000),
    autoRestarts: 0,
    headless: [],
    rcon: 'connected',
    players: 2,
    nextScheduledRestart: now + 3600_000,
    perf: { t: now, fps: 47.25, cpu: 31.4, memMB: 4300, ai: 120 },
    ...over,
  };
  return {
    setProfile: (p: typeof profile) => (profile = p),
    getProfile: () => profile,
    getStatus: () => status,
    getPlayers: () => [{ name: 'Oezi_*Dev*' }, { name: '@everyone' }],
    getLastPerf: () => ({ t: now, fps: 47, fpsMin: 30, players: 2, ai: 120, groups: 10, vehicles: 5, mission: 'Altis Life', world: 'Altis' }),
  };
}

describe('Discord durum mesajı', () => {
  it('ilk seferde POST ?wait=true, sonra PATCH; 404 gelirse yeniden POST ve yeni kimlik bildirilir', async () => {
    const { impl, calls } = fakeFetch([
      json(200, { id: '1111' }),
      json(200, { id: '1111' }),
      json(404, { message: 'Unknown Message', code: 10008 }),
      json(200, { id: '2222' }),
      json(200, { id: '2222' }),
    ]);
    const ids: string[] = [];
    const src = source();
    const up = new DiscordStatusUpdater({ source: src, fetchImpl: impl, onMessageId: (id) => ids.push(id) });
    await up.update();
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe(`${HOOK}?wait=true`);
    expect(ids).toEqual(['1111']);
    const embed = calls[0]!.body.embeds[0];
    expect(embed.title).toBe('Altis Life #1');
    expect(embed.color).toBe(0x2ecc71);
    const f = Object.fromEntries(embed.fields.map((x: any) => [x.name, x.value]));
    expect(f['Durum']).toBe('Çalışıyor');
    expect(f['Oyuncular']).toBe('2/80');
    expect(f['Sunucu FPS']).toBe('47.3');
    expect(f['CPU / RAM']).toBe('31% / 4.2 GB');
    expect(f['Görev / Harita']).toBe('Altis Life (Altis)');
    expect(f['Çalışma süresi']).toBe('2 sa 15 dk');
    expect(f['Sonraki restart']).toMatch(/^<t:\d+:t> \(<t:\d+:R>\)$/);
    expect(f['Oyuncu listesi (2)']).toBe('Oezi\\_\\*Dev\\*, @\u200beveryone');
    expect(f['Son güncelleme']).toMatch(/^<t:\d+:R>$/);

    await up.update();
    expect(calls[1]!.method).toBe('PATCH');
    expect(calls[1]!.url).toBe(`${HOOK}/messages/1111`);
    expect(calls[1]!.body).not.toHaveProperty('username');

    await up.update(); // 404 -> yeni mesaj
    expect(calls.slice(2).map((c) => `${c.method} ${c.url}`)).toEqual([`PATCH ${HOOK}/messages/1111`, `POST ${HOOK}?wait=true`]);
    expect(ids).toEqual(['1111', '2222']);
    await up.update();
    expect(calls[4]!.url).toBe(`${HOOK}/messages/2222`);
  });

  it('profildeki kayıtlı kimlikle başlar (uygulama yeniden açıldı); 429 retry_after kadar bekler', async () => {
    const { impl, calls } = fakeFetch([json(429, { retry_after: 0.2 }), json(200, { id: '5555' })]);
    const up = new DiscordStatusUpdater({ source: source({}, '5555'), fetchImpl: impl });
    await up.update();
    expect(calls.map((c) => c.method)).toEqual(['PATCH', 'PATCH']);
    expect(calls[0]!.url).toBe(`${HOOK}/messages/5555`);
    expect(calls[1]!.at - calls[0]!.at).toBeGreaterThanOrEqual(150);
  });

  it('kapalıyken / webhook yokken istek atmaz; sunucu kapalıysa canlı alanlar boş', async () => {
    const { impl, calls } = fakeFetch([]);
    const src = source({ status: 'stopped', players: 0 });
    src.setProfile(createProfile({ ...src.getProfile(), discordStatus: { enabled: false } }));
    const up = new DiscordStatusUpdater({ source: src, fetchImpl: impl });
    await up.update();
    expect(calls).toHaveLength(0);
    src.setProfile(createProfile({ ...src.getProfile(), discordStatus: { enabled: true }, notifications: { discordWebhook: '' } }));
    await up.update();
    expect(calls).toHaveLength(0);
    src.setProfile(createProfile({ ...src.getProfile(), discordStatus: { enabled: true, webhook: HOOK } }));
    await up.update();
    expect(calls).toHaveLength(1);
    const embed = calls[0]!.body.embeds[0];
    const f = Object.fromEntries(embed.fields.map((x: any) => [x.name, x.value]));
    expect(f['Durum']).toBe('Kapalı');
    expect(f['Oyuncular']).toBe('-');
    expect(f['Sunucu FPS']).toBe('-');
    expect(embed.fields.some((x: any) => x.name.startsWith('Oyuncu listesi'))).toBe(false);
  });

  it('oyuncu listesi 1024 karaktere sığdırılır', () => {
    const names = Array.from({ length: 200 }, (_, i) => `Oyuncu_Adi_Uzun_${i}`);
    const text = fitPlayerList(names, (n) => `... ve ${n} kişi daha`);
    expect(text.length).toBeLessThanOrEqual(1024);
    expect(text).toMatch(/\n\.\.\. ve \d+ kişi daha$/);
    const shown = text.split('\n')[0]!.split(', ').length;
    expect(text).toContain(`ve ${200 - shown} kişi daha`);
  });
});
