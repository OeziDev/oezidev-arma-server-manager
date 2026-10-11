import type { ExecOptions, Host } from '../host/types.js';
import { pathLib } from '../launch/paths.js';

/**
 * SteamCMD sarmalayıcı: sunucu kurulum/güncelleme ve Workshop indirme.
 *
 * Giriş stratejisi (şifreyi komut satırında mümkün olduğunca az göstermek için):
 *   1) Önce sadece kullanıcı adıyla dene (SteamCMD önceki girişi önbellekte tutar)
 *   2) Olmazsa şifreyle dene
 *   3) Steam Guard kodu istenirse kullanıcıdan al ve kodla tekrar dene
 */

export const ARMA3_SERVER_APP_ID = 233780;
export const ARMA3_WORKSHOP_APP_ID = 107410;

export interface SteamCredentials {
  username: string;
  password?: string;
}

export interface SteamCmdContext {
  host: Host;
  /** steamcmd.exe veya steamcmd.sh yolu */
  steamcmdPath: string;
  credentials: SteamCredentials;
  onLine?: (line: string) => void;
  onProgress?: (percent: number, label: string) => void;
  /** Steam Guard / 2FA kodu iste (iptal için null) */
  askGuardCode?: () => Promise<string | null>;
  signal?: AbortSignal;
  /** Tek bir SteamCMD çağrısı için üst süre (ms). Takılan indirme sunucuyu kapalı tutmasın. */
  timeoutMs?: number;
  /** Günlükte/hata mesajlarında gizlenecek ek değerler (ör. beta şifresi). Steam şifresi her zaman gizlenir. */
  secrets?: string[];
}

export type SteamCmdFailure =
  | 'guard_required'
  | 'mobile_confirm'
  | 'bad_password'
  | 'password_required'
  | 'rate_limited'
  | 'login_failed'
  | 'no_subscription'
  | 'disk_space'
  | 'disk_write'
  | 'timeout'
  | 'stalled'
  | 'aborted'
  | 'not_found'
  | 'missing_libs'
  | 'unknown';

export interface SteamCmdRun {
  code: number | null;
  output: string[];
  failure?: SteamCmdFailure;
  /** Giriş aşamasındaki hata (sonrasında başarılı giriş satırı gelmediyse) */
  loginFailure?: SteamCmdFailure;
}

export class SteamCmdError extends Error {
  constructor(
    message: string,
    readonly failure: SteamCmdFailure,
    readonly output: string[] = [],
    /** Workshop indirmesi yarıda kesildiyse o ana kadar başarılı/başarısız olanlar */
    public partial?: WorkshopDownloadResult,
  ) {
    super(message);
    this.name = 'SteamCmdError';
  }
}

const FAILURE_MESSAGES: Record<SteamCmdFailure, string> = {
  guard_required: 'Steam Guard kodu gerekli',
  mobile_confirm: 'Steam, girişi telefondaki Steam uygulamasından onaylamanı bekliyor; onaylayıp tekrar dene',
  bad_password: 'Steam şifresi yanlış',
  password_required: 'Steam şifresi gerekli (önbellekte giriş yok)',
  rate_limited: 'Steam çok fazla deneme yapıldığı için geçici olarak engelledi; biraz bekle',
  login_failed: 'Steam girişi başarısız',
  no_subscription: 'Bu Steam hesabı gerekli içeriğe sahip değil (Arma 3 sahibi bir hesap gerekir)',
  disk_space: 'Diskte yeterli yer yok',
  disk_write: 'Dosyalar yazılamadı: sunucu çalışırken dosyalar kilitli olabilir ya da izin yok',
  timeout: 'İndirme zaman aşımına uğradı',
  stalled: 'SteamCMD belirlenen sürede bitmedi ve durduruldu',
  aborted: 'İptal edildi',
  not_found: 'SteamCMD bulunamadı',
  missing_libs:
    'SteamCMD çalışmadı: 32-bit kütüphaneler eksik (Debian/Ubuntu: sudo dpkg --add-architecture i386 && sudo apt update && sudo apt install lib32gcc-s1 lib32stdc++6)',
  unknown: 'SteamCMD hatası',
};

export function failureMessage(f: SteamCmdFailure): string {
  return FAILURE_MESSAGES[f];
}

