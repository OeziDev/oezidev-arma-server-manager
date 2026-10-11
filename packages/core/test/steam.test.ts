import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalHost } from '../src/host/local.js';
import {
  type SteamCmdContext,
  SteamCmdError,
  appUpdateArgs,
  detectFailure,
  downloadWorkshopItems,
  ensureLinuxSteamClient,
  firstRunSteamCmd,
  maskSteamCmdArgs,
  updateServer,
  workshopContentDir,
} from '../src/steam/steamcmd.js';
import {
  fetchCollectionItems,
  fetchWorkshopDetails,
  installWorkshopMod,
  lowercaseTree,
  modFolderName,
  parseLauncherPreset,
  parseWorkshopId,
  sanitizeFolderName,
  syncModKeys,
  uninstallWorkshopMod,
} from '../src/steam/workshop.js';

/**
 * SteamCMD taklidi: önbellekli giriş, şifre, Steam Guard, app_update ve
 * workshop_download_item (ilk denemede zaman aşımı) davranışlarını taklit eder.
 */
const FAKE_STEAMCMD = `#!/bin/bash
dir="$(cd "$(dirname "$0")" && pwd)"
state="$dir/state"; mkdir -p "$state"
install=""; user=""; pass=""; code=""; bpw=""
args=("$@"); i=0
echo "$*" >> "$state/calls.log"
[ -f "$state/echoargs" ] && echo "args: $*"
for ((k=0; k<\${#args[@]}; k++)); do [ "\${args[$k]}" = "-betapassword" ] && bpw="\${args[$((k+1))]}"; done
while [ $i -lt \${#args[@]} ]; do
  a="\${args[$i]}"
  case "$a" in
    +@*)
      # Gerçek SteamCMD ayarları geri yazar: "@NoPromptForPassword" = "1"
      i=$((i+1)); echo "\\"\${a#+}\\" = \\"\${args[$i]}\\"" ;;
    +force_install_dir) i=$((i+1)); install="\${args[$i]}" ;;
    +login)
      i=$((i+1)); user="\${args[$i]}"
      n="\${args[$((i+1))]}"; if [ -n "$n" ] && [[ "$n" != +* ]]; then i=$((i+1)); pass="$n"; fi
      n="\${args[$((i+1))]}"; if [ -n "$n" ] && [[ "$n" != +* ]]; then i=$((i+1)); code="$n"; fi
      echo "Logging in user '$user' [U:1:0] to Steam Public..."
      if [ -f "$state/ratelimit" ]; then echo "FAILED (Rate Limit Exceeded)"; exit 5; fi
      if [ -f "$state/mobile" ] || [ -f "$state/mobile-deny" ]; then
        echo "This account is protected by a Steam Guard mobile authenticator."
        echo "Please confirm the login in the Steam Mobile app on your phone."
        echo ""
        echo "Waiting for confirmation..."
        if [ -f "$state/mobile-deny" ]; then exit 5; fi
        echo "Waiting for confirmation...OK"
        touch "$state/cached"
        echo "Waiting for client config...OK"
        echo "Waiting for user info...OK"
      else
        if [ ! -f "$state/cached" ]; then
          if [ -z "$pass" ]; then echo "Cached credentials not found."; printf "password: "; read -r x; exit 5; fi
          if [ "$pass" != "dogru-sifre" ]; then echo "FAILED (Invalid Password)"; exit 5; fi
          if [ "$code" != "ABC12" ]; then echo "This computer has not been authenticated for your account using Steam Guard."; printf "Steam Guard code:"; read -r x; exit 5; fi
          touch "$state/cached"
        fi
        echo "OK"
      fi ;;
    +app_update)
      i=$((i+1)); app="\${args[$i]}"
      if [ -n "$bpw" ] && [ "$bpw" != "dogru-beta" ]; then echo "ERROR! Failed to install app '$app' (Invalid beta password $bpw)"; exit 8; fi
      echo " Update state (0x61) downloading, progress: 12.50 (100 / 800)"
      echo " Update state (0x61) downloading, progress: 100.00 (800 / 800)"
      mkdir -p "$install"; touch "$install/arma3server_x64"
      echo "Success! App '$app' fully installed." ;;
    +workshop_download_item)
      i=$((i+2)); id="\${args[$i]}"
      if [ "$id" = "222" ] && [ ! -f "$state/timeout-done" ]; then touch "$state/timeout-done"; echo "ERROR! Download item $id failed (Timeout)."; exit 6; fi
      if [ "$id" = "444" ]; then echo "ERROR! Download item $id failed (Not enough disk space)."; i=$((i+1)); continue; fi
      if [ "$id" = "555" ]; then touch "$state/ratelimit"; echo "ERROR! Download item $id failed (Timeout)."; i=$((i+1)); continue; fi
      d="$install/steamapps/workshop/content/107410/$id"
      mkdir -p "$d/Addons" "$d/Keys"; echo pbo > "$d/Addons/CBA_Main.pbo"; echo key > "$d/Keys/CBA_3.18.bikey"
      echo 'name = "CBA_A3";' > "$d/meta.cpp"
      echo "Success. Downloaded item $id to \\"$d\\" (1234 bytes)" ;;
  esac
  i=$((i+1))
done
exit 0
`;

