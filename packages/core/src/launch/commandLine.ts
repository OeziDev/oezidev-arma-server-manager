import type { ModRef, ServerProfile } from '../model/profile.js';
import { type HostOs, type ResolvedPaths, resolvePaths } from './paths.js';

/**
 * Komut satırı argümanları DİZİ olarak üretilir; hiçbir zaman tek bir string'e
 * birleştirilip kabukta çalıştırılmaz. Böylece boşluklu yollar ve özel karakterler
 * güvenle geçer (TADST'deki tırnaksız -name/-pid sorunları burada yok).
 */

interface ArgToken {
  value: string;
  /** Ham metindeki başlangıç / bitiş (bitiş hariç) */
  start: number;
  end: number;
  /** Ham token kapanış tırnağıyla mı bitiyor */
  endsQuoted: boolean;
}

/** splitArgs'ın konum bilgili hâli: değiştirilecek tek token'ı ham metinde bulabilmek için. */
function tokenizeArgs(input: string): ArgToken[] {
  const out: ArgToken[] = [];
  let cur = '';
  let inQuote: '"' | "'" | null = null;
  let hasToken = false;
  let start = 0;
  let endsQuoted = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
        endsQuoted = true;
      } else if (ch === '\\' && inQuote === '"' && input[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        cur += ch;
      }
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasToken) {
        out.push({ value: cur, start, end: i, endsQuoted });
        cur = '';
        hasToken = false;
      }
      continue;
    }
    if (!hasToken) {
      start = i;
      hasToken = true;
    }
    endsQuoted = false;
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      continue;
    }
    cur += ch;
  }
  if (inQuote) throw new Error('Ek parametrelerde kapanmamış tırnak var');
  if (hasToken) out.push({ value: cur, start, end: input.length, endsQuoted });
  return out;
}

/** Kullanıcının yazdığı ek parametreleri tırnak kurallarına uyarak böler. */
export function splitArgs(input: string): string[] {
  return tokenizeArgs(input).map((t) => t.value);
}

const SERVERMOD_RE = /^-servermod=/i;

/** Ek parametrelerde -serverMod= var mı (tırnaklar dikkate alınır). */
export function extraArgsHaveServerMod(extraArgs: string): boolean {
  return splitArgs(extraArgs).some((a) => SERVERMOD_RE.test(a));
}

/**
 * Ek parametrelerdeki (son) -serverMod= değerinin sonuna bir mod ekler; ham metnin geri kalanına dokunmaz,
 * tırnaklıysa kapanış tırnağının içine yazar. -serverMod= yoksa null; mod zaten listedeyse metni aynen döndürür.
 */
export function appendServerModToExtraArgs(extraArgs: string, modPath: string): string | null {
  const tokens = tokenizeArgs(extraArgs);
  const t = [...tokens].reverse().find((x) => SERVERMOD_RE.test(x.value));
  if (!t) return null;
  const value = t.value.slice(t.value.indexOf('=') + 1);
  const leaf = (x: string) => x.trim().split(/[\\/]/).filter(Boolean).pop()?.toLowerCase();
  if (value.split(';').some((m) => leaf(m) === leaf(modPath))) return extraArgs;
  // Değer içinde boşluk vb. yoksa ekleme ham metinde tırnaksız güvenle durur
  const add = (value.trim() && !value.trim().endsWith(';') ? ';' : '') + modPath;
  const insertAt = t.endsQuoted ? t.end - 1 : t.end;
  return extraArgs.slice(0, insertAt) + add + extraArgs.slice(insertAt);
}

export function modListArg(mods: ModRef[]): string {
  return mods
    .filter((m) => m.enabled)
    .map((m) => m.path.trim())
    .filter(Boolean)
    .join(';');
}

/** Profil tarafından üretilen ve ek parametrelerle çakışmaması gereken anahtarlar. */
const MANAGED_KEYS = ['port', 'config', 'cfg', 'profiles', 'name', 'mod', 'servermod', 'ip', 'bepath'];

export interface LaunchSpec {
  executable: string;
  args: string[];
  cwd: string;
  /** Bilgi amaçlı uyarılar (ör. ek parametrede yönetilen bir anahtar). */
  warnings: string[];
}