/** Giriş aşamasıyla ilgili (yeniden denemenin anlamsız olduğu) hatalar */
export const LOGIN_FAILURES: readonly SteamCmdFailure[] = ['guard_required', 'mobile_confirm', 'bad_password', 'password_required', 'rate_limited', 'login_failed'];

/* ---------------- Çıktı çözümleme ---------------- */

/** SteamCMD "+@Ayar değer" komutlarını geri yazar: "@NoPromptForPassword" = "1" — bunlar hata değildir. */
const SETTING_ECHO_RE = /^"@?[\w.]+"\s*=\s*"/;
const LOGIN_START_RE = /Logging in user\b|Logging in using/i;
/** Giriş başarılı (ya da işin kendisi başarılı; giriş olmadan başarı olmaz) */
const LOGIN_OK_RE =
  /Waiting for user info\.\.\.\s*OK|Logged in OK|to Steam Public\.\.\.\s*OK\b|Waiting for confirmation\.\.\.\s*OK|Success!? App '\d+' (fully installed|already up to date)|Success\.? Downloaded item \d+/i;
/** Giriş aşamasındaki hata satırları; sıra öncelik sırasıdır. */
const LOGIN_FAILS: [RegExp, SteamCmdFailure][] = [
  [/Rate Limit Exceeded|RateLimitExceeded/i, 'rate_limited'],
  [/Invalid Password|InvalidPassword/i, 'bad_password'],
  [
    /Two-factor code|Two Factor Code|TwoFactorCodeMismatch|Steam Guard code|Invalid Login Auth Code|InvalidLoginAuthCode|Account Logon Denied|AccountLogonDenied|AccountLoginDeniedNeedTwoFactor|Account Login Denied|not been authenticated for your account using Steam Guard/i,
    'guard_required',
  ],
  [/confirm the login in the Steam Mobile app|Please confirm the login|^Waiting for confirmation\.\.\.\s*$/i, 'mobile_confirm'],
  [/Cached credentials not found|No cached credentials|^password:\s*$/i, 'password_required'],
];
const LOGIN_GENERIC_FAIL_RE = /Login Failure|FAILED login|^FAILED\b|\.\.\.\s*FAILED\b/i;
const JOB_FAILS: [RegExp, SteamCmdFailure][] = [
  [/No subscription/i, 'no_subscription'],
  [/Not enough disk space|insufficient disk space/i, 'disk_space'],
  [/disk write failure|Failed to write file|Access is denied/i, 'disk_write'],
  [/\(Timeout\)|Timeout downloading item/i, 'timeout'],
  [/linux32\/steamcmd: No such file or directory|error while loading shared libraries|cannot open shared object file/i, 'missing_libs'],
  [/^ERROR!|FAILED/m, 'unknown'],
];

export interface SteamCmdAnalysis {
  /** Giriş aşaması hatası; sonrasında başarılı giriş/iş satırı geldiyse yok sayılır */
  loginFailure?: SteamCmdFailure;
  /** Giriş (ya da işin kendisi) başarıyla sonuçlandı mı */
  loggedIn: boolean;
  /** Giriş dışındaki ilk iş hatası */
  jobFailure?: SteamCmdFailure;
}

/** SteamCMD çıktısını giriş aşaması ve iş aşaması olarak çözümler. */
export function analyzeSteamCmdOutput(lines: string[]): SteamCmdAnalysis {
  let lastSuccess = -1;
  let inLogin = false;
  const loginFails: { idx: number; failure: SteamCmdFailure }[] = [];
  const jobLines: string[] = [];
  lines.forEach((raw, idx) => {
    const line = raw.trim();
    if (!line || SETTING_ECHO_RE.test(line)) return;
    if (LOGIN_START_RE.test(line)) inLogin = true;
    if (LOGIN_OK_RE.test(line) || (inLogin && /^OK\.?$/i.test(line))) {
      lastSuccess = idx;
      inLogin = false;
      // "Success. Downloaded item" gibi iş satırları iş sonuçlarına da girer
      jobLines.push(line);
      return;
    }
    const specific = LOGIN_FAILS.find(([re]) => re.test(line));
    if (specific) {
      loginFails.push({ idx, failure: specific[1] });
      return;
    }
    if ((inLogin || LOGIN_START_RE.test(line)) && LOGIN_GENERIC_FAIL_RE.test(line)) {
      loginFails.push({ idx, failure: 'login_failed' });
      return;
    }
    jobLines.push(line);
  });
  const active = loginFails.filter((f) => f.idx > lastSuccess).map((f) => f.failure);
  const order: SteamCmdFailure[] = [...LOGIN_FAILS.map(([, f]) => f), 'login_failed'];
  const loginFailure = order.find((f) => active.includes(f));
  const jobText = jobLines.join('\n');
  const jobFailure = JOB_FAILS.find(([re]) => re.test(jobText))?.[1];
  return { loggedIn: lastSuccess >= 0, ...(loginFailure ? { loginFailure } : {}), ...(jobFailure ? { jobFailure } : {}) };
}

