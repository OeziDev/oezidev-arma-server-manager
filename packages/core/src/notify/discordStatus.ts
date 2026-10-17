import type { ServerProfile } from '../model/profile.js';
import type { PerfSample } from '../monitor/perf.js';
import type { ServerStatus, StatusInfo } from '../supervisor/manager.js';
import { isDiscordWebhook, retryAfterMs } from './discord.js';

/**
 * Discord'da kendini güncelleyen durum mesajı (webhook ile).
 * İlk seferde `POST {webhook}?wait=true` ile tek bir embed gönderilir, dönen mesaj kimliği saklanır;
 * sonra her intervalSec'te `PATCH {webhook}/messages/{id}` ile düzenlenir. Mesaj silinmişse (404) yenisi atılır.
 * Yeni kimlik `onMessageId` ile bildirilir: uygulama profile.discordStatus.messageId'ye kaydetmeli.
 */

export interface DiscordStatusSource {
  getProfile(): ServerProfile;
  getStatus(): StatusInfo;
  /** Son RCON oyuncu listesi */
  getPlayers(): { name: string }[];
  /** @oezi_monitor'dan son performans satırı (görev / harita adı için) */
  getLastPerf(): PerfSample | undefined;
}

export interface DiscordStatusOptions {
  source: DiscordStatusSource;
  fetchImpl?: typeof fetch;
  /** Yeni mesaj atıldığında kimliği (uygulama profile kaydeder) */
  onMessageId?: (id: string) => void;
  log?: (line: string) => void;
  lang?: 'tr' | 'en';
  /** 429 cevabında en fazla bu kadar beklenir (ms) */
  maxRetryWaitMs?: number;
  /** Kullanıcının görmesi gereken tek seferlik uyarı (ör. webhook silinmiş) */
  onWarning?: (message: { tr: string; en: string }) => void;
}

/** Discord JSON hata kodu: webhook silinmiş / geçersiz */
export const DISCORD_UNKNOWN_WEBHOOK = 10015;

/** Webhook adresini temel adres + thread_id olarak ayırır (diğer sorgu parametreleri atılır). */
export function parseStatusWebhook(raw: string): { base: string; threadId: string } {
  const trimmed = raw.trim();
  const q = trimmed.indexOf('?');
  const base = q >= 0 ? trimmed.slice(0, q) : trimmed;
  let threadId = '';
  if (q >= 0) {
    const t = new URLSearchParams(trimmed.slice(q + 1)).get('thread_id')?.trim() ?? '';
    if (/^\d+$/.test(t)) threadId = t;
  }
  return { base, threadId };
}

const STATUS_COLORS: Record<ServerStatus, number> = {
  running: 0x2ecc71,
  starting: 0xf1c40f,
  restarting: 0xf1c40f,
  updating: 0x3498db,
  stopping: 0x95a5a6,
  stopped: 0x95a5a6,
  crashed: 0xe74c3c,
};

const LABELS = {
  tr: {
    status: 'Durum',
    players: 'Oyuncular',
    fps: 'Sunucu FPS',
    cpuRam: 'CPU / RAM',
    mission: 'Görev / Harita',
    uptime: 'Çalışma süresi',
    nextRestart: 'Sonraki restart',
    playerList: 'Oyuncu listesi',
    lastUpdate: 'Son güncelleme',
    more: (n: number) => `... ve ${n} kişi daha`,
    unreachable: 'makineye ulaşılamıyor',
    states: {
      running: 'Çalışıyor',
      starting: 'Başlatılıyor',
      restarting: 'Yeniden başlatılıyor',
      updating: 'Güncelleniyor',
      stopping: 'Durduruluyor',
      stopped: 'Kapalı',
      crashed: 'Çöktü',
    } as Record<ServerStatus, string>,
    dur: { d: 'g', h: 'sa', m: 'dk' },
  },
  en: {
    status: 'Status',
    players: 'Players',
    fps: 'Server FPS',
    cpuRam: 'CPU / RAM',
    mission: 'Mission / Map',
    uptime: 'Uptime',
    nextRestart: 'Next restart',
    playerList: 'Player list',
    lastUpdate: 'Last update',
    more: (n: number) => `... and ${n} more`,
    unreachable: 'machine unreachable',
    states: {
      running: 'Running',
      starting: 'Starting',
      restarting: 'Restarting',
      updating: 'Updating',
      stopping: 'Stopping',
      stopped: 'Offline',
      crashed: 'Crashed',
    } as Record<ServerStatus, string>,
    dur: { d: 'd', h: 'h', m: 'min' },
  },
};

