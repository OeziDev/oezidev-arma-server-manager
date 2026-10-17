import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalHost } from '../src/host/local.js';
import { SshHost } from '../src/host/ssh.js';
import type { Host } from '../src/host/types.js';
import { createProfile, type ServerProfile, type ServerProfileInput } from '../src/model/profile.js';
import {
  backupFileName,
  backupNamePattern,
  buildMysqlOptionFile,
  buildTarArgs,
  buildWindowsZipScript,
  deleteBackup,
  encodePowerShell,
  isUnderProgramFiles,
  listBackups,
  mysqlOptionValue,
  nextBackupTime,
  planBackupItems,
  pruneBackups,
  resolveBackupDir,
  runBackup,
} from '../src/backup/backup.js';

const ID = 'a1b2c3d4-0000-4000-8000-000000000000';

function tarList(file: string): string[] {
  return execFileSync('tar', ['--quoting-style=literal', '-tzf', file], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .map((l) => l.replace(/\/$/, ''));
}

function makeServer(root: string): { serverDir: string; extraDir: string; extraFile: string } {
  const serverDir = path.join(root, 'arma sunucu');
  const prof = path.join(serverDir, 'oezi-profiles', 'a1b2c3d4');
  fs.mkdirSync(path.join(prof, 'Users', 'server'), { recursive: true });
  fs.mkdirSync(path.join(prof, 'BattlEye'), { recursive: true });
  fs.writeFileSync(path.join(prof, 'server.cfg'), 'hostname = "Test";\n');
  fs.writeFileSync(path.join(prof, 'Users', 'server', 'server.Arma3Profile'), 'x');
  fs.writeFileSync(path.join(prof, 'BattlEye', 'beserver_x64.cfg'), 'RConPassword x');
  fs.writeFileSync(path.join(prof, 'arma3server_x64_2026-10-17_12-00-00.rpt'), 'log');
  fs.writeFileSync(path.join(prof, 'server-stdout.log'), 'log');
  fs.writeFileSync(path.join(prof, 'crash.mdmp'), 'dump');
  fs.writeFileSync(path.join(prof, 'x.bidmp'), 'dump');
  fs.mkdirSync(path.join(serverDir, 'mpmissions', 'altislife.Altis'), { recursive: true });
  fs.writeFileSync(path.join(serverDir, 'mpmissions', 'altislife.Altis', 'mission.sqm'), 'class Mission {};');
  fs.writeFileSync(path.join(serverDir, 'mpmissions', 'a.pbo'), 'pbo');
  fs.mkdirSync(path.join(serverDir, 'BattlEye'), { recursive: true });
  fs.writeFileSync(path.join(serverDir, 'BattlEye', 'BEServer_x64.dll'), 'dll');
  fs.mkdirSync(path.join(serverDir, 'keys'), { recursive: true });
  fs.writeFileSync(path.join(serverDir, 'keys', 'a3.bikey'), 'key');
  const extraDir = path.join(root, 'Ekstra Klasör ğüş');
  fs.mkdirSync(path.join(extraDir, 'alt klasör'), { recursive: true });
  fs.writeFileSync(path.join(extraDir, 'alt klasör', 'çiçek.txt'), 'ç');
  fs.writeFileSync(path.join(extraDir, 'keep.log'), 'extra log kept'); // dışlama sadece profil klasöründe
  const extraFile = path.join(serverDir, 'özel ayar.sqf');
  fs.writeFileSync(extraFile, 'hint "x";');
  return { serverDir, extraDir, extraFile };
}

function profileFor(serverDir: string, backup: ServerProfileInput['backup'] = {}): ServerProfile {
  return createProfile({ id: ID, name: '57. Alay Şahin', paths: { serverDir }, backup });
}

describe('yedek adlandırma', () => {
  it('ad, desen ve klasör', () => {
    const p = profileFor('/srv/arma/server');
    const name = backupFileName(p, 'linux', new Date(2026, 9, 17, 4, 30, 5));
    expect(name).toBe('oezi-backup-57-alay-sahin-a1b2c3d4-20261017-043005.tar.gz');
    expect(backupNamePattern(p).test(name)).toBe(true);
    expect(backupNamePattern(p).test(name + '.partial')).toBe(false);
    // Profil yeniden adlandırılsa da eski yedekler bu profile ait sayılır
    expect(backupNamePattern(p).test('oezi-backup-eski-ad-a1b2c3d4-20250101-000000.tar.gz')).toBe(true);
    expect(backupNamePattern(p).test('oezi-backup-baska-ffffffff-20250101-000000.tar.gz')).toBe(false);
    expect(backupFileName(p, 'windows', new Date(2026, 0, 2, 3, 4, 5), 2)).toBe('oezi-backup-57-alay-sahin-a1b2c3d4-20260102-030405-2.zip');
    expect(resolveBackupDir(p, 'linux')).toBe('/srv/arma/oezi-backups/a1b2c3d4');
    expect(resolveBackupDir(profileFor('/srv/arma/server', { targetDir: 'yedek' }), 'linux')).toBe('/srv/arma/server/yedek');
    expect(resolveBackupDir(profileFor('C:\\Arma 3\\Server', { targetDir: 'D:\\Yedekler\\' }), 'windows')).toBe('D:\\Yedekler');
    expect(resolveBackupDir(profileFor('C:\\Arma 3\\Server'), 'windows')).toBe('C:\\Arma 3\\oezi-backups\\a1b2c3d4');
  });

  it('nextBackupTime scheduler ile aynı', () => {
    const next = nextBackupTime(['04:30', '16:00'], new Date(2026, 9, 17, 10, 0));
    expect(next).toEqual(new Date(2026, 9, 17, 16, 0));
  });

  it('mysql seçenek dosyası şifreyi doğru tırnaklar', () => {
    expect(buildMysqlOptionFile('a"b\\c #d')).toBe('[client]\npassword="a\\"b\\\\c #d"\n');
  });

  it('mysql seçenek değeri MySQL kaçışlarıyla aynen geri okunur', () => {
    // MySQL (my_default.cc) okuyucusu: aynı tırnakla başlayıp bitiyorsa soy, \\ kaçışlarını çöz
    const mysqlRead = (raw: string): string => {
      let v = raw;
      if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) v = v.slice(1, -1);
      const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', s: ' ', '"': '"', "'": "'", '\\': '\\' };
      let out = '';
      for (let i = 0; i < v.length; i++) {
        if (v[i] === '\\' && i < v.length - 1) {
          const c = v[++i]!;
          out += map[c] ?? `\\${c}`;
        } else out += v[i];
      }
      return out;
    };
    const pw = 'a"b\\c#d e';
    expect(mysqlOptionValue(pw)).toBe('"a\\"b\\\\c#d e"');
    for (const x of [pw, 'son\\', '"', '\\"', 'sekme\tsatır\nson', "tek'tırnak", 'şifre ğüş']) {
      expect(mysqlRead(mysqlOptionValue(x))).toBe(x);
    }
  });

  it('Program Files altındaki yedek klasörü algılanır', () => {
    expect(isUnderProgramFiles('C:\\Program Files (x86)\\Steam\\steamapps\\common\\oezi-backups\\a1b2c3d4', 'windows')).toBe(true);
    expect(isUnderProgramFiles('c:\\program files\\Arma', 'windows')).toBe(true);
    expect(isUnderProgramFiles('D:\\Program Files Yedek\\x', 'windows')).toBe(false);
    expect(isUnderProgramFiles('D:\\Yedek\\Program Files', 'windows')).toBe(false);
    expect(isUnderProgramFiles('/Program Files/x', 'linux')).toBe(false);
  });

  it('Windows zip betiği (saf)', () => {
    const script = buildWindowsZipScript("C:\\Yedek Klasörü\\o'zi\\spec.json");
    expect(script).toContain('[System.IO.FileShare]::ReadWrite');
    expect(script).toContain("'C:\\Yedek Klasörü\\o''zi\\spec.json'");
    expect(script).toContain('ZipArchive($out, [System.IO.Compression.ZipArchiveMode]::Create, $false, $utf8)');
    expect(script).toContain('-like $pat');
    expect(script).toContain('$item.exclude');
    expect(script).toContain('ReparsePoint');
    expect(script).toContain('[Console]::OutputEncoding = $utf8');
    // EncodedCommand: UTF-16LE
    expect(Buffer.from(encodePowerShell(script), 'base64').toString('utf16le')).toBe(script);
  });

  it('tar argümanları: dışlamalar öğeye bağlı, "--" sonrası öğeler', () => {
    const args = buildTarArgs('/b/x.tar.gz.partial', '/b/.st', [
      { source: '/s/p', name: 'profile', isDir: true, exclude: ['*.rpt'], excludeDirs: ['/s/p/yedek'] },
      { source: '/e/f.txt', name: 'extra/1/f.txt', isDir: false, exclude: [], excludeDirs: [] },
    ]);
    expect(args).toContain('--exclude=profile/*.rpt');
    expect(args).toContain('--exclude=profile/./yedek');
    expect(args.slice(args.indexOf('--'))).toEqual(['--', 'profile/.', 'extra/1/f.txt']);
  });
});

