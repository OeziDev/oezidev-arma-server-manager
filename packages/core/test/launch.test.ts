import { describe, expect, it } from 'vitest';
import {
  buildHeadlessLaunch,
  buildServerLaunch,
  createProfile,
  formatCommandLine,
  quotePosixArg,
  quoteSystemdArg,
  quoteWindowsArg,
  resolvePaths,
  splitArgs,
  validateProfile,
} from '../src/index.js';
import { generateSystemdUnit, parseSystemdShow } from '../src/host/systemd.js';
import { processMatches } from '../src/host/types.js';

describe('yollar', () => {
  it('Windows ve Linux için doğru dosya yolları', () => {
    const win = resolvePaths(createProfile({ id: 'abcdef12-0000', paths: { serverDir: 'C:\\Arma 3 Server', profileName: 'altis' } }), 'windows');
    expect(win.executable).toBe('C:\\Arma 3 Server\\arma3server_x64.exe');
    expect(win.profilesDir).toBe('C:\\Arma 3 Server\\oezi-profiles\\abcdef12');
    expect(win.arma3Profiles).toEqual(['C:\\Arma 3 Server\\oezi-profiles\\abcdef12\\Users\\altis\\altis.Arma3Profile']);
    expect(win.beCfg).toBe('C:\\Arma 3 Server\\oezi-profiles\\abcdef12\\BattlEye\\beserver_x64.cfg');
    expect(win.missionsDir).toBe('C:\\Arma 3 Server\\MPMissions');

    const lin = resolvePaths(createProfile({ paths: { serverDir: '/home/arma/server', profilesDir: '/home/arma/profiles/altis', profileName: 'altis' } }), 'linux');
    expect(lin.executable).toBe('/home/arma/server/arma3server_x64');
    expect(lin.arma3Profiles[0]).toBe('/home/arma/profiles/altis/home/altis/altis.Arma3Profile');
    expect(lin.missionsDir).toBe('/home/arma/server/mpmissions');
  });
  it('göreli serverDir reddedilir', () => {
    expect(() => resolvePaths(createProfile({ paths: { serverDir: 'arma' } }), 'linux')).toThrow();
  });
});