let root: string;
let ctx: SteamCmdContext;
let guardAsks = 0;
const host = new LocalHost();

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'oezi-steam-'));
  fs.mkdirSync(path.join(root, 'steamcmd'));
  fs.writeFileSync(path.join(root, 'steamcmd', 'steamcmd.sh'), FAKE_STEAMCMD, { mode: 0o755 });
  guardAsks = 0;
  ctx = {
    host,
    steamcmdPath: path.join(root, 'steamcmd', 'steamcmd.sh'),
    credentials: { username: 'halit', password: 'dogru-sifre' },
    askGuardCode: async () => {
      guardAsks++;
      return 'ABC12';
    },
  };
});

describe('SteamCMD', () => {
  it('önbellek yok -> şifre -> Steam Guard kodu ile giriş yapar ve sunucuyu kurar', async () => {
    const progress: number[] = [];
    const lines: string[] = [];
    await updateServer({ ...ctx, onProgress: (p) => progress.push(p), onLine: (l) => lines.push(l) }, { installDir: path.join(root, 'server'), branch: 'creatordlc' });
    expect(guardAsks).toBe(1);
    expect(fs.existsSync(path.join(root, 'server', 'arma3server_x64'))).toBe(true);
    expect(progress).toEqual([12.5, 100]);
    expect(lines.join('\n')).not.toContain('dogru-sifre');
    // ikinci sefer önbellekten, şifresiz ve kodsuz
    await updateServer(ctx, { installDir: path.join(root, 'server') });
    expect(guardAsks).toBe(1);
  });

  it('yanlış şifre anlaşılır hata verir', async () => {
    await expect(updateServer({ ...ctx, credentials: { username: 'halit', password: 'yanlis' } }, { installDir: path.join(root, 's') })).rejects.toMatchObject({
      failure: 'bad_password',
    });
  });

  it('Steam Guard kodu girilmezse iptal', async () => {
    await expect(updateServer({ ...ctx, askGuardCode: async () => null }, { installDir: path.join(root, 's') })).rejects.toBeInstanceOf(SteamCmdError);
  });

  it('Workshop: zaman aşımına uğrayan modu yeniden dener', async () => {
    const res = await downloadWorkshopItems(ctx, { workshopDir: path.join(root, 'ws'), ids: ['111', '222', '333', 'kotu'] });
    expect(res.ok.sort()).toEqual(['111', '222', '333']);
    expect(res.failed).toEqual([]);
  });

  it('SteamCMD yoksa not_found', async () => {
    await expect(updateServer({ ...ctx, steamcmdPath: path.join(root, 'yok.sh') }, { installDir: root })).rejects.toMatchObject({ failure: 'not_found' });
  });

  it('hata tespiti', () => {
    expect(detectFailure(['ERROR! Failed to install app \'233780\' (No subscription)'])).toBe('no_subscription');
    expect(detectFailure(['FAILED login with result code Rate Limit Exceeded'])).toBe('rate_limited');
    expect(detectFailure(['Success! App \'233780\' fully installed.'])).toBeUndefined();
  });
});