/** SteamCMD çıktısından hata türünü çıkarır (önce giriş, sonra iş hataları). */
export function detectFailure(lines: string[]): SteamCmdFailure | undefined {
  const a = analyzeSteamCmdOutput(lines);
  return a.loginFailure ?? a.jobFailure;
}

/** Şifre ve benzeri gizli değerleri metinden maskele (uzun olan önce). */
export function maskSteamSecrets(text: string, secrets: (string | undefined)[]): string {
  const list = [...new Set(secrets.filter((s): s is string => !!s))].sort((a, b) => b.length - a.length);
  let out = text;
  for (const s of list) out = out.split(s).join('******');
  return out;
}

function ctxSecrets(ctx: SteamCmdContext): string[] {
  return [ctx.credentials.password ?? '', ...(ctx.secrets ?? [])].filter(Boolean);
}

/** Hata nesnesine konacak çıktı: gizli değerler maskelenmiş */
function maskedOutput(ctx: SteamCmdContext, output: string[]): string[] {
  const secrets = ctxSecrets(ctx);
  return secrets.length ? output.map((l) => maskSteamSecrets(l, secrets)) : output;
}

/** Komut satırını günlüğe yazmak için: şifreler maskelenmiş argümanlar */
export function maskSteamCmdArgs(args: string[], secrets: (string | undefined)[]): string[] {
  const list = secrets.filter((s): s is string => !!s);
  return args.map((a, i) => {
    if (list.includes(a)) return '******';
    if (i > 0 && /^-betapassword$/i.test(args[i - 1]!)) return '******';
    return maskSteamSecrets(a, list);
  });
}

const PROGRESS_RE = /Update state \(0x[0-9a-f]+\) ([\w ]+), progress: ([\d.]+)/i;

/** Tek bir steamcmd çağrısı. */
export async function runSteamCmd(ctx: SteamCmdContext, args: string[], opts: { continueOnFailure?: boolean } = {}): Promise<SteamCmdRun> {
  const { host } = ctx;
  if (!(await host.exists(ctx.steamcmdPath))) {
    throw new SteamCmdError(`${failureMessage('not_found')}: ${ctx.steamcmdPath}`, 'not_found');
  }
  const L = pathLib(host.os);
  const secrets = ctxSecrets(ctx);
  // Workshop'ta bir mod başarısız olunca kalanlar da denensin (continueOnFailure)
  const fullArgs = ['+@ShutdownOnFailedCommand', opts.continueOnFailure ? '0' : '1', '+@NoPromptForPassword', '1', ...args, '+quit'];
  // stdin kapatılır: istem bekleyen SteamCMD EOF alıp çıkar, sonsuza kadar asılı kalmaz
  const proc = host.spawn(ctx.steamcmdPath, fullArgs, { cwd: L.dirname(ctx.steamcmdPath), closeStdin: true });
  let timedOut = false;
  const timer = ctx.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        void proc.kill();
      }, ctx.timeoutMs)
    : null;
  const output: string[] = [];
  let partial = '';
  const onAbort = () => void proc.kill();
  ctx.signal?.addEventListener('abort', onAbort, { once: true });
  if (ctx.signal?.aborted) onAbort();
  proc.onData((chunk) => {
    partial += chunk;
    const parts = partial.split(/\r\n|\r|\n/);
    partial = parts.pop() ?? '';
    for (const raw of parts) {
      const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
      if (!line) continue;
      output.push(line);
      if (output.length > 5000) output.shift();
      ctx.onLine?.(maskSteamSecrets(line, secrets));
      const m = PROGRESS_RE.exec(line);
      if (m) ctx.onProgress?.(Number(m[2]), m[1]!.trim());
    }
    // Şifre / kod istemi satır sonu olmadan gelir
    if (/(Steam Guard code|Two-factor code|password):\s*$/i.test(partial)) {
      output.push(partial.trim());
      ctx.onLine?.(maskSteamSecrets(partial.trim(), secrets));
      partial = '';
      void proc.kill();
    }
  });
  const code = await proc.wait();
  if (timer) clearTimeout(timer);
  ctx.signal?.removeEventListener('abort', onAbort);
  if (partial.trim()) output.push(partial.trim());
  const a = analyzeSteamCmdOutput(output);
  const login = a.loginFailure ? { loginFailure: a.loginFailure } : {};
  if (ctx.signal?.aborted) return { code, output, failure: 'aborted', ...login };
  if (timedOut) {
    output.push(`[SteamCMD ${Math.round((ctx.timeoutMs ?? 0) / 60000)} dk içinde bitmedi, durduruldu]`);
    return { code, output, failure: a.loginFailure === 'mobile_confirm' ? 'mobile_confirm' : 'stalled', ...login };
  }
  const failure = a.loginFailure ?? a.jobFailure ?? (code !== 0 ? 'unknown' : undefined);
  return failure ? { code, output, failure, ...login } : { code, output };
}