describe('komut satırı', () => {
  const base = createProfile({
    paths: { serverDir: '/srv/arma3', profilesDir: '/srv/arma3/p', profileName: 'server' },
    launch: {
      mods: [{ path: '@cba_a3' }, { path: '@ace', enabled: false }, { path: '@acre2' }],
      serverMods: [{ path: '@extdb3' }, { path: '@life_server' }],
      limitFPS: 100,
      extraArgs: '-world=empty "-par=/srv/arma3/my params.txt"',
    },
  });

  it('mod ve serverMod listelerini ayrı ayrı, kapalı modları atlayarak üretir', () => {
    const spec = buildServerLaunch(base, 'linux');
    expect(spec.executable).toBe('/srv/arma3/arma3server_x64');
    expect(spec.cwd).toBe('/srv/arma3');
    expect(spec.args).toEqual([
      '-port=2302',
      '-config=/srv/arma3/p/server.cfg',
      '-cfg=/srv/arma3/p/basic.cfg',
      '-profiles=/srv/arma3/p',
      '-name=server',
      '-bepath=/srv/arma3/p/BattlEye',
      '-mod=@cba_a3;@acre2',
      '-serverMod=@extdb3;@life_server',
      '-loadMissionToMemory',
      '-limitFPS=100',
      '-world=empty',
      '-par=/srv/arma3/my params.txt',
    ]);
    expect(spec.args).not.toContain('-filePatching');
  });

  it('ek parametrede yönetilen anahtar varsa uyarır', () => {
    const p = createProfile({ paths: { serverDir: '/a' }, launch: { extraArgs: '-port=9999' } });
    expect(buildServerLaunch(p, 'linux').warnings[0]).toMatch(/-port/);
  });

  it('headless client: sunucu modlarını değil istemci modlarını yükler, şifreyi geçirir', () => {
    const p = createProfile({ ...base, general: { password: 'gir' }, headless: { count: 1, limitFPS: 60 } });
    const spec = buildHeadlessLaunch(p, 'linux', 1);
    expect(spec.args).toEqual([
      '-client',
      '-connect=127.0.0.1',
      '-port=2302',
      '-profiles=/srv/arma3/p/hc1',
      '-name=hc1',
      '-password=gir',
      '-mod=@cba_a3;@acre2',
      '-limitFPS=60',
    ]);
  });

  it('splitArgs tırnakları doğru böler', () => {
    expect(splitArgs(`-a "-b=c d" '-e=f g' -h=""`)).toEqual(['-a', '-b=c d', '-e=f g', '-h=']);
    expect(() => splitArgs('"açık')).toThrow();
  });

  it('Windows tırnaklama CommandLineToArgvW kurallarına uyar', () => {
    expect(quoteWindowsArg('-config=C:\\Arma 3\\server.cfg')).toBe('"-config=C:\\Arma 3\\server.cfg"');
    expect(quoteWindowsArg('C:\\yol sonu\\')).toBe('"C:\\yol sonu\\\\"');
    expect(quoteWindowsArg('a"b')).toBe('"a\\"b"');
    expect(quoteWindowsArg('-port=2302')).toBe('-port=2302');
  });

  it('POSIX ve systemd tırnaklama', () => {
    expect(quotePosixArg("it's")).toBe(`'it'\\''s'`);
    expect(quotePosixArg('-mod=@a;@b')).toBe(`'-mod=@a;@b'`);
    expect(quoteSystemdArg('-mod=@a;@b')).toBe('"-mod=@a;@b"');
    expect(quoteSystemdArg('100%')).toBe('100%%');
    expect(quoteSystemdArg('$HOME')).toBe('$$HOME');
    expect(quoteSystemdArg('a "b"')).toBe('"a \\"b\\""');
  });

  it('formatCommandLine Windows gösterimi', () => {
    const p = createProfile({ paths: { serverDir: 'C:\\Arma 3', profilesDir: 'C:\\Arma 3\\p' } });
    const line = formatCommandLine(buildServerLaunch(p, 'windows'), 'windows');
    expect(line.startsWith('"C:\\Arma 3\\arma3server_x64.exe" -port=2302 "-config=C:\\Arma 3\\p\\server.cfg"')).toBe(true);
  });
});

describe('systemd unit', () => {
  it('ExecStart argümanlarını güvenli tırnaklar, restart sınırlarını yazar', () => {
    const unit = generateSystemdUnit({
      description: 'Arma 3 - Altis',
      executable: '/srv/Arma 3 Server/arma3server_x64',
      args: ['-port=2302', '-mod=@cba_a3;@ace', '-config=/srv/Arma 3 Server/p/server.cfg'],
      workingDirectory: '/srv/Arma 3 Server/100%',
      restart: 'on-failure',
      restartSec: 10,
      startLimitBurst: 5,
    });
    expect(unit).toContain('ExecStart="/srv/Arma 3 Server/arma3server_x64" -port=2302 "-mod=@cba_a3;@ace" "-config=/srv/Arma 3 Server/p/server.cfg"');
    // WorkingDirectory tırnaklanmaz (systemd tırnağı kaldırmaz), sadece % kaçırılır
    expect(unit).toContain('WorkingDirectory=/srv/Arma 3 Server/100%%');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('StartLimitBurst=5');
    expect(unit).toContain('StandardOutput=journal');
    expect(unit).not.toContain('TimeoutStartSec');
  });

  it('headless gecikmesi başlangıç zaman aşımını uzatır', () => {
    const unit = generateSystemdUnit({ description: 'hc', executable: '/a/b', args: [], workingDirectory: '/a', restart: 'always', restartSec: 5, startLimitBurst: 10, startDelaySec: 300 });
    expect(unit).toContain('ExecStartPre=/bin/sleep 300');
    expect(unit).toContain('TimeoutStartSec=420');
  });

  it('systemctl show çıktısı (systemd 249 uyumlu, --timestamp yok)', () => {
    const st = parseSystemdShow('LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=4242\nNRestarts=2\nActiveEnterTimestampMonotonic=1000000000\n__UPTIME=1600.00\n', 2_000_000);
    expect(st).toEqual({ exists: true, activeState: 'active', subState: 'running', mainPid: 4242, restarts: 2, startedAt: 2_000_000 - 600_000 });
    expect(parseSystemdShow('LoadState=not-found\nActiveState=inactive\n').exists).toBe(false);
  });

  it('süreç eşleşmesi: aynı exe ile çalışan başka profilin süreci eşleşmez', () => {
    const info = { pid: 1, alive: true, image: 'arma3server_x64', commandLine: '/srv/a/arma3server_x64 -port=2312 -profiles=/srv/a/oezi-profiles/b' };
    expect(processMatches(info, '/srv/a/arma3server_x64', '-profiles=/srv/a/oezi-profiles/a')).toBe(false);
    expect(processMatches(info, '/srv/a/arma3server_x64', '-profiles=/srv/a/oezi-profiles/b')).toBe(true);
    expect(processMatches({ ...info, image: 'bash' }, '/srv/a/arma3server_x64')).toBe(false);
  });
});

