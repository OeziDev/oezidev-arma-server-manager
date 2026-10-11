import type { Host } from '../host/types.js';
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
}

export type SteamCmdFailure =
  | 'guard_required'
  | 'mobile_confirm'
  | 'bad_password'
  | 'password_required'
  | 'rate_limited'
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
}

export class SteamCmdError extends Error {
  constructor(
    message: string,
    readonly failure: SteamCmdFailure,
    readonly output: string[] = [],
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
  no_subscription: 'Bu Steam hesabı gerekli içeriğe sahip değil (Arma 3 sahibi bir hesap gerekir)',
  disk_space: 'Diskte yeterli yer yok',
  disk_write: 'Dosyalar yazılamadı: sunucu çalışırken dosyalar kilitli olabilir ya da izin yok',
  timeout: 'İndirme zaman aşımına uğradı',
  stalled: 'SteamCMD belirlenen sürede bitmedi ve durduruldu',
  aborted: 'İptal edildi',
  not_found: 'SteamCMD bulunamadı',
  missing_libs: 'SteamCMD çalışmadı: 32-bit kütüphaneler eksik olabilir (Debian/Ubuntu: apt install lib32gcc-s1)',
  unknown: 'SteamCMD hatası',
};

export function failureMessage(f: SteamCmdFailure): string {
  return FAILURE_MESSAGES[f];
}

/** SteamCMD çıktısından hata türünü çıkarır. */
export function detectFailure(lines: string[]): SteamCmdFailure | undefined {
  const text = lines.join('\n');
  if (/Two-factor code|Steam Guard code|Account Logon Denied|Invalid Login Auth Code|Two Factor Code Mismatch|AccountLoginDeniedNeedTwoFactor|Account Login Denied/i.test(text)) return 'guard_required';
  if (/confirm the login in the Steam Mobile app|Please confirm the login/i.test(text)) return 'mobile_confirm';
  if (/Invalid Password|InvalidPassword/i.test(text)) return 'bad_password';
  if (/Cached credentials not found|No cached credentials|@NoPromptForPassword|password:\s*$/im.test(text)) return 'password_required';
  if (/Rate Limit Exceeded|RateLimitExceeded/i.test(text)) return 'rate_limited';
  if (/No subscription|\(No subscription\)/i.test(text)) return 'no_subscription';
  if (/Not enough disk space|insufficient disk space/i.test(text)) return 'disk_space';
  if (/disk write failure|Disk write failure|Failed to write file|Access is denied/i.test(text)) return 'disk_write';
  if (/\(Timeout\)|Timeout downloading item/i.test(text)) return 'timeout';
  if (/linux32\/steamcmd: No such file or directory|error while loading shared libraries/i.test(text)) return 'missing_libs';
  if (/^ERROR!|FAILED/m.test(text)) return 'unknown';
  return undefined;
}

const PROGRESS_RE = /Update state \(0x[0-9a-f]+\) ([\w ]+), progress: ([\d.]+)/i;

/** Tek bir steamcmd çağrısı. */
export async function runSteamCmd(ctx: SteamCmdContext, args: string[], opts: { continueOnFailure?: boolean } = {}): Promise<SteamCmdRun> {
  const { host } = ctx;
  if (!(await host.exists(ctx.steamcmdPath))) {
    throw new SteamCmdError(`${failureMessage('not_found')}: ${ctx.steamcmdPath}`, 'not_found');
  }
  const L = pathLib(host.os);
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
  proc.onData((chunk) => {
    partial += chunk;
    const parts = partial.split(/\r\n|\r|\n/);
    partial = parts.pop() ?? '';
    for (const raw of parts) {
      const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
      if (!line) continue;
      output.push(line);
      if (output.length > 5000) output.shift();
      ctx.onLine?.(maskPassword(line, ctx.credentials.password));
      const m = PROGRESS_RE.exec(line);
      if (m) ctx.onProgress?.(Number(m[2]), m[1]!.trim());
    }
    // Şifre / kod istemi satır sonu olmadan gelir
    if (/(Steam Guard code|Two-factor code|password):\s*$/i.test(partial)) {
      output.push(partial.trim());
      partial = '';
      void proc.kill();
    }
  });
  const code = await proc.wait();
  if (timer) clearTimeout(timer);
  ctx.signal?.removeEventListener('abort', onAbort);
  if (partial.trim()) output.push(partial.trim());
  if (ctx.signal?.aborted) return { code, output, failure: 'aborted' };
  if (timedOut) {
    output.push(`[SteamCMD ${Math.round((ctx.timeoutMs ?? 0) / 60000)} dk içinde bitmedi, durduruldu]`);
    return { code, output, failure: detectFailure(output) === 'mobile_confirm' ? 'mobile_confirm' : 'stalled' };
  }
  const failure = detectFailure(output) ?? (code !== 0 ? 'unknown' : undefined);
  return failure ? { code, output, failure } : { code, output };
}

function maskPassword(line: string, password?: string): string {
  return password ? line.split(password).join('******') : line;
}

/**
 * Giriş gerektiren bir SteamCMD işlemi: önbellek -> şifre -> Steam Guard sırasıyla dener.
 * `before` login'den önce gelecek komutlar (force_install_dir), `after` login sonrası komutlar.
 */
export async function runWithLogin(ctx: SteamCmdContext, before: string[], after: string[], opts: { continueOnFailure?: boolean } = {}): Promise<SteamCmdRun> {
  const user = ctx.credentials.username.trim();
  if (!user) throw new SteamCmdError('Steam kullanıcı adı ayarlanmamış', 'password_required');
  if (user === 'anonymous') return runSteamCmd(ctx, [...before, '+login', 'anonymous', ...after], opts);

  let run = await runSteamCmd(ctx, [...before, '+login', user, ...after], opts);
  if (run.failure === 'password_required' && ctx.credentials.password) {
    run = await runSteamCmd(ctx, [...before, '+login', user, ctx.credentials.password, ...after], opts);
  }
  for (let attempt = 0; attempt < 3 && run.failure === 'guard_required'; attempt++) {
    const code = await ctx.askGuardCode?.();
    if (!code) throw new SteamCmdError(failureMessage('guard_required'), 'guard_required', run.output);
    run = await runSteamCmd(ctx, [...before, '+login', user, ctx.credentials.password ?? '', code.trim(), ...after], opts);
  }
  if (run.failure === 'mobile_confirm' || run.failure === 'stalled') {
    throw new SteamCmdError(failureMessage(run.failure), run.failure, run.output);
  }
  if (run.failure === 'password_required') {
    throw new SteamCmdError(failureMessage('password_required'), 'password_required', run.output);
  }
  return run;
}

export interface UpdateServerOptions {
  installDir: string;
  appId?: number;
  branch?: string;
  branchPassword?: string;
  validate?: boolean;
}

/** Arma 3 sunucusunu kur / güncelle. */
export async function updateServer(ctx: SteamCmdContext, o: UpdateServerOptions): Promise<void> {
  const appId = o.appId ?? ARMA3_SERVER_APP_ID;
  const update = ['+app_update', String(appId)];
  if (o.branch && o.branch !== 'public') update.push('-beta', o.branch);
  if (o.branch && o.branch !== 'public' && o.branchPassword) update.push('-betapassword', o.branchPassword);
  if (o.validate) update.push('validate');
  // force_install_dir giriş komutundan ÖNCE gelmeli
  const run = await runWithLogin(ctx, ['+force_install_dir', o.installDir], update);
  const ok = run.output.some((l) => new RegExp(`Success! App '${appId}' (fully installed|already up to date)`, 'i').test(l));
  if (!ok) {
    const f = run.failure ?? 'unknown';
    throw new SteamCmdError(`${failureMessage(f)} (app ${appId})`, f, run.output);
  }
}

export interface WorkshopDownloadResult {
  ok: string[];
  failed: { id: string; failure: SteamCmdFailure; message: string }[];
}

export function workshopContentDir(os: Host['os'], workshopDir: string, id: string, appId = ARMA3_WORKSHOP_APP_ID): string {
  return pathLib(os).join(workshopDir, 'steamapps', 'workshop', 'content', String(appId), id);
}

/**
 * Workshop içeriklerini indir. Büyük modlarda SteamCMD sık sık "Timeout" verir;
 * başarısız olanlar en fazla `retries` kez yeniden denenir.
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
  for (let attempt = 0; attempt <= retries && pending.length; attempt++) {
    const cmds = pending.flatMap((id) => ['+workshop_download_item', appId, id, ...(o.validate ? ['validate'] : [])]);
    const run = await runWithLogin(ctx, ['+force_install_dir', o.workshopDir], cmds, { continueOnFailure: true });
    if (run.failure && ['bad_password', 'rate_limited', 'no_subscription', 'disk_space', 'disk_write', 'aborted', 'missing_libs', 'stalled', 'mobile_confirm'].includes(run.failure)) {
      throw new SteamCmdError(failureMessage(run.failure), run.failure, run.output);
    }
    const next: string[] = [];
    for (const id of pending) {
      if (run.output.some((l) => new RegExp(`Success\\. Downloaded item ${id}\\b`).test(l))) {
        ok.push(id);
      } else {
        const errLine = run.output.find((l) => new RegExp(`item ${id} failed`, 'i').test(l)) ?? '';
        lastFailure.set(id, /Timeout/i.test(errLine) ? 'timeout' : detectFailure([errLine]) ?? 'unknown');
        next.push(id);
      }
    }
    // Bir sonraki denemede aynı mod yine ilk sırada zaman aşımına uğramasın
    pending = next.length > 1 ? [...next.slice(1), next[0]!] : next;
  }
  return {
    ok,
    failed: pending.map((id) => {
      const f = lastFailure.get(id) ?? 'unknown';
      return { id, failure: f, message: failureMessage(f) };
    }),
  };
}

/** Linux: Arma sunucusu ~/.steam/sdk64/steamclient.so ister; yoksa SteamCMD'den kopyalar. */
export async function ensureLinuxSteamClient(host: Host, steamcmdPath: string): Promise<'ok' | 'copied' | 'missing'> {
  if (host.os !== 'linux') return 'ok';
  const dir = pathLib('linux').dirname(steamcmdPath);
  const script = `t="$HOME/.steam/sdk64/steamclient.so"; [ -f "$t" ] && { echo ok; exit 0; }; s="$1/linux64/steamclient.so"; [ -f "$s" ] || { echo missing; exit 0; }; mkdir -p "$HOME/.steam/sdk64" && cp "$s" "$t" && echo copied`;
  const res = await host.exec('sh', ['-c', script, 'sh', dir]);
  const out = res.stdout.trim();
  return out === 'copied' ? 'copied' : out === 'ok' ? 'ok' : 'missing';
}

/** SteamCMD'yi kur (Linux: indirip açar; Windows: PowerShell ile zip açar). */
export async function installSteamCmd(host: Host, dir: string): Promise<string> {
  const L = pathLib(host.os);
  await host.mkdirp(dir);
  if (host.os === 'linux') {
    const script =
      'cd "$1" && (command -v curl >/dev/null && curl -fsSL https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz || wget -qO- https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz) | tar zxf -';
    const res = await host.exec('sh', ['-c', script, 'sh', dir], { timeoutMs: 300_000 });
    if (res.code !== 0) throw new SteamCmdError(`SteamCMD indirilemedi: ${res.stderr.trim()}`, 'unknown');
    return L.join(dir, 'steamcmd.sh');
  }
  const zip = L.join(dir, 'steamcmd.zip');
  const ps = `$ErrorActionPreference='Stop'; Invoke-WebRequest -UseBasicParsing -Uri 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip' -OutFile '${zip.replace(/'/g, "''")}'; Expand-Archive -Force -Path '${zip.replace(/'/g, "''")}' -DestinationPath '${dir.replace(/'/g, "''")}'; Remove-Item '${zip.replace(/'/g, "''")}'`;
  const res = await host.exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeoutMs: 300_000 });
  if (res.code !== 0) throw new SteamCmdError(`SteamCMD indirilemedi: ${res.stderr.trim()}`, 'unknown');
  return L.join(dir, 'steamcmd.exe');
}