/**
 * Giriş gerektiren bir SteamCMD işlemi: önbellek -> şifre -> Steam Guard sırasıyla dener.
 * `before` login'den önce gelecek komutlar (force_install_dir), `after` login sonrası komutlar.
 * Giriş başarısız olursa (şifre, Steam Guard, telefon onayı, deneme sınırı) SteamCmdError fırlatır.
 */
export async function runWithLogin(ctx: SteamCmdContext, before: string[], after: string[], opts: { continueOnFailure?: boolean } = {}): Promise<SteamCmdRun> {
  const user = ctx.credentials.username.trim();
  if (!user) throw new SteamCmdError('Steam kullanıcı adı ayarlanmamış', 'password_required');
  const fail = (run: SteamCmdRun, f: SteamCmdFailure): never => {
    throw new SteamCmdError(failureMessage(f), f, maskedOutput(ctx, run.output));
  };
  if (user === 'anonymous') {
    const run = await runSteamCmd(ctx, [...before, '+login', 'anonymous', ...after], opts);
    if (run.failure !== 'aborted' && run.loginFailure) fail(run, run.loginFailure);
    return run;
  }

  let run = await runSteamCmd(ctx, [...before, '+login', user, ...after], opts);
  // Şifre gönderilmeden alınan "yanlış şifre" de aslında "şifre gerekli" demektir
  if (run.failure !== 'aborted' && (run.loginFailure === 'password_required' || run.loginFailure === 'bad_password')) {
    if (!ctx.credentials.password) fail(run, 'password_required');
    run = await runSteamCmd(ctx, [...before, '+login', user, ctx.credentials.password!, ...after], opts);
  }
  for (let attempt = 0; attempt < 3 && run.failure !== 'aborted' && run.loginFailure === 'guard_required'; attempt++) {
    const code = await ctx.askGuardCode?.();
    if (!code) fail(run, 'guard_required');
    run = await runSteamCmd(ctx, [...before, '+login', user, ctx.credentials.password ?? '', code!.trim(), ...after], opts);
  }
  if (run.failure !== 'aborted' && run.loginFailure) fail(run, run.loginFailure);
  return run;
}

export interface UpdateServerOptions {
  installDir: string;
  appId?: number;
  branch?: string;
  branchPassword?: string;
  validate?: boolean;
}

/** app_update argümanları. "-beta public" her zaman verilir: betadan public'e dönüş ancak böyle olur. */
export function appUpdateArgs(o: Omit<UpdateServerOptions, 'installDir'>): string[] {
  const appId = o.appId ?? ARMA3_SERVER_APP_ID;
  const branch = o.branch?.trim() || 'public';
  const update = ['+app_update', String(appId), '-beta', branch];
  if (branch !== 'public' && o.branchPassword) update.push('-betapassword', o.branchPassword);
  if (o.validate) update.push('validate');
  return update;
}

