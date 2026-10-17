/**
 * Oyuncu geçmişi: BattlEye RCON sunucu mesajlarından (giriş, GUID doğrulama, çıkış, kick) oturum kayıtları üretir.
 * Her profil için bir PlayerHistory örneği; kalıcılık uygulamanın verdiği satır tabanlı depoya (JSONL) yapılır.
 *
 * Depo biçimi (her satır bir JSON nesnesi, sürüm alanı "v":1):
 *   {"v":1,"k":"s","id":"…","guid":"…","name":"…","ip":"1.2.3.4","pid":3,"join":1700000000000,"leave":…,"kick":"…","approx":true}
 *     Oturumun TAM anlık görüntüsü. Aynı id'li sonraki satır öncekini geçersiz kılar (giriş, GUID, çıkış = en fazla birkaç satır).
 *   {"v":1,"k":"n","guid":"…","note":"…","t":1700000000000}
 *     Oyuncu notu; boş not = silindi. Sonraki satır öncekini geçersiz kılar.
 * Bozuk / tanınmayan satırlar yok sayılır (yarım yazılmış son satır vb.).
 */
import type { RconPlayer } from '../rcon/parse.js';

/* ---------------- mesaj ayrıştırıcı ---------------- */

export type BeHistoryMessage =
  | { type: 'connect'; playerId: number; name: string; ip: string; port?: number }
  | { type: 'guid'; playerId: number; name: string; guid: string; verified: boolean }
  | { type: 'disconnect'; playerId: number; name: string }
  | { type: 'kick'; playerId: number; name: string; guid?: string; reason: string; byAdmin: boolean; ban: boolean }
  | { type: 'chat'; channel: string; name: string; text: string };

const RE_CONNECT = /^Player #(\d+) (.+) \(((?:\d{1,3}\.){3}\d{1,3}|\[[0-9a-fA-F:.]+\]|[0-9a-fA-F:.]+?)(?::(\d+))?\) connected$/;
const RE_VERIFIED = /^Verified GUID \(([0-9a-fA-F]{32})\) of player #(\d+) (.+)$/;
const RE_UNVERIFIED = /^Player #(\d+) (.+) - (?:BE )?GUID: ([0-9a-fA-F]{32})$/;
const RE_DISCONNECT = /^Player #(\d+) (.+) disconnected$/;
const RE_KICK = /^Player #(\d+) (.+?)(?: \(([0-9a-fA-F]{32}|-)\))? has been kicked by BattlEye: (.*)$/;
const RE_KICK_GUID = /^Player #(\d+) (.+) \(([0-9a-fA-F]{32}|-)\) has been kicked by BattlEye: (.*)$/;
const RE_CHAT = /^\((Global|Side|Command|Group|Vehicle|Direct|Unknown|System)\) (.+?): (.*)$/;

/**
 * Oyuncu geçmişi için BattlEye sunucu mesajı ayrıştırıcı. Adlarda boşluk, Unicode ve parantez olabilir
 * (ör. "Player #3 Ahmet (TR) Şahin (1.2.3.4:2304) connected"). Tanınmayan mesaj için null.
 */
export function parseBeHistoryMessage(raw: string): BeHistoryMessage | null {
  const text = raw.replace(/[\r\n]+$/, '').trimEnd();
  let m = RE_CHAT.exec(text);
  if (m) return { type: 'chat', channel: m[1]!, name: m[2]!, text: m[3]! };
  m = RE_CONNECT.exec(text);
  if (m) {
    const ip = m[3]!.replace(/^\[|\]$/g, '');
    return { type: 'connect', playerId: Number(m[1]), name: m[2]!, ip, ...(m[4] ? { port: Number(m[4]) } : {}) };
  }
  m = RE_VERIFIED.exec(text);
  if (m) return { type: 'guid', playerId: Number(m[2]), name: m[3]!, guid: m[1]!.toLowerCase(), verified: true };
  m = RE_UNVERIFIED.exec(text);
  if (m) return { type: 'guid', playerId: Number(m[1]), name: m[2]!, guid: m[3]!.toLowerCase(), verified: false };
  // Kick satırı "disconnected" kalıbından önce: sebep metni "disconnected" ile bitebilir
  m = RE_KICK_GUID.exec(text) ?? RE_KICK.exec(text);
  if (m) {
    const reason = m[4]!;
    const guid = m[3] && m[3] !== '-' ? m[3].toLowerCase() : undefined;
    return {
      type: 'kick',
      playerId: Number(m[1]),
      name: m[2]!,
      ...(guid ? { guid } : {}),
      reason,
      byAdmin: /^Admin (?:Kick|Ban)\b/i.test(reason),
      ban: /^Admin Ban\b/i.test(reason),
    };
  }
  m = RE_DISCONNECT.exec(text);
  if (m) return { type: 'disconnect', playerId: Number(m[1]), name: m[2]! };
  return null;
}

