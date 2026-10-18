import {
  type CfgEntry,
  type CfgValue,
  type ParseIssue,
  asBool,
  asNumber,
  asString,
  asStringArray,
  dedupeEntries,
  findClass,
  findValue,
  parseConfig,
  serializeEntries,
} from './armaConfig.js';
import {
  DEFAULT_VOTE_CMDS,
  DIFFICULTY_OPTIONS,
  DIFFICULTY_PRESETS,
  KNOWN_VOTE_CMDS,
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
    'voteMissionPlayers', 'voteThreshold', 'disableVoN', 'vonCodec', 'vonCodecQuality',
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
  try {
    return importServerCfgUnsafe(text, base);
  } catch (err) {
    // Bozuk girdi asla istisna fırlatmasın: profil değişmeden döner, kullanıcı hatayı görür.
    return failedImport(err, base);
  }
}

function failedImport(err: unknown, base?: ServerProfile): ImportResult {
  const reason = err instanceof Error ? err.message : String(err);
  let profile: ServerProfile;
  try {
    profile = base ? ServerProfileSchema.parse(structuredClone(base)) : ServerProfileSchema.parse({});
  } catch {
    profile = ServerProfileSchema.parse({});
  }
  return {
    profile,
    issues: [
      {
        line: 0,
        severity: 'error',
        message: `İçe aktarma başarısız, profil değiştirilmedi: ${reason}`,
        messageEn: `Import failed, profile left unchanged: ${reason}`,
      },
    ],
    unknownKeys: [],
  };
}

/** {komut, önce, sonra} listesi bizim varsayılan listemiz mi (+ isteğe bağlı "admin")? Değilse undefined. */
function matchDefaultVoteCmds(value: CfgValue | undefined): { allowAdmin: boolean } | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Map<string, [boolean, boolean]>();
  for (const item of value) {
    const arr = Array.isArray(item) ? item : [item];
    // Eşik (4. eleman) içeren ya da başka biçimdeki listeler modele sığmaz.
    if (arr.length < 1 || arr.length > 3 || Array.isArray(arr[0])) return undefined;
    const cmd = asString(arr[0])?.toLowerCase();
    if (!cmd || !(KNOWN_VOTE_CMDS as readonly string[]).includes(cmd) || seen.has(cmd)) return undefined;
    const flags = arr.slice(1).map((x) => (Array.isArray(x) ? undefined : asBool(x)));
    if (flags.some((f) => f === undefined)) return undefined;
    seen.set(cmd, [flags[0] ?? true, flags[1] ?? true]);
  }
  for (const [cmd, pre, post] of DEFAULT_VOTE_CMDS) {
    const got = seen.get(cmd);
    if (!got || got[0] !== pre || got[1] !== post) return undefined;
  }
  const allowAdmin = seen.has('admin');
  if (seen.size !== DEFAULT_VOTE_CMDS.length + (allowAdmin ? 1 : 0)) return undefined;
  return { allowAdmin };
}

type Rotation = { template: string; difficulty: DifficultyPreset; enabled: boolean; params: { name: string; value: number }[] };

/** Missions altındaki bir görev class'ı modele birebir aktarılabiliyorsa onu döner. */
function missionFromClass(m: CfgEntry): Rotation | undefined {
  if (m.kind !== 'class' || m.base) return undefined;
  const allowed = new Set(['template', 'difficulty', 'params']);
  if (m.entries.some((e) => (e.kind === 'value' || e.kind === 'class') && !allowed.has(e.name.toLowerCase()))) return undefined;
  const templateRaw = findValue(m.entries, 'template');
  const template = Array.isArray(templateRaw) ? undefined : asString(templateRaw);
  if (!template) return undefined;
  const diffRaw = findValue(m.entries, 'difficulty');
  const difficulty = diffRaw === undefined ? 'regular' : asDifficulty(diffRaw);
  if (!difficulty) return undefined;
  const params: { name: string; value: number }[] = [];
  const paramsClass = findClass(m.entries, 'Params');
  if (findValue(m.entries, 'Params') !== undefined) return undefined;
  if (paramsClass) {
    for (const pe of paramsClass.entries) {
      if (pe.kind === 'comment' || pe.kind === 'blank') continue;
      const num = pe.kind === 'value' && !Array.isArray(pe.value) ? asNumber(pe.value) : undefined;
      if (pe.kind !== 'value' || num === undefined) return undefined;
      params.push({ name: pe.name, value: num });
    }
  }
  return { template: template.replace(/\.pbo$/i, ''), difficulty, enabled: true, params };
}