/** Arma 3 sunucusunu kur / güncelle. */
export async function updateServer(ctx: SteamCmdContext, o: UpdateServerOptions): Promise<void> {
  const appId = o.appId ?? ARMA3_SERVER_APP_ID;
  const c: SteamCmdContext = o.branchPassword ? { ...ctx, secrets: [...(ctx.secrets ?? []), o.branchPassword] } : ctx;
  // force_install_dir giriş komutundan ÖNCE gelmeli
  const run = await runWithLogin(c, ['+force_install_dir', o.installDir], appUpdateArgs(o));
  const ok = run.output.some((l) => new RegExp(`Success! App '${appId}' (fully installed|already up to date)`, 'i').test(l));
  if (!ok) {
    const f = run.failure ?? 'unknown';
    throw new SteamCmdError(`${failureMessage(f)} (app ${appId})`, f, maskedOutput(c, run.output));
  }
}

export interface WorkshopDownloadResult {
  ok: string[];
  failed: { id: string; failure: SteamCmdFailure; message: string }[];
  /** Yeniden denemeyi anlamsız kılan toplu hata (disk dolu, SteamCMD takıldı...); varsa kalanlar denenmedi */
  stoppedBy?: { failure: SteamCmdFailure; message: string };
}

export function workshopContentDir(os: Host['os'], workshopDir: string, id: string, appId = ARMA3_WORKSHOP_APP_ID): string {
  return pathLib(os).join(workshopDir, 'steamapps', 'workshop', 'content', String(appId), id);
}

/** Bu hatalarda aynı modları yeniden denemek işe yaramaz */
const NO_RETRY: readonly SteamCmdFailure[] = ['no_subscription', 'disk_space', 'disk_write', 'missing_libs', 'stalled'];

/**
 * Workshop içeriklerini indir. Büyük modlarda SteamCMD sık sık "Timeout" verir;
 * başarısız olanlar en fazla `retries` kez yeniden denenir.
 * Toplu hatalarda (disk dolu, takılma) başarılı olanlar yine `ok` içinde döner; sadece giriş
 * hatalarında ve iptalde SteamCmdError fırlatılır (o ana kadarki sonuç `err.partial` içinde).
 */
export async function downloadWorkshopItems(
  ctx: SteamCmdContext,
  o: { workshopDir: string; ids: string[]; validate?: boolean; retries?: number; appId?: number },
): Promise<WorkshopDownloadResult> {
  const appId = String(o.appId ?? ARMA3_WORKSHOP_APP_ID);
  let pending = [...new Set(o.ids.filter((id) => /^\d+$/.test(id)))];
  const ok: string[] = [];
  const lastFailure = new Map<string, SteamCmdFailure>();
  const retries = o.retries ?? 3;
  let stoppedBy: SteamCmdFailure | undefined;
  const result = (fallback?: SteamCmdFailure): WorkshopDownloadResult => ({
    ok: [...ok],
    failed: pending.map((id) => {
      const f = lastFailure.get(id) ?? fallback ?? 'unknown';
      return { id, failure: f, message: failureMessage(f) };
    }),
    ...(stoppedBy ? { stoppedBy: { failure: stoppedBy, message: failureMessage(stoppedBy) } } : {}),
  });
  for (let attempt = 0; attempt <= retries && pending.length; attempt++) {
    const cmds = pending.flatMap((id) => ['+workshop_download_item', appId, id, ...(o.validate ? ['validate'] : [])]);
    let run: SteamCmdRun;
    try {
      run = await runWithLogin(ctx, ['+force_install_dir', o.workshopDir], cmds, { continueOnFailure: true });
    } catch (err) {
      if (err instanceof SteamCmdError) err.partial = result(err.failure);
      throw err;
    }
    const next: string[] = [];
    const batch = run.failure && NO_RETRY.includes(run.failure) ? run.failure : undefined;
    for (const id of pending) {
      if (run.output.some((l) => new RegExp(`Success\\. Downloaded item ${id}\\b`).test(l))) {
        ok.push(id);
      } else {
        const errLine = run.output.find((l) => new RegExp(`item ${id} failed`, 'i').test(l));
        const f = errLine ? (/Timeout/i.test(errLine) ? 'timeout' : detectFailure([errLine]) ?? 'unknown') : batch ?? (run.failure === 'aborted' ? 'aborted' : 'unknown');
        lastFailure.set(id, f);
        next.push(id);
      }
    }
    if (run.failure === 'aborted') {
      pending = next;
      throw new SteamCmdError(failureMessage('aborted'), 'aborted', maskedOutput(ctx, run.output), result('aborted'));
    }
    if (batch) {
      pending = next;
      stoppedBy = batch;
      break;
    }
    // Bir sonraki denemede aynı mod yine ilk sırada zaman aşımına uğramasın
    pending = next.length > 1 ? [...next.slice(1), next[0]!] : next;
  }
  return result();
}

