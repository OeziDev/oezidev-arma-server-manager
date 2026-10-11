import { z } from 'zod';
import { randomUUID } from 'node:crypto';

/**
 * Sunucu profili: bir Arma 3 dedicated sunucusunun bütün ayarları.
 * Tek kaynak burasıdır; server.cfg, basic.cfg, Arma3Profile, BattlEye cfg ve
 * başlatma parametreleri bu modelden üretilir.
 */

export const DIFFICULTY_PRESETS = ['recruit', 'regular', 'veteran', 'custom'] as const;
export type DifficultyPreset = (typeof DIFFICULTY_PRESETS)[number];

export const TIMESTAMP_FORMATS = ['none', 'short', 'full'] as const;

/** Varsayılan dosya uzantısı izin listeleri (Bohemia varsayılanlarıyla aynı). */
export const DEFAULT_LOAD_EXTENSIONS = [
  'hpp', 'sqs', 'sqf', 'fsm', 'cpp', 'paa', 'txt', 'xml', 'inc', 'ext', 'sqm', 'ods',
  'fxy', 'lip', 'csv', 'kb', 'bik', 'bikb', 'html', 'htm', 'biedi',
];
export const DEFAULT_HTML_EXTENSIONS = ['htm', 'html', 'xml', 'txt'];

const int = (min: number, max: number) => z.number().int().min(min).max(max);

export const ModRefSchema = z.object({
  id: z.string().default(() => randomUUID()),
  /** Sunucu klasörüne göre göreli (ör. "@cba_a3") veya mutlak yol. */
  path: z.string().min(1),
  enabled: z.boolean().default(true),
  /** Arayüzde gösterilecek ad (meta.cpp / Workshop başlığı). */
  displayName: z.string().default(''),
  source: z.enum(['local', 'workshop']).default('local'),
  workshopId: z.string().regex(/^\d+$/).optional(),
});
export type ModRef = z.infer<typeof ModRefSchema>;

export const MissionParamSchema = z.object({
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Parametre adı geçersiz'),
  value: z.number(),
});

export const MissionSchema = z.object({
  id: z.string().default(() => randomUUID()),
  /** Dosya/klasör adı .pbo olmadan: "altislife.Altis" */
  template: z.string().min(1),
  enabled: z.boolean().default(true),
  difficulty: z.enum(DIFFICULTY_PRESETS).default('regular'),
  params: z.array(MissionParamSchema).default([]),
});
export type Mission = z.infer<typeof MissionSchema>;

const LimitSchema = (value: number, min: number, max: number) =>
  z
    .object({
      enabled: z.boolean().default(false),
      value: int(min, max).default(value),
      /** true: sınır aşılınca at; false: sadece logla */
      kick: z.boolean().default(false),
    })
    .prefault({});

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

const difficultyOptionsShape = Object.fromEntries(
  Object.entries(DIFFICULTY_OPTIONS).map(([k, meta]) => [k, int(0, meta.max).default(meta.default)]),
) as { [K in DifficultyOptionKey]: z.ZodDefault<z.ZodNumber> };