/* ---------------- tipler ---------------- */

export interface PlayerSession {
  id: string;
  /** Küçük harf BattlEye GUID; henüz doğrulanmadıysa boş */
  guid: string;
  name: string;
  ip: string;
  playerId: number;
  joinAt: number;
  leaveAt?: number;
  /** Kick / ban sebebi */
  kicked?: string;
  /** Giriş anı bilinmiyor (uygulama oturum sırasında açıldı, oyuncu listesinden eklendi) */
  approx?: boolean;
}

export interface PlayerSummary {
  guid: string;
  /** En son kullanılan ad */
  name: string;
  /** Kullanılan adlar, en yeniden eskiye */
  names: string[];
  /** Son IP'ler, en yeniden eskiye (en fazla 5) */
  ips: string[];
  firstSeen: number;
  lastSeen: number;
  totalPlaytimeMs: number;
  sessionCount: number;
  kickCount: number;
  lastKickReason?: string;
  note?: string;
  online: boolean;
}

export interface PlayerSearchQuery {
  /** Ad, GUID, IP ya da notta geçen metin (büyük/küçük harf ve Türkçe karakter duyarsız) */
  text?: string;
  /** Varsayılan 50 */
  limit?: number;
  offset?: number;
  /** Sadece şu an bağlı olanlar */
  onlineOnly?: boolean;
}

export interface PlayerHistoryStats {
  uniquePlayers: number;
  peakConcurrent: number;
  /** En yüksek eşzamanlı oyuncu sayısına ulaşılan an */
  peakAt?: number;
  totalSessions: number;
  totalPlaytimeMs: number;
}

export interface PlayerHistoryStorage {
  append(line: string): Promise<void>;
  readAll(): Promise<string[]>;
}

export interface PlayerHistoryOptions {
  /**
   * Önceki çalıştırmadan açık kalmış (çıkışı görülmemiş) oturumların sayılacak en uzun süresi.
   * Uygulama kapalıyken çıkan oyuncu sonsuza dek "oynuyor" görünmesin. Varsayılan 12 saat.
   */
  maxOpenSessionMs?: number;
  /** Saat (testler için) */
  now?: () => number;
  /** Depoya yazma hatası (geçmiş tutulmaya bellekte devam eder) */
  onError?: (err: Error) => void;
}

/** Bellek içi depo (testler ve geçici kullanım) */
export class MemoryHistoryStorage implements PlayerHistoryStorage {
  lines: string[] = [];
  constructor(initial: string[] = []) {
    this.lines = [...initial];
  }
  async append(line: string): Promise<void> {
    this.lines.push(line);
  }
  async readAll(): Promise<string[]> {
    return [...this.lines];
  }
}

