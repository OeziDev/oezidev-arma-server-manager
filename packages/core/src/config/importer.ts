import {
  type CfgEntry,
  type CfgValue,
  type ParseIssue,
  asBool,
  asNumber,
  asString,
  asStringArray,
  findClass,
  findValue,
  parseConfig,
  serializeEntries,
} from './armaConfig.js';
import {
  DIFFICULTY_OPTIONS,
  DIFFICULTY_PRESETS,
  type DifficultyPreset,
  type ServerProfile,
  ServerProfileSchema,
} from '../model/profile.js';

/** server.cfg'de tanınan (modele aktarılan) anahtarlar; geri kalanlar "ek satırlar"a gider. */
const KNOWN_SERVER_KEYS = new Set(
  [
    'hostname', 'password', 'passwordAdmin', 'serverCommandPassword', 'admins', 'maxPlayers', 'motd',
    'motdInterval', 'logFile', 'timeStampFormat', 'persistent', 'statisticsEnabled', 'drawingInMap',
    'forceRotorLibSimulation', 'BattlEye', 'verifySignatures', 'kickDuplicate', 'allowedFilePatching',
    'filePatchingExceptions', 'requiredBuild', 'allowedLoadFileExtensions', 'allowedPreprocessFileExtensions',
    'allowedHTMLLoadExtensions', 'allowedHTMLLoadURIs', 'onUnsignedData', 'onHackedData', 'onDifferentData',
    'doubleIdDetected', 'onUserConnected', 'onUserDisconnected', 'onUserKicked', 'kickTimeout',
    'voteMissionPlayers', 'voteThreshold', 'allowedVoteCmds', 'disableVoN', 'vonCodec', 'vonCodecQuality',
    'maxPing', 'maxPacketLoss', 'maxDesync', 'disconnectTimeout', 'kickClientsOnSlowNetwork', 'upnp',
    'loopback', 'steamProtocolMaxDataSize', 'headlessClients', 'localClient', 'autoSelectMission',
    'randomMissionOrder', 'forcedDifficulty', 'missionWhitelist', 'Missions', 'AdvancedOptions',
    // Eskimiş/anlamsız anahtarlar: içe aktarırken bilinçli olarak düşürülür.
    'requiredSecureId', 'kickduplicate',
  ].map((k) => k.toLowerCase()),
);

export interface ImportResult {
  profile: ServerProfile;
  issues: ParseIssue[];
  /** Modele aktarılamayan ve "ek satırlar"a konan anahtarlar */
  unknownKeys: string[];
}

type Patch = Record<string, unknown>;

function setIf<T>(target: Patch, key: string, value: T | undefined): void {
  if (value !== undefined) target[key] = value;
}

function asDifficulty(value: CfgValue | undefined): DifficultyPreset | undefined {
  const s = asString(value)?.toLowerCase();
  return s && (DIFFICULTY_PRESETS as readonly string[]).includes(s) ? (s as DifficultyPreset) : undefined;
}

/**
 * Mevcut bir server.cfg'yi profile dönüştürür. `base` verilirse onun üzerine uygulanır
 * (yol, port gibi server.cfg'de olmayan ayarlar korunur).
 */
