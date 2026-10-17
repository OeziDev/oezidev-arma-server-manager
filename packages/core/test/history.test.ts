import { describe, expect, it } from 'vitest';
import { HISTORY_RETENTION_MS, MemoryHistoryStorage, PlayerHistory, foldSearchText, parseBeHistoryMessage } from '../src/history/playerHistory.js';
import type { RconPlayer } from '../src/rcon/parse.js';

const G1 = 'a'.repeat(31) + '1';
const G2 = 'b'.repeat(31) + '2';
const G3 = 'C'.repeat(31) + '3'; // büyük harfli GUID küçültülmeli
const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 17, 18, 0, 0);

describe('parseBeHistoryMessage', () => {
  it('giriş: parantezli ve Unicode ad', () => {
    expect(parseBeHistoryMessage('Player #3 Ahmet (TR) Şahin [57.Alay] (85.105.1.2:2304) connected')).toEqual({
      type: 'connect',
      playerId: 3,
      name: 'Ahmet (TR) Şahin [57.Alay]',
      ip: '85.105.1.2',
      port: 2304,
    });
    expect(parseBeHistoryMessage('Player #0 Ali (1.1.1.1:5) (10.0.0.1:2316) connected\r')).toMatchObject({ name: 'Ali (1.1.1.1:5)', ip: '10.0.0.1' });
  });

  it('GUID, çıkış, kick, ban, sohbet', () => {
    expect(parseBeHistoryMessage(`Verified GUID (${G3}) of player #3 Ahmet (TR) Şahin`)).toEqual({
      type: 'guid',
      playerId: 3,
      name: 'Ahmet (TR) Şahin',
      guid: G3.toLowerCase(),
      verified: true,
    });
    expect(parseBeHistoryMessage(`Player #4 Veli - BE GUID: ${G2}`)).toMatchObject({ type: 'guid', verified: false, guid: G2 });
    expect(parseBeHistoryMessage('Player #3 Ahmet (TR) disconnected')).toEqual({ type: 'disconnect', playerId: 3, name: 'Ahmet (TR)' });
    expect(parseBeHistoryMessage(`Player #5 Kötü (Oyuncu) (${G1}) has been kicked by BattlEye: Script Restriction #12`)).toEqual({
      type: 'kick',
      playerId: 5,
      name: 'Kötü (Oyuncu)',
      guid: G1,
      reason: 'Script Restriction #12',
      byAdmin: false,
      ban: false,
    });
    expect(parseBeHistoryMessage(`Player #5 X (${G1}) has been kicked by BattlEye: Admin Kick (AFK (uzun süre))`)).toMatchObject({
      reason: 'Admin Kick (AFK (uzun süre))',
      byAdmin: true,
      ban: false,
    });
    expect(parseBeHistoryMessage(`Player #5 X (${G1}) has been kicked by BattlEye: Admin Ban (Hile) disconnected`)).toMatchObject({
      type: 'kick',
      ban: true,
    });
    expect(parseBeHistoryMessage('Player #5 X (-) has been kicked by BattlEye: Client not responding')).toMatchObject({ type: 'kick', name: 'X', reason: 'Client not responding' });
    expect(parseBeHistoryMessage('(Global) Ahmet Şahin: selam: nasılsınız')).toEqual({ type: 'chat', channel: 'Global', name: 'Ahmet Şahin', text: 'selam: nasılsınız' });
    expect(parseBeHistoryMessage('RCon admin #0 (1.2.3.4:5555) logged in')).toBeNull();
  });

  it('arama katlama', () => {
    expect(foldSearchText('İSMAİL Şahin Ğ')).toBe('ismail sahin g');
    expect(foldSearchText('ısıtıcı')).toBe('isitici');
  });
});

async function freshHistory(storage = new MemoryHistoryStorage(), now = T0 + 10 * 60 * MIN) {
  return PlayerHistory.open(storage, { now: () => now });
}