/** Arama için katlama: küçük harf, Türkçe ı/İ, aksanlar (ş->s, ğ->g, ü->u ...) */
export function foldSearchText(s: string): string {
  return s
    .replace(/[İIı]/g, 'i')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/** Kapanmış oturumların saklama süresi (sıkıştırmada daha eskiler atılır): 180 gün */
export const HISTORY_RETENTION_MS = 180 * 24 * 3600_000;

interface NoteRec {
  note: string;
  t: number;
}

/* ---------------- PlayerHistory ---------------- */

export class PlayerHistory {
  private readonly sessionsById = new Map<string, PlayerSession>();
  /** Bu çalıştırmada açılmış ya da yüklenip hâlâ açık oturumlar: playerId -> oturum */
  private readonly openByPid = new Map<number, PlayerSession>();
  /** Önceki çalıştırmadan kalan açık oturumlar (süre sınırı uygulanır) */
  private readonly stale = new Set<string>();
  private readonly notes = new Map<string, NoteRec>();
  private readonly maxOpenMs: number;
  private readonly clock: () => number;
  private readonly onError?: (err: Error) => void;
  private writeChain: Promise<void> = Promise.resolve();
  private seq = 0;
  /** Depodaki tahmini satır / bayt sayısı (sıkıştırma kararı için) */
  private storedLines = 0;
  private storedBytes = 0;
  private loaded = false;
  /** Her değişiklikte artar: özet önbelleği geçersiz olur */
  private rev = 0;
  /**
   * GUID özetleri önbelleği. Açık oturumu olan GUID'lerin (çevrimiçi / eski açık) süresi saate bağlıdır:
   * bunlar (`dynamic`) her sorguda yeniden hesaplanır, diğerleri değişiklik olana kadar aynen kullanılır.
   */
  private summaryCache: {
    rev: number;
    byGuid: Map<string, PlayerSession[]>;
    map: Map<string, PlayerSummary>;
    /** Arama için katlanmış metin (adlar + not) */
    folded: Map<string, string>;
    dynamic: Set<string>;
  } | null = null;

  constructor(
    private readonly storage: PlayerHistoryStorage,
    opts: PlayerHistoryOptions = {},
  ) {
    this.maxOpenMs = opts.maxOpenSessionMs ?? 12 * 3600_000;
    this.clock = opts.now ?? Date.now;
    this.onError = opts.onError;
  }

  /** Depo okunup hazırlanmış örnek */
  static async open(storage: PlayerHistoryStorage, opts: PlayerHistoryOptions = {}): Promise<PlayerHistory> {
    const h = new PlayerHistory(storage, opts);
    await h.load();
    return h;
  }

  /** Depodaki kayıtları yükler (bir kez). Açık kalmış oturumlar "eski açık" olarak işaretlenir. */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    this.rev++;
    const lines = await this.storage.readAll();
    for (const line of lines) {
      this.storedLines++;
      this.storedBytes += Buffer.byteLength(line, 'utf8') + 1;
      this.applyRecord(line);
    }
    // Açık oturumlar: hâlâ bağlı olabilir (sunucu çalışıyor, uygulama yeniden açıldı) ya da çoktan çıkmış.
    // Açık bırakılır ama süreleri maxOpenSessionMs ile sınırlanır; disconnect / oyuncu listesi / sunucu durması kapatır.
    const open = [...this.sessionsById.values()].filter((s) => s.leaveAt === undefined).sort((a, b) => a.joinAt - b.joinAt);
    for (const s of open) {
      this.stale.add(s.id);
      const prev = this.openByPid.get(s.playerId);
      if (prev && prev !== s) {
        // Aynı playerId ile iki açık oturum: eskisi kapatılır (süre sınırıyla)
        this.close(prev, this.cappedEnd(prev, s.joinAt));
      }
      this.openByPid.set(s.playerId, s);
    }
  }

  private applyRecord(line: string): void {
    if (!line.trim()) return;
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (!r || typeof r !== 'object') return;
    if (r.k === 's' && typeof r.id === 'string' && typeof r.join === 'number') {
      const s: PlayerSession = {
        id: r.id,
        guid: typeof r.guid === 'string' ? r.guid : '',
        name: typeof r.name === 'string' ? r.name : '',
        ip: typeof r.ip === 'string' ? r.ip : '',
        playerId: typeof r.pid === 'number' ? r.pid : -1,
        joinAt: r.join,
        ...(typeof r.leave === 'number' ? { leaveAt: r.leave } : {}),
        ...(typeof r.kick === 'string' ? { kicked: r.kick } : {}),
        ...(r.approx === true ? { approx: true } : {}),
      };
      this.sessionsById.set(s.id, s);
    } else if (r.k === 'n' && typeof r.guid === 'string') {
      const note = typeof r.note === 'string' ? r.note : '';
      if (note) this.notes.set(r.guid, { note, t: typeof r.t === 'number' ? r.t : 0 });
      else this.notes.delete(r.guid);
    }
  }

  /* ---------------- yazma ---------------- */

  private sessionLine(s: PlayerSession): string {
    return JSON.stringify({
      v: 1,
      k: 's',
      id: s.id,
      guid: s.guid,
      name: s.name,
      ip: s.ip,
      pid: s.playerId,
      join: s.joinAt,
      ...(s.leaveAt !== undefined ? { leave: s.leaveAt } : {}),
      ...(s.kicked !== undefined ? { kick: s.kicked } : {}),
      ...(s.approx ? { approx: true } : {}),
    });
  }

  private noteLine(guid: string, n: NoteRec): string {
    return JSON.stringify({ v: 1, k: 'n', guid, note: n.note, t: n.t });
  }

  private write(line: string): Promise<void> {
    // Bütün durum değişiklikleri buradan geçer (oturum / not satırı yazılır)
    this.rev++;
    this.storedLines++;
    this.storedBytes += Buffer.byteLength(line, 'utf8') + 1;
    // Sıra korunur: bir satır yazılmadan sonraki başlamaz
    this.writeChain = this.writeChain.then(
      () => this.storage.append(line),
      () => this.storage.append(line),
    );
    const p = this.writeChain.catch((err: unknown) => {
      this.onError?.(err instanceof Error ? err : new Error(String(err)));
    });
    return p;
  }

  private persist(s: PlayerSession): Promise<void> {
    return this.write(this.sessionLine(s));
  }

  /** Bekleyen bütün yazmalar bitene kadar bekler (dosyayı sıkıştırıp yeniden yazmadan önce çağır). */
  async flush(): Promise<void> {
    await this.writeChain.catch(() => undefined);
  }

  /* ---------------- oturum yardımcıları ---------------- */

  private newSession(playerId: number, name: string, ip: string, t: number, approx = false): PlayerSession {
    const s: PlayerSession = {
      id: `${t.toString(36)}-${playerId}-${(this.seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      guid: '',
      name,
      ip,
      playerId,
      joinAt: t,
      ...(approx ? { approx: true } : {}),
    };
    this.sessionsById.set(s.id, s);
    this.openByPid.set(playerId, s);
    return s;
  }

  /** Eski açık oturumun bitişi: en fazla joinAt + maxOpenSessionMs */
  private cappedEnd(s: PlayerSession, t: number): number {
    const end = this.stale.has(s.id) ? Math.min(t, s.joinAt + this.maxOpenMs) : t;
    return Math.max(s.joinAt, end);
  }

  private close(s: PlayerSession, t: number, kicked?: string): Promise<void> {
    s.leaveAt = Math.max(s.joinAt, t);
    if (kicked !== undefined) s.kicked = kicked;
    this.stale.delete(s.id);
    if (this.openByPid.get(s.playerId) === s) this.openByPid.delete(s.playerId);
    return this.persist(s);
  }

  /* ---------------- olaylar ---------------- */

  /**
   * RCON sunucu mesajı (BattlEyeRcon 'message' olayı). Durum hemen güncellenir; dönen söz depoya yazılınca çözülür.
   * Sohbet ve tanınmayan mesajlar yok sayılır.
   */
  onServerMessage(msg: string, t: number = this.clock()): Promise<void> {
    const m = parseBeHistoryMessage(msg);
    if (!m) return Promise.resolve();
    const writes: Promise<void>[] = [];
    switch (m.type) {
      case 'connect': {
        const prev = this.openByPid.get(m.playerId);
        if (prev) {
          // Aynı numara tekrar kullanılıyor ve öncekinin çıkışını görmedik: önceki oturumu kapat
          writes.push(this.close(prev, this.cappedEnd(prev, t)));
        }
        writes.push(this.persist(this.newSession(m.playerId, m.name, m.ip, t)));
        break;
      }
      case 'guid': {
        let s = this.openByPid.get(m.playerId);
        if (s && s.guid && s.guid !== m.guid) {
          // Numara başka bir oyuncuya geçmiş (aradaki çıkış kaçırıldı)
          writes.push(this.close(s, this.cappedEnd(s, t)));
          s = undefined;
        }
        if (!s) s = this.newSession(m.playerId, m.name, '', t, true);
        if (s.guid === m.guid && s.name === m.name && !this.stale.has(s.id)) break;
        if (!s.guid || m.verified) s.guid = m.guid;
        s.name = m.name;
        if (this.stale.has(s.id) && s.guid === m.guid) this.stale.delete(s.id);
        writes.push(this.persist(s));
        break;
      }
      case 'kick': {
        const s = this.openByPid.get(m.playerId);
        if (s) {
          if (!s.guid && m.guid) s.guid = m.guid;
          writes.push(this.close(s, this.cappedEnd(s, t), m.reason));
        } else if (m.guid) {
          // Oturumu görmeden kick (ör. uygulama yeni açıldı): sıfır süreli oturum olarak kaydet
          const ns = this.newSession(m.playerId, m.name, '', t, true);
          ns.guid = m.guid;
          writes.push(this.close(ns, t, m.reason));
        }
        break;
      }
      case 'disconnect': {
        const s = this.openByPid.get(m.playerId);
        if (s) writes.push(this.close(s, this.cappedEnd(s, t)));
        break;
      }
      case 'chat':
        break;
    }
    return Promise.all(writes).then(() => undefined);
  }

  /**
   * Periyodik RCON "players" çıktısı (parsePlayers). Kaçırılan olayları düzeltir:
   * listede olup açık oturumu olmayan oyuncu için oturum açar (approx), eksik GUID'i doldurur,
   * açık oturumu olup listede olmayanları kapatır. Lobideki oyuncular da bağlı sayılır.
   */
  onPlayerList(players: RconPlayer[], t: number = this.clock()): Promise<void> {
    const writes: Promise<void>[] = [];
    const seen = new Set<number>();
    for (const p of players) {
      seen.add(p.id);
      let s = this.openByPid.get(p.id);
      if (s && ((s.guid && p.guid && s.guid !== p.guid) || (!s.guid && s.name !== p.name))) {
        writes.push(this.close(s, this.cappedEnd(s, t)));
        s = undefined;
      }
      if (!s) {
        s = this.newSession(p.id, p.name, p.ip, t, true);
        if (p.guid) s.guid = p.guid;
        writes.push(this.persist(s));
        continue;
      }
      let changed = false;
      if (this.stale.has(s.id)) {
        // Önceki çalıştırmadan kalan oturum hâlâ sürüyor: süre sınırı kalkar
        this.stale.delete(s.id);
        changed = true;
      }
      if (!s.guid && p.guid) {
        s.guid = p.guid;
        changed = true;
      }
      if (!s.ip && p.ip) {
        s.ip = p.ip;
        changed = true;
      }
      if (changed) writes.push(this.persist(s));
    }
    for (const [pid, s] of [...this.openByPid]) {
      if (!seen.has(pid)) writes.push(this.close(s, this.cappedEnd(s, t)));
    }
    return Promise.all(writes).then(() => undefined);
  }

  /** Sunucu durdu / çöktü: açık bütün oturumlar kapanır. */
  onServerStopped(t: number = this.clock()): Promise<void> {
    const writes = [...this.openByPid.values()].map((s) => this.close(s, this.cappedEnd(s, t)));
    return Promise.all(writes).then(() => undefined);
  }

  /** Oyuncu notu (boş metin notu siler). */
  setNote(guid: string, note: string): Promise<void> {
    const g = guid.trim().toLowerCase();
    const text = note.trim();
    const rec: NoteRec = { note: text, t: this.clock() };
    if (text) this.notes.set(g, rec);
    else this.notes.delete(g);
    return this.write(this.noteLine(g, rec));
  }

  getNote(guid: string): string | undefined {
    return this.notes.get(guid.trim().toLowerCase())?.note;
  }

  /* ---------------- sorgular ---------------- */

  /** Oturum süresi (açıksa şimdiye kadar; eski açık oturumda süre sınırıyla) */
  private sessionEnd(s: PlayerSession, now: number): number {
    if (s.leaveAt !== undefined) return s.leaveAt;
    return this.cappedEnd(s, now);
  }

  private isOnline(s: PlayerSession): boolean {
    return s.leaveAt === undefined && this.openByPid.get(s.playerId) === s && !this.stale.has(s.id);
  }

  /** Şu an açık (bu çalıştırmada görülmüş) oturumlar */
  onlineSessions(): PlayerSession[] {
    return [...this.openByPid.values()].filter((s) => !this.stale.has(s.id)).map((s) => ({ ...s }));
  }

  /** Özetler (önbellekli): değişiklik yoksa sadece açık oturumu olan GUID'ler yeniden hesaplanır. */
  private summarize(now: number): Map<string, PlayerSummary> {
    const c = this.summaryCache;
    if (c && c.rev === this.rev) {
      for (const guid of c.dynamic) this.putSummary(c, guid, c.byGuid.get(guid)!, now);
      return c.map;
    }
    const byGuid = new Map<string, PlayerSession[]>();
    for (const s of this.sessionsById.values()) {
      if (!s.guid) continue;
      let arr = byGuid.get(s.guid);
      if (!arr) byGuid.set(s.guid, (arr = []));
      arr.push(s);
    }
    const cache = { rev: this.rev, byGuid, map: new Map<string, PlayerSummary>(), folded: new Map<string, string>(), dynamic: new Set<string>() };
    for (const [guid, list] of byGuid) {
      list.sort((a, b) => b.joinAt - a.joinAt);
      if (list.some((s) => s.leaveAt === undefined)) cache.dynamic.add(guid);
      this.putSummary(cache, guid, list, now);
    }
    // Oturumu olmayan ama notu olan GUID'ler de aranabilsin
    for (const [guid, n] of this.notes) {
      if (cache.map.has(guid)) continue;
      cache.map.set(guid, { guid, name: '', names: [], ips: [], firstSeen: n.t, lastSeen: n.t, totalPlaytimeMs: 0, sessionCount: 0, kickCount: 0, note: n.note, online: false });
      cache.folded.set(guid, foldSearchText(n.note));
    }
    this.summaryCache = cache;
    return cache.map;
  }

  /** Tek GUID'in özeti (liste en yeniden eskiye sıralı) */
  private putSummary(cache: NonNullable<PlayerHistory['summaryCache']>, guid: string, list: PlayerSession[], now: number): void {
    const names: string[] = [];
    const ips: string[] = [];
    let total = 0;
    let kicks = 0;
    let lastKick: string | undefined;
    let lastSeen = 0;
    let online = false;
    for (const s of list) {
      if (!names.includes(s.name) && s.name) names.push(s.name);
      if (s.ip && !ips.includes(s.ip) && ips.length < 5) ips.push(s.ip);
      const end = this.sessionEnd(s, now);
      total += Math.max(0, end - s.joinAt);
      if (s.kicked !== undefined) {
        kicks++;
        if (lastKick === undefined) lastKick = s.kicked;
      }
      if (this.isOnline(s)) {
        online = true;
        lastSeen = Math.max(lastSeen, now);
      } else lastSeen = Math.max(lastSeen, end);
    }
    const note = this.notes.get(guid)?.note;
    if (!cache.folded.has(guid)) cache.folded.set(guid, foldSearchText([...names, note ?? ''].join('\u0000')));
    cache.map.set(guid, {
      guid,
      name: list[0]!.name,
      names,
      ips,
      firstSeen: list[list.length - 1]!.joinAt,
      lastSeen,
      totalPlaytimeMs: total,
      sessionCount: list.length,
      kickCount: kicks,
      ...(lastKick !== undefined ? { lastKickReason: lastKick } : {}),
      ...(note ? { note } : {}),
      online,
    });
  }

  /** GUID'e göre toplanmış oyuncular; çevrimiçiler önce, sonra son görülmeye göre. */
  search(query: PlayerSearchQuery = {}, now: number = this.clock()): PlayerSummary[] {
    const q = query.text ? foldSearchText(query.text.trim()) : '';
    let list = [...this.summarize(now).values()];
    const folded = this.summaryCache!.folded;
    if (query.onlineOnly) list = list.filter((p) => p.online);
    if (q) {
      list = list.filter((p) => p.guid.includes(q) || (folded.get(p.guid) ?? '').includes(q) || p.ips.some((ip) => ip.includes(q)));
    }
    list.sort((a, b) => Number(b.online) - Number(a.online) || b.lastSeen - a.lastSeen || a.guid.localeCompare(b.guid));
    const offset = Math.max(0, query.offset ?? 0);
    const limit = Math.max(0, query.limit ?? 50);
    // Önbellekteki nesneler dışarı verilmez (kopya)
    return list.slice(offset, offset + limit).map(copySummary);
  }

  /** Tek oyuncunun özeti */
  player(guid: string, now: number = this.clock()): PlayerSummary | undefined {
    const s = this.summarize(now).get(guid.trim().toLowerCase());
    return s ? copySummary(s) : undefined;
  }

  /** Bir oyuncunun oturumları, en yeniden eskiye */
  sessions(guid: string, limit = 50): PlayerSession[] {
    const g = guid.trim().toLowerCase();
    return [...this.sessionsById.values()]
      .filter((s) => s.guid === g)
      .sort((a, b) => b.joinAt - a.joinAt)
      .slice(0, Math.max(0, limit))
      .map((s) => ({ ...s }));
  }

  /** `sinceMs`ten (Unix ms) bu yana: tekil oyuncu, en yüksek eşzamanlı oyuncu, oturum sayısı. */
  stats(sinceMs: number, now: number = this.clock()): PlayerHistoryStats {
    const unique = new Set<string>();
    const events: [number, number][] = [];
    let sessions = 0;
    let playtime = 0;
    for (const s of this.sessionsById.values()) {
      const end = this.sessionEnd(s, now);
      if (end < sinceMs && !(end === s.joinAt && s.joinAt >= sinceMs)) continue;
      if (s.joinAt > now) continue;
      sessions++;
      unique.add(s.guid || `name:${s.name}`);
      const start = Math.max(s.joinAt, sinceMs);
      playtime += Math.max(0, end - start);
      if (end > start) {
        events.push([start, 1], [end, -1]);
      }
    }
    // Aynı anda biten ve başlayan: önce çıkış (sayı şişmesin)
    events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let cur = 0;
    let peak = 0;
    let peakAt: number | undefined;
    for (const [t, d] of events) {
      cur += d;
      if (cur > peak) {
        peak = cur;
        peakAt = t;
      }
    }
    return { uniquePlayers: unique.size, peakConcurrent: peak, ...(peakAt !== undefined ? { peakAt } : {}), totalSessions: sessions, totalPlaytimeMs: playtime };
  }

  /* ---------------- sıkıştırma ---------------- */

  /** Depoda canlı kayıt başına birden fazla satır birikti ve boyut sınırı aşıldı mı? */
  shouldCompact(maxBytes = 16 * 1024 * 1024): boolean {
    const live = this.sessionsById.size + this.notes.size;
    return this.storedBytes > maxBytes && this.storedLines > live * 1.2;
  }

  /** `t`den (Unix ms) önce bitmiş oturum var mı (saklama süresi dolanları atmak için sıkıştırma gerekir mi) */
  hasClosedBefore(t: number): boolean {
    for (const s of this.sessionsById.values()) if (s.leaveAt !== undefined && s.leaveAt < t) return true;
    return false;
  }

  /** Depodaki tahmini boyut (yüklenen + yazılan satırlar) */
  get storageStats(): { lines: number; bytes: number } {
    return { lines: this.storedLines, bytes: this.storedBytes };
  }

  /**
   * Depoyu yeniden yazmak için güncel durum satırları (oturum başına bir satır + notlar).
   * `dropClosedBefore` verilirse o zamandan önce bitmiş oturumlar bellekten de atılır (saklama süresi).
   * Uygulama önce flush() bekler, sonra bu satırları dosyaya atomik olarak yazar (geçici dosya + yeniden adlandırma).
   * Tahmini depo boyutu bu satırlara göre sıfırlanır.
   */
  compact(opts: { dropClosedBefore?: number } = {}): string[] {
    this.rev++;
    if (opts.dropClosedBefore !== undefined) {
      for (const [id, s] of this.sessionsById) {
        if (s.leaveAt !== undefined && s.leaveAt < opts.dropClosedBefore) this.sessionsById.delete(id);
      }
    }
    const lines = [...this.sessionsById.values()].sort((a, b) => a.joinAt - b.joinAt).map((s) => this.sessionLine(s));
    for (const [guid, n] of this.notes) lines.push(this.noteLine(guid, n));
    this.storedLines = lines.length;
    this.storedBytes = lines.reduce((sum, l) => sum + Buffer.byteLength(l, 'utf8') + 1, 0);
    return lines;
  }
}

const copySummary = (s: PlayerSummary): PlayerSummary => ({ ...s, names: [...s.names], ips: [...s.ips] });