function importServerCfgUnsafe(text: string, base?: ServerProfile): ImportResult {
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
  const votedAdminCmds = get('allowedVotedAdminCmds');
  // allowedVoteCmds modele aktarıldıysa (boş liste ya da bizim varsayılan listemiz) ek satırlara gitmez.
  let voteCmdsMapped = Array.isArray(voteCmds) && voteCmds.length === 0;
  // Oylama ayarlarına sadece cfg oylamadan bahsediyorsa dokun (mevcut profilin ayarı korunur).
  if (threshold !== undefined || voteCmds !== undefined) {
    // Eski sürümlerin yazdığı 1.5 (eşik > 1) ve boş allowedVoteCmds[] oylamanın kapalı olduğu anlamına gelir.
    const votingOff = (threshold !== undefined && threshold > 1) || (Array.isArray(voteCmds) && voteCmds.length === 0);
    voting.enabled = !votingOff;
    // Kapalı oylamanın yazdığı eşik 1, profildeki (oylama açılınca kullanılacak) eşiği ezmesin.
    if (threshold !== undefined && threshold <= 1 && !(votingOff && threshold === 1)) voting.voteThreshold = threshold;
    if (!votingOff) {
      if (voteCmds === undefined) {
        // Liste yoksa Arma her oy komutuna, #vote admin dahil, izin verir.
        voting.allowAdminVote = true;
      } else {
        const match = matchDefaultVoteCmds(voteCmds);
        if (match) {
          voting.allowAdminVote = match.allowAdmin;
          voteCmdsMapped = true;
        }
      }
    }
  }
  // Boş allowedVotedAdminCmds'i üretici zaten yazıyorsa (oylama açık, admin oylaması kapalı) modelde karşılığı var.
  const votedAdminMapped =
    Array.isArray(votedAdminCmds) && votedAdminCmds.length === 0 && voting.enabled === true && voting.allowAdminVote === false;

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
  let keepMissionsClass = false;
  if (missionsClass) {
    const rotation: Rotation[] = [];
    for (const m of missionsClass.entries) {
      if (m.kind === 'comment' || m.kind === 'blank') continue;
      const mission = missionFromClass(m);
      if (!mission) {
        keepMissionsClass = true;
        break;
      }
      rotation.push(mission);
    }
    if (keepMissionsClass) {
      issues.push({
        line: 0,
        severity: 'warning',
        message:
          'Missions sınıfındaki bazı görevler (template\'siz/kampanya tarzı ya da ek alanlı) modele aktarılamadı; ' +
          'Missions sınıfının tamamı ek satırlara taşındı, görev rotasyonu değiştirilmedi.',
        messageEn:
          'Some entries in class Missions (campaign style without template, or with extra fields) cannot be modelled; ' +
          'the whole Missions class was moved to the extra lines and the mission rotation was left unchanged.',
      });
    } else {
      missions.rotation = rotation;
    }
  }

  const advanced: Patch = { ...p.advanced };
  const adv = findClass(entries, 'AdvancedOptions');
  if (adv) {
    setIf(advanced, 'logObjectNotFound', asBool(findValue(adv.entries, 'LogObjectNotFound')));
    setIf(advanced, 'skipDescriptionParsing', asBool(findValue(adv.entries, 'SkipDescriptionParsing')));
    setIf(advanced, 'ignoreMissionLoadErrors', asBool(findValue(adv.entries, 'ignoreMissionLoadErrors')));
    setIf(advanced, 'queueSizeLogG', asNumber(findValue(adv.entries, 'queueSizeLogG')));
  }
  const unknown: CfgEntry[] = entries.filter((en) => {
    if (en.kind !== 'value' && en.kind !== 'class') return false;
    const key = en.name.toLowerCase();
    if (key === 'missions') return keepMissionsClass && en.kind === 'class';
    // Boş ya da varsayılan allowedVoteCmds modelde var; başka listeler ek satır olarak korunur.
    if (key === 'allowedvotecmds') return !(voteCmdsMapped && en.kind === 'value');
    if (key === 'allowedvotedadmincmds') return !(votedAdminMapped && en.kind === 'value');
    return !KNOWN_SERVER_KEYS.has(key);
  });
  if (unknown.length) {
    advanced.extraServerCfg = mergeExtraLines(String(advanced.extraServerCfg ?? ''), dedupeEntries(unknown));
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
  return { profile: validateImported(merged, start, issues), issues, unknownKeys: unknown.map((u) => (u as { name: string }).name) };
}

/** Yolları karşılaştır: sayı indeksleri sayısal, aynı dizideki büyük indeks önce gelecek şekilde (azalan) sırala. */
function compareIssuePathDesc(a: PropertyKey[], b: PropertyKey[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return y - x;
    return String(y).localeCompare(String(x));
  }
  return b.length - a.length;
}

/**
 * Şemaya uymayan alanları uyarıyla varsayılana bırakır. Asla istisna fırlatmaz: düzeltilemezse
 * başlangıç profiline (ya da varsayılanlara) döner.
 */
function validateImported(merged: unknown, start: unknown, issues: ParseIssue[]): ServerProfile {
  const fixed = structuredClone(merged) as Record<string, unknown>;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = ServerProfileSchema.safeParse(fixed);
    if (res.success) return res.data;
    const paths = res.error.issues.map((i) => i.path as PropertyKey[]).sort(compareIssuePathDesc);
    if (attempt === 0) {
      for (const issue of res.error.issues) {
        const where = issue.path.map(String).join('.');
        issues.push({
          line: 0,
          severity: 'warning',
          message: `${where}: ${issue.message} (varsayılan kullanıldı)`,
          messageEn: `${where}: ${issue.message} (default used)`,
        });
      }
    }
    const seen = new Set<string>();
    for (const path of paths) {
      // İlk denemede sadece hatalı alan silinir; yetmezse hatalı dizi elemanının tamamı atılır.
      let target = path;
      if (attempt > 0) {
        const lastIdx = path.map((x) => typeof x === 'number').lastIndexOf(true);
        if (lastIdx >= 0) target = path.slice(0, lastIdx + 1);
      }
      const key = JSON.stringify(target);
      if (seen.has(key)) continue;
      seen.add(key);
      deletePath(fixed, target);
    }
  }
  issues.push({
    line: 0,
    severity: 'error',
    message: 'İçe aktarılan değerler düzeltilemedi; mevcut profil korundu.',
    messageEn: 'Imported values could not be repaired; the existing profile was kept.',
  });
  const back = ServerProfileSchema.safeParse(start);
  return back.success ? back.data : ServerProfileSchema.parse({});
}

