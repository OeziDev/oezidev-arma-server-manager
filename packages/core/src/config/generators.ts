import {
  type CfgEntry,
  type CfgValue,
  blank,
  cls,
  comment,
  dedupeEntries,
  findDuplicateNames,
  parseConfig,
  serializeEntries,
  v,
} from './armaConfig.js';
import {
  DIFFICULTY_OPTIONS,
  type DifficultyOptionKey,
  type ServerProfile,
  effectiveRconPort,
} from '../model/profile.js';

export interface GenerateOptions {
  /** Başlık yorumundaki tarih (testlerde sabitlemek için). */
  generatedAt?: Date;
  appName?: string;
}

const APP = 'OeziDev Arma Server Manager';

function header(title: string, opts: GenerateOptions): CfgEntry[] {
  const when = (opts.generatedAt ?? new Date()).toISOString().replace('T', ' ').slice(0, 19);
  return [
    comment(`${title} - ${opts.appName ?? APP} tarafından oluşturuldu (${when} UTC)`),
    comment('Bu dosya her başlatmada yeniden yazılır. Kalıcı değişiklikleri uygulamadan yapın.'),
    blank(),
  ];
}

const b01 = (x: boolean) => (x ? 1 : 0);

/**
 * Kullanıcının elle yazdığı ek satırları ayrıştırır. Sözdizimi hatası varsa
 * hata fırlatır; böylece bozuk bir config asla sunucuya gitmez.
 */
export function parseExtraLines(text: string, label: string): CfgEntry[] {
  if (!text.trim()) return [];
  const { entries, issues } = parseConfig(text);
  const errors = issues.filter((i) => i.severity === 'error');
  if (errors.length) {
    throw new ConfigSyntaxError(
      `${label} içinde sözdizimi hatası: ` + errors.map((e) => `satır ${e.line}: ${e.message}`).join('; '),
      errors.map((e) => ({ line: e.line, message: e.message })),
    );
  }
  return entries;
}

export class ConfigSyntaxError extends Error {
  constructor(
    message: string,
    readonly details: { line: number; message: string }[],
  ) {
    super(message);
    this.name = 'ConfigSyntaxError';
  }
}

/**
 * Ek satırlarda tanımlanan anahtarlar, üretilen aynı adlı girdilerin yerine geçer.
 * Ek satırların kendi içindeki tekrarlar da temizlenir (son tanım kalır); Arma aynı adı
 * iki kez görünce "Member already defined" deyip açılmaz.
 */
function applyOverrides(generated: CfgEntry[], extra: CfgEntry[]): CfgEntry[] {
  if (!extra.length) return dedupeEntries(generated);
  const names = new Set(
    extra.filter((e) => e.kind === 'value' || e.kind === 'class').map((e) => (e as { name: string }).name.toLowerCase()),
  );
  const filtered = generated.filter(
    (e) => !((e.kind === 'value' || e.kind === 'class') && names.has(e.name.toLowerCase())),
  );
  return dedupeEntries([...filtered, blank(), comment('Ek satırlar (kullanıcı tanımlı)'), ...extra]);
}

/**
 * Son güvenlik ağı: üretilen dosyayı tekrar ayrıştırır. Sözdizimi hatası ya da tekrar eden
 * ad varsa sunucuyu başlatmadan önce burada durulur (Arma'nın hata penceresine düşmeden).
 */
function selfCheck(text: string, label: string): string {
  const { entries, issues } = parseConfig(text);
  const errors = issues.filter((i) => i.severity === 'error').map((e) => ({ line: e.line, message: e.message }));
  for (const d of findDuplicateNames(entries)) errors.push({ line: 0, message: `"${d.path}" ${d.count} kez tanımlı` });
  if (errors.length) {
    throw new ConfigSyntaxError(
      `${label} üretilemedi: ` + errors.map((e) => (e.line ? `satır ${e.line}: ` : '') + e.message).join('; '),
      errors,
    );
  }
  return text;
}

/* ------------------------------------------------------------------ */
/* server.cfg                                                          */
/* ------------------------------------------------------------------ */

