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
import { generateSystemdUnit } from '../src/host/systemd.js';

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
      executable: '/srv/arma3/arma3server_x64',
      args: ['-port=2302', '-mod=@cba_a3;@ace', '-config=/srv/arma3/p/server.cfg'],
      workingDirectory: '/srv/arma3',
      logFile: '/srv/arma3/p/server-stdout.log',
      restart: 'on-failure',
      restartSec: 10,
      startLimitBurst: 5,
    });
    expect(unit).toContain('ExecStart=/srv/arma3/arma3server_x64 -port=2302 "-mod=@cba_a3;@ace" -config=/srv/arma3/p/server.cfg');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('StartLimitBurst=5');
    expect(unit).toContain('StandardOutput=append:/srv/arma3/p/server-stdout.log');
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