describe('runBackup (LocalHost, Linux)', () => {
  let root: string;
  let host: Host;
  let srv: ReturnType<typeof makeServer>;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'oezi-backup-'));
    srv = makeServer(root);
    host = new LocalHost();
    await host.connect();
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('arşiv oluşturur, dışlamalar ve ekstra yollar', async () => {
    const profile = profileFor(srv.serverDir, {
      includeKeys: true,
      extraPaths: [srv.extraDir, 'özel ayar.sqf', 'yok/olmayan'],
    });
    const lines: string[] = [];
    const res = await runBackup(host, profile, { now: new Date(2026, 9, 17, 4, 30, 0), onLine: (l) => lines.push(l) });
    expect(res.file).toBe(path.join(root, 'oezi-backups', 'a1b2c3d4', 'oezi-backup-57-alay-sahin-a1b2c3d4-20261017-043000.tar.gz'));
    expect(fs.existsSync(res.file)).toBe(true);
    expect(fs.existsSync(res.file + '.partial')).toBe(false);
    expect(res.sizeBytes).toBe(fs.statSync(res.file).size);
    expect(res.databaseDumped).toBe(false);
    expect(res.included).toEqual(['profile', 'missions', 'battleye', 'keys', 'extra/1-Ekstra Klasör ğüş', 'extra/2/özel ayar.sqf']);
    expect(res.skipped).toEqual([{ path: path.join(srv.serverDir, 'yok', 'olmayan'), reason: 'Bulunamadı' }]);

    const entries = tarList(res.file);
    expect(entries).toContain('profile/server.cfg');
    expect(entries).toContain('profile/Users/server/server.Arma3Profile');
    expect(entries).toContain('profile/BattlEye/beserver_x64.cfg');
    expect(entries.some((e) => /\.(rpt|log|mdmp|bidmp)$/.test(e) && e.startsWith('profile/'))).toBe(false);
    expect(entries).toContain('missions/altislife.Altis/mission.sqm');
    expect(entries).toContain('missions/a.pbo');
    expect(entries).toContain('battleye/BEServer_x64.dll');
    expect(entries).toContain('keys/a3.bikey');
    expect(entries).toContain('extra/1-Ekstra Klasör ğüş/alt klasör/çiçek.txt');
    expect(entries).toContain('extra/1-Ekstra Klasör ğüş/keep.log');
    expect(entries).toContain('extra/2/özel ayar.sqf');
    expect(entries.some((e) => e.includes('/./'))).toBe(false);
    // staging temizlendi
    expect(fs.readdirSync(path.dirname(res.file)).filter((n) => n.startsWith('.oezi-staging'))).toEqual([]);
    expect(lines.some((l) => l.startsWith('Yedek tamamlandı'))).toBe(true);

    // çıkarınca içerik doğru
    const out = path.join(root, 'cikar');
    fs.mkdirSync(out);
    execFileSync('tar', ['-xzf', res.file, '-C', out]);
    expect(fs.readFileSync(path.join(out, 'extra/1-Ekstra Klasör ğüş/alt klasör/çiçek.txt'), 'utf8')).toBe('ç');
    fs.rmSync(path.dirname(res.file), { recursive: true });
  });

  it('yedek klasörü yedeklenen klasörün içindeyse kendini arşivlemez', async () => {
    const profile = profileFor(srv.serverDir, { targetDir: 'oezi-profiles/a1b2c3d4/yedekler', includeMissions: false, includeBattlEye: false });
    const r1 = await runBackup(host, profile, { now: new Date(2026, 9, 17, 5, 0, 0) });
    const r2 = await runBackup(host, profile, { now: new Date(2026, 9, 17, 5, 0, 0) });
    expect(path.basename(r2.file)).toMatch(/-20261017-050000-2\.tar\.gz$/);
    expect(tarList(r2.file).some((e) => e.includes('yedekler'))).toBe(false);
    const list = await listBackups(host, profile);
    expect(list.map((b) => b.file)).toEqual([r2.file, r1.file]);
    fs.rmSync(path.dirname(r1.file), { recursive: true });
  });

  it('listBackups / pruneBackups / deleteBackup', async () => {
    const profile = profileFor(srv.serverDir, { includeMissions: false, includeBattlEye: false });
    const dir = resolveBackupDir(profile, 'linux');
    const made: string[] = [];
    for (let i = 1; i <= 4; i++) made.push((await runBackup(host, profile, { now: new Date(2026, 9, 10 + i, 4, 30, 0) })).file);
    // Yabancı dosyalar dokunulmaz
    fs.writeFileSync(path.join(dir, 'notlar.txt'), 'x');
    fs.writeFileSync(path.join(dir, 'oezi-backup-baska-ffffffff-20200101-000000.tar.gz'), 'x');
    const freshPartial = path.join(dir, 'oezi-backup-57-alay-sahin-a1b2c3d4-20260101-000000.tar.gz.partial');
    fs.writeFileSync(freshPartial, 'x');
    const oldPartial = path.join(dir, 'oezi-backup-57-alay-sahin-a1b2c3d4-20250101-000000.tar.gz.partial');
    fs.writeFileSync(oldPartial, 'x');
    const old = new Date(Date.now() - 3 * 24 * 3600_000);
    fs.utimesSync(oldPartial, old, old);

    const all = await listBackups(host, profile);
    expect(all.map((b) => b.name).filter((n) => n.includes('2026101'))).toHaveLength(4);
    expect(all[0]!.createdAt).toBeGreaterThan(all[1]!.createdAt);
    expect(all.every((b) => !b.name.endsWith('.partial') && b.name.includes('a1b2c3d4'))).toBe(true);

    const removed = await pruneBackups(host, profile, 2);
    expect(removed).toEqual(expect.arrayContaining([made[0], made[1], oldPartial]));
    expect(removed).not.toContain(freshPartial);
    expect((await listBackups(host, profile)).map((b) => b.file)).toEqual([made[3], made[2]]);
    expect(fs.existsSync(path.join(dir, 'notlar.txt'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'oezi-backup-baska-ffffffff-20200101-000000.tar.gz'))).toBe(true);

    await expect(deleteBackup(host, profile, path.join(dir, 'notlar.txt'))).rejects.toThrow(/yedeği değil/);
    await expect(deleteBackup(host, profile, path.join(srv.serverDir, path.basename(made[3]!)))).rejects.toThrow(/klasöründe değil/);
    await expect(deleteBackup(host, profile, path.join(dir, '..', 'a1b2c3d4', '..', path.basename(made[3]!)))).rejects.toThrow(/klasöründe değil/);
    await deleteBackup(host, profile, made[3]!);
    expect((await listBackups(host, profile)).map((b) => b.file)).toEqual([made[2]]);
    fs.rmSync(dir, { recursive: true });
  });

  it('iptal: süreç öldürülür, .partial silinir', async () => {
    // Büyük, sıkıştırılamayan dosya: tar birkaç saniye sürsün
    const big = path.join(root, 'buyuk');
    fs.mkdirSync(big);
    const fd = fs.openSync(path.join(big, 'rastgele.bin'), 'w');
    const chunk = Buffer.alloc(8 * 1024 * 1024);
    for (let i = 0; i < 48; i++) {
      for (let j = 0; j < chunk.length; j += 4) chunk.writeUInt32LE((Math.random() * 0xffffffff) >>> 0, j);
      fs.writeSync(fd, chunk);
    }
    fs.closeSync(fd);
    const profile = profileFor(srv.serverDir, { extraPaths: [big], includeMissions: false });
    const dir = resolveBackupDir(profile, 'linux');
    const ac = new AbortController();
    const p = runBackup(host, profile, { signal: ac.signal, onLine: (l) => l.startsWith('Arşivleniyor') && setTimeout(() => ac.abort(), 300) });
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    const left = fs.readdirSync(dir);
    expect(left.filter((n) => n.endsWith('.partial') || n.endsWith('.tar.gz') || n.startsWith('.oezi-staging'))).toEqual([]);
    // Zaten iptal edilmiş sinyal: hiç başlamaz
    await expect(runBackup(host, profile, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
    fs.rmSync(big, { recursive: true });
    fs.rmSync(dir, { recursive: true });
  }, 60000);

  it('veritabanı dökümü: şifre argv\'de yok, seçenek dosyası 0600 ve sonra silinir', async () => {
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    const record = path.join(root, 'mysqldump-kayit.txt');
    // Sahte mysqldump: argv, ortam ve seçenek dosyasını kaydeder, --result-file'a SQL yazar
    fs.writeFileSync(
      path.join(bin, 'mysqldump'),
      `#!/bin/bash
{
  echo "ARGV: $*"
  echo "ENV_MYSQL_PWD: \${MYSQL_PWD:-yok}"
  for a in "$@"; do
    case "$a" in
      --defaults-extra-file=*) f="\${a#--defaults-extra-file=}"; echo "MODE: $(stat -c %a "$f")"; echo "CNF: $(cat "$f" | tr '\\n' '|')"; echo "CNFPATH: $f" ;;
      --result-file=*) out="\${a#--result-file=}" ;;
    esac
  done
} > "${record}"
echo "-- MySQL dump" > "$out"
echo "CREATE TABLE players (id int);" >> "$out"
`,
      { mode: 0o755 },
    );
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath}`;
    try {
      const profile = profileFor(srv.serverDir, {
        includeMissions: false,
        includeBattlEye: false,
        database: { enabled: true, user: 'arma', password: 'Gizli Şifre"#1', database: 'altislife', port: 3307 },
      });
      const res = await runBackup(host, profile, { now: new Date(2026, 9, 17, 6, 0, 0) });
      expect(res.databaseDumped).toBe(true);
      expect(res.included).toContain('database/altislife.sql');
      const rec = fs.readFileSync(record, 'utf8');
      const argv = rec.split('\n').find((l) => l.startsWith('ARGV:'))!;
      expect(argv).not.toContain('Gizli');
      expect(argv).toMatch(/^ARGV: --defaults-extra-file=\S+ --single-transaction --routines --triggers /);
      expect(argv).toContain('--host=127.0.0.1');
      expect(argv).toContain('--port=3307');
      expect(argv).toContain('--user=arma');
      expect(argv.endsWith(' altislife')).toBe(true);
      expect(rec).toContain('ENV_MYSQL_PWD: yok');
      expect(rec).toContain('MODE: 600');
      expect(rec).toContain('CNF: [client]|password="Gizli Şifre\\"#1"|');
      const cnfPath = rec.split('\n').find((l) => l.startsWith('CNFPATH: '))!.slice(9);
      expect(fs.existsSync(cnfPath)).toBe(false);
      expect(tarList(res.file)).toContain('database/altislife.sql');
      const sql = execFileSync('tar', ['-xzOf', res.file, 'database/altislife.sql'], { encoding: 'utf8' });
      expect(sql).toContain('CREATE TABLE players');

      // mysqldump başarısız: dosya yedeği yine alınır, sebep raporlanır
      fs.writeFileSync(path.join(bin, 'mysqldump'), '#!/bin/sh\necho "mysqldump: Got error: 1045: Access denied" >&2\nexit 2\n', { mode: 0o755 });
      const res2 = await runBackup(host, profile, { now: new Date(2026, 9, 17, 6, 1, 0) });
      expect(res2.databaseDumped).toBe(false);
      expect(res2.skipped).toEqual([{ path: 'database/altislife', reason: 'mysqldump: Got error: 1045: Access denied' }]);
      expect(tarList(res2.file).some((e) => e.startsWith('database'))).toBe(false);
      fs.rmSync(path.dirname(res.file), { recursive: true });
    } finally {
      process.env.PATH = oldPath;
    }
  });

  it('planBackupItems: profil kapalıyken profil BattlEye klasörü ayrı eklenir', async () => {
    const profile = profileFor(srv.serverDir, { includeProfile: false, includeMissions: false });
    const plan = await planBackupItems(host, profile);
    expect(plan.items.map((i) => i.name)).toEqual(['battleye', 'battleye-profile']);
  });

  it('planBackupItems: sunucu klasörünün kendisi ya da üstü (profil / ek yol) yedeklenmez', async () => {
    const profile = createProfile({
      id: ID,
      name: 'Tam',
      paths: { serverDir: srv.serverDir, profilesDir: srv.serverDir },
      backup: { includeMissions: false, includeBattlEye: false, includeKeys: false, extraPaths: ['.', path.dirname(srv.serverDir), srv.extraFile] },
    });
    const plan = await planBackupItems(host, profile);
    const reason = 'Sunucu klasörünün tamamı yedeklenmez';
    expect(plan.skipped.filter((x) => x.reason === reason).map((x) => x.path)).toEqual([srv.serverDir, srv.serverDir, path.dirname(srv.serverDir)]);
    // Sunucu klasöründeki tek dosya yine yedeklenir
    expect(plan.items.map((i) => i.source)).toEqual([srv.extraFile]);
  });

  it('hiçbir öğe yoksa hata verir', async () => {
    const empty = path.join(root, 'bos sunucu');
    fs.mkdirSync(empty);
    const profile = profileFor(empty);
    await expect(runBackup(host, profile)).rejects.toThrow(/Yedeklenecek bir şey bulunamadı/);
    const dir = resolveBackupDir(profile, 'linux');
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

// Gerçek sshd varsa (hosts.test.ts ile aynı test sunucusu) SSH üzerinden de dene
const SSH_PORT = Number(process.env.OEZI_SSH_PORT || 2222);
const SSH_AVAILABLE = await new Promise<boolean>((resolve) => {
  import('node:net').then(({ createConnection }) => {
    const s = createConnection({ host: '127.0.0.1', port: SSH_PORT }, () => {
      s.end();
      resolve(true);
    });
    s.on('error', () => resolve(false));
  });
});

describe.skipIf(!SSH_AVAILABLE)('runBackup (SshHost)', () => {
  it('uzak Linux sunucuda tar.gz', async () => {
    const host = new SshHost({ id: 'bk', host: '127.0.0.1', port: SSH_PORT, username: 'armatest', password: 'TestSifre123!' });
    await host.connect();
    const root = `/home/armatest/oezi-bk-${Date.now()}`;
    try {
      const serverDir = `${root}/arma sunucu`;
      await host.writeFile(`${serverDir}/oezi-profiles/a1b2c3d4/server.cfg`, 'x');
      await host.writeFile(`${serverDir}/oezi-profiles/a1b2c3d4/a.rpt`, 'x');
      await host.writeFile(`${serverDir}/mpmissions/görev ğ.pbo`, 'x');
      const profile = profileFor(serverDir);
      const res = await runBackup(host, profile);
      const ls = await host.exec('tar', ['--quoting-style=literal', '-tzf', res.file]);
      expect(ls.stdout).toContain('profile/server.cfg');
      expect(ls.stdout).toContain('missions/görev ğ.pbo');
      expect(ls.stdout).not.toContain('a.rpt');
      expect((await listBackups(host, profile)).map((b) => b.file)).toEqual([res.file]);
    } finally {
      await host.remove(root, { recursive: true }).catch(() => undefined);
      await host.close();
    }
  });
});
