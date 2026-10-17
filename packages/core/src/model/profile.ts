import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_HTML_EXTENSIONS,
  DEFAULT_LOAD_EXTENSIONS,
  DIFFICULTY_OPTIONS,
  DIFFICULTY_PRESETS,
  TIMESTAMP_FORMATS,
  type DifficultyOptionKey,
} from './constants.js';

export * from './constants.js';

/**
 * Sunucu profili: bir Arma 3 dedicated sunucusunun bütün ayarları.
 * Tek kaynak burasıdır; server.cfg, basic.cfg, Arma3Profile, BattlEye cfg ve
 * başlatma parametreleri bu modelden üretilir.
 */

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

const difficultyOptionsShape = Object.fromEntries(
  Object.entries(DIFFICULTY_OPTIONS).map(([k, meta]) => [k, int(0, meta.max).default(meta.default)]),
) as { [K in DifficultyOptionKey]: z.ZodDefault<z.ZodNumber> };

export const ServerProfileSchema = z.object({
  // Daha yeni bir sürümün kaydettiği profil de açılabilsin: bilinmeyen anahtarlar atılır
  // (z.object varsayılanı), sürüm numarası 1'e çekilir. Eksik alanlar varsayılanla dolar.
  schemaVersion: z.literal(1).default(1).catch(1),
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
      /** Oyuncular oylamayla birini admin seçebilsin mi (#vote admin). Kapalıyken izinli oy komutları listesinde "admin" yer almaz. */
      allowAdminVote: z.boolean().default(false),
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
      /** Sunucu bu süre içinde hazır olmazsa (RCON / "Host identity created") başlatma başarısız sayılır. 0: kapalı */
      startTimeoutSec: int(0, 3600).default(300),
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
      /** FPS uyarısı (performans izleme) Discord'a da gitsin */
      onPerformance: z.boolean().default(true),
    })
    .prefault({}),

  /** Performans izleme: @oezi_monitor sunucu modu FPS / birim sayılarını loga yazar, uygulama CPU/RAM ölçer */
  monitoring: z
    .object({
      enabled: z.boolean().default(true),
      /** Ölçüm aralığı (sn) */
      sampleSec: int(5, 300).default(10),
      /** Sunucu FPS'i bu değerin altına düşüp ... */
      fpsAlertBelow: int(0, 100).default(15),
      /** ... bu kadar dakika kalırsa uyar (0: uyarı kapalı) */
      fpsAlertMinutes: int(0, 120).default(3),
    })
    .prefault({}),

  /** Zamanlı yedekleme */
  backup: z
    .object({
      enabled: z.boolean().default(false),
      /** Günlük yedek saatleri "HH:MM" */
      times: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)).default(['04:30']),
      /** Yedek klasörü; boşsa sunucu klasörünün yanında oezi-backups/<profil> */
      targetDir: z.string().default(''),
      /** Saklanacak yedek sayısı (eskiler silinir) */
      keep: int(1, 365).default(14),
      includeProfile: z.boolean().default(true),
      includeMissions: z.boolean().default(true),
      includeBattlEye: z.boolean().default(true),
      includeKeys: z.boolean().default(false),
      /** Ek dosya/klasörler (mutlak ya da sunucu klasörüne göre) */
      extraPaths: z.array(z.string()).default([]),
      database: z
        .object({
          enabled: z.boolean().default(false),
          host: z.string().default('127.0.0.1'),
          port: int(1, 65535).default(3306),
          user: z.string().default(''),
          password: z.string().default(''),
          database: z.string().default(''),
          /** mysqldump yolu; boşsa PATH'te aranır */
          dumpPath: z.string().default(''),
        })
        .prefault({}),
    })
    .prefault({}),

  /** Discord'da kendini güncelleyen durum mesajı (webhook ile) */
  discordStatus: z
    .object({
      enabled: z.boolean().default(false),
      /** Boşsa notifications.discordWebhook kullanılır */
      webhook: z.string().default(''),
      intervalSec: int(30, 3600).default(60),
      showPlayers: z.boolean().default(true),
      /** Uygulamanın yönettiği mesaj kimliği (elle değiştirme) */
      messageId: z.string().default(''),
    })
    .prefault({}),

  /** RCON ile belirli aralıklarla oyunculara gönderilen duyurular */
  announcements: z
    .object({
      enabled: z.boolean().default(false),
      intervalMin: int(1, 1440).default(15),
      /** Sırayla gönderilir */
      messages: z.array(z.string().max(400)).default([]),
    })
    .prefault({}),

  /** Uygulama açılınca bu sunucu (kapalıysa) otomatik başlatılsın */
  autoStartOnLaunch: z.boolean().default(false),
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