/**
 * İçe aktarılan tanınmayan satırları mevcut "ek satırlar"a ekler. Aynı adlı eski satırlar
 * yenisiyle değiştirilir; aynı dosyayı iki kez içe aktarmak satırları çoğaltmaz.
 */
export function mergeExtraLines(prevText: string, incoming: CfgEntry[]): string {
  const prev = prevText.trim();
  const add = serializeEntries(incoming);
  if (!prev) return add;
  const parsed = parseConfig(prev);
  if (parsed.issues.some((i) => i.severity === 'error')) {
    // Eski metin bozuksa dokunma; kullanıcı doğrulama uyarısını görecek.
    return prev + '\n' + add;
  }
  const names = new Set(
    incoming.filter((e) => e.kind === 'value' || e.kind === 'class').map((e) => (e as { name: string }).name.toLowerCase()),
  );
  const collides = parsed.entries.some((e) => (e.kind === 'value' || e.kind === 'class') && names.has(e.name.toLowerCase()));
  // Çakışma yoksa eski metni olduğu gibi bırak (yorumları korunur).
  if (!collides) return prev + '\n' + add;
  const kept = parsed.entries.filter((e) => !((e.kind === 'value' || e.kind === 'class') && names.has(e.name.toLowerCase())));
  const keptText = serializeEntries(dedupeEntries(kept)).trim();
  return keptText ? keptText + '\n' + add : add;
}