export function importServerCfg(text: string, base?: ServerProfile): ImportResult {
  const { entries, issues } = parseConfig(text);
  const get = (k: string) => findValue(entries, k);
  const start = base ? structuredClone(base) : ServerProfileSchema.parse({});
  const p = start as unknown as Record<string, Patch>;

  const general: Patch = { ...p.general };
  setIf(general, 'hostname', asString(get('hostname')));
  setIf(general, 'password', asString(get('password')));
  setIf(general, 'passwordAdmin', asString(get('passwordAdmin')));
  setIf(general, 'serverCommandPassword', asString(get('serverCommandPassword')));
  const admins = asStringArray(get('admins'))?.filter((x) => /^\d{17}$/.test(x));
  setIf(general, 'admins', admins);
  setIf(general, 'maxPlayers', asNumber(get('maxPlayers')));
  setIf(general, 'motd', asStringArray(get('motd')));
  setIf(general, 'motdInterval', asNumber(get('motdInterval')));
  setIf(general, 'logFile', asString(get('logFile')));
  const ts = asString(get('timeStampFormat'))?.toLowerCase();
  if (ts === 'none' || ts === 'short' || ts === 'full') general.timeStampFormat = ts;
  setIf(general, 'persistent', asBool(get('persistent')));
  setIf(general, 'statisticsEnabled', asBool(get('statisticsEnabled')));
  setIf(general, 'drawingInMap', asBool(get('drawingInMap')));
  setIf(general, 'forceRotorLibSimulation', asNumber(get('forceRotorLibSimulation')));

  const security: Patch = { ...p.security };
  setIf(security, 'battlEye', asBool(get('BattlEye')));
  const vs = asNumber(get('verifySignatures'));
  if (vs !== undefined) security.verifySignatures = vs === 0 ? 0 : 2;
  setIf(security, 'kickDuplicate', asBool(get('kickDuplicate')));
  setIf(security, 'allowedFilePatching', asNumber(get('allowedFilePatching')));
  setIf(security, 'filePatchingExceptions', asStringArray(get('filePatchingExceptions')));
  setIf(security, 'requiredBuild', asNumber(get('requiredBuild')));
  for (const k of ['allowedLoadFileExtensions', 'allowedPreprocessFileExtensions', 'allowedHTMLLoadExtensions', 'allowedHTMLLoadURIs']) {
    setIf(security, k, asStringArray(get(k)));
  }
  for (const k of ['onUnsignedData', 'onHackedData', 'onDifferentData', 'doubleIdDetected', 'onUserConnected', 'onUserDisconnected', 'onUserKicked']) {
    setIf(security, k, asString(get(k)));
  }
  const kt = get('kickTimeout');
  if (Array.isArray(kt)) {
    const kickTimeout: Patch = { ...(security.kickTimeout as Patch) };
    const names = ['manual', 'connectivity', 'battlEye', 'harmless'];
    for (const pair of kt) {
      if (Array.isArray(pair) && pair.length >= 2) {
        const idx = asNumber(pair[0]);
        const val = asNumber(pair[1]);
        if (idx !== undefined && val !== undefined && names[idx]) kickTimeout[names[idx]!] = val;
      }
    }
    security.kickTimeout = kickTimeout;
  }

  const voting: Patch = { ...p.voting };
  setIf(voting, 'voteMissionPlayers', asNumber(get('voteMissionPlayers')));
  const threshold = asNumber(get('voteThreshold'));
  const voteCmds = get('allowedVoteCmds');
  const votingOff = (threshold !== undefined && threshold > 1) || (Array.isArray(voteCmds) && voteCmds.length === 0);
  voting.enabled = !votingOff;
  if (threshold !== undefined && threshold <= 1) voting.voteThreshold = threshold;

  const von: Patch = { ...p.von };
  setIf(von, 'disabled', asBool(get('disableVoN')));
  setIf(von, 'codec', asNumber(get('vonCodec')));
  setIf(von, 'quality', asNumber(get('vonCodecQuality')));

  const connection: Patch = { ...p.connection };
  const kicks = get('kickClientsOnSlowNetwork');
  const kickArr = Array.isArray(kicks) ? kicks.map((x) => asNumber(x as CfgValue) === 1) : [];
  // TADST tek sayı yazıyordu; onu da anla.
  const kickScalar = !Array.isArray(kicks) ? asNumber(kicks) === 1 : undefined;
  (['maxPing', 'maxPacketLoss', 'maxDesync', 'disconnectTimeout'] as const).forEach((k, i) => {
    const val = asNumber(get(k));
    const current = connection[k] as Patch;
    if (val !== undefined) {
      connection[k] = { ...current, enabled: true, value: Math.round(val), kick: kickArr[i] ?? kickScalar ?? false };
    }
  });
  setIf(connection, 'upnp', asBool(get('upnp')));
  setIf(connection, 'loopback', asBool(get('loopback')));
  setIf(connection, 'steamProtocolMaxDataSize', asNumber(get('steamProtocolMaxDataSize')));

  const headless: Patch = { ...p.headless };
  setIf(headless, 'allowedIps', asStringArray(get('headlessClients')));
  setIf(headless, 'localClients', asStringArray(get('localClient')));

  const missions: Patch = { ...p.missions };
  setIf(missions, 'autoSelectMission', asBool(get('autoSelectMission')));
  setIf(missions, 'randomMissionOrder', asBool(get('randomMissionOrder')));
  const fd = asDifficulty(get('forcedDifficulty'));
  if (fd) missions.forcedDifficulty = fd;
  setIf(missions, 'missionWhitelist', asStringArray(get('missionWhitelist')));
  const missionsClass = findClass(entries, 'Missions');
  if (missionsClass) {
    const rotation: Patch[] = [];
    for (const m of missionsClass.entries) {
      if (m.kind !== 'class') continue;
      const template = asString(findValue(m.entries, 'template'));
      if (!template) continue;
      const params: { name: string; value: number }[] = [];
      const paramsClass = findClass(m.entries, 'Params');
      if (paramsClass) {
        for (const pe of paramsClass.entries) {
          const num = pe.kind === 'value' ? asNumber(pe.value) : undefined;
          if (pe.kind === 'value' && num !== undefined) params.push({ name: pe.name, value: num });
        }
      }
      rotation.push({
        template: template.replace(/\.pbo$/i, ''),
        difficulty: asDifficulty(findValue(m.entries, 'difficulty')) ?? 'regular',
        enabled: true,
        params,
      });
    }
    missions.rotation = rotation;
  }

  const advanced: Patch = { ...p.advanced };
  const adv = findClass(entries, 'AdvancedOptions');
  if (adv) {
    setIf(advanced, 'logObjectNotFound', asBool(findValue(adv.entries, 'LogObjectNotFound')));
    setIf(advanced, 'skipDescriptionParsing', asBool(findValue(adv.entries, 'SkipDescriptionParsing')));
    setIf(advanced, 'ignoreMissionLoadErrors', asBool(findValue(adv.entries, 'ignoreMissionLoadErrors')));
    setIf(advanced, 'queueSizeLogG', asNumber(findValue(adv.entries, 'queueSizeLogG')));
  }
  const unknown: CfgEntry[] = entries.filter(
    (en) => (en.kind === 'value' || en.kind === 'class') && !KNOWN_SERVER_KEYS.has(en.name.toLowerCase()),
  );
  if (unknown.length) {
    const prev = String(advanced.extraServerCfg ?? '').trim();
    advanced.extraServerCfg = (prev ? prev + '\n' : '') + serializeEntries(unknown);
  }

  const merged = {
    ...p,
    general,
    security,
    voting,
    von,
    connection,
    headless,
    missions,
    advanced,
  };
  const res = ServerProfileSchema.safeParse(merged);
  if (!res.success) {
    // Aralık dışı değerleri kullanıcıya bildir, geçersiz alanları varsayılana bırak.
    const fixed = structuredClone(merged) as Record<string, unknown>;
    for (const issue of res.error.issues) {
      issues.push({ line: 0, severity: 'warning', message: `${issue.path.join('.')}: ${issue.message} (varsayılan kullanıldı)` });
      deletePath(fixed, issue.path as (string | number)[]);
    }
    return {
      profile: ServerProfileSchema.parse(fixed),
      issues,
      unknownKeys: unknown.map((u) => (u as { name: string }).name),
    };
  }
  return { profile: res.data, issues, unknownKeys: unknown.map((u) => (u as { name: string }).name) };
}