describe('Workshop kurulumu', () => {
  it('Linux\'ta küçük harfe çevirir, @klasör bağlar, anahtarları kopyalar ve kaldırırken temizler', async () => {
    await downloadWorkshopItems(ctx, { workshopDir: path.join(root, 'ws'), ids: ['450814997'] });
    const server = path.join(root, 'server');
    fs.mkdirSync(server);
    const res = await installWorkshopMod(host, { serverDir: server, workshopDir: path.join(root, 'ws'), id: '450814997', folder: '@CBA_A3' });
    expect(res.folder).toBe('@cba_a3');
    expect(fs.existsSync(path.join(server, '@cba_a3', 'addons', 'cba_main.pbo'))).toBe(true);
    expect(fs.existsSync(path.join(server, 'keys', 'cba_3.18.bikey'))).toBe(true);
    expect(fs.readlinkSync(path.join(server, '@cba_a3'))).toBe(workshopContentDir('linux', path.join(root, 'ws'), '450814997'));
    // SteamCMD güncellemesi orijinal harflerle tekrar yazarsa
    const content = workshopContentDir('linux', path.join(root, 'ws'), '450814997');
    fs.mkdirSync(path.join(content, 'Addons'));
    fs.writeFileSync(path.join(content, 'Addons', 'CBA_Main.pbo'), 'yeni');
    await installWorkshopMod(host, { serverDir: server, workshopDir: path.join(root, 'ws'), id: '450814997', folder: '@cba_a3' });
    expect(fs.readFileSync(path.join(server, '@cba_a3', 'addons', 'cba_main.pbo'), 'utf8')).toBe('yeni');
    expect(fs.readdirSync(content).sort()).toEqual(['addons', 'keys', 'meta.cpp']);

    await uninstallWorkshopMod(host, server, '@cba_a3');
    expect(fs.existsSync(path.join(server, '@cba_a3'))).toBe(false);
    expect(fs.existsSync(path.join(server, 'keys', 'cba_3.18.bikey'))).toBe(false);
    expect(fs.existsSync(content)).toBe(true);
  });

  it('başka modun da kullandığı anahtar silinmez', async () => {
    await downloadWorkshopItems(ctx, { workshopDir: path.join(root, 'ws'), ids: ['1001', '1002'] });
    const server = path.join(root, 'server');
    fs.mkdirSync(server);
    await installWorkshopMod(host, { serverDir: server, workshopDir: path.join(root, 'ws'), id: '1001', folder: '@a' });
    await installWorkshopMod(host, { serverDir: server, workshopDir: path.join(root, 'ws'), id: '1002', folder: '@b' });
    await uninstallWorkshopMod(host, server, '@a');
    expect(fs.existsSync(path.join(server, 'keys', 'cba_3.18.bikey'))).toBe(true);
  });
});