describe('PlayerHistory', () => {
  it('giriş GUID\'den önce gelir, playerId ile eşleşir; aynı adlı iki oyuncu karışmaz', async () => {
    const st = new MemoryHistoryStorage();
    const h = await freshHistory(st);
    await h.onServerMessage('Player #0 Ahmet (TR) (1.2.3.4:2304) connected', T0);
    await h.onServerMessage('Player #1 Ahmet (TR) (5.6.7.8:2304) connected', T0 + 1000);
    await h.onServerMessage(`Verified GUID (${G2}) of player #1 Ahmet (TR)`, T0 + 2000);
    await h.onServerMessage(`Verified GUID (${G1}) of player #0 Ahmet (TR)`, T0 + 3000);
    await h.onServerMessage('(Global) Ahmet (TR): selam', T0 + 4000);
    await h.onServerMessage('Player #0 Ahmet (TR) disconnected', T0 + 30 * MIN);

    const s1 = h.sessions(G1);
    expect(s1).toHaveLength(1);
    expect(s1[0]).toMatchObject({ guid: G1, ip: '1.2.3.4', playerId: 0, joinAt: T0, leaveAt: T0 + 30 * MIN });
    const s2 = h.sessions(G2);
    expect(s2[0]).toMatchObject({ ip: '5.6.7.8' });
    expect(s2[0]!.leaveAt).toBeUndefined();
    expect(h.onlineSessions().map((s) => s.guid)).toEqual([G2]);

    const res = h.search({ text: 'ahmet' });
    expect(res.map((p) => p.guid)).toEqual([G2, G1]); // çevrimiçi önce
    expect(res[0]).toMatchObject({ online: true, sessionCount: 1, totalPlaytimeMs: T0 + 10 * 60 * MIN - (T0 + 1000) });
    expect(res[1]).toMatchObject({ online: false, totalPlaytimeMs: 30 * MIN, firstSeen: T0, lastSeen: T0 + 30 * MIN });
    // Sohbet geçmişe yazılmaz
    expect(st.lines.every((l) => !l.includes('selam'))).toBe(true);
  });

  it('yeniden bağlanma, kick, ad değişikliği, arama ve sayfalama', async () => {
    const h = await freshHistory();
    // Oturum 1
    await h.onServerMessage('Player #2 Şahin (TR) (10.0.0.5:2304) connected', T0);
    await h.onServerMessage(`Verified GUID (${G3}) of player #2 Şahin (TR)`, T0 + 500);
    await h.onServerMessage('Player #2 Şahin (TR) disconnected', T0 + 20 * MIN);
    // Oturum 2: başka ad, başka IP, aynı GUID; admin tarafından atılır
    await h.onServerMessage('Player #7 Şahin [57] (10.0.0.9:2304) connected', T0 + 60 * MIN);
    await h.onServerMessage(`Verified GUID (${G3}) of player #7 Şahin [57]`, T0 + 60 * MIN + 500);
    await h.onServerMessage(`Player #7 Şahin [57] (${G3.toLowerCase()}) has been kicked by BattlEye: Admin Kick (küfür)`, T0 + 70 * MIN);
    await h.onServerMessage('Player #7 Şahin [57] disconnected', T0 + 70 * MIN + 100); // kick sonrası gelen çıkış yok sayılır
    // Başka oyuncu aynı numarayla (#2) giriyor
    await h.onServerMessage('Player #2 Mehmet (10.0.0.7:2304) connected', T0 + 80 * MIN);
    await h.onServerMessage(`Verified GUID (${G1}) of player #2 Mehmet`, T0 + 80 * MIN + 100);

    const g3 = G3.toLowerCase();
    const p = h.player(g3)!;
    expect(p).toMatchObject({
      name: 'Şahin [57]',
      names: ['Şahin [57]', 'Şahin (TR)'],
      ips: ['10.0.0.9', '10.0.0.5'],
      sessionCount: 2,
      kickCount: 1,
      lastKickReason: 'Admin Kick (küfür)',
      totalPlaytimeMs: 30 * MIN,
      online: false,
    });
    expect(h.sessions(g3).map((s) => s.kicked)).toEqual(['Admin Kick (küfür)', undefined]);
    expect(h.sessions(g3, 1)).toHaveLength(1);

    // Türkçe karakter duyarsız arama, GUID ve IP ile arama
    expect(h.search({ text: 'SAHIN' }).map((x) => x.guid)).toEqual([g3]);
    expect(h.search({ text: g3.slice(0, 10) }).map((x) => x.guid)).toEqual([g3]);
    expect(h.search({ text: '10.0.0.7' }).map((x) => x.guid)).toEqual([G1]);
    expect(h.search({}).map((x) => x.guid)).toEqual([G1, g3]);
    expect(h.search({ limit: 1, offset: 1 }).map((x) => x.guid)).toEqual([g3]);
    expect(h.search({ onlineOnly: true }).map((x) => x.guid)).toEqual([G1]);
  });

  it('GUID\'siz kick ve önceden görülmemiş oyuncu', async () => {
    const h = await freshHistory();
    await h.onServerMessage('Player #1 Yeni (1.1.1.1:1) connected', T0);
    await h.onServerMessage('Player #1 Yeni (-) has been kicked by BattlEye: Client not responding', T0 + 1000);
    // Bağlantısı görülmeden GUID gelir (uygulama yeni açıldı)
    await h.onServerMessage(`Verified GUID (${G2}) of player #4 Geç Gelen`, T0 + 2000);
    expect(h.sessions(G2)[0]).toMatchObject({ approx: true, name: 'Geç Gelen', joinAt: T0 + 2000 });
    expect(h.stats(T0).totalSessions).toBe(2);
    expect(h.stats(T0).uniquePlayers).toBe(2);
  });

  it('notlar kalıcıdır ve aranabilir', async () => {
    const st = new MemoryHistoryStorage();
    const h = await freshHistory(st);
    await h.onServerMessage('Player #0 Ali (1.1.1.1:1) connected', T0);
    await h.onServerMessage(`Verified GUID (${G1}) of player #0 Ali`, T0 + 1);
    await h.setNote(G1.toUpperCase(), 'Şüpheli: hız hilesi');
    await h.setNote(G2, 'Hiç girmedi ama banlı');
    expect(h.player(G1)!.note).toBe('Şüpheli: hız hilesi');
    expect(h.search({ text: 'supheli' }).map((p) => p.guid)).toEqual([G1]);
    expect(h.search({ text: 'banli' })[0]).toMatchObject({ guid: G2, sessionCount: 0 });

    const h2 = await freshHistory(new MemoryHistoryStorage(st.lines));
    expect(h2.getNote(G1)).toBe('Şüpheli: hız hilesi');
    await h2.setNote(G1, '');
    expect(h2.getNote(G1)).toBeUndefined();
  });

  it('istatistik: tekil oyuncu, en yüksek eşzamanlı, oturum sayısı', async () => {
    const h = await freshHistory(undefined, T0 + 5 * 60 * MIN);
    const join = (pid: number, guid: string, t: number) =>
      h.onServerMessage(`Player #${pid} P${pid} (1.1.1.${pid}:1) connected`, t).then(() => h.onServerMessage(`Verified GUID (${guid}) of player #${pid} P${pid}`, t + 1));
    const leave = (pid: number, t: number) => h.onServerMessage(`Player #${pid} P${pid} disconnected`, t);
    await join(0, G1, T0); //           [T0, T0+60]
    await join(1, G2, T0 + 10 * MIN); // [T0+10, T0+30]
    await leave(1, T0 + 30 * MIN);
    await join(2, G2, T0 + 30 * MIN); // [T0+30, T0+40]  aynı oyuncu yeniden; çıkışla aynı anda giriş: zirve 2 kalır
    await join(3, G3, T0 + 35 * MIN); // [T0+35, ...] açık
    await leave(2, T0 + 40 * MIN);
    await leave(0, T0 + 60 * MIN);
    const s = h.stats(T0);
    expect(s).toMatchObject({ uniquePlayers: 3, peakConcurrent: 3, peakAt: T0 + 35 * MIN, totalSessions: 4 });
    // Pencere dışındaki eski oturumlar sayılmaz
    const later = h.stats(T0 + 50 * MIN);
    expect(later).toMatchObject({ uniquePlayers: 2, peakConcurrent: 2, totalSessions: 2 });
  });

  it('uygulama oturum ortasında yeniden açılır: açık oturum korunur, süre sınırlanır, sunucu durunca kapanır', async () => {
    const st = new MemoryHistoryStorage();
    const h = await freshHistory(st);
    await h.onServerMessage('Player #0 Ali (1.1.1.1:1) connected', T0);
    await h.onServerMessage(`Verified GUID (${G1}) of player #0 Ali`, T0 + 1);
    await h.onServerMessage('Player #1 Veli (2.2.2.2:1) connected', T0);
    await h.onServerMessage(`Verified GUID (${G2}) of player #1 Veli`, T0 + 1);
    await h.flush();

    // 2 gün sonra yeniden açılış: açık oturumlar en fazla 12 saat sayılır
    const later = T0 + 48 * 60 * MIN;
    const h2 = await PlayerHistory.open(new MemoryHistoryStorage(st.lines), { now: () => later });
    expect(h2.player(G1)!.totalPlaytimeMs).toBe(12 * 60 * MIN);
    expect(h2.player(G1)!.online).toBe(false);
    expect(h2.onlineSessions()).toEqual([]);

    // Oyuncu listesi: Veli hâlâ bağlı (oturum devam eder), Ali yok (kapanır), Can yeni (approx oturum)
    const players: RconPlayer[] = [
      { id: 1, ip: '2.2.2.2', port: 1, ping: 50, guid: G2, verified: true, name: 'Veli', inLobby: false },
      { id: 5, ip: '3.3.3.3', port: 1, ping: 50, guid: G3.toLowerCase(), verified: true, name: 'Can (TR)', inLobby: true },
    ];
    await h2.onPlayerList(players, later);
    expect(h2.sessions(G1)[0]).toMatchObject({ leaveAt: T0 + 12 * 60 * MIN });
    expect(h2.player(G2)!.online).toBe(true);
    expect(h2.player(G2)!.totalPlaytimeMs).toBe(later - T0);
    expect(h2.sessions(G3)[0]).toMatchObject({ approx: true, joinAt: later, name: 'Can (TR)' });

    await h2.onServerStopped(later + 10 * MIN);
    expect(h2.onlineSessions()).toEqual([]);
    expect(h2.sessions(G2)[0]!.leaveAt).toBe(later + 10 * MIN);
    expect(h2.sessions(G3)[0]!.leaveAt).toBe(later + 10 * MIN);

    // Sunucu durdu bilgisi yeniden açılışta görülmemişse: onServerStopped eski oturumu sınırla kapatır
    const h3 = await PlayerHistory.open(new MemoryHistoryStorage(st.lines), { now: () => later });
    await h3.onServerStopped(later);
    expect(h3.sessions(G2)[0]!.leaveAt).toBe(T0 + 12 * 60 * MIN);
  });

  it('bozuk satırlar yok sayılır, sıkıştırma gidiş-dönüşü', async () => {
    const st = new MemoryHistoryStorage();
    const h = await freshHistory(st);
    for (let i = 0; i < 5; i++) {
      const t = T0 + i * 60 * MIN;
      await h.onServerMessage(`Player #${i} Oyuncu ${i} (Ü) (1.1.1.${i}:1) connected`, t);
      await h.onServerMessage(`Verified GUID (${i % 2 ? G1 : G2}) of player #${i} Oyuncu ${i} (Ü)`, t + 1);
      if (i < 4) await h.onServerMessage(`Player #${i} Oyuncu ${i} (Ü) disconnected`, t + 30 * MIN);
    }
    await h.setNote(G1, 'not 1');
    await h.setNote(G1, 'not 2');
    await h.flush();
    st.lines.push('{"v":1,"k":"s","id":"yarim', 'çöp', '');
    const before = st.lines.length;

    const h2 = await freshHistory(new MemoryHistoryStorage(st.lines));
    expect(h2.storageStats.lines).toBe(before);
    const lines = h2.compact();
    expect(lines.length).toBe(5 + 1); // 5 oturum + 1 not
    expect(lines.length).toBeLessThan(before);
    expect(h2.storageStats.lines).toBe(lines.length);

    const h3 = await freshHistory(new MemoryHistoryStorage(lines));
    expect(h3.search({})).toEqual(h2.search({}));
    expect(h3.getNote(G1)).toBe('not 2');
    expect(h3.sessions(G2)).toEqual(h2.sessions(G2));

    // Saklama süresi: eski kapanmış oturumlar atılır, açık olan kalır
    const trimmed = h3.compact({ dropClosedBefore: T0 + 3 * 60 * MIN });
    expect(trimmed.length).toBe(2 + 1);
    expect(h3.shouldCompact(1)).toBe(false); // satır sayısı canlı kayıt sayısına eşit

    // Depo yazma hatası durumu bozmaz
    const errors: Error[] = [];
    const failing = { append: async () => Promise.reject(new Error('disk dolu')), readAll: async () => [] };
    const h4 = await PlayerHistory.open(failing, { onError: (e) => errors.push(e), now: () => T0 });
    await h4.onServerMessage('Player #0 A (1.1.1.1:1) connected', T0);
    await h4.onServerMessage(`Verified GUID (${G1}) of player #0 A`, T0);
    expect(errors.map((e) => e.message)).toEqual(['disk dolu', 'disk dolu']);
    expect(h4.player(G1)!.online).toBe(true);
  });

  it('özet önbelleği: değişiklik olunca geçersiz olur, çevrimiçi süre saatle güncellenir, dışarı kopya verilir', async () => {
    let now = T0;
    const h = await PlayerHistory.open(new MemoryHistoryStorage(), { now: () => now });
    await h.onServerMessage('Player #0 Ali (1.1.1.1:1) connected', T0);
    await h.onServerMessage(`Verified GUID (${G1}) of player #0 Ali`, T0);
    await h.onServerMessage('Player #1 Veli (1.1.1.2:1) connected', T0);
    await h.onServerMessage(`Verified GUID (${G2}) of player #1 Veli`, T0);
    await h.onServerMessage('Player #1 Veli disconnected', T0 + 10 * MIN);
    now = T0 + 20 * MIN;
    expect(h.player(G1)!.totalPlaytimeMs).toBe(20 * MIN);
    expect(h.player(G2)!.totalPlaytimeMs).toBe(10 * MIN);
    // Değişiklik yokken saat ilerler: çevrimiçi oyuncunun süresi güncel
    now = T0 + 30 * MIN;
    expect(h.search({ text: 'ali' })[0]!.totalPlaytimeMs).toBe(30 * MIN);
    // Dönen nesneyi değiştirmek önbelleği bozmaz
    const s = h.search({ text: 'veli' })[0]!;
    s.names.push('sahte');
    s.totalPlaytimeMs = 0;
    expect(h.player(G2)!.names).toEqual(['Veli']);
    expect(h.player(G2)!.totalPlaytimeMs).toBe(10 * MIN);
    // Not ve ad değişikliği önbelleği geçersiz kılar
    await h.setNote(G2, 'Şüpheli');
    expect(h.search({ text: 'supheli' }).map((x) => x.guid)).toEqual([G2]);
    await h.onServerMessage('Player #0 Ali disconnected', T0 + 40 * MIN);
    now = T0 + 60 * MIN;
    expect(h.player(G1)!.online).toBe(false);
    expect(h.player(G1)!.totalPlaytimeMs).toBe(40 * MIN);
  });

  it('saklama süresi: hasClosedBefore ve 180 günlük sınır', async () => {
    const h = await PlayerHistory.open(new MemoryHistoryStorage(), { now: () => T0 });
    await h.onServerMessage('Player #0 Ali (1.1.1.1:1) connected', T0);
    await h.onServerMessage(`Verified GUID (${G1}) of player #0 Ali`, T0);
    await h.onServerMessage('Player #0 Ali disconnected', T0 + MIN);
    expect(HISTORY_RETENTION_MS).toBe(180 * 24 * 3600_000);
    expect(h.hasClosedBefore(T0)).toBe(false);
    expect(h.hasClosedBefore(T0 + 2 * MIN)).toBe(true);
    expect(h.player(G1)).toBeDefined();
    h.compact({ dropClosedBefore: T0 + 2 * MIN });
    expect(h.hasClosedBefore(T0 + 2 * MIN)).toBe(false);
    expect(h.player(G1)).toBeUndefined();
  });
});