export function generateServerCfg(p: ServerProfile, opts: GenerateOptions = {}): string {
  const g = p.general;
  const s = p.security;
  const c = p.connection;
  const e: CfgEntry[] = [...header('server.cfg', opts)];

  e.push(comment('--- Genel ---'));
  e.push(v('hostname', g.hostname));
  e.push(v('password', g.password));
  e.push(v('passwordAdmin', g.passwordAdmin));
  if (g.serverCommandPassword) e.push(v('serverCommandPassword', g.serverCommandPassword));
  if (g.admins.length) e.push(v('admins', g.admins));
  e.push(v('maxPlayers', g.maxPlayers));
  const motd = g.motd.filter((line, i, arr) => !(line === '' && i === arr.length - 1));
  if (motd.length) {
    e.push(v('motd', motd));
    e.push(v('motdInterval', g.motdInterval));
  }
  if (g.logFile) e.push(v('logFile', g.logFile));
  e.push(v('timeStampFormat', g.timeStampFormat));
  e.push(v('persistent', b01(g.persistent)));
  e.push(v('statisticsEnabled', b01(g.statisticsEnabled)));
  e.push(v('drawingInMap', b01(g.drawingInMap)));
  if (g.forceRotorLibSimulation) e.push(v('forceRotorLibSimulation', g.forceRotorLibSimulation));

  e.push(blank(), comment('--- Güvenlik ---'));
  e.push(v('BattlEye', b01(s.battlEye)));
  e.push(v('verifySignatures', s.verifySignatures));
  e.push(v('kickDuplicate', b01(s.kickDuplicate)));
  e.push(v('allowedFilePatching', s.allowedFilePatching));
  if (s.filePatchingExceptions.length) e.push(v('filePatchingExceptions', s.filePatchingExceptions));
  if (s.requiredBuild > 0) e.push(v('requiredBuild', s.requiredBuild));
  e.push(v('allowedLoadFileExtensions', s.allowedLoadFileExtensions));
  e.push(v('allowedPreprocessFileExtensions', s.allowedPreprocessFileExtensions));
  e.push(v('allowedHTMLLoadExtensions', s.allowedHTMLLoadExtensions));
  if (s.allowedHTMLLoadURIs.length) e.push(v('allowedHTMLLoadURIs', s.allowedHTMLLoadURIs));
  e.push(v('onUnsignedData', s.onUnsignedData));
  e.push(v('onHackedData', s.onHackedData));
  if (s.onDifferentData) e.push(v('onDifferentData', s.onDifferentData));
  if (s.doubleIdDetected) e.push(v('doubleIdDetected', s.doubleIdDetected));
  if (s.onUserConnected) e.push(v('onUserConnected', s.onUserConnected));
  if (s.onUserDisconnected) e.push(v('onUserDisconnected', s.onUserDisconnected));
  if (s.onUserKicked) e.push(v('onUserKicked', s.onUserKicked));
  const kt = s.kickTimeout;
  e.push(
    v(
      'kickTimeout',
      [
        [0, kt.manual],
        [1, kt.connectivity],
        [2, kt.battlEye],
        [3, kt.harmless],
      ],
      'manual, bağlantı, BattlEye, zararsız (sn; -1 görev sonu, -2 restart)',
    ),
  );

  e.push(blank(), comment('--- Oylama ---'));
  e.push(v('voteMissionPlayers', p.voting.voteMissionPlayers));
  if (p.voting.enabled) {
    e.push(v('voteThreshold', p.voting.voteThreshold));
  } else {
    // Oylamayı tamamen kapat: izinli oy komutu yok + eşik %150 (ulaşılamaz).
    e.push(v('allowedVoteCmds', []));
    e.push(v('voteThreshold', 1.5));
  }

  e.push(blank(), comment('--- Sesli iletişim (VoN) ---'));
  e.push(v('disableVoN', b01(p.von.disabled)));
  e.push(v('vonCodec', p.von.codec));
  e.push(v('vonCodecQuality', p.von.quality));

  e.push(blank(), comment('--- Bağlantı kalitesi ---'));
  const limits = [
    ['maxPing', c.maxPing],
    ['maxPacketLoss', c.maxPacketLoss],
    ['maxDesync', c.maxDesync],
    ['disconnectTimeout', c.disconnectTimeout],
  ] as const;
  for (const [name, lim] of limits) if (lim.enabled) e.push(v(name, lim.value));
  if (limits.some(([, lim]) => lim.enabled)) {
    e.push(
      v(
        'kickClientsOnSlowNetwork',
        limits.map(([, lim]) => b01(lim.enabled && lim.kick)),
        '{maxPing, maxPacketLoss, maxDesync, disconnectTimeout}: 0 logla, 1 at',
      ),
    );
  }
  if (c.upnp) e.push(v('upnp', 1));
  if (c.loopback) e.push(v('loopback', true));
  if (c.steamProtocolMaxDataSize !== 1024) e.push(v('steamProtocolMaxDataSize', c.steamProtocolMaxDataSize));

  const hc = p.headless;
  const externalHc = hc.allowedIps.some((ip) => ip !== '127.0.0.1');
  if (hc.allowedIps.length && (hc.count > 0 || externalHc)) {
    e.push(blank(), comment('--- Headless client ---'));
    e.push(v('headlessClients', hc.allowedIps));
    if (hc.localClients.length) e.push(v('localClient', hc.localClients));
  }

  e.push(blank(), comment('--- Görevler ---'));
  const m = p.missions;
  if (m.autoSelectMission) e.push(v('autoSelectMission', 1));
  if (m.randomMissionOrder) e.push(v('randomMissionOrder', 1));
  if (m.forcedDifficulty) e.push(v('forcedDifficulty', m.forcedDifficulty));
  if (m.missionWhitelist.length) e.push(v('missionWhitelist', m.missionWhitelist));
  const missions = m.rotation.filter((x) => x.enabled);
  e.push(
    cls(
      'Missions',
      missions.map((mission, i) => {
        const inner: CfgEntry[] = [v('template', mission.template), v('difficulty', mission.difficulty)];
        if (mission.params.length) inner.push(cls('Params', mission.params.map((pp) => v(pp.name, pp.value))));
        return cls(`Mission_${i + 1}`, inner);
      }),
    ),
  );

  e.push(blank());
  const a = p.advanced;
  e.push(
    cls('AdvancedOptions', [
      v('LogObjectNotFound', a.logObjectNotFound),
      v('SkipDescriptionParsing', a.skipDescriptionParsing),
      v('ignoreMissionLoadErrors', a.ignoreMissionLoadErrors),
      v('queueSizeLogG', a.queueSizeLogG),
    ]),
  );

  const extra = parseExtraLines(a.extraServerCfg, 'Ek server.cfg satırları');
  return selfCheck(serializeEntries(applyOverrides(e, extra)) + '\n', 'server.cfg');
}

