import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalHost } from '../src/host/local.js';
import { SshHost } from '../src/host/ssh.js';
import type { Host } from '../src/host/types.js';
import { scanMissions, scanMods, uploadMission } from '../src/scan.js';

// Test sshd portu (varsayılan 2222); başka portta geçici bir sshd ile denemek için OEZI_SSH_PORT
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => Promise<boolean> | boolean, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await sleep(100);
  }
  throw new Error('zaman aşımı');
}

const FAKE_SERVER = `#!/bin/bash
echo "Fake Arma 3 server starting $@"
i=0
trap 'echo "SIGTERM alındı"; exit 0' TERM
while true; do i=$((i+1)); echo "tick $i"; sleep 0.2; done
`;

function hostSuite(name: string, makeHost: () => Promise<{ host: Host; root: string; cleanup: () => Promise<void> }>) {
  describe(name, () => {
    let host: Host;
    let root: string;
    let cleanup: () => Promise<void>;
    let j: (...parts: string[]) => string;

    beforeAll(async () => {
      ({ host, root, cleanup } = await makeHost());
      await host.connect();
      j = (...parts) => path.posix.join(root, ...parts);
    });
    afterAll(async () => {
      await cleanup();
      await host.close();
    });

    it('atomik yazma, okuma, stat, listeleme', async () => {
      await host.writeFile(j('a', 'b', 'server.cfg'), 'hostname = "Türkçe ğüşiöç";\n');
      expect(await host.readText(j('a', 'b', 'server.cfg'))).toBe('hostname = "Türkçe ğüşiöç";\n');
      expect(await host.exists(j('a', 'b', 'server.cfg'))).toBe(true);
      expect(await host.exists(j('yok'))).toBe(false);
      const st = await host.stat(j('a', 'b'));
      expect(st?.isDir).toBe(true);
      const list = await host.list(j('a', 'b'));
      expect(list.map((e) => e.name)).toEqual(['server.cfg']);
      // geçici dosya kalmamalı
      expect(list.some((e) => e.name.endsWith('.tmp'))).toBe(false);
    });

    it('klasör bağlantısı (symlink), readLink, bağlantıyı silince hedef kalır', async () => {
      await host.writeFile(j('workshop', '450814997', 'addons', 'cba.pbo'), 'x');
      await host.linkDir(j('workshop', '450814997'), j('server', '@cba_a3'));
      const list = await host.list(j('server'));
      expect(list).toEqual([expect.objectContaining({ name: '@cba_a3', isDir: true, isSymlink: true })]);
      expect(await host.readLink(j('server', '@cba_a3'))).toBe(j('workshop', '450814997'));
      // aynı hedefe tekrar bağlamak sorun değil
      await host.linkDir(j('workshop', '450814997'), j('server', '@cba_a3'));
      await host.remove(j('server', '@cba_a3'), { recursive: true });
      expect(await host.exists(j('server', '@cba_a3'))).toBe(false);
      expect(await host.exists(j('workshop', '450814997', 'addons', 'cba.pbo'))).toBe(true);
    });

    it('kopyala, taşı, yükle', async () => {
      await host.writeFile(j('c', 'x.bikey'), 'key');
      await host.copyFile(j('c', 'x.bikey'), j('keys', 'x.bikey'));
      await host.rename(j('keys', 'x.bikey'), j('keys', 'y.bikey'));
      expect(await host.readText(j('keys', 'y.bikey'))).toBe('key');
      const local = path.join(os.tmpdir(), `oezi-upload-${Date.now()}.pbo`);
      fs.writeFileSync(local, 'PBO');
      await host.upload(local, j('up', 'mission.pbo'));
      expect(await host.readText(j('up', 'mission.pbo'))).toBe('PBO');
      fs.rmSync(local);
    });

    it('kök klasörü silmeyi reddeder', async () => {
      await expect(host.remove('/', { recursive: true })).rejects.toThrow();
    });

    it('exec: boşluk ve tırnak içeren argümanlar güvenle geçer', async () => {
      const res = await host.exec('printf', ['%s|', 'a b', `it's`, '"q"', '$HOME', ';rm -rf /']);
      expect(res.code).toBe(0);
      expect(res.stdout).toBe(`a b|it's|"q"|$HOME|;rm -rf /|`);
      const fail = await host.exec('sh', ['-c', 'exit 3']);
      expect(fail.code).toBe(3);
    });

    it('spawn: canlı çıktı, stdin ve pid', async () => {
      const proc = host.spawn('sh', ['-c', 'read x; echo "girdi:$x"; echo hata >&2']);
      let out = '';
      let err = '';
      proc.onData((c, s) => (s === 'stdout' ? (out += c) : (err += c)));
      expect(await proc.pid).toBeGreaterThan(0);
      proc.write('kod123\n');
      expect(await proc.wait()).toBe(0);
      expect(out).toContain('girdi:kod123');
      expect(err).toContain('hata');
    });

    it('arka planda başlat, takip et, log tail, kapat', async () => {
      await host.writeFile(j('srv', 'fake_arma'), FAKE_SERVER);
      await host.exec('chmod', ['+x', j('srv', 'fake_arma')]);
      const log = j('srv', 'profiles', 'server-stdout.log');
      const pid = await host.startDetached(j('srv', 'fake_arma'), ['-port=2302', '-name=my server'], { cwd: j('srv'), logFile: log });
      expect(pid).toBeGreaterThan(0);
      const info = await host.processInfo(pid);
      expect(info.alive).toBe(true);
      const lines: string[] = [];
      const t = host.tail(log, (l) => lines.push(...l), { initialLines: 50 });
      await waitFor(() => lines.some((l) => l.startsWith('tick 3')));
      expect(lines[0]).toBe('Fake Arma 3 server starting -port=2302 -name=my server');
      await host.killProcess(pid);
      await waitFor(async () => !(await host.processInfo(pid)).alive);
      t.stop();
      expect((await host.readText(log)).includes('SIGTERM alındı')).toBe(true);
    });

    it('görev ve mod taraması', async () => {
      const srv = j('scan');
      await host.writeFile(j('scan', 'mpmissions', 'altislife.Altis.pbo'), 'p');
      await host.writeFile(j('scan', 'mpmissions', 'co10_escape.Tanoa', 'mission.sqm'), 'm');
      await host.writeFile(j('scan', 'mpmissions', 'readme.txt'), 'r');
      await host.writeFile(j('scan', '@cba_a3', 'meta.cpp'), 'protocol = 1;\npublishedid = 450814997;\nname = "CBA_A3";\n');
      await host.writeFile(j('scan', '@cba_a3', 'addons', 'cba_main.pbo'), 'x');
      await host.writeFile(j('scan', '@cba_a3', 'keys', 'cba_3.18.0.bikey'), 'k');
      await host.writeFile(j('scan', 'keys', 'a3.bikey'), 'k');
      const { missions } = await scanMissions(host, srv);
      expect(missions.map((m) => [m.template, m.island, m.kind])).toEqual([
        ['altislife.Altis', 'Altis', 'pbo'],
        ['co10_escape.Tanoa', 'Tanoa', 'folder'],
      ]);
      const mods = await scanMods(host, srv);
      expect(mods).toEqual([
        expect.objectContaining({ path: '@cba_a3', displayName: 'CBA_A3', workshopId: '450814997', hasAddons: true }),
      ]);
      expect(mods[0]!.keys[0]).toMatch(/cba_3\.18\.0\.bikey$/);

      const local = path.join(os.tmpdir(), `KingOfTheHill.Altis.pbo`);
      fs.writeFileSync(local, 'PBO');
      const template = await uploadMission(host, srv, local);
      expect(template).toBe(host.os === 'linux' ? 'kingofthehill.altis' : 'KingOfTheHill.Altis');
      fs.rmSync(local);
    });

    it('writeFile mode: şifreli cfg sadece sahibi tarafından okunur (0600)', async () => {
      await host.writeFile(j('perm', 'server.cfg'), 'passwordAdmin = "x";\n', { mode: 0o600 });
      const res = await host.exec('stat', ['-c', '%a', j('perm', 'server.cfg')]);
      expect(res.stdout.trim()).toBe('600');
      // üzerine yazınca da 0600 kalır
      await host.writeFile(j('perm', 'server.cfg'), 'passwordAdmin = "y";\n', { mode: 0o600 });
      expect((await host.exec('stat', ['-c', '%a', j('perm', 'server.cfg')])).stdout.trim()).toBe('600');
      expect(await host.readText(j('perm', 'server.cfg'))).toBe('passwordAdmin = "y";\n');
    });

    it('spawn kill: alt süreçler de ölür, wait() takılmaz (steamcmd.sh -> steamcmd)', async () => {
      const proc = host.spawn('sh', ['-c', 'sh -c \'echo inner:$$; exec sleep 300\'; echo bitti']);
      let out = '';
      proc.onData((c) => (out += c));
      await waitFor(() => /inner:\d+/.test(out));
      const inner = Number(/inner:(\d+)/.exec(out)![1]);
      expect((await host.processInfo(inner)).alive).toBe(true);
      await proc.kill();
      const code = await Promise.race([proc.wait(), sleep(4000).then(() => 'takıldı')]);
      expect(code).not.toBe('takıldı');
      await waitFor(async () => !(await host.processInfo(inner)).alive);
      expect(out).not.toContain('__OEZI_PID__');
    });

    it('exec timeoutMs: hemen döner ve süreç grubunu öldürür', async () => {
      const start = Date.now();
      const res = await host.exec('sh', ['-c', 'sleep 300 & echo $!; wait'], { timeoutMs: 800 });
      expect(Date.now() - start).toBeLessThan(3000);
      expect(res.timedOut).toBe(true);
      expect(res.code).toBeNull();
      const child = Number(res.stdout.trim());
      expect(child).toBeGreaterThan(0);
      await waitFor(async () => !(await host.processInfo(child)).alive, 8000);
      // normal komutta timedOut yok
      const ok = await host.exec('echo', ['tamam'], { timeoutMs: 5000 });
      expect(ok).toMatchObject({ code: 0, stdout: 'tamam\n' });
      expect(ok.timedOut).toBeFalsy();
    });

    it('followCommand stop: takip edilen süreç ve alt süreçleri kalmaz', async () => {
      const lines: string[] = [];
      const t = host.followCommand('sh', ['-c', 'echo pid:$$; while :; do sleep 1; done'], (l) => lines.push(...l));
      await waitFor(() => lines.some((l) => l.startsWith('pid:')));
      const pid = Number(lines.find((l) => l.startsWith('pid:'))!.slice(4));
      expect(lines.some((l) => l.includes('__OEZI_PID__'))).toBe(false);
      expect((await host.processInfo(pid, { commandLine: true })).commandLine).toContain('while');
      t.stop();
      await waitFor(async () => !(await host.processInfo(pid)).alive);
    });

    it('tail: yarım son satır ayrı satır olarak bölünmez', async () => {
      const log = j('tail2', 'a.log');
      await host.writeFile(log, 'bir\niki\nyar');
      const lines: string[] = [];
      const t = host.tail(log, (l) => lines.push(...l), { initialLines: 10 });
      await waitFor(() => lines.includes('iki'));
      await host.exec('sh', ['-c', 'printf "ım satır\\nüç\\n" >> "$1"', 'sh', log]);
      await waitFor(() => lines.includes('üç'));
      t.stop();
      expect(lines).toEqual(['bir', 'iki', 'yarım satır', 'üç']);
    });

    it('getRemoteTime: host saati (ms)', async () => {
      const t = await host.getRemoteTime!();
      expect(Math.abs(t - Date.now())).toBeLessThan(5000);
    });

    it('Linux: sadece "MPMissions" varsa kullanılmaz, uyarı döner; yükleme küçük harfli klasöre', async () => {
      if (host.os !== 'linux') return;
      const srv = j('case');
      await host.writeFile(j('case', 'MPMissions', 'eski.Altis.pbo'), 'p');
      const r = await scanMissions(host, srv);
      expect(r.dir).toBeNull();
      expect(r.missions).toEqual([]);
      expect(r.wrongCaseDir).toBe(j('case', 'MPMissions'));
      expect(r.warning).toMatch(/mpmissions/);
      const local = path.join(os.tmpdir(), `Yeni.Altis.pbo`);
      fs.writeFileSync(local, 'PBO');
      await uploadMission(host, srv, local);
      fs.rmSync(local);
      expect(await host.exists(j('case', 'mpmissions', 'yeni.altis.pbo'))).toBe(true);
      const r2 = await scanMissions(host, srv);
      expect(r2.dir).toBe(j('case', 'mpmissions'));
      expect(r2.missions.map((m) => m.template)).toEqual(['yeni.altis']);
      expect(r2.warning).toMatch(/okunmaz/);
    });
  });
}