describe('Workshop yardımcıları', () => {
  it('id ayrıştırma', () => {
    expect(parseWorkshopId('https://steamcommunity.com/sharedfiles/filedetails/?id=450814997&searchtext=')).toBe('450814997');
    expect(parseWorkshopId('463939057')).toBe('463939057');
    expect(parseWorkshopId('cba')).toBeNull();
  });
  it('klasör adı', () => {
    expect(modFolderName('Task Force Arrowhead Radio (BETA!!!)', '1')).toBe('@task_force_arrowhead_radio_beta');
    expect(modFolderName('Türk Silahlı Kuvvetleri Modu', '1')).toBe('@turk_silahli_kuvvetleri_modu');
    expect(modFolderName('!!!', '123')).toBe('@123');
  });
  it('Arma 3 Launcher preset HTML', () => {
    const html = `<html><body><div class="mod-list"><table>
      <tr data-type="ModContainer"><td data-type="DisplayName">CBA_A3</td><td><span class="from-steam">Steam</span></td>
      <td><a href="https://steamcommunity.com/sharedfiles/filedetails/?id=450814997" data-type="Link">link</a></td></tr>
      <tr data-type="ModContainer"><td data-type="DisplayName">ace &amp; friends</td><td><a href="http://steamcommunity.com/sharedfiles/filedetails/?id=463939057" data-type="Link">x</a></td></tr>
      <tr data-type="LocalModContainer"><td data-type="DisplayName">@yerel</td></tr></table></div></body></html>`;
    expect(parseLauncherPreset(html)).toEqual([
      { name: 'CBA_A3', workshopId: '450814997' },
      { name: 'ace & friends', workshopId: '463939057' },
      { name: '@yerel', folder: '@yerel', displayName: '@yerel' },
    ]);
  });
  it('Steam API: mod bilgisi ve koleksiyon (taklit fetch)', async () => {
    const calls: string[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      calls.push(url);
      if (url.includes('GetPublishedFileDetails')) {
        return new Response(
          JSON.stringify({
            response: {
              publishedfiledetails: [
                { publishedfileid: body.get('publishedfileids[0]'), result: 1, title: 'CBA_A3', file_size: '12345', time_updated: 1700000000 },
                { publishedfileid: '999', result: 9 },
              ],
            },
          }),
        );
      }
      const count = Number(body.get('collectioncount'));
      const kids: Record<string, { publishedfileid: string; filetype: number }[]> = {
        C1: [{ publishedfileid: '1', filetype: 0 }, { publishedfileid: 'C2', filetype: 2 }],
        C2: [{ publishedfileid: '2', filetype: 0 }, { publishedfileid: '1', filetype: 0 }],
      };
      return new Response(
        JSON.stringify({
          response: {
            collectiondetails: Array.from({ length: count }, (_, i) => {
              const id = body.get(`publishedfileids[${i}]`)!;
              return kids[id] ? { publishedfileid: id, result: 1, children: kids[id] } : { publishedfileid: id, result: 9 };
            }),
          },
        }),
      );
    }) as typeof fetch;
    const info = await fetchWorkshopDetails(['450814997', '999'], fakeFetch);
    expect(info[0]).toEqual({ id: '450814997', title: 'CBA_A3', sizeBytes: 12345, updatedAt: 1700000000000, found: true });
    expect(info[1]!.found).toBe(false);
    expect(await fetchCollectionItems('C1', fakeFetch)).toEqual(['1', '2']);
  });
});

/* ---------------- Hata düzeltmeleri için regresyon testleri ---------------- */

const stateDir = () => path.join(root, 'steamcmd', 'state');
const touchState = (name: string) => {
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(path.join(stateDir(), name), '');
};
const calls = () => fs.readFileSync(path.join(stateDir(), 'calls.log'), 'utf8').trim().split('\n');

describe('SteamCMD giriş tespiti', () => {
  it('ayar yankısı ("@NoPromptForPassword" = "1") giriş hatası sayılmaz', () => {
    const out = ['"@ShutdownOnFailedCommand" = "1"', '"@NoPromptForPassword" = "1"', "Logging in user 'halit' [U:1:0] to Steam Public...OK", 'Waiting for user info...OK', "Success! App '233780' fully installed."];
    expect(detectFailure(out)).toBeUndefined();
  });

  it('önbellekli giriş: tek çağrıda, şifre gönderilmeden kurar', async () => {
    touchState('cached');
    await updateServer(ctx, { installDir: path.join(root, 'server') });
    expect(calls()).toHaveLength(1);
    expect(calls()[0]).not.toContain('dogru-sifre');
    expect(fs.existsSync(path.join(root, 'server', 'arma3server_x64'))).toBe(true);
  });

  it('gerçek giriş hataları tanınır', () => {
    expect(detectFailure(["Logging in user 'x' to Steam Public...", 'Cached credentials not found.', 'password:'])).toBe('password_required');
    expect(detectFailure(["Logging in user 'x' to Steam Public...", 'FAILED (Invalid Password)'])).toBe('bad_password');
    expect(detectFailure(["Logging in user 'x' to Steam Public...FAILED (Two-factor code mismatch)"])).toBe('guard_required');
    expect(detectFailure(['Login Failure: Rate Limit Exceeded'])).toBe('rate_limited');
    expect(detectFailure(["Logging in user 'x' to Steam Public...", 'FAILED (No Connection)'])).toBe('login_failed');
  });

  it('telefon onayı: onaylanıp giriş tamamlanırsa başarı, onaylanmazsa mobile_confirm', () => {
    const pending = ["Logging in user 'x' to Steam Public...", 'Please confirm the login in the Steam Mobile app on your phone.', 'Waiting for confirmation...'];
    expect(detectFailure(pending)).toBe('mobile_confirm');
    expect(detectFailure([...pending, 'Waiting for confirmation...OK', 'Waiting for user info...OK', "Success! App '233780' fully installed."])).toBeUndefined();
  });

  it('telefon onayı verilen giriş sunucuyu kurar', async () => {
    touchState('mobile');
    await updateServer(ctx, { installDir: path.join(root, 'server') });
    expect(fs.existsSync(path.join(root, 'server', 'arma3server_x64'))).toBe(true);
  });

  it('telefon onayı verilmezse mobile_confirm hatası', async () => {
    touchState('mobile-deny');
    await expect(updateServer(ctx, { installDir: path.join(root, 'server') })).rejects.toMatchObject({ failure: 'mobile_confirm' });
  });
});

