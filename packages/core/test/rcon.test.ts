import { afterEach, describe, expect, it } from 'vitest';
import { BattlEyeRcon, buildPacket, classifyMessage, crc32, parseBans, parsePacket, parsePlayers } from '../src/rcon/battleye.js';
import { BANS_TEXT, FakeRconServer, PLAYERS_TEXT } from './fakeRcon.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

async function setup(password = 'GizliRcon123', clientPassword = password, opts: Partial<ConstructorParameters<typeof BattlEyeRcon>[0]> = {}) {
  const server = new FakeRconServer(password);
  const port = await server.start();
  const client = new BattlEyeRcon({ host: '127.0.0.1', port, password: clientPassword, timeoutMs: 800, reconnect: false, ...opts });
  cleanups.push(() => client.close(), () => server.close());
  return { server, client };
}

describe('BattlEye RCon paketleri', () => {
  it('CRC32 standart değerleri', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });
  it('paket kur / çöz, bozuk CRC reddedilir', () => {
    const pkt = buildPacket(1, Buffer.from([7, ...Buffer.from('players')]));
    expect(pkt.subarray(0, 2).toString()).toBe('BE');
    const parsed = parsePacket(pkt)!;
    expect(parsed.type).toBe(1);
    expect(parsed.payload.subarray(1).toString()).toBe('players');
    pkt[pkt.length - 1] ^= 0xff;
    expect(parsePacket(pkt)).toBeNull();
  });
});

