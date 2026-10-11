import dgram from 'node:dgram';
import { PacketType, buildPacket, parsePacket } from '../src/rcon/battleye.js';

/** Testler için BattlEye RCon sunucusu taklidi. */
export class FakeRconServer {
  readonly socket = dgram.createSocket('udp4');
  port = 0;
  loggedIn = false;
  received: string[] = [];
  acks: number[] = [];
  messageSeq = 0;
  client: { address: string; port: number } | null = null;
  /** Komut cevabını değiştirmek için */
  handlers = new Map<string, string>();
  /** true ise komutlara cevap vermez (zaman aşımı testi) */
  silent = false;
  splitSize = 400;

  constructor(readonly password: string) {}

  async start(port = 0): Promise<number> {
    this.socket.on('message', (msg, rinfo) => this.onMessage(msg, rinfo));
    await new Promise<void>((r) => this.socket.bind(port, '127.0.0.1', () => r()));
    this.port = (this.socket.address() as { port: number }).port;
    return this.port;
  }

  private send(type: number, payload: Buffer) {
    if (!this.client) return;
    this.socket.send(buildPacket(type, payload), this.client.port, this.client.address);
  }

  private onMessage(msg: Buffer, rinfo: dgram.RemoteInfo) {
    const pkt = parsePacket(msg);
    if (!pkt) return;
    this.client = { address: rinfo.address, port: rinfo.port };
    if (pkt.type === PacketType.Login) {
      this.loggedIn = pkt.payload.toString('utf8') === this.password;
      this.send(PacketType.Login, Buffer.from([this.loggedIn ? 1 : 0]));
      return;
    }
    if (pkt.type === PacketType.Message) {
      this.acks.push(pkt.payload[0]!);
      return;
    }
    if (pkt.type === PacketType.Command) {
      if (!this.loggedIn || this.silent) return;
      const seq = pkt.payload[0]!;
      const cmd = pkt.payload.subarray(1).toString('utf8');
      this.received.push(cmd);
      const reply = this.reply(cmd);
      const data = Buffer.from(reply, 'utf8');
      if (data.length <= this.splitSize) {
        this.send(PacketType.Command, Buffer.concat([Buffer.from([seq]), data]));
        return;
      }
      const parts: Buffer[] = [];
      for (let i = 0; i < data.length; i += this.splitSize) parts.push(data.subarray(i, i + this.splitSize));
      // Parçaları ters sırayla gönder: istemci sırayı indeksle kurmalı
      parts
        .map((part, i) => ({ part, i }))
        .reverse()
        .forEach(({ part, i }) => this.send(PacketType.Command, Buffer.concat([Buffer.from([seq, 0x00, parts.length, i]), part])));
    }
  }

  private reply(cmd: string): string {
    if (this.handlers.has(cmd)) return this.handlers.get(cmd)!;
    if (cmd === '') return '';
    if (cmd === 'players') return PLAYERS_TEXT;
    if (cmd === 'bans') return BANS_TEXT;
    return '';
  }

  /** Sunucudan istemciye mesaj (sohbet vb.) gönder. */
  pushMessage(text: string, seq = this.messageSeq++ & 0xff) {
    this.send(PacketType.Message, Buffer.concat([Buffer.from([seq]), Buffer.from(text, 'utf8')]));
    return seq;
  }

  close() {
    this.socket.close();
  }
}

export const PLAYERS_TEXT = [
  'Players on server:',
  '[#] [IP Address]:[Port] [Ping] [GUID] [Name]',
  '--------------------------------------------------',
  ...Array.from({ length: 30 }, (_, i) => `${i}   78.47.157.${i}:2304    ${40 + i}   ${'0123456789abcdef0123456789abcde'}${i % 10}(OK) Oyuncu ${i} Çağrı`),
  '30   10.0.0.2:2316         -1   -  Yeni Gelen (Lobby)',
  '(31 players in total)',
].join('\n');

export const BANS_TEXT = [
  'GUID Bans:',
  '[#] [GUID] [Minutes left] [Reason]',
  '----------------------------------------',
  '0  bec2bd9eb2e1e6a0b5a1c0b2c5e3d0f1 perm Hile kullanımı',
  '1  aec2bd9eb2e1e6a0b5a1c0b2c5e3d0f2 1440 Küfür',
  '',
  'IP Bans:',
  '[#] [IP Address] [Minutes left] [Reason]',
  '----------------------------------------------',
  '2  1.2.3.4 perm Spam',
].join('\n');