/** Discord markdown karakterlerini kaçır (oyuncu adları biçimlendirmeyi bozmasın) */
const escapeMd = (s: string) => s.replace(/([\\*_~`|>])/g, '\\$1').replace(/@/g, '@\u200b');

/** Ad listesini 1024 karakterlik alan sınırına sığdırır */
export function fitPlayerList(names: string[], moreLabel: (n: number) => string, limit = 1024): string {
  const parts: string[] = [];
  let len = 0;
  for (let i = 0; i < names.length; i++) {
    const item = escapeMd(names[i]!.trim() || '?');
    const sep = parts.length ? 2 : 0;
    const rest = names.length - i - 1;
    const tail = rest > 0 ? 2 + moreLabel(rest + 1).length : 0;
    if (len + sep + item.length + tail > limit) {
      const more = moreLabel(names.length - i);
      return parts.length ? `${parts.join(', ')}\n${more}`.slice(0, limit) : more.slice(0, limit);
    }
    parts.push(item);
    len += sep + item.length;
  }
  return parts.join(', ');
}

function fmtDuration(ms: number, u: { d: string; h: string; m: string }): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  if (d) return `${d} ${u.d} ${h} ${u.h}`;
  if (h) return `${h} ${u.h} ${m} ${u.m}`;
  return `${m} ${u.m}`;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    /** Discord JSON gövdesindeki `code` (varsa) */
    readonly code?: number,
  ) {
    super(`Discord HTTP ${status}${code ? ` (kod ${code})` : ''}`);
  }
}

export class DiscordStatusUpdater {
  private readonly fetchImpl: typeof fetch;
  private timer: NodeJS.Timeout | null = null;
  private pokeTimer: NodeJS.Timeout | null = null;
  private running = false;
  private inFlight: Promise<void> | null = null;
  private messageId: string | null = null;
  private lastHook: string | null = null;
  /** Webhook değişince profildeki eski kimlik (başka webhook'a ait) yok sayılır */
  private ignoreProfileId: string | null = null;
  private lastErrorLog = { text: '', at: 0 };
  /** "Mesaj silinmiş" logu en fazla 10 dk'da bir */
  private lastDeletedLogAt = 0;
  /** Discord 10015 (Unknown Webhook) dönen webhook: değişene kadar istek atılmaz */
  private deadHook: string | null = null;
  private lastRun = 0;

  constructor(private readonly opts: DiscordStatusOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get currentMessageId(): string | null {
    return this.messageId;
  }

  /** Durum mesajı açık ve webhook geçerli mi */
  isEnabled(): boolean {
    const p = this.opts.source.getProfile();
    return p.discordStatus.enabled && isDiscordWebhook(this.webhookOf(p));
  }

  private webhookOf(p: ServerProfile): string {
    return parseStatusWebhook(this.rawWebhookOf(p)).base;
  }

  private rawWebhookOf(p: ServerProfile): string {
    return p.discordStatus.webhook.trim() || p.notifications.discordWebhook.trim();
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(1000);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.pokeTimer) clearTimeout(this.pokeTimer);
    this.timer = null;
    this.pokeTimer = null;
  }

  /** Profil / webhook değişti ya da elle yenilendi: silinmiş webhook bekleyişini kaldır */
  resetBackoff(): void {
    this.deadHook = null;
  }

  /** Durum değişti: kısa süre içinde (en az 5 sn arayla) güncelle */
  poke(): void {
    if (!this.running || this.pokeTimer) return;
    const wait = Math.max(2000, 5000 - (Date.now() - this.lastRun));
    this.pokeTimer = setTimeout(() => {
      this.pokeTimer = null;
      void this.update().catch(() => undefined);
    }, wait);
  }

  private schedule(ms: number) {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      this.timer = null;
      await this.update().catch(() => undefined);
      const sec = this.opts.source.getProfile().discordStatus.intervalSec;
      this.schedule(Math.max(10, sec) * 1000);
    }, ms);
  }

  /** Tek güncelleme turu (aynı anda tek tur). Kapalıysa bir şey yapmaz. */
  update(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const p = this.runOnce().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = p;
    return p;
  }

  private logThrottled(line: string) {
    const now = Date.now();
    if (this.lastErrorLog.text === line && now - this.lastErrorLog.at < 10 * 60_000) return;
    this.lastErrorLog = { text: line, at: now };
    this.opts.log?.(line);
  }

  private async runOnce(): Promise<void> {
    this.lastRun = Date.now();
    const profile = this.opts.source.getProfile();
    if (!profile.discordStatus.enabled) return;
    const { base: hook, threadId } = parseStatusWebhook(this.rawWebhookOf(profile));
    if (!isDiscordWebhook(hook)) {
      this.logThrottled('Discord durum mesajı: geçerli bir webhook adresi yok');
      return;
    }
    // Webhook kimliği: thread değişince de mesaj başka yerde demektir
    const hookKey = threadId ? `${hook}?thread_id=${threadId}` : hook;
    if (this.lastHook !== null && this.lastHook !== hookKey) {
      this.ignoreProfileId = profile.discordStatus.messageId || null;
      this.messageId = null;
    }
    this.lastHook = hookKey;
    if (this.deadHook !== null) {
      if (this.deadHook === hookKey) return;
      this.deadHook = null;
    }
    const thread = threadId ? `thread_id=${threadId}` : '';
    const profileId = profile.discordStatus.messageId.trim();
    let id = this.messageId ?? (profileId && profileId !== this.ignoreProfileId && /^\d+$/.test(profileId) ? profileId : '');
    const embed = this.buildEmbed(profile);
    try {
      if (id) {
        try {
          await this.request('PATCH', `${hook}/messages/${id}${thread ? `?${thread}` : ''}`, { embeds: [embed] });
          this.messageId = id;
          return;
        } catch (err) {
          if (!(err instanceof HttpError) || err.status !== 404 || err.code === DISCORD_UNKNOWN_WEBHOOK) throw err;
          // Mesaj (ya da kanal) silinmiş: yenisini at
          const now = Date.now();
          if (now - this.lastDeletedLogAt >= 10 * 60_000) {
            this.lastDeletedLogAt = now;
            this.opts.log?.('Discord durum mesajı bulunamadı (silinmiş); yenisi gönderiliyor');
          }
          id = '';
          this.messageId = null;
        }
      }
      const res = await this.request('POST', `${hook}?wait=true${thread ? `&${thread}` : ''}`, { username: 'Arma Server Manager', embeds: [embed] });
      const newId = String((res as { id?: unknown } | null)?.id ?? '');
      if (!/^\d+$/.test(newId)) throw new Error('Discord mesaj kimliği dönmedi');
      this.messageId = newId;
      this.ignoreProfileId = null;
      this.opts.onMessageId?.(newId);
    } catch (err) {
      if (err instanceof HttpError && err.status === 404 && err.code === DISCORD_UNKNOWN_WEBHOOK) {
        // Webhook silinmiş: her turda boşuna denemeyelim; adres (ya da profil) değişince yeniden denenir
        this.deadHook = hookKey;
        this.messageId = null;
        this.opts.log?.('Discord durum mesajı durduruldu: webhook bulunamadı (silinmiş ya da geçersiz). Webhook adresi değişince yeniden denenecek.');
        this.opts.onWarning?.({
          tr: 'Discord durum mesajı gönderilemiyor: webhook silinmiş ya da geçersiz. Yeni bir webhook adresi girin.',
          en: 'Discord status message cannot be sent: the webhook was deleted or is invalid. Enter a new webhook URL.',
        });
        throw err;
      }
      this.logThrottled(`Discord durum mesajı güncellenemedi: ${(err as Error).message}`);
      throw err;
    }
  }

  private async request(method: 'POST' | 'PATCH', url: string, body: unknown): Promise<unknown> {
    const send = () =>
      this.fetchImpl(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    let res = await send();
    if (res.status === 429) {
      const waitMs = Math.min(this.opts.maxRetryWaitMs ?? 30_000, Math.max(0, await retryAfterMs(res)));
      await new Promise((r) => setTimeout(r, waitMs));
      res = await send();
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { code?: unknown } | null;
      throw new HttpError(res.status, typeof body?.code === 'number' ? body.code : undefined);
    }
    if (res.status === 204) return null;
    return res.json().catch(() => null);
  }

  /** Embed içeriği (test ve önizleme için açık) */
  buildEmbed(profile: ServerProfile = this.opts.source.getProfile(), now = Date.now()): Record<string, unknown> {
    const L = LABELS[this.opts.lang ?? 'tr'];
    const st = this.opts.source.getStatus();
    const live = st.status === 'running' || st.status === 'starting';
    const perf = st.perf;
    const last = this.opts.source.getLastPerf();
    // Eski performans verisini gösterme (sunucu durduysa / mod yüklenmediyse)
    const freshMs = Math.max(60_000, profile.monitoring.sampleSec * 3000);
    const perfFresh = live && perf && now - perf.t <= freshMs;
    const lastFresh = live && last && now - last.t <= freshMs;
    const dash = '-';
    const fields: { name: string; value: string; inline: boolean }[] = [];
    const add = (name: string, value: string, inline = true) => fields.push({ name, value: (value || dash).slice(0, 1024), inline });
    add(L.status, `${L.states[st.status]}${st.unreachable ? ` (${L.unreachable})` : ''}`);
    add(L.players, live ? `${st.players}/${profile.general.maxPlayers}` : dash);
    add(L.fps, perfFresh && perf.fps !== undefined ? perf.fps.toFixed(1) : dash);
    const cpu = perfFresh && perf.cpu !== undefined ? `${Math.round(perf.cpu)}%` : '';
    const ram = perfFresh && perf.memMB !== undefined ? (perf.memMB >= 1024 ? `${(perf.memMB / 1024).toFixed(1)} GB` : `${Math.round(perf.memMB)} MB`) : '';
    add(L.cpuRam, cpu || ram ? `${cpu || dash} / ${ram || dash}` : dash);
    add(L.mission, lastFresh && (last.mission || last.world) ? escapeMd(`${last.mission || dash}${last.world ? ` (${last.world})` : ''}`) : dash);
    add(L.uptime, live && st.startedAt ? fmtDuration(now - st.startedAt, L.dur) : dash);
    if (st.nextScheduledRestart) {
      const sec = Math.floor(st.nextScheduledRestart / 1000);
      add(L.nextRestart, `<t:${sec}:t> (<t:${sec}:R>)`);
    }
    if (profile.discordStatus.showPlayers && live) {
      const names = this.opts.source.getPlayers().map((p) => p.name);
      if (names.length) add(`${L.playerList} (${names.length})`, fitPlayerList(names, L.more), false);
    }
    add(L.lastUpdate, `<t:${Math.floor(now / 1000)}:R>`, false);
    const embed: Record<string, unknown> = {
      title: profile.name.slice(0, 256),
      color: STATUS_COLORS[st.status],
      fields,
      timestamp: new Date(now).toISOString(),
      footer: { text: 'OeziDev Arma Server Manager' },
    };
    const host = profile.general.hostname.trim();
    if (host && host !== profile.name) embed.description = escapeMd(host).slice(0, 4000);
    return embed;
  }
}