/* ------------------------------------------------------------------ */
/* basic.cfg                                                           */
/* ------------------------------------------------------------------ */

export function generateBasicCfg(p: ServerProfile, opts: GenerateOptions = {}): string {
  const bc = p.basic;
  const e: CfgEntry[] = [...header('basic.cfg', opts)];
  e.push(v('MaxMsgSend', bc.maxMsgSend));
  e.push(v('MaxSizeGuaranteed', bc.maxSizeGuaranteed));
  e.push(v('MaxSizeNonguaranteed', bc.maxSizeNonguaranteed));
  e.push(v('MinBandwidth', bc.minBandwidth));
  e.push(v('MaxBandwidth', bc.maxBandwidth));
  e.push(v('MinErrorToSend', bc.minErrorToSend));
  e.push(v('MinErrorToSendNear', bc.minErrorToSendNear));
  e.push(v('MaxCustomFileSize', bc.maxCustomFileSize));
  e.push(cls('sockets', [v('maxPacketSize', bc.maxPacketSize)]));
  if (bc.terrainGrid > 0) e.push(v('terrainGrid', bc.terrainGrid));
  if (bc.viewDistance > 0) e.push(v('viewDistance', bc.viewDistance));
  const extra = parseExtraLines(bc.extraBasicCfg, 'Ek basic.cfg satırları');
  return selfCheck(serializeEntries(applyOverrides(e, extra)) + '\n', 'basic.cfg');
}

/* ------------------------------------------------------------------ */
/* <name>.Arma3Profile (zorluk)                                        */
/* ------------------------------------------------------------------ */

export function generateArma3Profile(p: ServerProfile, opts: GenerateOptions = {}): string {
  const d = p.difficulty;
  const options: CfgEntry[] = (Object.keys(DIFFICULTY_OPTIONS) as DifficultyOptionKey[]).map((key) => {
    const max = DIFFICULTY_OPTIONS[key].max;
    const raw = d.options[key];
    return v(key, Math.min(Math.max(Math.round(raw), 0), max));
  });
  const e: CfgEntry[] = [
    ...header('Arma3Profile', opts),
    cls('DifficultyPresets', [
      cls('CustomDifficulty', [cls('Options', options), v('aiLevelPreset', d.aiLevelPreset)]),
      // CustomAILevel, CustomDifficulty'nin içinde değil yanında durur (TADST bunu yanlış yere yazıyordu).
      cls('CustomAILevel', [v('skillAI', d.skillAI), v('precisionAI', d.precisionAI)]),
    ]),
  ];
  return selfCheck(serializeEntries(e) + '\n', 'Arma3Profile');
}

/* ------------------------------------------------------------------ */
/* BattlEye beserver(_x64).cfg                                         */
/* ------------------------------------------------------------------ */

export function generateBeServerCfg(p: ServerProfile): string {
  const lines: string[] = [];
  if (p.rcon.enabled) {
    const pw = p.rcon.password;
    if (!pw) throw new Error('RCON açık ama RCON şifresi boş');
    if (/\s/.test(pw)) throw new Error('RCON şifresi boşluk içeremez');
    lines.push(`RConPassword ${pw}`);
    lines.push(`RConPort ${effectiveRconPort(p)}`);
    lines.push(`RConIP ${p.rcon.listenIp || '0.0.0.0'}`);
  }
  if (p.rcon.maxPing > 0) lines.push(`MaxPing ${p.rcon.maxPing}`);
  return lines.join('\n') + '\n';
}

/** Tüm dosyalar tek seferde (önizleme ve dağıtım için). */
export function generateAll(p: ServerProfile, opts: GenerateOptions = {}) {
  return {
    serverCfg: generateServerCfg(p, opts),
    basicCfg: generateBasicCfg(p, opts),
    arma3Profile: generateArma3Profile(p, opts),
    beServerCfg: p.security.battlEye ? generateBeServerCfg(p) : null,
  };
}

export type { CfgValue };
