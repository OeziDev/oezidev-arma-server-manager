import { describe, expect, it } from 'vitest';
import { DiscordNotifier } from '../src/notify/discord.js';

const HOOK = 'https://discord.com/api/webhooks/123456/abc-DEF_ghi';

function fakeFetch(responses: (() => Response)[]) {
  const calls: { body: any; at: number }[] = [];
  const impl = (async (_url: string, init: RequestInit) => {
    calls.push({ body: JSON.parse(String(init.body)), at: Date.now() });
    const next = responses.shift() ?? (() => new Response(null, { status: 204 }));
    return next();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('Discord bildirimleri', () => {
  it('boş açıklama alanını göndermez', async () => {
    const { impl, calls } = fakeFetch([]);
    await new DiscordNotifier(HOOK, 'Altis', impl).notify('start', 'Sunucu başlatıldı');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.embeds[0]).not.toHaveProperty('description');
    expect(calls[0]!.body.embeds[0].title).toBe('Altis: Sunucu başlatıldı');
    await new DiscordNotifier(HOOK, 'Altis', impl).notify('crash', 'Çöktü', 'File x, line 1: hata');
    expect(calls[1]!.body.embeds[0].description).toBe('File x, line 1: hata');
  });

  it('429 gelirse retry_after kadar bekleyip bir kez daha dener', async () => {
    const { impl, calls } = fakeFetch([() => new Response(JSON.stringify({ retry_after: 0.3 }), { status: 429, headers: { 'Content-Type': 'application/json' } })]);
    await new DiscordNotifier(HOOK, 'Altis', impl).notify('info', 'Test', 'x');
    expect(calls).toHaveLength(2);
    expect(calls[1]!.at - calls[0]!.at).toBeGreaterThanOrEqual(250);
  });

  it('ikinci 429 da gelirse hata verir (sonsuz deneme yok)', async () => {
    const r429 = () => new Response(JSON.stringify({ retry_after: 0 }), { status: 429 });
    const { impl, calls } = fakeFetch([r429, r429, r429]);
    await expect(new DiscordNotifier(HOOK, 'Altis', impl).notify('info', 'Test')).rejects.toThrow('HTTP 429');
    expect(calls).toHaveLength(2);
  });
});
