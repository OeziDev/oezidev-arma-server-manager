import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { parseBans, parseMissions, parsePlayers, type RconBan, type RconPlayer } from './parse.js';

export * from './parse.js';

/**
 * BattlEye RCon (protokol v2) istemcisi.
 *
 * Paket: 'B' 'E' | CRC32 (LE, kalan baytların) | 0xFF | tip | yük
 *   0x00 giriş:   şifre                 -> cevap 0x00 | 0x01 (başarılı) / 0x00 (hatalı)
 *   0x01 komut:   sıra | komut          -> cevap 0x01 | sıra | [0x00 | toplam | indeks] | veri
 *   0x02 mesaj:   sıra | metin (sunucudan) -> istemci 0x02 | sıra ile onaylar
 * 45 saniye trafik olmazsa sunucu bağlantıyı düşürür; bu yüzden boş komutla keepalive gönderilir.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export const PacketType = { Login: 0x00, Command: 0x01, Message: 0x02 } as const;

export function buildPacket(type: number, payload: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from([0xff, type]), payload]);
  const header = Buffer.alloc(6);
  header.write('BE', 0, 'ascii');
  header.writeUInt32LE(crc32(body), 2);
  return Buffer.concat([header, body]);
}

export interface ParsedPacket {
  type: number;
  /** tipten sonraki baytlar */
  payload: Buffer;
}

export function parsePacket(msg: Buffer): ParsedPacket | null {
  if (msg.length < 8 || msg[0] !== 0x42 || msg[1] !== 0x45) return null;
  const crc = msg.readUInt32LE(2);
  const body = msg.subarray(6);
  if (crc32(body) !== crc || body[0] !== 0xff) return null;
  return { type: body[1]!, payload: body.subarray(2) };
}

export type RconState = 'disconnected' | 'connecting' | 'connected';

export interface RconOptions {
  host: string;
  port: number;
  password: string;
  /** Tek bir komut cevabı için bekleme (ms) */
  timeoutMs?: number;
  keepAliveMs?: number;
  /** Bağlantı koparsa yeniden bağlan */
  reconnect?: boolean;
  reconnectDelayMs?: number;
}

export class RconError extends Error {
  constructor(
    message: string,
    readonly code: 'timeout' | 'auth_failed' | 'not_connected' | 'closed' | 'invalid',
  ) {
    super(message);
    this.name = 'RconError';
  }
}

interface Pending {
  seq: number;
  parts: Map<number, Buffer>;
  total: number;
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface RconEvents {
  message: [text: string];
  state: [state: RconState, reason?: string];
}

export class BattlEyeRcon extends EventEmitter<RconEvents> {
  private socket: dgram.Socket | null = null;
  private seq = 0;
  private pending: Pending | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private lastReceived = 0;
  private loginWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private recentMessages = new Map<number, number>();
  private closedByUser = false;
  private _state: RconState = 'disconnected';
  private readonly opts: Required<RconOptions>;

  constructor(opts: RconOptions) {
    super();
    this.opts = { timeoutMs: 4000, keepAliveMs: 25000, reconnect: true, reconnectDelayMs: 5000, ...opts };
  }

  get state(): RconState {
    return this._state;
  }

  private setState(s: RconState, reason?: string) {
    if (this._state === s) return;
    this._state = s;
    this.emit('state', s, reason);
  }

  async connect(): Promise<void> {
    this.closedByUser = false;
    if (this._state === 'connected') return;
    this.clearReconnect();
    this.setState('connecting');
    try {
      await this.openAndLogin();
      this.setState('connected');
      this.startTimers();
    } catch (err) {
      this.teardown();
      this.setState('disconnected', (err as Error).message);
      if (err instanceof RconError && err.code === 'auth_failed') throw err;
      this.scheduleReconnect();
      throw err;
    }
  }