hostSuite('LocalHost', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oezi-local-'));
  return { host: new LocalHost(), root, cleanup: async () => fs.rmSync(root, { recursive: true, force: true }) };
});

describe.skipIf(!SSH_AVAILABLE)('SSH', () => {
  hostSuite('SshHost (gerçek sshd)', async () => {
    const host = new SshHost({ id: 'test', host: '127.0.0.1', port: SSH_PORT, username: 'armatest', password: 'TestSifre123!' });
    const root = `/home/armatest/oezi-test-${Date.now()}`;
    return {
      host,
      root,
      cleanup: async () => {
        await host.remove(root, { recursive: true });
      },
    };
  });

  it('close(): takip edilen uzak süreçler (journalctl -f gibi) çalışır halde kalmaz', async () => {
    const cfg = { host: '127.0.0.1', port: SSH_PORT, username: 'armatest', password: 'TestSifre123!' };
    const host = new SshHost({ id: 'c1', ...cfg });
    await host.connect();
    const lines: string[] = [];
    host.followCommand('sh', ['-c', 'echo pid:$$; exec sleep 300'], (l) => lines.push(...l));
    await waitFor(() => lines.some((l) => l.startsWith('pid:')));
    const pid = Number(lines.find((l) => l.startsWith('pid:'))!.slice(4));
    await host.close();
    const check = new SshHost({ id: 'c2', ...cfg });
    await check.connect();
    try {
      await waitFor(async () => !(await check.processInfo(pid)).alive);
    } finally {
      await check.close();
    }
  });

  it('yanlış şifre ve değişmiş parmak izi reddedilir', async () => {
    const bad = new SshHost({ id: 'x', host: '127.0.0.1', port: SSH_PORT, username: 'armatest', password: 'yanlis' });
    await expect(bad.connect()).rejects.toMatchObject({ code: 'auth_failed' });
    const good = new SshHost({ id: 'y', host: '127.0.0.1', port: SSH_PORT, username: 'armatest', password: 'TestSifre123!' });
    await good.connect();
    expect(good.fingerprint).toMatch(/^SHA256:/);
    await good.close();
    const spoofed = new SshHost({ id: 'z', host: '127.0.0.1', port: SSH_PORT, username: 'armatest', password: 'TestSifre123!', expectedFingerprint: 'SHA256:baska' });
    await expect(spoofed.connect()).rejects.toMatchObject({ code: 'host_key_mismatch' });
  });
});