describe('SteamCMD beta dalı', () => {
  it('dal yoksa/public ise "-beta public" gönderilir (betadan çıkış)', async () => {
    expect(appUpdateArgs({})).toEqual(['+app_update', '233780', '-beta', 'public']);
    expect(appUpdateArgs({ branch: 'public', branchPassword: 'x' })).toEqual(['+app_update', '233780', '-beta', 'public']);
    expect(appUpdateArgs({ branch: 'profiling', branchPassword: 'p', validate: true })).toEqual(['+app_update', '233780', '-beta', 'profiling', '-betapassword', 'p', 'validate']);
    touchState('cached');
    await updateServer(ctx, { installDir: path.join(root, 'server') });
    expect(calls()[0]).toContain('+app_update 233780 -beta public');
  });

  it('beta şifresi ve Steam şifresi günlükte ve hata çıktısında maskelenir', async () => {
    touchState('echoargs');
    const lines: string[] = [];
    const err = (await updateServer({ ...ctx, onLine: (l) => lines.push(l) }, { installDir: path.join(root, 'server'), branch: 'creatordlc', branchPassword: 'gizli-beta' }).catch((e: unknown) => e)) as SteamCmdError;
    expect(err).toBeInstanceOf(SteamCmdError);
    const all = [...lines, ...err.output, err.message].join('\n');
    expect(all).toContain('******');
    expect(all).not.toContain('gizli-beta');
    expect(all).not.toContain('dogru-sifre');
    expect(maskSteamCmdArgs(['+login', 'u', 'pw', '+app_update', '1', '-betapassword', 'bp'], ['pw'])).toEqual(['+login', 'u', '******', '+app_update', '1', '-betapassword', '******']);
  });
});

describe('Workshop toplu hata', () => {
  it('toplu hatada (disk dolu) başarılı modlar kaybolmaz, hata fırlatılmaz', async () => {
    touchState('cached');
    const res = await downloadWorkshopItems(ctx, { workshopDir: path.join(root, 'ws'), ids: ['111', '444', '333'] });
    expect(res.ok.sort()).toEqual(['111', '333']);
    expect(res.failed).toEqual([{ id: '444', failure: 'disk_space', message: expect.any(String) }]);
    expect(res.stoppedBy?.failure).toBe('disk_space');
    expect(calls()).toHaveLength(1);
  });

  it('sonraki turda giriş hatası: hata fırlatılır ama önceki turda başarılı olanlar err.partial içinde', async () => {
    touchState('cached');
    const err = (await downloadWorkshopItems(ctx, { workshopDir: path.join(root, 'ws'), ids: ['111', '555'] }).catch((e: unknown) => e)) as SteamCmdError;
    expect(err).toBeInstanceOf(SteamCmdError);
    expect(err.failure).toBe('rate_limited');
    expect(err.partial?.ok).toEqual(['111']);
    expect(err.partial?.failed.map((f) => f.id)).toEqual(['555']);
  });
});

