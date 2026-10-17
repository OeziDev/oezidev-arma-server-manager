/**
 * Zamanlı / elle yedekleme.
 *
 * Sadece Host arayüzü kullanılır: yerel Windows, yerel Linux ve SSH ile bağlanılan Linux VPS'te aynı kod çalışır.
 * - Windows: PowerShell + System.IO.Compression.ZipArchive (.zip). Dosyalar FileShare.ReadWrite ile açılır:
 *   sunucunun açık tuttuğu RPT / veritabanı dosyaları yedeği bozmaz, okunamayan dosya atlanır ve sebebi raporlanır.
 * - Linux: GNU tar + gzip (.tar.gz). Farklı köklerdeki öğeler geçici bir "staging" klasöründeki sembolik
 *   bağlantılar üzerinden tek arşive, düzgün adlarla (profile/, missions/ ...) girer.
 * Arşiv önce `<ad>.partial` olarak yazılır, bitince yeniden adlandırılır: yarıda kalan yedek tamamlanmış görünmez.
 */
import type { Host, StreamingProcess } from '../host/types.js';
import { LineSplitter } from '../host/types.js';
import { pathLib, resolvePaths, trimTrailingSep, type HostOs } from '../launch/paths.js';
import { slugify, type ServerProfile } from '../model/profile.js';
import { nextOccurrence } from '../supervisor/scheduler.js';

export interface BackupOptions {
  signal?: AbortSignal;
  /** İlerleme / uyarı satırları (arayüzdeki yedek günlüğü için) */
  onLine?: (line: string) => void;
  /** Dosya adındaki zaman damgası (testler için) */
  now?: Date;
}

export interface BackupSkip {
  path: string;
  reason: string;
}

export interface BackupResult {
  /** Tamamlanmış arşivin tam yolu */
  file: string;
  sizeBytes: number;
  /** Arşive giren öğelerin arşiv içindeki adları (profile, missions, database/x.sql ...) */
  included: string[];
  skipped: BackupSkip[];
  databaseDumped: boolean;
  durationMs: number;
}

export interface BackupFileInfo {
  file: string;
  name: string;
  sizeBytes: number;
  /** Unix ms (dosya adındaki zaman damgası, yoksa değiştirilme zamanı) */
  createdAt: number;
}

/** Arşive girecek bir öğe: kaynak yol + arşiv içindeki ad. */
export interface BackupItem {
  source: string;
  /** Arşiv içindeki ad, "/" ile (ör. "profile", "extra/1-Görev Dosyaları", "database/altislife.sql") */
  name: string;
  isDir: boolean;
  /** Dosya adı desenleri (sadece bu öğenin içinde uygulanır), ör. "*.rpt" */
  exclude: string[];
  /** Bu öğenin altında atlanacak klasörler (mutlak yol; ör. yedek klasörünün kendisi) */
  excludeDirs: string[];
}

/** Profil klasöründen yedeğe alınmayan dosyalar (loglar ve çökme dökümleri) */
export const PROFILE_EXCLUDES = ['*.rpt', '*.log', '*.mdmp', '*.bidmp'];

export class BackupAbortedError extends Error {
  constructor() {
    super('Yedekleme iptal edildi');
    this.name = 'AbortError';
  }
}

/* ---------------- adlandırma ---------------- */

/** Profil id'sinden kısa, kararlı kimlik (defaultProfilesDir ile aynı kural). */
export function profileShortId(profile: Pick<ServerProfile, 'id'>): string {
  return profile.id.replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toLowerCase() || 'default';
}

/**
 * Yedek klasörü: backup.targetDir (mutlak ya da sunucu klasörüne göre), boşsa
 * `<sunucu klasörünün üstü>/oezi-backups/<id8>`. Profil adı değişse de klasör değişmesin diye id kullanılır.
 */
/**
 * Windows: klasör "Program Files" altında mı (büyük/küçük harf duyarsız). Oraya yazmak yönetici izni ister,
 * UAC sanallaştırması yüzünden dosyalar başka yerde görünebilir: kullanıcı uyarılır.
 */