function deletePath(obj: Record<string, unknown>, path: (string | number)[]): void {
  if (!path.length) return;
  let cur: unknown = obj;
  for (let i = 0; i < path.length - 1; i++) {
    if (cur === null || typeof cur !== 'object') return;
    cur = (cur as Record<string | number, unknown>)[path[i]!];
  }
  if (cur && typeof cur === 'object') {
    const last = path[path.length - 1]!;
    if (Array.isArray(cur) && typeof last === 'number') cur.splice(last, 1);
    else delete (cur as Record<string | number, unknown>)[last];
  }
}

/** Arma3Profile'dan zorluk ayarlarını içe aktar. */
export function importArma3Profile(text: string, base: ServerProfile): ImportResult {
  const { entries, issues } = parseConfig(text);
  const p = structuredClone(base);
  const presets = findClass(entries, 'DifficultyPresets');
  const custom = presets && findClass(presets.entries, 'CustomDifficulty');
  const options = custom && findClass(custom.entries, 'Options');
  if (options) {
    for (const key of Object.keys(DIFFICULTY_OPTIONS) as (keyof typeof DIFFICULTY_OPTIONS)[]) {
      const n = asNumber(findValue(options.entries, key));
      if (n !== undefined) p.difficulty.options[key] = Math.min(Math.max(Math.round(n), 0), DIFFICULTY_OPTIONS[key].max);
    }
    // Eski "mapContent" tek anahtarını yeni üçlüye dağıt.
    const legacy = asNumber(findValue(options.entries, 'mapContent'));
    if (legacy !== undefined && findValue(options.entries, 'mapContentFriendly') === undefined) {
      const val = legacy ? 1 : 0;
      p.difficulty.options.mapContentFriendly = val;
      p.difficulty.options.mapContentEnemy = val;
      p.difficulty.options.mapContentMines = val;
    }
  }
  const preset = custom && asNumber(findValue(custom.entries, 'aiLevelPreset'));
  if (preset !== undefined && preset >= 0 && preset <= 3) p.difficulty.aiLevelPreset = preset;
  // CustomAILevel hem doğru yerde (DifficultyPresets altında) hem TADST'nin koyduğu yerde aranır.
  const ai = (presets && findClass(presets.entries, 'CustomAILevel')) ?? (custom && findClass(custom.entries, 'CustomAILevel'));
  if (ai) {
    const skill = asNumber(findValue(ai.entries, 'skillAI'));
    const precision = asNumber(findValue(ai.entries, 'precisionAI'));
    if (skill !== undefined) p.difficulty.skillAI = Math.min(Math.max(skill, 0), 1);
    if (precision !== undefined) p.difficulty.precisionAI = Math.min(Math.max(precision, 0), 1);
  }
  return { profile: ServerProfileSchema.parse(p), issues, unknownKeys: [] };
}
