import { ConfigSyntaxError, parseExtraLines } from './config/generators.js';
import { findDuplicateNames } from './config/armaConfig.js';
import { type ServerProfile, effectiveRconPort, usedPorts } from './model/profile.js';
import type { HostOs } from './launch/paths.js';
import { splitArgs } from './launch/commandLine.js';

export type Severity = 'error' | 'warning' | 'info';
export type Lang = 'tr' | 'en';

export interface Issue {
  code: string;
  severity: Severity;
  /** Profil içindeki alan yolu (arayüzde ilgili alana gitmek için) */
  path?: string;
  message: Record<Lang, string>;
}

const issue = (code: string, severity: Severity, tr: string, en: string, path?: string): Issue => ({
  code,
  severity,
  ...(path ? { path } : {}),
  message: { tr, en },
});

/**
 * Anlamsal kontroller: şema geçerli olsa bile sunucuyu bozacak ya da güvenlik
 * açığı yaratacak ayarları yakalar. Hatalar (error) başlatmayı engeller.
 */
export function validateProfile(p: ServerProfile, os?: HostOs, others: ServerProfile[] = []): Issue[] {
  const out: Issue[] = [];

  if (!p.paths.serverDir.trim()) {
    out.push(issue('serverDir.missing', 'error', 'Sunucu klasörü seçilmemiş.', 'Server folder is not set.', 'paths.serverDir'));
  }

  // Güvenlik
  if (!p.security.battlEye) {
    out.push(issue('battleye.off', 'warning', 'BattlEye kapalı: hile koruması ve RCON çalışmaz.', 'BattlEye is off: no anti-cheat and no RCON.', 'security.battlEye'));
  }
  if (p.security.verifySignatures === 0) {
    out.push(issue('signatures.off', 'warning', 'İmza doğrulaması kapalı: oyuncular imzasız/değiştirilmiş PBO ile girebilir.', 'Signature verification is off: players can join with unsigned/modified PBOs.', 'security.verifySignatures'));
  }
  if (p.launch.filePatching) {
    out.push(issue('filePatching.on', 'warning', 'Sunucuda -filePatching açık: sunucu klasöründeki açık dosyalar PBO yerine yüklenebilir.', 'Server -filePatching is on: loose files in the server folder can override PBOs.', 'launch.filePatching'));
  }
  if (p.security.allowedFilePatching === 2) {
    out.push(issue('clientFilePatching.all', 'warning', 'Bütün oyunculara filePatching izni verilmiş.', 'All clients are allowed to use filePatching.', 'security.allowedFilePatching'));
  }
  if (!p.general.passwordAdmin) {
    out.push(issue('adminPassword.empty', 'info', 'Admin şifresi boş: kimse #login ile admin olamaz (admins[] listesi hariç).', 'Admin password is empty: nobody can #login as admin (except the admins[] list).', 'general.passwordAdmin'));
  } else if (p.general.passwordAdmin.length < 10) {
    out.push(issue('adminPassword.weak', 'warning', 'Admin şifresi kısa (10 karakterden az).', 'Admin password is short (less than 10 characters).', 'general.passwordAdmin'));
  }
  if (p.general.passwordAdmin && p.general.passwordAdmin === p.general.password) {
    out.push(issue('adminPassword.sameAsJoin', 'error', 'Admin şifresi sunucu giriş şifresiyle aynı olamaz.', 'Admin password must differ from the join password.', 'general.passwordAdmin'));
  }

  // RCON
  if (p.rcon.enabled) {
    if (!p.security.battlEye) {
      out.push(issue('rcon.needsBattlEye', 'warning', 'RCON için BattlEye açık olmalı; şu an RCON çalışmayacak.', 'RCON requires BattlEye; RCON will not work now.', 'rcon.enabled'));
    } else if (!p.rcon.password) {
      out.push(issue('rcon.noPassword', 'error', 'RCON açık ama şifresi boş.', 'RCON is enabled but has no password.', 'rcon.password'));
    } else if (/\s/.test(p.rcon.password)) {
      out.push(issue('rcon.passwordSpace', 'error', 'RCON şifresi boşluk içeremez.', 'RCON password cannot contain spaces.', 'rcon.password'));
    } else if (p.rcon.password.length < 10) {
      out.push(issue('rcon.weak', 'warning', 'RCON şifresi kısa (10 karakterden az). RCON internete açıksa uzun bir şifre kullan.', 'RCON password is short (< 10 chars). Use a long one if RCON is reachable from the internet.', 'rcon.password'));
    }
    const rp = effectiveRconPort(p);
    const base = p.network.port;
    if (rp >= base && rp <= base + 4) {
      out.push(issue('rcon.portClash', 'error', `RCON portu (${rp}) oyunun kullandığı ${base}-${base + 4} aralığında olamaz.`, `RCON port (${rp}) cannot be inside the game range ${base}-${base + 4}.`, 'rcon.port'));
    }
  }

  // Görevler
  const enabledMissions = p.missions.rotation.filter((m) => m.enabled);
  if (!enabledMissions.length) {
    out.push(issue('missions.empty', 'warning', 'Rotasyonda görev yok: sunucu görev seçim ekranında bekler.', 'No missions in rotation: the server will wait at mission selection.', 'missions.rotation'));
  }
  if (p.launch.autoInit && !p.general.persistent) {
    out.push(issue('autoInit.needsPersistent', 'warning', '-autoInit için "persistent" açık olmalı (Bohemia şartı).', '-autoInit requires "persistent" to be enabled.', 'launch.autoInit'));
  }
  const templates = new Set<string>();
  for (const m of enabledMissions) {
    const key = m.template.toLowerCase();
    if (templates.has(key)) {
      out.push(issue('missions.duplicate', 'info', `Görev rotasyonda birden fazla kez var: ${m.template}`, `Mission appears more than once in rotation: ${m.template}`, 'missions.rotation'));
    }
    templates.add(key);
    if (os === 'linux' && m.template !== m.template.toLowerCase()) {
      out.push(issue('missions.linuxCase', 'warning', `Linux sunucusu küçük harfli görev adı bekler: ${m.template}`, `Linux servers expect lowercase mission names: ${m.template}`, 'missions.rotation'));
    }
  }

  // Headless
  const hc = p.headless;
  if (hc.count > 0) {
    if (!hc.allowedIps.includes(hc.connectIp)) {
      out.push(issue('headless.ipNotAllowed', 'error', `Headless client ${hc.connectIp} adresinden bağlanacak ama bu IP headlessClients[] listesinde yok.`, `Headless clients connect from ${hc.connectIp} but that IP is not in headlessClients[].`, 'headless.allowedIps'));
    }
    if (p.general.maxPlayers + hc.count > 1024) {
      out.push(issue('headless.slots', 'info', 'Headless client\'lar da oyuncu slotu kullanır.', 'Headless clients also use player slots.', 'headless.count'));
    }
  }

  // Modlar
  const modIssues = (list: ServerProfile['launch']['mods'], label: string, path: string) => {
    const seen = new Set<string>();
    for (const mod of list.filter((m) => m.enabled)) {
      if (mod.path.includes(';')) {
        out.push(issue('mods.semicolon', 'error', `${label}: "${mod.path}" yolu ';' içeriyor (Arma mod ayırıcısı).`, `${label}: path "${mod.path}" contains ';' (Arma's mod separator).`, path));
      }
      const key = mod.path.toLowerCase();
      if (seen.has(key)) {
        out.push(issue('mods.duplicate', 'warning', `${label}: "${mod.path}" iki kez eklenmiş.`, `${label}: "${mod.path}" is listed twice.`, path));
      }
      seen.add(key);
      if (os === 'linux' && mod.path !== mod.path.toLowerCase() && !mod.path.startsWith('/')) {
        out.push(issue('mods.linuxCase', 'warning', `Linux sunucusunda mod klasörleri küçük harf olmalı: ${mod.path}`, `Mod folders must be lowercase on Linux: ${mod.path}`, path));
      }
    }
  };
  modIssues(p.launch.mods, 'Modlar', 'launch.mods');
  modIssues(p.launch.serverMods, 'Sunucu modları', 'launch.serverMods');
  const both = p.launch.mods.filter((m) => m.enabled && p.launch.serverMods.some((s) => s.enabled && s.path.toLowerCase() === m.path.toLowerCase()));
  for (const m of both) {
    out.push(issue('mods.inBoth', 'warning', `"${m.path}" hem -mod hem -serverMod listesinde.`, `"${m.path}" is in both -mod and -serverMod.`, 'launch.serverMods'));
  }

  // Ağ / performans
  const bc = p.basic;
  if (bc.minBandwidth > bc.maxBandwidth) {
    out.push(issue('basic.bandwidth', 'error', 'MinBandwidth, MaxBandwidth değerinden büyük olamaz.', 'MinBandwidth cannot be greater than MaxBandwidth.', 'basic.minBandwidth'));
  }
  if (bc.maxSizeGuaranteed > bc.maxPacketSize || bc.maxSizeNonguaranteed > bc.maxPacketSize) {
    out.push(issue('basic.packetSize', 'warning', 'MaxSizeGuaranteed/MaxSizeNonguaranteed, maxPacketSize değerini aşmamalı (desync yapar).', 'MaxSizeGuaranteed/MaxSizeNonguaranteed should not exceed maxPacketSize (causes desync).', 'basic.maxSizeGuaranteed'));
  }
  if (bc.minErrorToSend > 0.1) {
    out.push(issue('basic.minErrorToSend', 'warning', `MinErrorToSend çok yüksek (${bc.minErrorToSend}); uzaktaki birimler takılarak hareket eder. Önerilen 0.001-0.01.`, `MinErrorToSend is very high (${bc.minErrorToSend}); distant units will stutter. Recommended 0.001-0.01.`, 'basic.minErrorToSend'));
  }

  // Ek satırlar sözdizimi
  for (const [text, label, path] of [
    [p.advanced.extraServerCfg, 'server.cfg', 'advanced.extraServerCfg'],
    [p.basic.extraBasicCfg, 'basic.cfg', 'basic.extraBasicCfg'],
  ] as const) {
    try {
      const entries = parseExtraLines(text, label);
      for (const d of findDuplicateNames(entries)) {
        out.push(issue('extra.duplicate', 'warning', `Ek ${label} satırlarında "${d.path}" ${d.count} kez yazılmış; yalnızca sonuncusu kullanılır. Fazlalarını sil.`, `"${d.path}" appears ${d.count} times in the extra ${label} lines; only the last one is used. Remove the others.`, path));
      }
    } catch (err) {
      if (err instanceof ConfigSyntaxError) {
        out.push(issue('extra.syntax', 'error', `Ek ${label} satırlarında hata: ${err.details.map((d) => `satır ${d.line}: ${d.message}`).join('; ')}`, `Error in extra ${label} lines: ${err.details.map((d) => `line ${d.line}: ${d.message}`).join('; ')}`, path));
      }
    }
  }
  for (const [text, path] of [
    [p.launch.extraArgs, 'launch.extraArgs'],
    [p.headless.extraArgs, 'headless.extraArgs'],
  ] as const) {
    try {
      splitArgs(text);
    } catch {
      out.push(issue('extraArgs.quote', 'error', 'Ek parametrelerde kapanmamış tırnak var.', 'Extra parameters contain an unclosed quote.', path));
    }
  }

  // Zamanlayıcı
  if (p.supervisor.scheduledRestarts.length && !(p.rcon.enabled && p.security.battlEye)) {
    out.push(issue('schedule.noRcon', 'info', 'Zamanlı restart uyarıları RCON ile gönderilir; RCON kapalı olduğu için oyuncular uyarılmayacak.', 'Scheduled restart warnings are sent via RCON; players will not be warned because RCON is off.', 'supervisor.scheduledRestarts'));
  }

  // Diğer profillerle port çakışması (aynı makinede)
  const mine = usedPorts(p);
  for (const other of others) {
    if (other.id === p.id || other.hostId !== p.hostId) continue;
    const theirs = new Set(usedPorts(other).map((x) => x.port));
    const clash = mine.filter((x) => theirs.has(x.port)).map((x) => x.port);
    if (clash.length) {
      out.push(issue('ports.clash', 'error', `"${other.name}" ile port çakışması: ${clash.join(', ')}. Sunucular arasında en az 10 port bırak.`, `Port clash with "${other.name}": ${clash.join(', ')}. Leave at least 10 ports between servers.`, 'network.port'));
    }
  }

  return out;
}

export function hasBlockingIssues(issues: Issue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}