export function isUnderProgramFiles(dir: string, os: HostOs): boolean {
  if (os !== 'windows') return false;
  return /^(?:[a-z]:)?\\program files(?: \(x86\))?(?:\\|$)/i.test(pathLib(os).normalize(dir.trim()));
}

export function resolveBackupDir(profile: ServerProfile, os: HostOs): string {
  const p = pathLib(os);
  const { serverDir } = resolvePaths(profile, os);
  const setting = profile.backup.targetDir.trim();
  if (setting) return trimTrailingSep(os, p.isAbsolute(setting) ? setting : p.join(serverDir, setting));
  return p.join(p.dirname(serverDir), 'oezi-backups', profileShortId(profile));
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** YYYYMMDD-HHmmss (yerel saat) */
export function backupStamp(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function backupExtension(os: HostOs): '.zip' | '.tar.gz' {
  return os === 'windows' ? '.zip' : '.tar.gz';
}

/**
 * Yedek dosya adı: `oezi-backup-<profil slug>-<id8>-YYYYMMDD-HHmmss.zip|.tar.gz`.
 * id8 sayesinde aynı hedef klasörü paylaşan iki profilin yedekleri karışmaz (budama başkasının yedeğini silmez),
 * profil yeniden adlandırılsa da eski yedekler listelenmeye devam eder.
 */
export function backupFileName(profile: Pick<ServerProfile, 'id' | 'name'>, os: HostOs, now: Date, suffix = 0): string {
  const id8 = profileShortId(profile);
  let slug = slugify(profile.name);
  if (slug === id8) slug = '';
  return `oezi-backup-${slug ? `${slug}-` : ''}${id8}-${backupStamp(now)}${suffix > 0 ? `-${suffix}` : ''}${backupExtension(os)}`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Bu profilin yedek dosyası adı mı? (.partial ve başka profillerin yedekleri hariç) */
export function backupNamePattern(profile: Pick<ServerProfile, 'id'>): RegExp {
  const id8 = escapeRegex(profileShortId(profile));
  return new RegExp(`^oezi-backup-(?:[a-z0-9-]+-)?${id8}-(\\d{8})-(\\d{6})(?:-(\\d+))?\\.(?:zip|tar\\.gz)$`, 'i');
}

function stampToMs(date: string, time: string): number {
  const d = new Date(
    Number(date.slice(0, 4)),
    Number(date.slice(4, 6)) - 1,
    Number(date.slice(6, 8)),
    Number(time.slice(0, 2)),
    Number(time.slice(2, 4)),
    Number(time.slice(4, 6)),
  );
  return d.getTime();
}

/** Bir sonraki zamanlı yedek (günlük "HH:MM" listesi, yerel saat). */
export function nextBackupTime(times: string[], now: Date): Date | null {
  return nextOccurrence(times, now);
}

/* ---------------- listeleme / budama / silme ---------------- */

export async function listBackups(host: Host, profile: ServerProfile): Promise<BackupFileInfo[]> {
  const os = host.os;
  const p = pathLib(os);
  const dir = resolveBackupDir(profile, os);
  if (!(await host.exists(dir))) return [];
  const re = backupNamePattern(profile);
  const out: (BackupFileInfo & { order: number })[] = [];
  for (const e of await host.list(dir)) {
    if (e.isDir) continue;
    const m = re.exec(e.name);
    if (!m) continue;
    const t = stampToMs(m[1]!, m[2]!);
    out.push({
      file: p.join(dir, e.name),
      name: e.name,
      sizeBytes: e.size,
      createdAt: Number.isFinite(t) ? t : e.mtimeMs,
      order: Number(m[3] ?? 0),
    });
  }
  out.sort((a, b) => b.createdAt - a.createdAt || b.order - a.order || b.name.localeCompare(a.name));
  return out.map(({ order: _o, ...rest }) => rest);
}

/** Yarıda kalmış .partial dosyaları bu kadar eskiyse budamada silinir */
const STALE_PARTIAL_MS = 24 * 3600_000;

/**
 * En yeni `keep` yedek dışındakileri siler (sadece bu profilin adlandırmasına uyan dosyalar).
 * Bir günden eski, yarıda kalmış `.partial` dosyaları da temizlenir. Silinen yolları döner.
 */
export async function pruneBackups(host: Host, profile: ServerProfile, keep: number): Promise<string[]> {
  const removed: string[] = [];
  const all = await listBackups(host, profile);
  const k = Math.max(0, Math.floor(keep));
  for (const b of all.slice(k)) {
    await host.remove(b.file);
    removed.push(b.file);
  }
  const dir = resolveBackupDir(profile, host.os);
  const re = backupNamePattern(profile);
  const now = Date.now();
  for (const e of (await host.exists(dir)) ? await host.list(dir) : []) {
    if (e.isDir || !e.name.endsWith('.partial')) continue;
    if (!re.test(e.name.slice(0, -'.partial'.length))) continue;
    if (e.mtimeMs > 0 && now - e.mtimeMs < STALE_PARTIAL_MS) continue;
    const f = pathLib(host.os).join(dir, e.name);
    await host.remove(f).catch(() => undefined);
    removed.push(f);
  }
  return removed;
}

/** Tek bir yedeği siler; dosya yedek klasöründe değilse ya da adı yedek adına uymuyorsa reddeder. */
export async function deleteBackup(host: Host, profile: ServerProfile, file: string): Promise<void> {
  const os = host.os;
  const p = pathLib(os);
  const dir = resolveBackupDir(profile, os);
  const norm = (s: string) => {
    const n = trimTrailingSep(os, p.normalize(s));
    return os === 'windows' ? n.toLowerCase() : n;
  };
  if (!p.isAbsolute(file) || norm(p.dirname(file)) !== norm(dir)) {
    throw new Error(`Bu dosya yedek klasöründe değil: ${file}`);
  }
  if (!backupNamePattern(profile).test(p.basename(file))) {
    throw new Error(`Bu dosya bir OeziDev yedeği değil: ${file}`);
  }
  await host.remove(file);
}

/* ---------------- öğe planlama ---------------- */

/** a, b'nin içinde mi (ya da aynısı mı)? */
function isInside(os: HostOs, child: string, parent: string): boolean {
  const p = pathLib(os);
  const rel = p.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !p.isAbsolute(rel));
}

function samePath(os: HostOs, a: string, b: string): boolean {
  const p = pathLib(os);
  const na = trimTrailingSep(os, p.normalize(a));
  const nb = trimTrailingSep(os, p.normalize(b));
  return os === 'windows' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/** Arşiv içi adda kullanılamayacak karakterleri temizler (/, \, : ve kontrol karakterleri) */
function safeArchiveSegment(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+$/, '_') || '_';
}

interface PlanResult {
  items: BackupItem[];
  skipped: BackupSkip[];
}

/**
 * Profil ayarlarına göre arşive girecek öğeleri belirler (dosya sistemine sadece okuma için bakar).
 * Var olmayan öğeler `skipped` listesine sebebiyle eklenir.
 */
export async function planBackupItems(host: Host, profile: ServerProfile): Promise<PlanResult> {
  const os = host.os;
  const p = pathLib(os);
  const paths = resolvePaths(profile, os);
  const backupDir = resolveBackupDir(profile, os);
  const b = profile.backup;
  const items: BackupItem[] = [];
  const skipped: BackupSkip[] = [];

  const add = async (source: string, name: string, exclude: string[] = [], kind: 'dir' | 'any' = 'dir'): Promise<void> => {
    const st = await host.stat(source);
    if (!st) {
      skipped.push({ path: source, reason: 'Bulunamadı' });
      return;
    }
    if (kind === 'dir' && !st.isDir) {
      skipped.push({ path: source, reason: 'Klasör değil' });
      return;
    }
    if (samePath(os, source, backupDir) || isInside(os, source, backupDir)) {
      skipped.push({ path: source, reason: 'Yedek klasörünün içinde' });
      return;
    }
    // -profiles ya da ek yol sunucu klasörünün kendisi / üstü ise: bütün Arma kurulumu (onlarca GB) arşivlenmesin
    if (st.isDir && isInside(os, paths.serverDir, source)) {
      skipped.push({ path: source, reason: 'Sunucu klasörünün tamamı yedeklenmez' });
      return;
    }
    // Zaten eklenmiş bir klasörün içindeyse tekrar eklenmez (ör. profil içindeki BattlEye)
    const parent = items.find((i) => i.isDir && isInside(os, source, i.source));
    if (parent) {
      skipped.push({ path: source, reason: `Zaten "${parent.name}" içinde yedekleniyor` });
      return;
    }
    const excludeDirs = st.isDir && isInside(os, backupDir, source) ? [backupDir] : [];
    items.push({ source, name, isDir: st.isDir, exclude: st.isDir ? exclude : [], excludeDirs });
  };

  if (b.includeProfile) await add(paths.profilesDir, 'profile', PROFILE_EXCLUDES);

  if (b.includeMissions) {
    // Büyük/küçük harfe duyarsız ara: Windows'ta "MPMissions", Linux'ta "mpmissions" (ikisi de olabilir)
    let found: string[] = [];
    try {
      found = (await host.list(paths.serverDir))
        .filter((e) => e.isDir && e.name.toLowerCase() === 'mpmissions')
        .map((e) => p.join(paths.serverDir, e.name))
        .sort();
    } catch {
      /* sunucu klasörü okunamadı: aşağıda "bulunamadı" */
    }
    if (found.length === 0) skipped.push({ path: paths.missionsDir, reason: 'Bulunamadı' });
    for (const [i, dir] of found.entries()) await add(dir, i === 0 ? 'missions' : `missions-${i + 1}`);
  }

  if (b.includeBattlEye) {
    await add(p.join(paths.serverDir, 'BattlEye'), 'battleye');
    // -profiles altındaki BattlEye (beserver_x64.cfg, ban listesi); profil yedekleniyorsa zaten içinde
    if (!(b.includeProfile && isInside(os, paths.beDir, paths.profilesDir))) {
      const st = await host.stat(paths.beDir);
      if (st) await add(paths.beDir, 'battleye-profile');
    }
  }

  if (b.includeKeys) await add(paths.keysDir, 'keys');

  for (const [i, raw] of b.extraPaths.entries()) {
    const s = raw.trim();
    if (!s) continue;
    const abs = trimTrailingSep(os, p.isAbsolute(s) ? s : p.join(paths.serverDir, s));
    const st = await host.stat(abs);
    const base = safeArchiveSegment(p.basename(abs));
    // Klasörler extra/<n>-<ad>/..., dosyalar extra/<n>/<ad>
    await add(abs, st && !st.isDir ? `extra/${i + 1}/${base}` : `extra/${i + 1}-${base}`, [], 'any');
  }

  return { items, skipped };
}

/* ---------------- süreç yardımcısı ---------------- */

interface RunOutcome {
  code: number | null;
  aborted: boolean;
}

/** Uzun süren komutu çalıştırır; satırları iletir, signal gelirse süreci (grubunu) öldürür. */
async function runProcess(
  host: Host,
  file: string,
  args: string[],
  opts: { signal?: AbortSignal; onStdout?: (l: string) => void; onStderr?: (l: string) => void; cwd?: string },
): Promise<RunOutcome> {
  if (opts.signal?.aborted) return { code: null, aborted: true };
  const proc: StreamingProcess = host.spawn(file, args, { cwd: opts.cwd, closeStdin: true });
  const out = new LineSplitter();
  const err = new LineSplitter();
  proc.onData((chunk, stream) => {
    if (stream === 'stdout') out.push(chunk).forEach((l) => opts.onStdout?.(l));
    else err.push(chunk).forEach((l) => opts.onStderr?.(l));
  });
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    void proc.kill();
  };
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const code = await proc.wait();
    out.flush().forEach((l) => opts.onStdout?.(l));
    err.flush().forEach((l) => opts.onStderr?.(l));
    return { code, aborted: aborted || !!opts.signal?.aborted };
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

/* ---------------- veritabanı ---------------- */

/**
 * MySQL seçenek dosyası değeri (çift tırnaklı). MySQL ilk ve son karakter aynı tırnaksa soyar ve
 * içerdeki \\ \" \' \n \r \t \b \s kaçışlarını işler; tırnak içindeki # yorum sayılmaz.
 * \ ve " de kaçırılır: a"b\c#d e gibi şifreler aynen geri okunur.
 */
export function mysqlOptionValue(v: string): string {
  const esc = v
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/\x08/g, '\\b');
  return `"${esc}"`;
}

/** --defaults-extra-file içeriği: şifre komut satırında (ps / görev yöneticisi) görünmesin. */
export function buildMysqlOptionFile(password: string): string {
  return `[client]\npassword=${mysqlOptionValue(password)}\n`;
}

/** mysqldump argümanları; --defaults-extra-file mutlaka ilk argüman olmalı. */
export function buildMysqldumpArgs(db: ServerProfile['backup']['database'], optionFile: string, resultFile: string): string[] {
  return [
    `--defaults-extra-file=${optionFile}`,
    '--single-transaction',
    '--routines',
    '--triggers',
    '--default-character-set=utf8mb4',
    `--host=${db.host || '127.0.0.1'}`,
    `--port=${db.port}`,
    `--user=${db.user}`,
    `--result-file=${resultFile}`,
    db.database,
  ];
}

/* ---------------- Windows: PowerShell + ZipArchive ---------------- */

function psLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * Windows yedek betiği (saf fonksiyon, test edilebilir). `specPath`teki JSON:
 * `{ output: string, items: BackupItem[] }`. Çıktı satırları (UTF-8):
 * `SKIP\t<yol>\t<sebep>`, `PROGRESS\t<dosya>\t<bayt>`, `DONE\t<dosya>\t<bayt>`, `ERROR\t<mesaj>`.
 */
export function buildWindowsZipScript(specPath: string): string {
  return `$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8
Add-Type -AssemblyName System.IO.Compression
$spec = [System.IO.File]::ReadAllText(${psLiteral(specPath)}, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$script:count = 0
$script:bytes = [long]0
$script:zip = $null
function Emit([string]$line) { [Console]::Out.WriteLine($line); [Console]::Out.Flush() }
function Skip([string]$p, [string]$r) { Emit ("SKIP" + [char]9 + $p + [char]9 + ($r -replace '[\\r\\n\\t]+', ' ')) }
function Add-File([string]$src, [string]$name) {
  # FileShare.ReadWrite + Delete: sunucunun açık tuttuğu dosyalar (RPT, veritabanı) da okunabilsin
  try {
    $fs = New-Object System.IO.FileStream($src, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, ([System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete), 1048576)
  } catch { Skip $src $_.Exception.Message; return }
  try {
    $entry = $script:zip.CreateEntry($name, [System.IO.Compression.CompressionLevel]::Optimal)
    try { $entry.LastWriteTime = [DateTimeOffset]([System.IO.File]::GetLastWriteTime($src)) } catch { }
    $es = $entry.Open()
    try { $fs.CopyTo($es, 1048576) } catch { Skip $src ('Okuma yarıda kaldı (dosya eksik olabilir): ' + $_.Exception.Message) } finally { $es.Dispose() }
    $script:count++
    $script:bytes += $fs.Length
    if (($script:count % 500) -eq 0) { Emit ("PROGRESS" + [char]9 + $script:count + [char]9 + $script:bytes) }
  } finally { $fs.Dispose() }
}
function Add-Dir([string]$dir, [string]$prefix, $exclude, $excludeDirs) {
  try { $children = (New-Object System.IO.DirectoryInfo($dir)).GetFileSystemInfos() } catch { Skip $dir $_.Exception.Message; return }
  if ($children.Count -eq 0) { [void]$script:zip.CreateEntry($prefix + '/'); return }
  foreach ($c in $children) {
    if ($c -is [System.IO.DirectoryInfo]) {
      if ($excludeDirs -contains $c.FullName.TrimEnd('\\')) { continue }
      # Junction / sembolik bağlantılar izlenmez (döngü ve Workshop klasörünün tamamını yedeklemek olmasın)
      if ($c.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { Skip $c.FullName 'Bağlantı (junction/symlink) izlenmedi'; continue }
      Add-Dir $c.FullName ($prefix + '/' + $c.Name) $exclude $excludeDirs
    } else {
      $skip = $false
      foreach ($pat in $exclude) { if ($c.Name -like $pat) { $skip = $true; break } }
      if (-not $skip) { Add-File $c.FullName ($prefix + '/' + $c.Name) }
    }
  }
}
try {
  $out = New-Object System.IO.FileStream($spec.output, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
  try {
    # Giriş adları UTF-8 (genel amaçlı bit 11 işaretlenir): Türkçe karakterli dosya adları bozulmaz
    $script:zip = New-Object System.IO.Compression.ZipArchive($out, [System.IO.Compression.ZipArchiveMode]::Create, $false, $utf8)
    try {
      foreach ($item in @($spec.items)) {
        $ex = @(); if ($item.exclude) { $ex = @($item.exclude) }
        $exd = @(); if ($item.excludeDirs) { $exd = @($item.excludeDirs | ForEach-Object { $_.TrimEnd('\\') }) }
        if ($item.isDir) { Add-Dir $item.source $item.name $ex $exd } else { Add-File $item.source $item.name }
      }
    } finally { $script:zip.Dispose() }
  } finally { $out.Dispose() }
  Emit ("DONE" + [char]9 + $script:count + [char]9 + $script:bytes)
  exit 0
} catch {
  Emit ("ERROR" + [char]9 + ($_.Exception.Message -replace '[\\r\\n\\t]+', ' '))
  exit 2
}
`;
}

/** powershell.exe -EncodedCommand için UTF-16LE base64 */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/* ---------------- Linux: tar ---------------- */

/** tar joker karakterlerini kaçırır (fnmatch) */
function tarGlobEscape(s: string): string {
  return s.replace(/[\\*?[\]]/g, '\\$&');
}

/**
 * Linux tar argümanları (saf). Her öğe staging klasöründe bir bağlantıyla temsil edilir:
 * klasör: `<staging>/<ad>` -> kaynak, argüman `<ad>/.`; dosya: `<staging>/<ad'ın klasörü>` -> kaynağın klasörü,
 * argüman `<ad>`. `--transform` "/./" parçasını atar; dışlamalar --anchored ve öğe önekli olduğundan
 * sadece kendi öğesine uygulanır.
 */
export function buildTarArgs(output: string, stagingDir: string, items: BackupItem[]): string[] {
  // literal: C/POSIX yerel ayarlı VPS'te de hata mesajlarındaki Türkçe adlar \303\247 gibi kaçırılmasın
  const args = ['-czf', output, '--quoting-style=literal', '--ignore-failed-read', '--warning=no-file-changed', '--warning=no-file-removed'];
  args.push('--transform=flags=r;s,/\\./,/,;s,/\\.$,,');
  const excludes: string[] = [];
  for (const it of items) {
    if (!it.isDir) continue;
    for (const pat of it.exclude) excludes.push(`${tarGlobEscape(it.name)}/*${pat.startsWith('*') ? pat.slice(1) : `/${pat}`}`);
    for (const d of it.excludeDirs) {
      const rel = pathLib('linux').relative(it.source, d);
      if (rel && !rel.startsWith('..')) excludes.push(`${tarGlobEscape(it.name)}/./${tarGlobEscape(rel)}`);
    }
  }
  if (excludes.length) {
    args.push('--anchored', '--wildcards-match-slash');
    for (const e of excludes) args.push(`--exclude=${e}`);
  }
  args.push('-C', stagingDir, '--');
  for (const it of items) args.push(it.isDir ? `${it.name}/.` : it.name);
  return args;
}

/* ---------------- yedekleme ---------------- */

export async function runBackup(host: Host, profile: ServerProfile, opts: BackupOptions = {}): Promise<BackupResult> {
  const started = Date.now();
  const os = host.os;
  const p = pathLib(os);
  const log = (l: string) => opts.onLine?.(l);
  const signal = opts.signal;
  const checkAbort = () => {
    if (signal?.aborted) throw new BackupAbortedError();
  };
  checkAbort();

  const now = opts.now ?? new Date();
  const backupDir = resolveBackupDir(profile, os);
  if (isUnderProgramFiles(backupDir, os)) {
    log(`Uyarı: yedek klasörü "Program Files" altında (${backupDir}); yazma izni sorun çıkarabilir, ayarlardan başka bir yedek klasörü seçmeniz önerilir`);
  }
  await host.mkdirp(backupDir);

  // Aynı saniyede ikinci yedek: -2, -3 ...
  let fileName = backupFileName(profile, os, now);
  for (let n = 2; (await host.exists(p.join(backupDir, fileName))) || (await host.exists(p.join(backupDir, `${fileName}.partial`))); n++) {
    fileName = backupFileName(profile, os, now, n);
  }
  const finalPath = p.join(backupDir, fileName);
  const partial = `${finalPath}.partial`;
  const staging = p.join(backupDir, `.oezi-staging-${backupStamp(now)}-${Math.random().toString(36).slice(2, 8)}`);

  log(`Yedekleme başladı: ${fileName}`);
  const plan = await planBackupItems(host, profile);
  const items = plan.items;
  const skipped = [...plan.skipped];
  for (const s of plan.skipped) log(`Atlandı: ${s.path} (${s.reason})`);

  let databaseDumped = false;
  const links: string[] = [];
  try {
    await host.mkdirp(staging);

    /* --- veritabanı --- */
    const db = profile.backup.database;
    if (db.enabled) {
      checkAbort();
      if (!db.database.trim() || db.database.startsWith('-')) {
        skipped.push({ path: 'database', reason: 'Veritabanı adı ayarlanmamış' });
        log('Veritabanı yedeği atlandı: veritabanı adı ayarlanmamış');
      } else {
        const sqlName = `${safeArchiveSegment(db.database)}.sql`;
        const sqlPath = p.join(staging, 'database', sqlName);
        const optFile = p.join(staging, 'mysql-client.cnf');
        await host.mkdirp(p.join(staging, 'database'));
        await host.writeFile(optFile, buildMysqlOptionFile(db.password), { mode: 0o600 });
        log(`Veritabanı dökülüyor: ${db.database} (${db.host}:${db.port})`);
        const errLines: string[] = [];
        let res: RunOutcome;
        try {
          res = await runProcess(host, db.dumpPath.trim() || 'mysqldump', buildMysqldumpArgs(db, optFile, sqlPath), {
            signal,
            onStderr: (l) => {
              if (!l.trim()) return;
              if (errLines.length < 20) errLines.push(l.trim());
              log(`mysqldump: ${l}`);
            },
          });
        } finally {
          await host.remove(optFile).catch(() => undefined);
        }
        if (res.aborted) throw new BackupAbortedError();
        const st = await host.stat(sqlPath);
        if (res.code === 0 && st && !st.isDir) {
          databaseDumped = true;
          items.push({ source: sqlPath, name: `database/${sqlName}`, isDir: false, exclude: [], excludeDirs: [] });
          log(`Veritabanı döküldü (${st.size} bayt)`);
        } else {
          const reason = errLines.filter((l) => !/Using a password on the command line/i.test(l)).join(' | ') || `mysqldump çıkış kodu ${res.code}`;
          skipped.push({ path: `database/${db.database}`, reason });
          log(`Veritabanı yedeği başarısız: ${reason}`);
          await host.remove(sqlPath).catch(() => undefined);
        }
      }
    }

    checkAbort();
    if (items.length === 0) throw new Error('Yedeklenecek bir şey bulunamadı (bütün öğeler eksik ya da kapalı)');

    /* --- arşiv --- */
    if (os === 'windows') {
      const specPath = p.join(staging, 'spec.json');
      await host.writeFile(specPath, JSON.stringify({ output: partial, items }));
      let fatal = '';
      log(`Arşivleniyor (zip): ${items.map((i) => i.name).join(', ')}`);
      const res = await runProcess(
        host,
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShell(buildWindowsZipScript(specPath))],
        {
          signal,
          onStdout: (l) => {
            const parts = l.replace(/\r$/, '').split('\t');
            if (parts[0] === 'SKIP') {
              skipped.push({ path: parts[1] ?? '', reason: parts[2] ?? '' });
              log(`Atlandı: ${parts[1]} (${parts[2]})`);
            } else if (parts[0] === 'PROGRESS') log(`${parts[1]} dosya, ${parts[2]} bayt`);
            else if (parts[0] === 'DONE') log(`Arşive ${parts[1]} dosya eklendi (${parts[2]} bayt)`);
            else if (parts[0] === 'ERROR') fatal = parts.slice(1).join(' ');
            else if (l.trim()) log(l);
          },
          onStderr: (l) => {
            if (l.trim()) {
              if (!fatal) fatal = l.trim();
              log(l);
            }
          },
        },
      );
      if (res.aborted) throw new BackupAbortedError();
      if (res.code !== 0) throw new Error(`Arşiv oluşturulamadı: ${fatal || `çıkış kodu ${res.code}`}`);
    } else {
      // Staging'de bağlantılar: farklı köklerdeki öğeler tek arşivde düzgün adlarla
      for (const it of items) {
        if (it.source.startsWith(staging + '/')) continue; // veritabanı dökümü zaten staging'de
        const link = it.isDir ? p.join(staging, it.name) : p.join(staging, p.dirname(it.name));
        await host.linkDir(it.isDir ? it.source : p.dirname(it.source), link);
        links.push(link);
      }
      log(`Arşivleniyor (tar.gz): ${items.map((i) => i.name).join(', ')}`);
      const errLines: string[] = [];
      const res = await runProcess(host, 'tar', buildTarArgs(partial, staging, items), {
        signal,
        onStderr: (l) => {
          const line = l.trim();
          if (!line) return;
          log(line);
          // "tar: profile/./x: Cannot open: Permission denied" -> atlanan dosya
          const m = /^tar: (.+?): (Cannot (?:open|stat|read|savedir)|Warning: Cannot \w+)[^:]*: (.+)$/.exec(line);
          if (m) skipped.push({ path: m[1]!.replace(/\/\.(?=\/|$)/, ''), reason: m[3]! });
          else if (errLines.length < 20) errLines.push(line);
        },
      });
      if (res.aborted) throw new BackupAbortedError();
      // 1: okunurken değişen dosya (arşiv yine geçerli)
      if (res.code !== 0 && res.code !== 1) throw new Error(`Arşiv oluşturulamadı: ${errLines.join(' | ') || `tar çıkış kodu ${res.code}`}`);
    }

    checkAbort();
    await host.rename(partial, finalPath);
    const st = await host.stat(finalPath);
    const result: BackupResult = {
      file: finalPath,
      sizeBytes: st?.size ?? 0,
      included: items.map((i) => i.name),
      skipped,
      databaseDumped,
      durationMs: Date.now() - started,
    };
    log(`Yedek tamamlandı: ${finalPath} (${result.sizeBytes} bayt, ${Math.round(result.durationMs / 1000)} sn)`);
    return result;
  } catch (err) {
    await removeWithRetry(host, partial);
    if (signal?.aborted && !(err instanceof BackupAbortedError)) throw new BackupAbortedError();
    throw err;
  } finally {
    // Önce bağlantılar (hedeflere dokunmadan), sonra staging klasörü
    for (const l of links.reverse()) await host.remove(l).catch(() => undefined);
    await host.remove(staging, { recursive: true }).catch(() => undefined);
  }
}

/** Windows'ta öldürülen süreç dosyayı kısa süre kilitli tutabilir: birkaç kez dene */
async function removeWithRetry(host: Host, file: string): Promise<void> {
  for (let i = 0; i < 6; i++) {
    try {
      await host.remove(file);
      if (!(await host.exists(file))) return;
    } catch {
      /* tekrar dene */
    }
    await new Promise((r) => setTimeout(r, 250 * (i + 1)));
  }
}