/* ---------------- Linux steamclient.so ---------------- */

const LINUX_USER_RE = /^[a-z_][a-z0-9_.-]*\$?$/i;

/**
 * Linux: Arma sunucusu ~/.steam/sdk64/steamclient.so ister; yoksa SteamCMD'den kopyalar.
 * `user` verilirse (sunucu başka bir Linux kullanıcısıyla çalışıyorsa) o kullanıcının ev klasörüne
 * kopyalanır ve sahipliği ona verilir (gerekirse sudo ile).
 */
export async function ensureLinuxSteamClient(host: Host, steamcmdPath: string, user?: string): Promise<'ok' | 'copied' | 'missing'> {
  if (host.os !== 'linux') return 'ok';
  const dir = pathLib('linux').dirname(steamcmdPath);
  let res;
  if (user) {
    if (!LINUX_USER_RE.test(user)) throw new Error(`Geçersiz Linux kullanıcı adı: ${user}`);
    const script = `s="$1/linux64/steamclient.so"; u="$2"
h=$(getent passwd "$u" | cut -d: -f6)
[ -n "$h" ] || { echo nouser; exit 0; }
t="$h/.steam/sdk64/steamclient.so"
[ -f "$t" ] && { echo ok; exit 0; }
[ -f "$s" ] || { echo missing; exit 0; }
g=$(id -gn "$u" 2>/dev/null) || g=""
mkdir -p "$h/.steam/sdk64" && cp "$s" "$t" && chown "$u\${g:+:$g}" "$h/.steam" "$h/.steam/sdk64" "$t" && echo copied`;
    res = await host.exec('sh', ['-c', script, 'sh', dir, user], { privileged: true } as ExecOptions);
    if (res.stdout.trim() === 'nouser') throw new Error(`Linux kullanıcısı bulunamadı: ${user}`);
  } else {
    const script = `t="$HOME/.steam/sdk64/steamclient.so"; [ -f "$t" ] && { echo ok; exit 0; }; s="$1/linux64/steamclient.so"; [ -f "$s" ] || { echo missing; exit 0; }; mkdir -p "$HOME/.steam/sdk64" && cp "$s" "$t" && echo copied`;
    res = await host.exec('sh', ['-c', script, 'sh', dir]);
  }
  const out = res.stdout.trim();
  if (out === 'copied' || out === 'ok' || out === 'missing') return out;
  throw new Error(`steamclient.so kopyalanamadı${user ? ` (${user})` : ''}: ${res.stderr.trim() || `çıkış kodu ${res.code}`}`);
}

/* ---------------- SteamCMD kurulumu ---------------- */

const STEAMCMD_LINUX_URL = 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz';
const STEAMCMD_WINDOWS_URL = 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip';