describe('lowercaseTree (Linux, LocalHost)', () => {
  it('kısmi Workshop güncellemesinde klasörleri birleştirir, değişmeyen dosyaları silmez', async () => {
    const d = path.join(root, "mod 'x' \"y\"");
    const w = (rel: string, content: string) => {
      fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
      fs.writeFileSync(path.join(d, rel), content);
    };
    // Önceki kurulum (küçük harfe çevrilmiş)
    w('addons/a.pbo', 'eski-a');
    w('addons/b.pbo', 'eski-b');
    w('addons/sub dir/x.paa', 'eski-x');
    w('addons/.gizli', 'g');
    w('keys/cba.bikey', 'k');
    // SteamCMD sadece değişenleri orijinal harflerle yazdı
    w('Addons/A.pbo', 'yeni-a');
    w('Addons/New File.PBO', 'yeni');
    w('Addons/Sub Dir/Y.paa', 'yeni-y');
    w("Addons/It's.pbo", 'tirnak');
    w('Addons/.Gizli2', 'g2');
    w('META.cpp', 'meta');
    await lowercaseTree(host, d);
    const read = (rel: string) => fs.readFileSync(path.join(d, rel), 'utf8');
    expect(read('addons/a.pbo')).toBe('yeni-a');
    expect(read('addons/b.pbo')).toBe('eski-b');
    expect(read('addons/sub dir/x.paa')).toBe('eski-x');
    expect(read('addons/sub dir/y.paa')).toBe('yeni-y');
    expect(read('addons/new file.pbo')).toBe('yeni');
    expect(read("addons/it's.pbo")).toBe('tirnak');
    expect(read('addons/.gizli')).toBe('g');
    expect(read('addons/.gizli2')).toBe('g2');
    expect(read('meta.cpp')).toBe('meta');
    expect(fs.readdirSync(d).sort()).toEqual(['addons', 'keys', 'meta.cpp']);
    expect(fs.readdirSync(path.join(d, 'addons')).sort()).toEqual(['.gizli', '.gizli2', 'a.pbo', 'b.pbo', "it's.pbo", 'new file.pbo', 'sub dir']);
    // ikinci çalıştırmada yapacak iş yok
    expect(await lowercaseTree(host, d)).toBe(0);
  });

  it('dosya <-> klasör tür değişiminde eskisini değiştirir', async () => {
    const d = path.join(root, 'm');
    fs.mkdirSync(path.join(d, 'thing'), { recursive: true });
    fs.writeFileSync(path.join(d, 'thing', 'old.txt'), 'x');
    fs.writeFileSync(path.join(d, 'THING'), 'dosya');
    expect(await lowercaseTree(host, d)).toBe(1);
    expect(fs.readFileSync(path.join(d, 'thing'), 'utf8')).toBe('dosya');
  });
});

describe('Anahtar senkronu', () => {
  it('mod güncellemesinde adı değişen anahtarın eskisi silinir; başkasının/elle konan anahtara dokunulmaz', async () => {
    const server = path.join(root, 'server');
    const modA = path.join(root, 'modA');
    const modB = path.join(root, 'modB');
    fs.mkdirSync(path.join(modA, 'keys'), { recursive: true });
    fs.mkdirSync(path.join(modB, 'keys'), { recursive: true });
    fs.mkdirSync(path.join(server, 'keys'), { recursive: true });
    fs.writeFileSync(path.join(server, 'keys', 'elle.bikey'), 'elle');
    fs.writeFileSync(path.join(modA, 'keys', 'cba_3.18.bikey'), 'a');
    fs.writeFileSync(path.join(modA, 'keys', 'ortak.bikey'), 'o');
    fs.writeFileSync(path.join(modB, 'keys', 'ortak.bikey'), 'o');
    await syncModKeys(host, server, modA, '@a');
    await syncModKeys(host, server, modB, '@b');
    // @a güncellendi: anahtar adı değişti, ortak anahtarı artık getirmiyor
    fs.rmSync(path.join(modA, 'keys', 'cba_3.18.bikey'));
    fs.rmSync(path.join(modA, 'keys', 'ortak.bikey'));
    fs.writeFileSync(path.join(modA, 'keys', 'cba_3.19.bikey'), 'a2');
    expect(await syncModKeys(host, server, modA, '@a')).toEqual(['cba_3.19.bikey']);
    const keys = fs.readdirSync(path.join(server, 'keys')).filter((k) => k.endsWith('.bikey')).sort();
    expect(keys).toEqual(['cba_3.19.bikey', 'elle.bikey', 'ortak.bikey']);
    const manifest = JSON.parse(fs.readFileSync(path.join(server, 'keys', '.oezi-keys.json'), 'utf8')) as { keys: Record<string, string[]> };
    expect(manifest.keys).toEqual({ 'cba_3.19.bikey': ['@a'], 'ortak.bikey': ['@b'] });
  });
});

