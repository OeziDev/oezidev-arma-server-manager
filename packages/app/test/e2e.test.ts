/**
 * Uçtan uca test: gerçek Electron uygulaması (Xvfb altında) + sahte Arma sunucusu + sahte RCON.
 * Çalıştırma: xvfb-run -a env E2E=1 npx vitest run packages/app/test/e2e.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import electronPath from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FakeRconServer } from '../../core/test/fakeRcon.js';

const RUN = process.env.E2E === '1';
const SHOTS = process.env.E2E_SHOTS ?? path.join(os.tmpdir(), 'oezi-shots');
const appDir = path.resolve(__dirname, '..');

const FAKE_ARMA = `#!/bin/bash
echo "Arma 3 Console version 2.20.152984 x64 : port 2302"
echo "FAKE ARMA $*"
echo " 14:30:01 BattlEye Server: Initialized (v1.220)"
echo " 14:30:02 Host identity created."
echo " 14:30:03 Warning Message: No entry 'bin\\\\config.bin/CfgVehicles.Something'"
echo " 14:30:04 Error in expression <player setPos [0,0,0]>"
echo " 14:30:05 Game started."
dir="$(pwd)"
trap 'echo "Server stopped"; exit 0' TERM
i=0
while true; do
  if [ -f "$dir/shutdown.flag" ]; then rm -f "$dir/shutdown.flag"; echo "Server shutting down (RCON)"; exit 0; fi
  i=$((i+1)); if [ $((i % 20)) -eq 0 ]; then echo " Server load: FPS 47, memory used: 2133 MB, out: 1820 Kbps, in: 412 Kbps, NG:0, G:340, BE-NG:0, BE-G:0, Players: 31 (L:0, R:31, B:0, G:0)"; fi
  # @oezi_monitor benzeri performans satırı (~2 sn'de bir, değerler biraz oynar)
  if [ $((i % 20)) -eq 10 ]; then echo ' 14:30:06 [OEZI-PERF] {"fps":'$((42 + RANDOM % 8)).$((RANDOM % 10))',"fpsMin":'$((28 + RANDOM % 6)).$((RANDOM % 10))',"players":'$((29 + RANDOM % 4))',"ai":'$((400 + RANDOM % 30))',"groups":'$((55 + RANDOM % 6))',"vehicles":96,"objects":12,"time":120,"mission":"altislife","world":"Altis"}'; fi
  sleep 0.1
done
`;

describe.skipIf(!RUN)('Electron uçtan uca', () => {
  let app: ElectronApplication;
  let page: Page;
  let serverDir: string;
  let rcon: FakeRconServer;
  const shot = async (name: string) => {
    fs.mkdirSync(SHOTS, { recursive: true });
    // README görselleri için: bildirimleri gizle (E2E_CLEAN_SHOTS=1)
    if (process.env.E2E_CLEAN_SHOTS === '1') await page.addStyleTag({ content: '.toasts { display: none !important; }' });
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  };

  beforeAll(async () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'oezi-e2e-data-'));
    serverDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oezi-e2e-server-'));
    fs.writeFileSync(path.join(serverDir, 'arma3server_x64'), FAKE_ARMA, { mode: 0o755 });
    fs.mkdirSync(path.join(serverDir, 'mpmissions'));
    for (const m of ['altislife.altis.pbo', 'co10_escape.tanoa.pbo', 'koth.malden.pbo']) fs.writeFileSync(path.join(serverDir, 'mpmissions', m), 'PBO');
    fs.mkdirSync(path.join(serverDir, '@cba_a3', 'addons'), { recursive: true });
    fs.mkdirSync(path.join(serverDir, '@cba_a3', 'keys'), { recursive: true });
    fs.writeFileSync(path.join(serverDir, '@cba_a3', 'keys', 'cba_3.18.bikey'), 'k');
    fs.writeFileSync(path.join(serverDir, '@cba_a3', 'meta.cpp'), 'publishedid = 450814997;\nname = "CBA_A3";\n');
    fs.mkdirSync(path.join(serverDir, '@extdb3', 'addons'), { recursive: true });

    rcon = new FakeRconServer('E2eRconSifresi123');
    await rcon.start(2307);
    // Sahte RCON: #shutdown gelince sahte sunucu kapanır
    const iv = setInterval(() => {
      const idx = rcon.received.indexOf('#shutdown');
      if (idx >= 0) {
        rcon.received[idx] = '#shutdown-handled';
        fs.writeFileSync(path.join(serverDir, 'shutdown.flag'), '');
      }
    }, 50);
    afterAll(() => clearInterval(iv));

    app = await electron.launch({
      executablePath: electronPath as unknown as string,
      args: [appDir],
      env: { ...process.env, OEZI_NO_SANDBOX: '1', OEZI_USER_DATA: userData, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
    });
    page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForSelector('.brand-mark');
  }, 60_000);

  afterAll(async () => {
    try {
      await page?.evaluate(async () => {
        const list = await window.oezi.profiles.list();
        for (const p of list) await window.oezi.server.stop(p.id).catch(() => undefined);
      });
    } catch {
      /* yoksay */
    }
    await app?.close();
    rcon?.close();
  });

  it('karşılama ekranı ve yeni sunucu oluşturma', async () => {
    await shot('01-welcome');
    await page.getByRole('button', { name: 'Yeni sunucu' }).first().click();
    await page.getByPlaceholder('ArmaTürk Altis Life').fill('ArmaTürk Altis Life');
    await page.locator('.modal input.mono').first().fill(serverDir);
    await shot('02-new-server');
    await page.getByRole('button', { name: 'Sunucuyu oluştur' }).click();
    await page.waitForSelector('.server-title');
    expect(await page.locator('.server-title').textContent()).toBe('ArmaTürk Altis Life');
    await shot('03-config-server');
  });

  it('yapılandırma: alan düzenle, hata göster, kaydet', async () => {
    await page.getByRole('button', { name: 'Genel', exact: true }).click();
    const hostname = page.locator('.field', { hasText: 'Sunucu adı' }).locator('input');
    await hostname.fill('[TR] "ArmaTürk" Altis Life | Discord: discord.gg/xyz');
    await page.locator('.field', { hasText: 'Karşılama mesajları' }).locator('textarea').fill('Hoş geldin!\nKurallar: discord.gg/xyz');
    await shot('04-config-general-dirty');
    await page.getByRole('button', { name: 'Ağ ve performans' }).click();
    const mets = page.locator('.field', { hasText: 'MinErrorToSend' }).first().locator('input');
    await mets.fill('0,005');
    await page.waitForTimeout(500);
    await shot('05-config-network');
    await page.getByRole('button', { name: 'Zorluk' }).click();
    await shot('06-config-difficulty');
    await page.locator('.dirty-bar').getByRole('button', { name: 'Kaydet' }).click();
    await page.waitForSelector('.dirty-bar', { state: 'detached' });
    const id = await page.evaluate(async () => (await window.oezi.profiles.list())[0]!.id);
    const prof = await page.evaluate((pid) => window.oezi.profiles.get(pid), id);
    expect(prof.general.hostname).toBe('[TR] "ArmaTürk" Altis Life | Discord: discord.gg/xyz');
    expect(prof.basic.minErrorToSend).toBe(0.005);
  });

  it('görevler ve modlar', async () => {
    await page.getByRole('tab', { name: 'Görevler' }).click();
    await page.getByRole('button', { name: 'Klasörü tara' }).click();
    await page.waitForSelector('text=altislife.altis');
    await page.locator('.rot-item', { hasText: 'altislife.altis' }).getByRole('button', { name: 'Rotasyona ekle' }).click();
    await page.locator('.rot-item', { hasText: 'koth.malden' }).getByRole('button', { name: 'Rotasyona ekle' }).click();
    await shot('07-missions');
    await page.getByRole('tab', { name: 'Modlar' }).click();
    await page.locator('.panel', { hasText: 'Sunucu klasöründeki @modlar' }).getByRole('button', { name: 'Klasörü tara' }).click();
    await page.waitForSelector('text=CBA_A3');
    await page.locator('tr', { hasText: '@cba_a3' }).getByRole('button', { name: '-mod' }).click();
    await page.locator('tr', { hasText: '@extdb3' }).getByRole('button', { name: '-serverMod' }).click();
    await shot('08-mods');
    await page.locator('.dirty-bar').getByRole('button', { name: 'Kaydet' }).click();
    await page.waitForSelector('.dirty-bar', { state: 'detached' });
  });

  it('başlatma sekmesi: RCON şifresi ve zamanlı restart', async () => {
    await page.getByRole('tab', { name: 'Başlatma ve izleme' }).click();
    const pw = page.locator('.field', { hasText: 'RCON şifresi' }).locator('input');
    await pw.fill('E2eRconSifresi123');
    await page.locator('input[type=time]').fill('05:00');
    await page.getByRole('button', { name: 'Saat ekle' }).click();
    await shot('09-launch');
    await page.locator('.dirty-bar').getByRole('button', { name: 'Kaydet' }).click();
    await page.waitForSelector('.dirty-bar', { state: 'detached' });
  });

  it('dosya önizleme doğru config üretir', async () => {
    await page.getByRole('tab', { name: 'Dosyalar' }).click();
    await page.waitForSelector('pre.code:has-text("hostname")');
    const cfg = await page.locator('pre.code').textContent();
    expect(cfg).toContain('hostname = "[TR] ""ArmaTürk"" Altis Life | Discord: discord.gg/xyz";');
    expect(cfg).toContain('template = "altislife.altis";');
    await shot('10-files');
    await page.getByRole('tab', { name: 'Komut satırı' }).click();
    const cmd = await page.locator('pre.code').textContent();
    expect(cmd).toContain(' -mod=@cba_a3 ');
    expect(cmd).toContain(' -serverMod=@extdb3 ');
  });

  it('başlat, konsol, oyuncular (RCON), durdur', async () => {
    await page.getByRole('tab', { name: 'Genel bakış' }).click();
    await shot('11-overview-stopped');
    await page.locator('.head-actions').getByRole('button', { name: 'Başlat' }).click();
    await page.waitForSelector('.fact-value[data-s="running"]', { timeout: 20_000 });
    await page.getByRole('tab', { name: 'Konsol' }).click();
    await page.waitForSelector('text=Game started.', { timeout: 10_000 });
    await shot('12-console');
    // RCON 20 sn gecikmeyle bağlanır
    await page.waitForFunction(() => document.querySelectorAll('.fact-value')[5]?.textContent === 'Bağlı', undefined, { timeout: 40_000 });
    rcon.pushMessage('(Global) Mehmet: Selam millet, sunucu ne zaman restart?');
    rcon.pushMessage('Player #31 Ayşe Yılmaz (85.10.1.2:2304) connected');
    await page.getByRole('tab', { name: 'Oyuncular' }).click();
    await page.waitForSelector('text=Oyuncu 0 Çağrı');
    await shot('13-players');
    await page.getByPlaceholder('Herkese mesaj gönder').fill('Sunucu 5 dakika sonra yeniden başlayacak');
    await page.getByRole('button', { name: 'Gönder' }).click();
    await page.waitForTimeout(400);
    expect(rcon.received).toContain('say -1 Sunucu 5 dakika sonra yeniden başlayacak');
    // Performans: izleme varsayılan açık; ilk örnek monitoring.sampleSec (10 sn) içinde gelir
    await page.getByRole('tab', { name: 'Performans' }).click();
    await page.waitForSelector('.perf-tiles');
    await page.waitForFunction(() => [...document.querySelectorAll('.chart path.line')].some((p) => (p.getAttribute('d') ?? '').includes('L')), undefined, { timeout: 30_000 }).catch(() => undefined);
    await shot('19-performance');
    await page.getByRole('tab', { name: 'Genel bakış' }).click();
    await shot('14-overview-running');
    await page.locator('.head-actions').getByRole('button', { name: 'Durdur' }).click();
    await page.locator('.modal').getByRole('button', { name: 'Onayla' }).click();
    await page.waitForSelector('.fact-value[data-s="stopped"]', { timeout: 30_000 });
    expect(rcon.received).toContain('#shutdown-handled');
  }, 180_000);

  it('yedekler sekmesi', async () => {
    await page.getByRole('tab', { name: 'Yedekler' }).click();
    await page.waitForSelector('.panel-head h3:has-text("Yedekler")');
    await page.getByRole('button', { name: 'Şimdi yedekle' }).waitFor();
    await page.waitForTimeout(500);
    await shot('20-backups');
    // Oyuncular > Geçmiş alt sekmesi RCON olmadan da açılır
    await page.getByRole('tab', { name: 'Oyuncular' }).click();
    await page.getByRole('tab', { name: 'Geçmiş' }).click();
    await page.waitForSelector('input[placeholder="Ad, GUID, IP ya da not ara"]');
    await page.getByRole('tab', { name: 'Çevrimiçi' }).click();
  });

  it('makineler ve ayarlar ekranları', async () => {
    await page.getByRole('button', { name: 'Makineler' }).click();
    await page.getByRole('button', { name: 'Makine ekle' }).click();
    await page.locator('.modal input').nth(0).fill('Test VPS');
    await page.locator('.modal input').nth(1).fill('127.0.0.1');
    await page.locator('.modal input').nth(2).fill('2222');
    await page.locator('.modal input').nth(3).fill('armatest');
    await page.locator('.modal input[type=password]').fill('TestSifre123!');
    await page.getByRole('button', { name: 'Bağlantıyı test et' }).click();
    await page.waitForSelector('text=Sunucu parmak izi', { timeout: 15_000 });
    await shot('15-host-dialog');
    await page.locator('.modal').getByRole('button', { name: 'Kaydet' }).click();
    await page.waitForSelector('text=armatest@127.0.0.1:2222');
    await shot('16-hosts');
    await page.getByRole('button', { name: 'Ayarlar' }).click();
    await shot('17-settings');
    await page.getByRole('button', { name: 'English' }).click();
    await page.waitForSelector('text=Minimize to tray on close');
    await shot('18-settings-en');
  });
});
