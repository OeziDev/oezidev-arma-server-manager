import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalHost } from '../src/host/local.js';
import { buildPbo, parsePbo } from '../src/monitor/pbo.js';
import { buildMonitorPbo, ensureMonitorMod, generateMonitorScript } from '../src/monitor/monitorMod.js';
import { parsePerfLine } from '../src/monitor/perf.js';
import { MetricsStore } from '../src/monitor/metrics.js';
import { FpsAlertTracker } from '../src/monitor/fpsAlert.js';
import { LinuxCpuTracker, parseLinuxProcessStatsOutput, parseProcPidStat, parseWinProcessStats, WindowsCpuTracker } from '../src/monitor/procstat.js';

describe('PBO yazıcı', () => {
  it('Vers girdisi, özellikler, dosyalar, sonlandırıcı, veri ve SHA1 doğru yazılır; geri okunur', () => {
    const buf = buildPbo(
      [
        { path: 'config.cpp', data: 'class CfgPatches {};\n' },
        { path: 'functions/fn_init.sqf', data: Buffer.from('diag_log "x";') },
        { path: 'empty.txt', data: '' },
      ],
      { prefix: 'oezi_monitor', product: 'test' },
    );
    // İlk girdi: boş ad + PackingMethod 0x56657273 ("Vers", little endian => "sreV")
    expect(buf[0]).toBe(0);
    expect(buf.readUInt32LE(1)).toBe(0x56657273);
    expect(buf.subarray(1, 5).toString('latin1')).toBe('sreV');
    expect([buf.readUInt32LE(5), buf.readUInt32LE(9), buf.readUInt32LE(13), buf.readUInt32LE(17)]).toEqual([0, 0, 0, 0]);
    // Özellikler: prefix\0oezi_monitor\0product\0test\0\0
    expect(buf.subarray(21, 21 + 35).toString('latin1')).toBe('prefix\0oezi_monitor\0product\0test\0\0c'); // ardından ilk dosya adı
    // Sondaki 21 bayt: 0x00 + öncesinin SHA1'i
    const body = buf.subarray(0, buf.length - 21);
    expect(buf[buf.length - 21]).toBe(0);
    expect(buf.subarray(buf.length - 20)).toEqual(createHash('sha1').update(body).digest());

    const parsed = parsePbo(buf);
    expect(parsed.checksumOk).toBe(true);
    expect(parsed.props).toEqual({ prefix: 'oezi_monitor', product: 'test' });
    expect(parsed.files.map((f) => f.path)).toEqual(['config.cpp', 'functions\\fn_init.sqf', 'empty.txt']);
    expect(parsed.files[0]!.data.toString()).toBe('class CfgPatches {};\n');
    expect(parsed.files[1]!.data.toString()).toBe('diag_log "x";');
    expect(parsed.files[2]!.data.length).toBe(0);
    expect(parsed.files.every((f) => f.packing === 0 && f.timestamp === 0)).toBe(true);

    // Bozulan içerik SHA1 kontrolünden geçmez
    const broken = Buffer.from(buf);
    broken[buf.length - 30] ^= 0xff;
    expect(parsePbo(broken).checksumOk).toBe(false);
  });

  it('aynı içerik aynı baytları üretir; aynı dosya iki kez eklenemez', () => {
    expect(buildMonitorPbo().equals(buildMonitorPbo())).toBe(true);
    expect(() => buildPbo([{ path: 'a.sqf', data: '' }, { path: 'A.sqf', data: '' }], {})).toThrow();
  });
});