describe('doğrulama', () => {
  const codes = (p: Parameters<typeof validateProfile>[0], os?: 'linux' | 'windows', others?: Parameters<typeof validateProfile>[2]) =>
    validateProfile(p, os, others).map((i) => i.code);

  it('güvenli bir profilde hata yok', () => {
    const p = createProfile({
      paths: { serverDir: '/srv/a' },
      general: { passwordAdmin: 'cok-uzun-admin-sifresi' },
      rcon: { password: 'cok-uzun-rcon-sifresi' },
      missions: { rotation: [{ template: 'altislife.altis' }] },
    });
    expect(validateProfile(p, 'linux').filter((i) => i.severity !== 'info')).toEqual([]);
  });

  it('RCON şifresi boşsa ve port çakışıyorsa hata', () => {
    const p = createProfile({ paths: { serverDir: '/a' }, rcon: { password: '', port: 2304 } });
    expect(codes(p)).toEqual(expect.arrayContaining(['rcon.noPassword']));
    const p2 = createProfile({ paths: { serverDir: '/a' }, rcon: { password: 'abcdefghijk', port: 2304 } });
    expect(codes(p2)).toContain('rcon.portClash');
  });

  it('headless IP izin listesinde değilse hata', () => {
    const p = createProfile({ paths: { serverDir: '/a' }, headless: { count: 1, connectIp: '10.0.0.5', allowedIps: ['127.0.0.1'] } });
    expect(codes(p)).toContain('headless.ipNotAllowed');
  });

  it('Linux\'ta büyük harfli mod/görev adı uyarısı', () => {
    const p = createProfile({ paths: { serverDir: '/a' }, launch: { mods: [{ path: '@CBA_A3' }] }, missions: { rotation: [{ template: 'AltisLife.Altis' }] } });
    expect(codes(p, 'linux')).toEqual(expect.arrayContaining(['mods.linuxCase', 'missions.linuxCase']));
    expect(codes(p, 'windows')).not.toContain('mods.linuxCase');
  });

  it('aynı makinedeki profillerle port çakışması', () => {
    const a = createProfile({ name: 'A', paths: { serverDir: '/a' }, network: { port: 2302 } });
    const b = createProfile({ name: 'B', paths: { serverDir: '/b' }, network: { port: 2304 } });
    const c = createProfile({ name: 'C', paths: { serverDir: '/c' }, network: { port: 2312 } });
    expect(codes(a, 'linux', [b])).toContain('ports.clash');
    expect(codes(a, 'linux', [c])).not.toContain('ports.clash');
  });

  it('ek satır sözdizimi hatası ve yüksek MinErrorToSend', () => {
    const p = createProfile({ paths: { serverDir: '/a' }, advanced: { extraServerCfg: 'x = "a' }, basic: { minErrorToSend: 1 } });
    expect(codes(p)).toEqual(expect.arrayContaining(['extra.syntax', 'basic.minErrorToSend']));
  });
});