  private async openAndLogin(): Promise<void> {
    this.teardown();
    const family = net.isIPv6(this.opts.host) ? 'udp6' : 'udp4';
    const socket = dgram.createSocket(family);
    this.socket = socket;
    socket.on('message', (msg) => this.onMessage(msg));
    socket.on('error', (err) => this.onDisconnect(`Soket hatası: ${err.message}`));
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.connect(this.opts.port, this.opts.host, () => {
        socket.off('error', reject);
        resolve();
      });
    });
    const loginPacket = buildPacket(PacketType.Login, Buffer.from(this.opts.password, 'utf8'));
    let lastErr: Error = new RconError('RCON sunucusu cevap vermedi', 'timeout');
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            this.loginWaiter = null;
            reject(new RconError('RCON sunucusu cevap vermedi (port/şifre/firewall?)', 'timeout'));
          }, this.opts.timeoutMs);
          this.loginWaiter = {
            resolve: () => {
              clearTimeout(timer);
              resolve();
            },
            reject: (e) => {
              clearTimeout(timer);
              reject(e);
            },
          };
          socket.send(loginPacket);
        });
        return;
      } catch (err) {
        lastErr = err as Error;
        if (err instanceof RconError && err.code === 'auth_failed') throw err;
      }
    }
    throw lastErr;
  }

  private onMessage(msg: Buffer) {
    const pkt = parsePacket(msg);
    if (!pkt) return;
    this.lastReceived = Date.now();
    switch (pkt.type) {
      case PacketType.Login: {
        const ok = pkt.payload[0] === 0x01;
        const w = this.loginWaiter;
        this.loginWaiter = null;
        if (!w) return;
        if (ok) w.resolve();
        else w.reject(new RconError('RCON şifresi yanlış', 'auth_failed'));
        return;
      }
      case PacketType.Command: {
        const seq = pkt.payload[0];
        const p = this.pending;
        if (seq === undefined || !p || p.seq !== seq) return;
        const rest = pkt.payload.subarray(1);
        if (rest.length >= 3 && rest[0] === 0x00) {
          // Çok parçalı cevap
          const total = rest[1]!;
          const index = rest[2]!;
          p.total = total;
          p.parts.set(index, rest.subarray(3));
          if (p.parts.size < total) return;
          const ordered = Array.from({ length: total }, (_, i) => p.parts.get(i) ?? Buffer.alloc(0));
          this.finishPending(Buffer.concat(ordered).toString('utf8'));
        } else {
          this.finishPending(rest.toString('utf8'));
        }
        return;
      }
      case PacketType.Message: {
        const seq = pkt.payload[0];
        if (seq === undefined) return;
        this.socket?.send(buildPacket(PacketType.Message, Buffer.from([seq])));
        // Onay kaybolursa sunucu aynı mesajı tekrar gönderir: kısa süreli tekrarları ele.
        const now = Date.now();
        const seen = this.recentMessages.get(seq);
        this.recentMessages.set(seq, now);
        if (seen && now - seen < 10_000) return;
        if (this.recentMessages.size > 512) {
          for (const [k, t] of this.recentMessages) if (now - t > 60_000) this.recentMessages.delete(k);
        }
        this.emit('message', pkt.payload.subarray(1).toString('utf8'));
        return;
      }
    }
  }

  private finishPending(text: string) {
    const p = this.pending;
    if (!p) return;
    clearTimeout(p.timer);
    this.pending = null;
    p.resolve(text);
  }

  /** Komut gönder ve cevabı bekle. Komutlar sırayla (tek tek) gönderilir. */
  command(cmd: string): Promise<string> {
    if (/[\r\n]/.test(cmd)) return Promise.reject(new RconError('Komut satır sonu içeremez', 'invalid'));
    const run = () => this.sendCommand(cmd);
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private sendCommand(cmd: string): Promise<string> {
    if (this._state !== 'connected' || !this.socket) {
      return Promise.reject(new RconError('RCON bağlı değil', 'not_connected'));
    }
    const seq = this.seq;
    this.seq = (this.seq + 1) & 0xff;
    const packet = buildPacket(PacketType.Command, Buffer.concat([Buffer.from([seq]), Buffer.from(cmd, 'utf8')]));
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.seq === seq) this.pending = null;
        reject(new RconError(`RCON komutu zaman aşımına uğradı: ${cmd || '(keepalive)'}`, 'timeout'));
      }, this.opts.timeoutMs);
      this.pending = { seq, parts: new Map(), total: 0, resolve, reject, timer };
      this.socket!.send(packet);
    });
  }

  private startTimers() {
    this.lastReceived = Date.now();
    this.keepAliveTimer = setInterval(() => {
      this.command('').catch(() => undefined);
    }, this.opts.keepAliveMs);
    this.watchdogTimer = setInterval(() => {
      if (Date.now() - this.lastReceived > Math.max(this.opts.keepAliveMs * 2, 45_000)) {
        this.onDisconnect('Sunucudan cevap gelmiyor');
      }
    }, 5000);
  }

  private onDisconnect(reason: string) {
    if (this._state === 'disconnected' && !this.socket) return;
    this.teardown();
    this.setState('disconnected', reason);
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.closedByUser || !this.opts.reconnect || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => undefined);
    }, this.opts.reconnectDelayMs);
  }

  private clearReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private teardown() {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.keepAliveTimer = null;
    this.watchdogTimer = null;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new RconError('RCON bağlantısı kapandı', 'closed'));
      this.pending = null;
    }
    if (this.loginWaiter) {
      this.loginWaiter.reject(new RconError('RCON bağlantısı kapandı', 'closed'));
      this.loginWaiter = null;
    }
    if (this.socket) {
      const s = this.socket;
      this.socket = null;
      try {
        s.close();
      } catch {
        /* zaten kapalı */
      }
    }
  }

  close() {
    this.closedByUser = true;
    this.clearReconnect();
    this.teardown();
    this.setState('disconnected', 'Kapatıldı');
  }

  /* ---------------- Yüksek seviye komutlar ---------------- */

  players(): Promise<RconPlayer[]> {
    return this.command('players').then(parsePlayers);
  }
  bans(): Promise<RconBan[]> {
    return this.command('bans').then(parseBans);
  }
  missions(): Promise<string[]> {
    return this.command('missions').then(parseMissions);
  }
  /** playerId -1: herkese */
  say(message: string, playerId = -1): Promise<string> {
    return this.command(`say ${Math.trunc(playerId)} ${sanitize(message)}`);
  }
  kick(playerId: number, reason = ''): Promise<string> {
    return this.command(`kick ${Math.trunc(playerId)} ${sanitize(reason)}`.trim());
  }
  /** minutes 0 = kalıcı */
  ban(playerId: number, minutes: number, reason = ''): Promise<string> {
    return this.command(`ban ${Math.trunc(playerId)} ${Math.max(0, Math.trunc(minutes))} ${sanitize(reason)}`.trim());
  }
  /** GUID veya IP ile (oyuncu sunucuda değilken) ban */
  addBan(guidOrIp: string, minutes: number, reason = ''): Promise<string> {
    if (!/^([0-9a-fA-F]{32}|\d{1,3}(\.\d{1,3}){3})$/.test(guidOrIp)) {
      return Promise.reject(new RconError('Geçersiz GUID veya IP', 'invalid'));
    }
    return this.command(`addBan ${guidOrIp} ${Math.max(0, Math.trunc(minutes))} ${sanitize(reason)}`.trim());
  }
  removeBan(banId: number): Promise<string> {
    return this.command(`removeBan ${Math.trunc(banId)}`);
  }
  lock(): Promise<string> {
    return this.command('#lock');
  }
  unlock(): Promise<string> {
    return this.command('#unlock');
  }
  restartMission(): Promise<string> {
    return this.command('#restart');
  }
  shutdown(): Promise<string> {
    return this.command('#shutdown');
  }
  reloadBans(): Promise<string> {
    return this.command('loadBans');
  }
}

function sanitize(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').trim();
}

