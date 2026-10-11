/** RCON çıktı ayrıştırıcıları (saf; arayüzde de kullanılır). */

/* ---------------- Çıktı ayrıştırıcılar ---------------- */

export interface RconPlayer {
  id: number;
  ip: string;
  port: number;
  ping: number;
  guid: string;
  verified: boolean;
  name: string;
  inLobby: boolean;
}

const PLAYER_RE = /^(\d+)\s+(\S+):(\d+)\s+(-?\d+)\s+([0-9a-fA-F]{32}|-)(?:\(([^)]*)\))?\s+(.*?)\s*$/;

export function parsePlayers(text: string): RconPlayer[] {
  const out: RconPlayer[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = PLAYER_RE.exec(raw.trim());
    if (!m) continue;
    let name = m[7]!;
    const inLobby = / \(Lobby\)$/.test(name);
    if (inLobby) name = name.replace(/ \(Lobby\)$/, '');
    out.push({
      id: Number(m[1]),
      ip: m[2]!,
      port: Number(m[3]),
      ping: Number(m[4]),
      guid: m[5] === '-' ? '' : m[5]!.toLowerCase(),
      verified: m[6] === 'OK',
      name,
      inLobby,
    });
  }
  return out;
}

export interface RconBan {
  id: number;
  kind: 'guid' | 'ip';
  value: string;
  /** -1 kalıcı, süresi dolmuşsa 0 */
  minutesLeft: number;
  reason: string;
  /** Süresi dolmuş (BattlEye dakika sütununda "-" yazar; bir sonraki loadBans'ta silinir) */
  expired?: boolean;
}

export function parseBans(text: string): RconBan[] {
  const out: RconBan[] = [];
  let kind: 'guid' | 'ip' = 'guid';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^GUID Bans:/i.test(line)) kind = 'guid';
    else if (/^IP Bans:/i.test(line)) kind = 'ip';
    const m = /^(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!m) continue;
    const col = m[3]!.toLowerCase();
    const expired = col === '-';
    const minutes = col === 'perm' ? -1 : expired ? 0 : Number(col);
    if (Number.isNaN(minutes)) continue;
    out.push({ id: Number(m[1]), kind, value: m[2]!, minutesLeft: minutes, reason: m[4]!.trim(), ...(expired ? { expired: true } : {}) });
  }
  return out;
}

export function parseMissions(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^Missions on server:?$/i.test(l));
}

export type ServerMessage =
  | { type: 'chat'; channel: string; name: string; text: string }
  | { type: 'connect'; playerId: number; name: string; ip: string }
  | { type: 'disconnect'; playerId: number; name: string }
  | { type: 'guid'; playerId: number; name: string; guid: string; verified: boolean }
  | { type: 'kick'; playerId: number; name: string; reason: string }
  | { type: 'rconLogin'; adminId: number; ip: string }
  | { type: 'other'; text: string };

/** Sunucudan gelen RCON mesajlarını sınıflandırır (sohbet, giriş/çıkış, kick...). */
export function classifyMessage(text: string): ServerMessage {
  let m = /^\((\w+)\) (.+?): (.*)$/.exec(text);
  if (m) return { type: 'chat', channel: m[1]!, name: m[2]!, text: m[3]! };
  m = /^Player #(\d+) (.+) \(([\d.:a-fA-F[\]]+)\) connected$/.exec(text);
  if (m) return { type: 'connect', playerId: Number(m[1]), name: m[2]!, ip: m[3]! };
  m = /^Player #(\d+) (.+) disconnected$/.exec(text);
  if (m) return { type: 'disconnect', playerId: Number(m[1]), name: m[2]! };
  m = /^Verified GUID \(([0-9a-fA-F]{32})\) of player #(\d+) (.+)$/.exec(text);
  if (m) return { type: 'guid', playerId: Number(m[2]), name: m[3]!, guid: m[1]!.toLowerCase(), verified: true };
  m = /^Player #(\d+) (.+) - (?:BE )?GUID: ([0-9a-fA-F]{32})$/.exec(text);
  if (m) return { type: 'guid', playerId: Number(m[1]), name: m[2]!, guid: m[3]!.toLowerCase(), verified: false };
  m = /^Player #(\d+) (.+?) \([0-9a-fA-F]{32}\) has been kicked by BattlEye: (.*)$/.exec(text);
  if (m) return { type: 'kick', playerId: Number(m[1]), name: m[2]!, reason: m[3]! };
  m = /^RCon admin #(\d+) \((.+)\) logged in$/.exec(text);
  if (m) return { type: 'rconLogin', adminId: Number(m[1]), ip: m[2]! };
  return { type: 'other', text };
}