describe('@oezi_monitor modu', () => {
  it('PBO içeriği: prefix, config.cpp (postInit) ve sabit 10 sn aralıklı script', () => {
    const parsed = parsePbo(buildMonitorPbo());
    expect(parsed.checksumOk).toBe(true);
    expect(parsed.props.prefix).toBe('oezi_monitor');
    const cfg = parsed.files.find((f) => f.path === 'config.cpp')!.data.toString();
    expect(cfg).toContain('requiredAddons[] = {"A3_Functions_F"};');
    expect(cfg).toContain('class oezi_monitor');
    expect(cfg).toContain('file = "\\oezi_monitor\\functions";');
    expect(cfg).toContain('postInit = 1;');
    const sqf = parsed.files.find((f) => f.path === 'functions\\fn_init.sqf')!.data.toString();
    expect(sqf).toContain('if (!isServer) exitWith {};');
    expect(sqf).toContain('oezi_monitor_sampleSec = 10;');
    expect(sqf).toContain('diag_log text ("[OEZI-PERF] " + _json);');
    expect(sqf).toContain('allPlayers - _hcs');
    // Profil ayarı gömülmez: her zaman aynı baytlar
    expect(generateMonitorScript()).toBe(generateMonitorScript());
    expect(buildMonitorPbo().equals(buildMonitorPbo())).toBe(true);
  });

  it('ensureMonitorMod sadece içerik değişince yazar', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oezi-mon-'));
    const host = new LocalHost();
    const a = await ensureMonitorMod(host, dir);
    expect(a).toEqual({ folder: path.join(dir, '@oezi_monitor'), changed: true });
    const pbo = path.join(dir, '@oezi_monitor', 'addons', 'oezi_monitor.pbo');
    expect(parsePbo(fs.readFileSync(pbo)).checksumOk).toBe(true);
    expect(fs.readFileSync(path.join(dir, '@oezi_monitor', 'mod.cpp'), 'utf8')).toContain('name = "OeziDev Monitor";');
    const mtime = fs.statSync(pbo).mtimeMs;
    // Aynı klasörü paylaşan (farklı sampleSec'li) profiller birbirinin dosyasını yeniden yazmaz
    expect((await ensureMonitorMod(host, dir)).changed).toBe(false);
    expect(fs.statSync(pbo).mtimeMs).toBe(mtime);
    fs.writeFileSync(pbo, 'bozuk');
    expect((await ensureMonitorMod(host, dir)).changed).toBe(true);
  });
});

describe('performans satırı çözümleme', () => {
  const base = { fps: 47.3, fpsMin: 31.0, players: 12, ai: 240, groups: 60, vehicles: 85, objects: 14, time: 3605, world: 'Altis' };
  it('RPT satırı (zaman damgalı), tırnak içeren görev adı', () => {
    // SQF kaçışı: " -> \" , \ -> \\
    const line = `12:00:01 [OEZI-PERF] {"fps":47.3,"fpsMin":31.0,"players":12,"ai":240,"groups":60,"vehicles":85,"objects":14,"time":3605,"mission":"Op \\"Red\\" C:\\\\x","world":"Altis"}`;
    expect(parsePerfLine(line, 1000)).toEqual({ t: 1000, ...base, mission: 'Op "Red" C:\\x' });
  });
  it('tırnaklı diag_log biçimi ("" ikilenmiş) ve journald öneki', () => {
    const line = `Oct 17 12:00:01 vps arma3server[1]: 12:00:01 "[OEZI-PERF] {""fps"":20,""fpsMin"":5,""players"":0,""ai"":0,""groups"":0,""vehicles"":0,""mission"":""m"",""world"":""Stratis""}"`;
    expect(parsePerfLine(line, 5)).toMatchObject({ t: 5, fps: 20, fpsMin: 5, mission: 'm', world: 'Stratis' });
  });
  it('bozuk / ilgisiz satırlar null', () => {
    expect(parsePerfLine('12:00 Host identity created.')).toBeNull();
    expect(parsePerfLine('[OEZI-PERF] {"fps":')).toBeNull();
    expect(parsePerfLine('[OEZI-PERF] {"players":3}')).toBeNull();
  });
});