function deletePath(obj: Record<string, unknown>, path: PropertyKey[]): void {
  if (!path.length) return;
  let cur: unknown = obj;
  for (let i = 0; i < path.length - 1; i++) {
    if (cur === null || typeof cur !== 'object') return;
    cur = (cur as Record<PropertyKey, unknown>)[path[i]!];
  }
  if (cur && typeof cur === 'object') {
    const last = path[path.length - 1]!;
    if (Array.isArray(cur) && typeof last === 'number') cur.splice(last, 1);
    else delete (cur as Record<PropertyKey, unknown>)[last];
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
  // Sunucu görüş mesafesi / arazi detayı profilin en üst seviyesinde durur (modelde p.basic altında).
  mapViewSettings(entries, p);
  return { profile: validateImported(p, base, issues), issues, unknownKeys: [] };
}

/** viewDistance / terrainGrid (Arma3Profile en üst seviye; eski config'lerde basic.cfg) -> p.basic */
function mapViewSettings(entries: CfgEntry[], p: ServerProfile): void {
  const vd = asNumber(findValue(entries, 'viewDistance'));
  if (vd !== undefined && Number.isFinite(vd)) p.basic.viewDistance = Math.min(Math.max(Math.round(vd), 0), 40_000);
  const tg = asNumber(findValue(entries, 'terrainGrid'));
  if (tg !== undefined && Number.isFinite(tg)) p.basic.terrainGrid = Math.min(Math.max(tg, 0), 50);
}

const BASIC_KEYS: [cfgKey: string, field: 'maxMsgSend' | 'maxSizeGuaranteed' | 'maxSizeNonguaranteed' | 'minBandwidth' | 'maxBandwidth' | 'minErrorToSend' | 'minErrorToSendNear' | 'maxCustomFileSize'][] = [
  ['MaxMsgSend', 'maxMsgSend'],
  ['MaxSizeGuaranteed', 'maxSizeGuaranteed'],
  ['MaxSizeNonguaranteed', 'maxSizeNonguaranteed'],
  ['MinBandwidth', 'minBandwidth'],
  ['MaxBandwidth', 'maxBandwidth'],
  ['MinErrorToSend', 'minErrorToSend'],
  ['MinErrorToSendNear', 'minErrorToSendNear'],
  ['MaxCustomFileSize', 'maxCustomFileSize'],
];

/**
 * Mevcut bir basic.cfg'yi profile aktarır. terrainGrid / viewDistance da modele alınır
 * (artık Arma3Profile'a yazılırlar). Tanınmayan satırlar "ek basic.cfg satırları"na gider.
 */
export function importBasicCfg(text: string, base: ServerProfile): ImportResult {
  try {
    const { entries, issues } = parseConfig(text);
    const p = structuredClone(base);
    const basic = p.basic as Record<string, unknown>;
    for (const [key, field] of BASIC_KEYS) {
      const n = asNumber(findValue(entries, key));
      if (n !== undefined) basic[field] = n;
    }
    mapViewSettings(entries, p);
    const known = new Set([...BASIC_KEYS.map(([k]) => k.toLowerCase()), 'terraingrid', 'viewdistance', 'sockets']);
    const unknown: CfgEntry[] = entries.filter((en) => (en.kind === 'value' || en.kind === 'class') && !known.has(en.name.toLowerCase()));
    const sockets = findClass(entries, 'sockets');
    if (sockets) {
      const mps = asNumber(findValue(sockets.entries, 'maxPacketSize'));
      if (mps !== undefined) basic.maxPacketSize = mps;
      // sockets içindeki diğer ayarlar (ör. initBandwidth) ek satırlarda kalır; üretilen class'la birleşir.
      const rest = sockets.entries.filter((e) => !(e.kind === 'value' && e.name.toLowerCase() === 'maxpacketsize'));
      if (rest.some((e) => e.kind === 'value' || e.kind === 'class')) unknown.push({ ...sockets, entries: rest });
    }
    if (unknown.length) basic.extraBasicCfg = mergeExtraLines(String(basic.extraBasicCfg ?? ''), dedupeEntries(unknown));
    return { profile: validateImported(p, base, issues), issues, unknownKeys: unknown.map((u) => (u as { name: string }).name) };
  } catch (err) {
    return failedImport(err, base);
  }
}