/** PowerShell tek tırnaklı dize */
function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** SteamCMD'yi kur (Linux: indirip açar; Windows: PowerShell ile zip açar). İlk çalıştırma için firstRunSteamCmd. */
export async function installSteamCmd(host: Host, dir: string): Promise<string> {
  const L = pathLib(host.os);
  await host.mkdirp(dir);
  if (host.os === 'linux') {
    const script = `cd "$1" || exit 1
if command -v curl >/dev/null 2>&1; then curl -fsSL "$2" -o steamcmd_linux.tar.gz; else wget -q -O steamcmd_linux.tar.gz "$2"; fi || exit 1
tar zxf steamcmd_linux.tar.gz && rm -f steamcmd_linux.tar.gz`;
    const res = await host.exec('sh', ['-c', script, 'sh', dir, STEAMCMD_LINUX_URL], { timeoutMs: 300_000 });
    const path = L.join(dir, 'steamcmd.sh');
    if (res.code !== 0 || !(await host.exists(path))) throw new SteamCmdError(`SteamCMD indirilemedi: ${res.stderr.trim() || `çıkış kodu ${res.code}`}`, 'unknown');
    return path;
  }
  const zip = L.join(dir, 'steamcmd.zip');
  // Eski Windows/PowerShell 5.1 varsayılan olarak TLS 1.2 kullanmayabilir; yollarda [ ] olabilir (-LiteralPath)
  const ps = [
    `$ErrorActionPreference='Stop'`,
    `[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12`,
    `$zip = ${psQuote(zip)}`,
    `$dir = ${psQuote(dir)}`,
    `(New-Object Net.WebClient).DownloadFile(${psQuote(STEAMCMD_WINDOWS_URL)}, $zip)`,
    `Expand-Archive -Force -LiteralPath $zip -DestinationPath $dir`,
    `Remove-Item -LiteralPath $zip -Force`,
  ].join('; ');
  const res = await host.exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeoutMs: 300_000 });
  if (res.code !== 0) throw new SteamCmdError(`SteamCMD indirilemedi: ${res.stderr.trim()}`, 'unknown');
  return L.join(dir, 'steamcmd.exe');
}

/**
 * SteamCMD'nin ilk çalıştırması (kendini günceller, "+quit" ile çıkar).
 * stdin kapalı, süre sınırlı (varsayılan 10 dk), iptal edilebilir. Linux'ta eksik 32-bit
 * kütüphaneleri anlaşılır bir hata olarak bildirir.
 */
export async function firstRunSteamCmd(
  host: Host,
  steamcmdPath: string,
  opts: { signal?: AbortSignal; timeoutMs?: number; onLine?: (line: string) => void } = {},
): Promise<void> {
  if (!(await host.exists(steamcmdPath))) throw new SteamCmdError(`${failureMessage('not_found')}: ${steamcmdPath}`, 'not_found');
  const L = pathLib(host.os);
  const proc = host.spawn(steamcmdPath, ['+quit'], { cwd: L.dirname(steamcmdPath), closeStdin: true });
  const timeoutMs = opts.timeoutMs ?? 600_000;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void proc.kill();
  }, timeoutMs);
  const onAbort = () => void proc.kill();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  if (opts.signal?.aborted) onAbort();
  const output: string[] = [];
  let partial = '';
  proc.onData((chunk) => {
    partial += chunk;
    const parts = partial.split(/\r\n|\r|\n/);
    partial = parts.pop() ?? '';
    for (const raw of parts) {
      const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
      if (!line) continue;
      output.push(line);
      if (output.length > 2000) output.shift();
      opts.onLine?.(line);
    }
  });
  const code = await proc.wait();
  clearTimeout(timer);
  opts.signal?.removeEventListener('abort', onAbort);
  if (partial.trim()) {
    output.push(partial.trim());
    opts.onLine?.(partial.trim());
  }
  if (opts.signal?.aborted) throw new SteamCmdError(failureMessage('aborted'), 'aborted', output);
  const text = output.join('\n');
  if (/linux32\/steamcmd: No such file or directory|error while loading shared libraries|cannot open shared object file/i.test(text)) {
    throw new SteamCmdError(failureMessage('missing_libs'), 'missing_libs', output);
  }
  if (timedOut) throw new SteamCmdError(`SteamCMD ilk çalıştırması ${Math.round(timeoutMs / 60000)} dk içinde bitmedi ve durduruldu`, 'stalled', output);
  if (code !== 0) {
    // SteamCMD bazen başarılı çıkışta da 0 dışı kod verir; çalıştığına dair iz yoksa hata say
    const ran = /Steam Console Client|Loading Steam API|Steam>|Update complete|Verifying installation|Checking for available update/i.test(text);
    if (!ran) {
      const f = detectFailure(output) ?? 'unknown';
      throw new SteamCmdError(`SteamCMD ilk çalıştırması başarısız (çıkış kodu ${code}): ${failureMessage(f)}`, f, output);
    }
  }
}
