/** Discord webhook bildirimleri (sunucu başladı, durdu, çöktü, güncellendi...). */

export type NotifyEvent = 'start' | 'stop' | 'crash' | 'restart' | 'update' | 'info';

const COLORS: Record<NotifyEvent, number> = {
  start: 0x2ecc71,
  stop: 0x95a5a6,
  crash: 0xe74c3c,
  restart: 0xf1c40f,
  update: 0x3498db,
  info: 0x7f8c8d,
};

export interface Notifier {
  notify(event: NotifyEvent, title: string, description?: string): Promise<void>;
}

const WEBHOOK_RE = /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;

export function isDiscordWebhook(url: string): boolean {
  return WEBHOOK_RE.test(url.trim());
}

export class DiscordNotifier implements Notifier {
  constructor(
    private readonly webhookUrl: string,
    private readonly serverName: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!isDiscordWebhook(webhookUrl)) throw new Error('Geçersiz Discord webhook adresi');
  }

  async notify(event: NotifyEvent, title: string, description = ''): Promise<void> {
    const embed: Record<string, unknown> = {
      title: `${this.serverName}: ${title}`.slice(0, 256),
      color: COLORS[event],
      timestamp: new Date().toISOString(),
      footer: { text: 'OeziDev Arma Server Manager' },
    };
    // Discord boş açıklamayı reddedebilir: boşsa hiç gönderme
    if (description.trim()) embed.description = description.slice(0, 4000);
    const body = JSON.stringify({ username: 'Arma Server Manager', embeds: [embed] });
    const send = () =>
      this.fetchImpl(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(10_000),
      });
    let res = await send();
    if (res.status === 429) {
      // Hız sınırı: retry_after kadar bekleyip bir kez daha dene (en fazla 10 sn)
      const waitMs = Math.min(10_000, Math.max(0, await retryAfterMs(res)));
      await new Promise((r) => setTimeout(r, waitMs));
      res = await send();
    }
    if (!res.ok && res.status !== 204) {
      throw new Error(`Discord bildirimi gönderilemedi (HTTP ${res.status})`);
    }
  }
}

/** 429 cevabındaki bekleme süresi (gövdedeki retry_after saniye, yoksa Retry-After başlığı). */
async function retryAfterMs(res: Response): Promise<number> {
  try {
    const data = (await res.clone().json()) as { retry_after?: unknown };
    const sec = Number(data?.retry_after);
    if (Number.isFinite(sec) && sec >= 0) return sec * 1000;
  } catch {
    /* JSON değil */
  }
  const header = Number(res.headers?.get?.('retry-after'));
  return Number.isFinite(header) && header >= 0 ? header * 1000 : 1000;
}