export const ServerProfileSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  id: z.string().default(() => randomUUID()),
  /** Uygulamada görünen ad */
  name: z.string().min(1).default('Yeni Sunucu'),
  /** Hangi makinede çalışıyor: 'local' veya bir SSH host id'si */
  hostId: z.string().default('local'),

  paths: z
    .object({
      /** Arma 3 sunucu kurulum klasörü */
      serverDir: z.string().default(''),
      /** Boşsa işletim sistemine göre arma3server_x64(.exe) */
      executable: z.string().default(''),
      /** -profiles klasörü. Boşsa <serverDir>/oezi-profiles/<slug> */
      profilesDir: z.string().default(''),
      /** -name: profil adı (Users/<name>/<name>.Arma3Profile) */
      profileName: z.string().regex(/^[A-Za-z0-9_\-]+$/, 'Profil adı sadece harf, rakam, - ve _ içerebilir').default('server'),
    })
    .prefault({}),

  network: z
    .object({
      port: int(1, 65530).default(2302),
      /** -ip parametresi: boşsa tüm arayüzler */
      bindIp: z.string().default(''),
    })
    .prefault({}),

  general: z
    .object({
      hostname: z.string().default('Arma 3 Sunucusu'),
      password: z.string().default(''),
      passwordAdmin: z.string().default(''),
      serverCommandPassword: z.string().default(''),
      /** Otomatik admin olacak Steam64 ID'leri */
      admins: z.array(z.string().regex(/^\d{17}$/, 'Steam64 ID 17 haneli olmalı')).default([]),
      maxPlayers: int(1, 1024).default(64),
      motd: z.array(z.string()).default([]),
      motdInterval: z.number().min(0).max(3600).default(5),
      logFile: z.string().default('server_console.log'),
      timeStampFormat: z.enum(TIMESTAMP_FORMATS).default('short'),
      persistent: z.boolean().default(false),
      statisticsEnabled: z.boolean().default(true),
      drawingInMap: z.boolean().default(true),
      /** 0: oyuncuya bırak, 1: AFM zorunlu, 2: SFM zorunlu */
      forceRotorLibSimulation: int(0, 2).default(0),
    })
    .prefault({}),

  security: z
    .object({
      battlEye: z.boolean().default(true),
      /** 0 kapalı, 2 tam doğrulama (v1 artık desteklenmiyor) */
      verifySignatures: z.union([z.literal(0), z.literal(2)]).default(2),
      kickDuplicate: z.boolean().default(true),
      /** 0: kimse, 1: sadece headless client, 2: herkes */
      allowedFilePatching: int(0, 2).default(0),
      filePatchingExceptions: z.array(z.string().regex(/^\d{17}$/)).default([]),
      requiredBuild: int(0, 9_999_999).default(0),
      allowedLoadFileExtensions: z.array(z.string()).default(DEFAULT_LOAD_EXTENSIONS),
      allowedPreprocessFileExtensions: z.array(z.string()).default(DEFAULT_LOAD_EXTENSIONS),
      allowedHTMLLoadExtensions: z.array(z.string()).default(DEFAULT_HTML_EXTENSIONS),
      allowedHTMLLoadURIs: z.array(z.string()).default([]),
      onUnsignedData: z.string().default('kick (_this select 0)'),
      onHackedData: z.string().default('kick (_this select 0)'),
      onDifferentData: z.string().default(''),
      doubleIdDetected: z.string().default(''),
      onUserConnected: z.string().default(''),
      onUserDisconnected: z.string().default(''),
      onUserKicked: z.string().default(''),
      /** Kick süreleri (sn): -1 görev sonuna kadar, -2 sunucu restartına kadar */
      kickTimeout: z
        .object({
          manual: z.number().int().min(-2).default(-1),
          connectivity: z.number().int().min(-2).default(180),
          battlEye: z.number().int().min(-2).default(180),
          harmless: z.number().int().min(-2).default(180),
        })
        .prefault({}),
    })
    .prefault({}),

  voting: z
    .object({
      enabled: z.boolean().default(true),
      voteMissionPlayers: int(0, 1024).default(1),
      voteThreshold: z.number().min(0).max(1).default(0.33),
    })
    .prefault({}),

  von: z
    .object({
      disabled: z.boolean().default(false),
      /** 0: SPEEX (eski), 1: OPUS */
      codec: int(0, 1).default(1),
      /** 0-10: 8kHz, 11-20: 16kHz, 21-30: 32kHz */
      quality: int(0, 30).default(20),
    })
    .prefault({}),

  connection: z
    .object({
      maxPing: LimitSchema(250, 10, 100_000),
      maxPacketLoss: LimitSchema(50, 0, 100),
      maxDesync: LimitSchema(150, 0, 100_000),
      disconnectTimeout: LimitSchema(90, 5, 90),
      upnp: z.boolean().default(false),
      loopback: z.boolean().default(false),
      steamProtocolMaxDataSize: int(0, 100_000).default(1024),
    })
    .prefault({}),

  missions: z
    .object({
      rotation: z.array(MissionSchema).default([]),
      autoSelectMission: z.boolean().default(false),
      randomMissionOrder: z.boolean().default(false),
      /** Boş değilse bütün görevlere zorla uygulanır */
      forcedDifficulty: z.union([z.enum(DIFFICULTY_PRESETS), z.literal('')]).default(''),
      /** Boş değilse sadece bu görevler oylanabilir/seçilebilir */
      missionWhitelist: z.array(z.string()).default([]),
    })
    .prefault({}),

  headless: z
    .object({
      /** Kaç headless client başlatılacak (0 = kapalı) */
      count: int(0, 16).default(0),
      /** server.cfg headlessClients[] / localClient[] */
      allowedIps: z.array(z.string()).default(['127.0.0.1']),
      localClients: z.array(z.string()).default(['127.0.0.1']),
      connectIp: z.string().default('127.0.0.1'),
      /** Sunucu başladıktan kaç sn sonra HC'ler bağlansın */
      startDelaySec: int(0, 600).default(45),
      limitFPS: int(0, 1000).default(0),
      extraArgs: z.string().default(''),
    })
    .prefault({}),

  advanced: z
    .object({
      logObjectNotFound: z.boolean().default(true),
      skipDescriptionParsing: z.boolean().default(false),
      ignoreMissionLoadErrors: z.boolean().default(false),
      queueSizeLogG: int(0, 100_000_000).default(1_000_000),
      /** server.cfg sonuna olduğu gibi eklenecek satırlar (sözdizimi kontrol edilir) */
      extraServerCfg: z.string().default(''),
    })
    .prefault({}),

  basic: z
    .object({
      maxMsgSend: int(1, 100_000).default(128),
      maxSizeGuaranteed: int(1, 1400).default(512),
      maxSizeNonguaranteed: int(1, 1400).default(256),
      // Arma tam sayıları 32-bit okur; 2.147.483.647 üstü taşar (TADST'deki hata), o yüzden sınırlı.
      minBandwidth: z.number().int().min(0).max(2_147_483_647).default(131_072),
      maxBandwidth: z.number().int().min(0).max(2_147_483_647).default(1_000_000_000),
      minErrorToSend: z.number().min(0).max(1).default(0.001),
      minErrorToSendNear: z.number().min(0).max(10).default(0.01),
      maxCustomFileSize: z.number().int().min(0).max(2_147_483_647).default(0),
      maxPacketSize: int(256, 1500).default(1400),
      terrainGrid: z.number().min(0).max(50).default(0),
      viewDistance: int(0, 40_000).default(0),
      extraBasicCfg: z.string().default(''),
    })
    .prefault({}),

  difficulty: z
    .object({
      options: z.object(difficultyOptionsShape).prefault({}),
      /** 0 düşük, 1 normal, 2 yüksek, 3 özel (skillAI/precisionAI) */
      aiLevelPreset: int(0, 3).default(1),
      skillAI: z.number().min(0).max(1).default(0.5),
      precisionAI: z.number().min(0).max(1).default(0.5),
    })
    .prefault({}),

  launch: z
    .object({
      mods: z.array(ModRefSchema).default([]),
      serverMods: z.array(ModRefSchema).default([]),
      autoInit: z.boolean().default(false),
      loadMissionToMemory: z.boolean().default(true),
      filePatching: z.boolean().default(false),
      limitFPS: int(0, 1000).default(0),
      enableHT: z.boolean().default(false),
      hugepages: z.boolean().default(false),
      maxMem: int(0, 1_000_000).default(0),
      cpuCount: int(0, 256).default(0),
      exThreads: int(0, 7).default(0),
      malloc: z.string().default(''),
      netlog: z.boolean().default(false),
      noLogs: z.boolean().default(false),
      /** Windows'ta sunucu konsol penceresi gösterilsin mi */
      showConsoleWindow: z.boolean().default(false),
      extraArgs: z.string().default(''),
    })
    .prefault({}),

  rcon: z
    .object({
      enabled: z.boolean().default(true),
      /** 0 ise oyun portu + 5 (2306 BattlEye trafiğine ayrılmış olduğu için onun bir üstü) */
      port: int(0, 65535).default(0),
      password: z.string().default(''),
      /** RCON'un dinleyeceği IP (BattlEye RConIP). Boşsa 0.0.0.0 */
      listenIp: z.string().default(''),
      /** Uygulamanın bağlanacağı adres; boşsa host adresi / 127.0.0.1 */
      connectHost: z.string().default(''),
      maxPing: int(0, 100_000).default(0),
    })
    .prefault({}),

  supervisor: z
    .object({
      autoRestart: z.boolean().default(true),
      restartDelaySec: int(0, 3600).default(10),
      /** Bir saat içinde en fazla kaç otomatik restart (döngüye girmesin) */
      maxRestartsPerHour: int(1, 100).default(5),
      /** Günlük zamanlı restartlar, "HH:MM" (uygulamanın çalıştığı makinenin saati) */
      scheduledRestarts: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)).default([]),
      /** Restarttan kaç dakika önce oyunculara uyarı gönderilsin */
      warnMinutes: z.array(int(1, 120)).default([15, 10, 5, 1]),
      warnMessage: z.string().default('Sunucu {minutes} dakika içinde yeniden başlatılacak!'),
      /** Zamanlı restartlarda önce SteamCMD ile sunucu ve Workshop modları güncellensin */
      updateOnScheduledRestart: z.boolean().default(false),
      /** Kapatırken RCON #shutdown sonrası bekleme süresi */
      gracefulShutdownSec: int(0, 300).default(20),
    })
    .prefault({}),

  steam: z
    .object({
      appId: z.number().int().default(233780),
      branch: z.string().default('public'),
      branchPassword: z.string().default(''),
      validate: z.boolean().default(false),
      /** Workshop içerikleri buraya indirilir (force_install_dir). Boşsa <serverDir>/../oezi-workshop */
      workshopDir: z.string().default(''),
    })
    .prefault({}),

  notifications: z
    .object({
      discordWebhook: z.string().default(''),
      onStart: z.boolean().default(true),
      onStop: z.boolean().default(true),
      onCrash: z.boolean().default(true),
      onUpdate: z.boolean().default(true),
    })
    .prefault({}),
});

export type ServerProfile = z.infer<typeof ServerProfileSchema>;
export type ServerProfileInput = z.input<typeof ServerProfileSchema>;

/** Varsayılan değerlerle yeni profil. */
export function createProfile(input: ServerProfileInput = {}): ServerProfile {
  return ServerProfileSchema.parse(input);
}

export interface ValidationError {
  path: string;
  message: string;
}

/** Şema doğrulaması: kullanıcıya gösterilecek okunur hata listesi döner. */
export function parseProfile(input: unknown): { profile?: ServerProfile; errors: ValidationError[] } {
  const res = ServerProfileSchema.safeParse(input);
  if (res.success) return { profile: res.data, errors: [] };
  return {
    errors: res.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  };
}

/** Dosya/klasör adı için güvenli kısa ad. */
export function slugify(name: string): string {
  const map: Record<string, string> = { ç: 'c', ğ: 'g', ı: 'i', İ: 'i', ö: 'o', ş: 's', ü: 'u', Ç: 'c', Ğ: 'g', Ö: 'o', Ş: 's', Ü: 'u', ä: 'ae', ß: 'ss' };
  const s = name
    .split('')
    .map((c) => map[c] ?? c)
    .join('')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'server';
}

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
