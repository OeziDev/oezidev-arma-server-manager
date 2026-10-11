/**
 * Saf sabitler ve yardımcılar: Node bağımlılığı yoktur, arayüzde de kullanılır.
 */
import type { ServerProfile } from './profile.js';

export const DIFFICULTY_PRESETS = ['recruit', 'regular', 'veteran', 'custom'] as const;
export type DifficultyPreset = (typeof DIFFICULTY_PRESETS)[number];

export const TIMESTAMP_FORMATS = ['none', 'short', 'full'] as const;

/** Varsayılan dosya uzantısı izin listeleri (Bohemia varsayılanlarıyla aynı). */
export const DEFAULT_LOAD_EXTENSIONS = [
  'hpp', 'sqs', 'sqf', 'fsm', 'cpp', 'paa', 'txt', 'xml', 'inc', 'ext', 'sqm', 'ods',
  'fxy', 'lip', 'csv', 'kb', 'bik', 'bikb', 'html', 'htm', 'biedi',
];
export const DEFAULT_HTML_EXTENSIONS = ['htm', 'html', 'xml', 'txt'];

/** Arma 3 CustomDifficulty seçenekleri. Değer aralıkları Bohemia dokümantasyonuna göre. */
export const DIFFICULTY_OPTIONS = {
  reducedDamage: { max: 1, default: 0, group: 'simulation' },
  groupIndicators: { max: 2, default: 0, group: 'awareness' },
  friendlyTags: { max: 2, default: 0, group: 'awareness' },
  enemyTags: { max: 2, default: 0, group: 'awareness' },
  detectedMines: { max: 2, default: 0, group: 'awareness' },
  commands: { max: 2, default: 1, group: 'awareness' },
  waypoints: { max: 2, default: 1, group: 'awareness' },
  tacticalPing: { max: 1, default: 0, group: 'awareness' },
  weaponInfo: { max: 2, default: 2, group: 'personal' },
  stanceIndicator: { max: 2, default: 2, group: 'personal' },
  staminaBar: { max: 1, default: 0, group: 'personal' },
  weaponCrosshair: { max: 1, default: 0, group: 'personal' },
  visionAid: { max: 1, default: 0, group: 'personal' },
  thirdPersonView: { max: 2, default: 0, group: 'view' },
  cameraShake: { max: 1, default: 1, group: 'view' },
  scoreTable: { max: 1, default: 1, group: 'multiplayer' },
  deathMessages: { max: 1, default: 1, group: 'multiplayer' },
  vonID: { max: 1, default: 1, group: 'multiplayer' },
  mapContentFriendly: { max: 1, default: 0, group: 'misc' },
  mapContentEnemy: { max: 1, default: 0, group: 'misc' },
  mapContentMines: { max: 1, default: 0, group: 'misc' },
  autoReport: { max: 1, default: 0, group: 'misc' },
  multipleSaves: { max: 1, default: 0, group: 'misc' },
} as const;
export type DifficultyOptionKey = keyof typeof DIFFICULTY_OPTIONS;

/** RCON portu: ayarlanmamışsa oyun portu + 5. (+1..+4 Arma/Steam/BattlEye tarafından kullanılır.) */
export function effectiveRconPort(p: ServerProfile): number {
  return p.rcon.port > 0 ? p.rcon.port : p.network.port + 5;
}

/** Arma 3'ün kullandığı UDP portları. */
export function usedPorts(p: ServerProfile): { port: number; purpose: string }[] {
  const base = p.network.port;
  const ports = [
    { port: base, purpose: 'game' },
    { port: base + 1, purpose: 'steamQuery' },
    { port: base + 2, purpose: 'steam' },
    { port: base + 3, purpose: 'vonReserved' },
    { port: base + 4, purpose: 'battlEye' },
  ];
  if (p.rcon.enabled && p.security.battlEye) {
    ports.push({ port: effectiveRconPort(p), purpose: 'rcon' });
  }
  return ports;
}