describe('BattlEye RCon istemcisi', () => {
  it('giriş yapar, komut gönderir', async () => {
    const { server, client } = await setup();
    await client.connect();
    expect(client.state).toBe('connected');
    await client.say('Merhaba "herkes" ğüş');
    expect(server.received).toContain('say -1 Merhaba "herkes" ğüş');
  });

  it('yanlış şifrede auth_failed', async () => {
    const { client } = await setup('dogru', 'yanlis');
    await expect(client.connect()).rejects.toMatchObject({ code: 'auth_failed' });
    expect(client.state).toBe('disconnected');
  });

  it('çok paketli (ters sırada gelen) cevabı birleştirir ve oyuncuları ayrıştırır', async () => {
    const { client } = await setup();
    await client.connect();
    const players = await client.players();
    expect(players).toHaveLength(31);
    expect(players[0]).toEqual({
      id: 0,
      ip: '78.47.157.0',
      port: 2304,
      ping: 40,
      guid: '0123456789abcdef0123456789abcde0',
      verified: true,
      name: 'Oyuncu 0 Çağrı',
      inLobby: false,
    });
    expect(players[30]).toMatchObject({ id: 30, ping: -1, guid: '', verified: false, name: 'Yeni Gelen', inLobby: true });
  });

  it('sırayla gelen komutlar karışmaz', async () => {
    const { server, client } = await setup();
    server.handlers.set('a', 'cevap-a');
    server.handlers.set('b', 'cevap-b');
    await client.connect();
    const [a, b, players] = await Promise.all([client.command('a'), client.command('b'), client.players()]);
    expect(a).toBe('cevap-a');
    expect(b).toBe('cevap-b');
    expect(players).toHaveLength(31);
  });

  it('sunucu mesajlarını onaylar ve tekrarları eler', async () => {
    const { server, client } = await setup();
    const messages: string[] = [];
    client.on('message', (m) => messages.push(m));
    await client.connect();
    const seq = server.pushMessage('(Global) Ahmet: selam');
    server.pushMessage('(Global) Ahmet: selam', seq); // onay kaybolmuş gibi tekrar
    await sleep(200);
    expect(messages).toEqual(['(Global) Ahmet: selam']);
    expect(server.acks).toEqual([seq, seq]);
  });

  it('komut zaman aşımı', async () => {
    const { server, client } = await setup();
    await client.connect();
    server.silent = true;
    await expect(client.command('players')).rejects.toMatchObject({ code: 'timeout' });
  });

  it('keepalive gönderir', async () => {
    const { server, client } = await setup('pw', 'pw', { keepAliveMs: 150 });
    await client.connect();
    await sleep(500);
    expect(server.received.filter((c) => c === '').length).toBeGreaterThanOrEqual(2);
  });

  it('bağlantı koparsa yeniden bağlanır', async () => {
    const { server, client } = await setup('pw', 'pw', { keepAliveMs: 100, reconnect: true, reconnectDelayMs: 100 });
    // watchdog en az 45 sn bekler; bunu test için doğrudan tetikleyelim
    await client.connect();
    const states: string[] = [];
    client.on('state', (s) => states.push(s));
    (client as unknown as { onDisconnect(r: string): void }).onDisconnect('test');
    await sleep(600);
    expect(states).toEqual(['disconnected', 'connecting', 'connected']);
    expect(client.state).toBe('connected');
    expect(server.loggedIn).toBe(true);
  });

  it('eşzamanlı connect() çağrıları aynı denemeyi paylaşır (asılı kalmaz, birbirinin soketini kapatmaz)', async () => {
    const { server, client } = await setup();
    const both = Promise.all([client.connect(), client.connect(), client.connect()]);
    await Promise.race([both, sleep(3000).then(() => Promise.reject(new Error('asılı kaldı')))]);
    expect(client.state).toBe('connected');
    expect(server.logins).toBe(1);
    await expect(client.command('players')).resolves.toContain('Players on server');
  });

  it('bağlanırken close() çağrılırsa connect() reddedilir (asılı kalmaz), sonra yeniden bağlanılabilir', async () => {
    const { client } = await setup('pw', 'pw', { host: 'localhost' });
    const p = client.connect();
    client.close();
    const result = await Promise.race([p.then(() => 'resolved', (e: { code?: string }) => e.code ?? 'rejected'), sleep(3000).then(() => 'hang')]);
    expect(result).not.toBe('hang');
    expect(client.state).toBe('disconnected');
    await client.connect();
    expect(client.state).toBe('connected');
  });

  it('geçersiz girdileri reddeder', async () => {
    const { client } = await setup();
    await client.connect();
    await expect(client.command('say -1 a\n#shutdown')).rejects.toMatchObject({ code: 'invalid' });
    await expect(client.addBan('kotu-deger', 0)).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('RCON çıktı ayrıştırıcıları', () => {
  it('ban listesi', () => {
    expect(parseBans(BANS_TEXT)).toEqual([
      { id: 0, kind: 'guid', value: 'bec2bd9eb2e1e6a0b5a1c0b2c5e3d0f1', minutesLeft: -1, reason: 'Hile kullanımı' },
      { id: 1, kind: 'guid', value: 'aec2bd9eb2e1e6a0b5a1c0b2c5e3d0f2', minutesLeft: 1440, reason: 'Küfür' },
      { id: 2, kind: 'ip', value: '1.2.3.4', minutesLeft: -1, reason: 'Spam' },
    ]);
  });
  it('süresi dolmuş banlar ("-") atlanmaz, expired işaretlenir', () => {
    const text = ['GUID Bans:', '[#] [GUID] [Minutes left] [Reason]', '0  bec2bd9eb2e1e6a0b5a1c0b2c5e3d0f1 - Eski ceza', '1  aec2bd9eb2e1e6a0b5a1c0b2c5e3d0f2 perm Hile'].join('\n');
    expect(parseBans(text)).toEqual([
      { id: 0, kind: 'guid', value: 'bec2bd9eb2e1e6a0b5a1c0b2c5e3d0f1', minutesLeft: 0, reason: 'Eski ceza', expired: true },
      { id: 1, kind: 'guid', value: 'aec2bd9eb2e1e6a0b5a1c0b2c5e3d0f2', minutesLeft: -1, reason: 'Hile' },
    ]);
  });
  it('GUID henüz doğrulanmamış (?) oyuncu da listelenir', () => {
    const p = parsePlayers('5   1.1.1.1:2304   0   0123456789abcdef0123456789abcdef(?) Yeni Oyuncu (Lobby)');
    expect(p[0]).toMatchObject({ id: 5, verified: false, name: 'Yeni Oyuncu', inLobby: true });
  });
  it('oyuncu adı parantez içerse bile', () => {
    const p = parsePlayers('3   1.1.1.1:2304   50   0123456789abcdef0123456789abcdef(OK) [TR] Ali (Medic) (Lobby)');
    expect(p[0]).toMatchObject({ name: '[TR] Ali (Medic)', inLobby: true });
    expect(parsePlayers(PLAYERS_TEXT)).toHaveLength(31);
  });
  it('sunucu mesajlarını sınıflandırır', () => {
    expect(classifyMessage('(Side) Mehmet Y.: hazır mısınız')).toEqual({ type: 'chat', channel: 'Side', name: 'Mehmet Y.', text: 'hazır mısınız' });
    expect(classifyMessage('Player #4 Ayşe (85.10.1.2:2304) connected')).toEqual({ type: 'connect', playerId: 4, name: 'Ayşe', ip: '85.10.1.2:2304' });
    expect(classifyMessage('Player #4 Ayşe disconnected')).toEqual({ type: 'disconnect', playerId: 4, name: 'Ayşe' });
    expect(classifyMessage('Verified GUID (0123456789abcdef0123456789abcdef) of player #4 Ayşe')).toMatchObject({ type: 'guid', verified: true });
    expect(classifyMessage('RCon admin #0 (127.0.0.1:50000) logged in')).toEqual({ type: 'rconLogin', adminId: 0, ip: '127.0.0.1:50000' });
    expect(classifyMessage('bilinmeyen')).toEqual({ type: 'other', text: 'bilinmeyen' });
  });
});