export function buildServerLaunch(profile: ServerProfile, os: HostOs, paths?: ResolvedPaths): LaunchSpec {
  const rp = paths ?? resolvePaths(profile, os);
  const l = profile.launch;
  const warnings: string[] = [];
  const args: string[] = [
    `-port=${profile.network.port}`,
    `-config=${rp.serverCfg}`,
    `-cfg=${rp.basicCfg}`,
    `-profiles=${rp.profilesDir}`,
    `-name=${profile.paths.profileName}`,
  ];
  if (profile.network.bindIp.trim()) args.push(`-ip=${profile.network.bindIp.trim()}`);
  // BattlEye klasörünü açıkça ver: Linux'ta büyük/küçük harf belirsizliği kalmasın, cfg'yi yazdığımız yerden okusun
  if (profile.security.battlEye) args.push(`-bepath=${rp.beDir}`);
  const mods = modListArg(l.mods);
  if (mods) args.push(`-mod=${mods}`);
  const serverMods = modListArg(l.serverMods);
  if (serverMods) args.push(`-serverMod=${serverMods}`);
  if (l.autoInit) args.push('-autoInit');
  if (l.loadMissionToMemory) args.push('-loadMissionToMemory');
  if (l.filePatching) args.push('-filePatching');
  if (l.limitFPS > 0) args.push(`-limitFPS=${l.limitFPS}`);
  if (l.enableHT) args.push('-enableHT');
  if (l.hugepages) args.push('-hugepages');
  if (l.maxMem > 0) args.push(`-maxMem=${l.maxMem}`);
  if (l.cpuCount > 0) args.push(`-cpuCount=${l.cpuCount}`);
  if (l.exThreads > 0) args.push(`-exThreads=${l.exThreads}`);
  if (l.malloc.trim()) args.push(`-malloc=${l.malloc.trim()}`);
  if (l.netlog) args.push('-netlog');
  if (l.noLogs) args.push('-noLogs');

  const extra = splitArgs(l.extraArgs);
  for (const a of extra) {
    const key = /^-([A-Za-z]+)/.exec(a)?.[1]?.toLowerCase();
    if (key && MANAGED_KEYS.includes(key)) {
      warnings.push(`Ek parametre "${a}" uygulamanın yönettiği -${key} değerini geçersiz kılıyor`);
    }
  }
  args.push(...extra);
  return { executable: rp.executable, args, cwd: rp.serverDir, warnings };
}

export function buildHeadlessLaunch(profile: ServerProfile, os: HostOs, index: number, paths?: ResolvedPaths): LaunchSpec {
  const rp = paths ?? resolvePaths(profile, os);
  const hc = profile.headless;
  const args: string[] = [
    '-client',
    `-connect=${hc.connectIp}`,
    `-port=${profile.network.port}`,
    `-profiles=${rp.headlessProfilesDir(index)}`,
    `-name=hc${index}`,
  ];
  if (profile.general.password) args.push(`-password=${profile.general.password}`);
  // HC istemci modlarını yükler; sunucu modlarını (serverMod) değil.
  const mods = modListArg(profile.launch.mods);
  if (mods) args.push(`-mod=${mods}`);
  if (hc.limitFPS > 0) args.push(`-limitFPS=${hc.limitFPS}`);
  args.push(...splitArgs(hc.extraArgs));
  return { executable: rp.executable, args, cwd: rp.serverDir, warnings: [] };
}

/* ------------------------------------------------------------------ */
/* Gösterim / dışa aktarma biçimleri                                   */
/* ------------------------------------------------------------------ */

/**
 * Windows komut satırı kuralı (CommandLineToArgvW uyumlu) ile tek argümanı tırnakla.
 * cmd.exe'nin özel karakterleri (& | < > ^) de tırnaklanır: gösterilen satır .bat dosyasına kopyalanınca bozulmasın.
 * ";" ayırıcı değildir (-mod=@a;@b tırnaksız kalabilir), Türkçe karakterler olduğu gibi geçer.
 */
export function quoteWindowsArg(arg: string): string {
  if (arg !== '' && !/[\s"&|<>^]/.test(arg)) return arg;
  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes++;
      continue;
    }
    if (ch === '"') {
      out += '\\'.repeat(backslashes * 2 + 1) + '"';
    } else {
      out += '\\'.repeat(backslashes) + ch;
    }
    backslashes = 0;
  }
  out += '\\'.repeat(backslashes * 2) + '"';
  return out;
}

/** POSIX kabuğu için tek tırnaklı güvenli argüman. */
export function quotePosixArg(arg: string): string {
  if (arg !== '' && /^[A-Za-z0-9_\-=.,/:@%+]+$/.test(arg)) return arg;
  return "'" + arg.replace(/'/g, `'\\''`) + "'";
}

/** systemd ExecStart= için argüman: çift tırnak, \ ve " kaçışı, % ve $ ikilenir. */
export function quoteSystemdArg(arg: string): string {
  const escaped = arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$');
  if (escaped !== '' && /^[A-Za-z0-9_\-=.,/:@+%$]+$/.test(escaped) && !escaped.includes('\\')) return escaped;
  return `"${escaped}"`;
}

export function formatCommandLine(spec: Pick<LaunchSpec, 'executable' | 'args'>, os: HostOs): string {
  const q = os === 'windows' ? quoteWindowsArg : quotePosixArg;
  return [spec.executable, ...spec.args].map(q).join(' ');
}

/** Gizli bilgileri (şifreler) gösterimden maskele. */
export function maskSecrets(args: string[]): string[] {
  return args.map((a) => (/^-password=/i.test(a) ? '-password=******' : a));
}
