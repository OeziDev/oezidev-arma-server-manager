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
    const body = {
      username: 'Arma Server Manager',
      embeds: [
        {
          title: `${this.serverName}: ${title}`.slice(0, 256),
          description: description.slice(0, 4000),
          color: COLORS[event],
          timestamp: new Date().toISOString(),
          footer: { text: 'OeziDev Arma Server Manager' },
        },
      ],
    };
    const res = await this.fetchImpl(this.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok && res.status !== 204) {
      throw new Error(`Discord bildirimi gönderilemedi (HTTP ${res.status})`);
    }
  }
}
