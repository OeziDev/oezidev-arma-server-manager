import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalHost } from '../src/host/local.js';
import {
  type SteamCmdContext,
  SteamCmdError,
  detectFailure,
  downloadWorkshopItems,
  updateServer,
  workshopContentDir,
} from '../src/steam/steamcmd.js';
import {
  fetchCollectionItems,
  fetchWorkshopDetails,
  installWorkshopMod,
  modFolderName,
  parseLauncherPreset,
  parseWorkshopId,
  uninstallWorkshopMod,
} from '../src/steam/workshop.js';

/**
 * SteamCMD taklidi: önbellekli giriş, şifre, Steam Guard, app_update ve
 * workshop_download_item (ilk denemede zaman aşımı) davranışlarını taklit eder.
 */
const FAKE_STEAMCMD = `#!/bin/bash
dir="$(cd "$(dirname "$0")" && pwd)"
state="$dir/state"; mkdir -p "$state"
install=""; user=""; pass=""; code=""
args=("$@"); i=0
while [ $i -lt \${#args[@]} ]; do
  a="\${args[$i]}"
  case "$a" in
    +force_install_dir) i=$((i+1)); install="\${args[$i]}" ;;
    +login)
      i=$((i+1)); user="\${args[$i]}"
      n="\${args[$((i+1))]}"; if [ -n "$n" ] && [[ "$n" != +* ]]; then i=$((i+1)); pass="$n"; fi
      n="\${args[$((i+1))]}"; if [ -n "$n" ] && [[ "$n" != +* ]]; then i=$((i+1)); code="$n"; fi
      echo "Logging in user '$user' to Steam Public..."
      if [ ! -f "$state/cached" ]; then
        if [ -z "$pass" ]; then echo "Cached credentials not found."; printf "password: "; read -r x; exit 5; fi
        if [ "$pass" != "dogru-sifre" ]; then echo "FAILED (Invalid Password)"; exit 5; fi
        if [ "$code" != "ABC12" ]; then echo "This computer has not been authenticated for your account using Steam Guard."; printf "Steam Guard code:"; read -r x; exit 5; fi
        touch "$state/cached"
      fi
      echo "OK" ;;
    +app_update)
      i=$((i+1)); app="\${args[$i]}"
      echo " Update state (0x61) downloading, progress: 12.50 (100 / 800)"
      echo " Update state (0x61) downloading, progress: 100.00 (800 / 800)"
      mkdir -p "$install"; touch "$install/arma3server_x64"
      echo "Success! App '$app' fully installed." ;;
    +workshop_download_item)
      i=$((i+2)); id="\${args[$i]}"
      if [ "$id" = "222" ] && [ ! -f "$state/timeout-done" ]; then touch "$state/timeout-done"; echo "ERROR! Download item $id failed (Timeout)."; exit 6; fi
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
      { name: '@yerel' },
    ]);
  });
  it('Steam API: mod bilgisi ve koleksiyon (taklit fetch)', async () => {
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
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
      return new Response(
        JSON.stringify({
          response: {
            collectiondetails: [
              { result: 1, children: body.get('publishedfileids[0]') === 'C1' ? [{ publishedfileid: '1', filetype: 0 }, { publishedfileid: 'C2', filetype: 2 }] : [{ publishedfileid: '2', filetype: 0 }, { publishedfileid: '1', filetype: 0 }] },
            ],
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