describe('Koleksiyon tespiti', () => {
  it('file_type olmadan da GetCollectionDetails ile (tek toplu istek) koleksiyonu tanır', async () => {
    const urls: string[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      urls.push(url);
      const body = new URLSearchParams(String(init?.body));
      if (url.includes('GetPublishedFileDetails')) {
        return new Response(
          JSON.stringify({
            response: {
              publishedfiledetails: [
                { publishedfileid: '100', result: 1, title: 'Koleksiyon' },
                { publishedfileid: '200', result: 1, title: 'Mod', creator_app_id: 107410, consumer_app_id: 107410 },
                { publishedfileid: '300', result: 1, title: 'Boş koleksiyon', creator_app_id: 766, consumer_app_id: 107410 },
                { publishedfileid: '400', result: 1, title: 'Tools ile yüklenmiş mod' },
              ],
            },
          }),
        );
      }
      const ids = Array.from({ length: Number(body.get('collectioncount')) }, (_, i) => body.get(`publishedfileids[${i}]`));
      expect(ids).toEqual(['100', '400']);
      return new Response(
        JSON.stringify({ response: { collectiondetails: [{ publishedfileid: '100', result: 1, children: [{ publishedfileid: '200', filetype: 0 }] }, { publishedfileid: '400', result: 9 }] } }),
      );
    }) as typeof fetch;
    const info = await fetchWorkshopDetails(['100', '200', '300', '400'], fakeFetch);
    expect(info.map((i) => [i.id, !!i.isCollection])).toEqual([
      ['100', true],
      ['200', false],
      ['300', true],
      ['400', false],
    ]);
    expect(urls.filter((u) => u.includes('GetCollectionDetails'))).toHaveLength(1);
  });

  it('GetCollectionDetails başarısızsa mod bilgisi yine döner', async () => {
    const fakeFetch = (async (url: string) =>
      url.includes('GetPublishedFileDetails')
        ? new Response(JSON.stringify({ response: { publishedfiledetails: [{ publishedfileid: '1', result: 1, title: 'M' }] } }))
        : new Response('x', { status: 500 })) as typeof fetch;
    expect(await fetchWorkshopDetails(['1'], fakeFetch)).toEqual([{ id: '1', title: 'M', sizeBytes: 0, updatedAt: 0, found: true }]);
  });
});

describe('Launcher preset yerel modlar ve klasör adları', () => {
  it('yerel modun klasör adı Link yolundaki son klasörden alınır', () => {
    const html = `<table>
      <tr data-type="ModContainer"><td data-type="DisplayName">Benim Modum</td><td><span class="from-local">Local</span></td>
      <td><span data-type="Link" data-meta="local:C:\\Arma 3\\Mods\\@benim_mod\\|@benim_mod|">C:\\Arma 3\\Mods\\@benim_mod\\</span></td></tr>
      <tr data-type="ModContainer"><td data-type="DisplayName">Diğer</td><td><span data-type="Link">local:D:\\Mods\\@diger;x\\</span></td></tr>
      <tr data-type="LocalModContainer"><td data-type="DisplayName">Kötü: ad?. </td></tr></table>`;
    expect(parseLauncherPreset(html)).toEqual([
      { name: '@benim_mod', folder: '@benim_mod', displayName: 'Benim Modum' },
      { name: '@diger_x', folder: '@diger_x', displayName: 'Diğer' },
      { name: 'Kötü_ ad_', folder: 'Kötü_ ad_', displayName: 'Kötü: ad?.' },
    ]);
  });

  it('klasör adı temizleme', () => {
    expect(sanitizeFolderName('@a;b')).toBe('@a_b');
    expect(sanitizeFolderName('a<b>c:d"e/f\\g|h?i*j')).toBe('a_b_c_d_e_f_g_h_i_j');
    expect(sanitizeFolderName('ad\u0001x')).toBe('ad_x');
    expect(sanitizeFolderName('@mod. . ')).toBe('@mod');
    expect(sanitizeFolderName('CON')).toBe('_CON');
    expect(sanitizeFolderName('...')).toBe('');
  });
});