describe('MetricsStore', () => {
  it('son 1 saat ham, eskisi dakikada bir nokta; 24 saatten eskisi atılır; JSON geri yüklenir', () => {
    const m = new MetricsStore();
    const t0 = Date.UTC(2026, 9, 17, 0, 0, 0);
    // 3 saat boyunca 10 sn'de bir
    for (let t = t0; t <= t0 + 3 * 3600_000; t += 10_000) m.push({ t, fps: 40 + ((t / 10_000) % 2), fpsMin: 30 + ((t / 10_000) % 6), players: (t / 10_000) % 7, cpu: 25 });
    const all = m.query();
    const newest = t0 + 3 * 3600_000;
    const old = all.filter((s) => s.t < newest - 3600_000);
    const recent = all.filter((s) => s.t >= newest - 3600_000);
    expect(recent.length).toBe(361);
    // 2 saat => 120 dakika noktası (bir de doldurulmakta olan dakika olabilir)
    expect(old.length).toBeGreaterThanOrEqual(120);
    expect(old.length).toBeLessThanOrEqual(121);
    expect(old.every((s) => s.t % 60_000 === 0)).toBe(true);
    const p = old[5]!;
    expect(p.fps).toBe(40.5);
    expect(p.fpsMin).toBe(30); // dakikanın en düşüğü
    expect(p.players).toBe(6); // dakikanın en yükseği
    expect(p.cpu).toBe(25);
    expect(m.query(newest - 60_000).length).toBe(7);

    // 25 saat sonra: 24 saatten eskiler atılır
    m.push({ t: newest + 22 * 3600_000, fps: 50 });
    expect(m.query()[0]!.t).toBeGreaterThanOrEqual(newest + 22 * 3600_000 - 24 * 3600_000);

    const json = JSON.parse(JSON.stringify(m));
    const back = MetricsStore.fromJSON(json, {}, newest + 22 * 3600_000);
    expect(back.query()).toEqual(m.query());
  });
});

describe('FPS uyarısı', () => {
  const cfg = { belowFps: 15, minutes: 3 };
  it('3 dk boyunca bütün örnekler eşiğin altındaysa bir kez uyarır, 2 dk düzelince yeniden kurulur', () => {
    const a = new FpsAlertTracker();
    const t0 = 1_000_000;
    const events: string[] = [];
    const feed = (from: number, to: number, fps: number) => {
      for (let t = from; t <= to; t += 10_000) {
        const e = a.update(t0 + t, fps, cfg);
        if (e) events.push(`${e.kind}@${t / 1000}`);
      }
    };
    feed(0, 170_000, 10); // 2 dk 50 sn: henüz değil
    expect(events).toEqual([]);
    feed(180_000, 400_000, 10);
    expect(events).toEqual(['alert@180']);
    // kısa düzelme (1 dk) yetmez, tekrar düşünce yeni uyarı yok
    feed(410_000, 470_000, 30);
    feed(480_000, 800_000, 10);
    expect(events).toEqual(['alert@180']);
    // 2 dk düzelme: yeniden kurulur
    feed(810_000, 930_000, 30);
    expect(events).toEqual(['alert@180', 'recovered@930']);
    // Yeniden kuruldu ama 30 dk bekleme süresi dolmadan yeni uyarı yok (ilk uyarı 180 sn'de)
    feed(940_000, 1_970_000, 5);
    expect(events).toEqual(['alert@180', 'recovered@930']);
    feed(1_980_000, 1_990_000, 5);
    expect(events).toEqual(['alert@180', 'recovered@930', 'alert@1980']);
    // reset() (yeniden başlatma) bekleme süresini sıfırlamaz
    a.reset();
    feed(2_000_000, 2_400_000, 30);
    feed(2_410_000, 2_700_000, 5);
    expect(events).toHaveLength(3);
  });
  it('bekleme süresi ayarlanabilir', () => {
    const a = new FpsAlertTracker();
    const c = { ...cfg, cooldownMs: 0 };
    const events: string[] = [];
    for (let t = 0; t <= 1_200_000; t += 10_000) {
      const fps = t < 400_000 || t > 600_000 ? 5 : 30;
      const e = a.update(t, fps, c);
      if (e) events.push(e.kind);
    }
    expect(events).toEqual(['alert', 'recovered', 'alert']);
  });
  it('arada iyi bir örnek seriyi bozar; en az 3 örnek gerekir; 0 dk kapalı', () => {
    const a = new FpsAlertTracker();
    expect(a.update(0, 5, cfg)).toBeNull();
    expect(a.update(100_000, 20, cfg)).toBeNull();
    expect(a.update(120_000, 5, cfg)).toBeNull();
    expect(a.update(300_000, 5, cfg)).toBeNull(); // sadece 2 örnek
    expect(a.update(310_000, 5, cfg)?.kind).toBe('alert');
    const b = new FpsAlertTracker();
    for (let t = 0; t < 600_000; t += 10_000) expect(b.update(t, 1, { belowFps: 15, minutes: 0 })).toBeNull();
  });
});

describe('süreç CPU / RAM', () => {
  it('/proc ayrıştırma ve fark hesabı', () => {
    const stat = (ticks: number) => `4242 (arma3server x) S 1 4242 4242 0 -1 4194560 100 0 0 0 ${ticks} 0 0 0 20 0 30 0 777 123456789 25600 18446744073709551615`;
    expect(parseProcPidStat(stat(100))).toEqual({ pid: 4242, ticks: 100, startTime: 777, rssPages: 25600 });
    const out = `cpu  100 0 100 800 0 0 0 0 0 0\nPAGESIZE 4096\nP ${stat(50)}\n`;
    const parsed = parseLinuxProcessStatsOutput(out);
    expect(parsed.total).toBe(1000);
    const tr = new LinuxCpuTracker();
    tr.update(parsed.total!, parsed.samples, parsed.pageSize, [4242, 9999]);
    expect(tr.hasBaseline([4242, 9999])).toBe(true);
    const r = tr.update(2000, [parseProcPidStat(stat(300))!], 4096, [4242]);
    expect(r).toEqual([{ pid: 4242, cpuPercent: 25, memMB: 100 }]);
    const w = new WindowsCpuTracker();
    expect(parseWinProcessStats('12 1000 104857600\r\n13 5 1\r\n')).toEqual([
      { pid: 12, cpuMs: 1000, workingSet: 104857600 },
      { pid: 13, cpuMs: 5, workingSet: 1 },
    ]);
    w.update([{ pid: 12, cpuMs: 1000, workingSet: 1048576 }], 0, 4);
    expect(w.update([{ pid: 12, cpuMs: 3000, workingSet: 1048576 }], 1000, 4)).toEqual([{ pid: 12, cpuPercent: 50, memMB: 1 }]);
  });

  it('Windows: 500 ms\'lik çift okuma pid başına en fazla bir kez', () => {
    const w = new WindowsCpuTracker();
    expect(w.needsPrime([12])).toBe(true);
    // Önceki ölçüm yokken bile ikinci kez istenmez (ör. ilk okuma başarısız oldu ya da ölçüm unutuldu)
    expect(w.needsPrime([12])).toBe(false);
    w.update([{ pid: 12, cpuMs: 1000, workingSet: 1 }], 0, 4);
    expect(w.needsPrime([12])).toBe(false);
    // Yeni pid (headless client) gelince bir kez daha
    expect(w.needsPrime([12, 13])).toBe(true);
    expect(w.needsPrime([12, 13])).toBe(false);
    // Uzun aradan sonra (önceki ölçüm silindi) yine çift okuma yok
    w.update([{ pid: 12, cpuMs: 2000, workingSet: 1 }], 11 * 60_000, 4, [12]);
    expect(w.hasBaseline([13])).toBe(false);
    expect(w.needsPrime([13])).toBe(false);
  });

  it.runIf(process.platform === 'linux')('yerel Linux: meşgul döngü CPU > 0, olmayan PID atlanır', async () => {
    const child = spawn(process.execPath, ['-e', 'const end=Date.now()+20000; while(Date.now()<end){}'], { stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 200));
      const host = new LocalHost();
      const first = await host.processStats([child.pid!, 999_999_999]);
      expect(first).toHaveLength(1);
      expect(first[0]!.pid).toBe(child.pid);
      expect(first[0]!.cpuPercent).toBeGreaterThan(0);
      expect(first[0]!.memMB).toBeGreaterThan(5);
      await new Promise((r) => setTimeout(r, 300));
      const second = await host.processStats([child.pid!]);
      expect(second[0]!.cpuPercent).toBeGreaterThan(0);
      expect(second[0]!.cpuPercent).toBeLessThanOrEqual(100);
    } finally {
      child.kill('SIGKILL');
    }
  });
});