describe('steamclient.so (servis kullanıcısı)', () => {
  it('verilen kullanıcının ev klasörüne kopyalar (getent ile)', async () => {
    const home = path.join(root, 'home arma');
    const bin = path.join(root, 'bin');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(bin);
    const me = os.userInfo().username;
    fs.writeFileSync(path.join(bin, 'getent'), `#!/bin/sh\n[ "$2" = "${me}" ] && echo "${me}:x:0:0::${home}:/bin/sh"\nexit 0\n`, { mode: 0o755 });
    fs.mkdirSync(path.join(root, 'steamcmd', 'linux64'));
    fs.writeFileSync(path.join(root, 'steamcmd', 'linux64', 'steamclient.so'), 'so');
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath}`;
    try {
      expect(await ensureLinuxSteamClient(host, ctx.steamcmdPath, me)).toBe('copied');
      expect(fs.readFileSync(path.join(home, '.steam', 'sdk64', 'steamclient.so'), 'utf8')).toBe('so');
      expect(await ensureLinuxSteamClient(host, ctx.steamcmdPath, me)).toBe('ok');
      await expect(ensureLinuxSteamClient(host, ctx.steamcmdPath, 'olmayan_kullanici')).rejects.toThrow(/bulunamadı/);
      await expect(ensureLinuxSteamClient(host, ctx.steamcmdPath, 'kotu;ad')).rejects.toThrow(/Geçersiz/);
    } finally {
      process.env.PATH = oldPath;
    }
  });
});

describe('SteamCMD ilk çalıştırma', () => {
  const script = (body: string) => {
    const p = path.join(root, 'steamcmd', 'first.sh');
    fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return p;
  };

  it('başarılı ilk çalıştırma', async () => {
    const lines: string[] = [];
    await firstRunSteamCmd(host, script('echo "Steam Console Client (c) Valve Corporation"; echo "Update complete, launching..."; exit 7'), { onLine: (l) => lines.push(l) });
    expect(lines[0]).toContain('Steam Console Client');
  });

  it('eksik 32-bit kütüphaneler anlaşılır hata verir', async () => {
    const p = script('echo "steamcmd.sh: line 39: /x/linux32/steamcmd: error while loading shared libraries: libstdc++.so.6: cannot open shared object file: No such file or directory" >&2; exit 127');
    await expect(firstRunSteamCmd(host, p)).rejects.toMatchObject({ failure: 'missing_libs', message: expect.stringContaining('lib32gcc-s1') });
  });

  it('takılırsa süre sınırında durdurulur; stdin kapalıdır', async () => {
    // stdin kapalı değilse read beklerdi; kapalıysa hemen geçer, sonra uyur
    const p = script('read x; echo "stdin kapali"; exec sleep 30');
    const lines: string[] = [];
    await expect(firstRunSteamCmd(host, p, { timeoutMs: 500, onLine: (l) => lines.push(l) })).rejects.toMatchObject({ failure: 'stalled' });
    expect(lines).toContain('stdin kapali');
  });

  it('iptal edilebilir', async () => {
    const p = script('exec sleep 30');
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    await expect(firstRunSteamCmd(host, p, { signal: ac.signal })).rejects.toMatchObject({ failure: 'aborted' });
  });
});
