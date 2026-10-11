import { describe, expect, it } from 'vitest';
import {
  ConfigSyntaxError,
  asString,
  asStringArray,
  createProfile,
  findClass,
  findValue,
  generateArma3Profile,
  generateBasicCfg,
  generateServerCfg,
  importArma3Profile,
  importBasicCfg,
  importServerCfg,
  parseConfig,
  parseProfile,
  validateProfile,
} from '../src/index.js';

const fixed = { generatedAt: new Date('2026-10-11T10:00:00Z') };
const errors = (issues: { severity: string }[]) => issues.filter((i) => i.severity === 'error');

describe('1) eksik ";" sonraki ifadeyi yutmaz', () => {
  it('sayısal değer + yeni satırda yeni ifade: ikisi de doğru okunur, hata bildirilir', () => {
    const { entries, issues } = parseConfig('maxPlayers = 40\nhostname = "Real Name";');
    expect(findValue(entries, 'maxPlayers')).toBe(40);
    expect(findValue(entries, 'hostname')).toBe('Real Name');
    expect(errors(issues)).toHaveLength(1);
    expect(errors(issues)[0]!.message).toMatch(/';' eksik/);
    expect(errors(issues)[0]!.line).toBe(1);
  });

  it('içe aktarmada iki değer de modele gelir ve sorun raporlanır', () => {
    const { profile, issues } = importServerCfg('maxPlayers = 40\nhostname = "Real Name";');
    expect(profile.general.maxPlayers).toBe(40);
    expect(profile.general.hostname).toBe('Real Name');
    expect(errors(issues).length).toBeGreaterThan(0);
  });

  it('ek satırlarda eksik ";" config üretimini durdurur (sessizce yanlış değer yazılmaz)', () => {
    const p = createProfile({ advanced: { extraServerCfg: 'skipLobby = 1\nzeusCompositionScriptLevel = 2;' } });
    expect(() => generateServerCfg(p, fixed)).toThrow(ConfigSyntaxError);
    const v = validateProfile(p, 'windows').filter((i) => i.code === 'extra.syntax');
    expect(v).toHaveLength(1);
    expect(v[0]!.message.en).toMatch(/Missing ';'/);
  });

  it('dizi ve class başlangıcını da yeni ifade sayar', () => {
    const a = parseConfig('x = abc\nlist[] = {1};\ny = 2\nclass Foo { z = 3; };');
    expect(findValue(a.entries, 'x')).toBe('abc');
    expect(findValue(a.entries, 'list')).toEqual([1]);
    expect(findValue(a.entries, 'y')).toBe(2);
    expect(findClass(a.entries, 'Foo')).toBeDefined();
    expect(errors(a.issues)).toHaveLength(2);
  });

  it('aynı satırdaki tırnaksız çok kelimeli değer ve son satırdaki eksik ";" hâlâ tolere edilir', () => {
    const a = parseConfig('template = co10 Escape.Altis;\nlast = 5');
    expect(findValue(a.entries, 'template')).toBe('co10 Escape.Altis');
    expect(findValue(a.entries, 'last')).toBe(5);
    expect(errors(a.issues)).toEqual([]);
    expect(a.issues.some((i) => i.severity === 'warning')).toBe(true);
  });

  it('kapanmamış dizi sonraki satırdaki ifadeyi yutmaz', () => {
    const a = parseConfig('motd[] = {"a", "b"\nhostname = "x";');
    expect(findValue(a.entries, 'motd')).toEqual(['a', 'b']);
    expect(findValue(a.entries, 'hostname')).toBe('x');
    expect(errors(a.issues).length).toBeGreaterThan(0);
  });
});

describe('2) oylama: #vote admin varsayılan olarak kapalı', () => {
  it('oylama açık + allowAdminVote kapalı: güvenli allowedVoteCmds ve boş allowedVotedAdminCmds yazılır', () => {
    const cfg = generateServerCfg(createProfile(), fixed);
    const { entries } = parseConfig(cfg);
    expect(findValue(entries, 'allowedVoteCmds')).toEqual([
      ['missions', true, true],
      ['mission', true, true],
      ['kick', false, true],
      ['restart', true, true],
      ['reassign', true, true],
    ]);
    expect(cfg).toContain('\t{"kick", false, true},');
    expect(cfg).toContain('allowedVotedAdminCmds[] = {};');
    expect(cfg).not.toMatch(/"admin"/);
  });

  it('allowAdminVote açıkken iki liste de yazılmaz', () => {
    const cfg = generateServerCfg(createProfile({ voting: { allowAdminVote: true } }), fixed);
    expect(cfg).not.toContain('allowedVoteCmds');
    expect(cfg).not.toContain('allowedVotedAdminCmds');
    expect(cfg).toContain('voteThreshold = 0.33;');
  });

  it.each([
    ['admin oylaması kapalı', { enabled: true, allowAdminVote: false }],
    ['admin oylaması açık', { enabled: true, allowAdminVote: true }],
    ['oylama kapalı', { enabled: false, allowAdminVote: false }],
  ])('üret -> içe aktar -> üret kararlı (%s)', (_label, voting) => {
    const original = createProfile({ voting });
    const cfg1 = generateServerCfg(original, fixed);
    const r = importServerCfg(cfg1);
    expect(r.profile.voting).toMatchObject(voting);
    expect(r.profile.advanced.extraServerCfg).toBe('');
    expect(r.unknownKeys).toEqual([]);
    expect(generateServerCfg(r.profile, fixed)).toBe(cfg1);
  });

  it('varsayılan liste + "admin" -> allowAdminVote = true, ek satıra gitmez', () => {
    const r = importServerCfg(
      'voteThreshold = 0.5;\nallowedVoteCmds[] = {{"admin", true, true}, {"missions", true, true}, {"mission", true, true}, {"kick", false, true}, {"restart", true, true}, {"reassign", true, true}};',
    );
    expect(r.profile.voting).toMatchObject({ enabled: true, allowAdminVote: true, voteThreshold: 0.5 });
    expect(r.profile.advanced.extraServerCfg).not.toContain('allowedVoteCmds');
  });

  it('allowedVoteCmds yoksa (eski cfg) admin oylaması açık sayılır', () => {
    const r = importServerCfg('voteThreshold = 0.33;');
    expect(r.profile.voting).toMatchObject({ enabled: true, allowAdminVote: true });
  });

  it('eşikli ya da farklı liste ek satırlarda kalır', () => {
    const r = importServerCfg('allowedVoteCmds[] = {{"kick", false, false, 0.75}};');
    expect(r.profile.advanced.extraServerCfg).toContain('allowedVoteCmds[]');
    expect(r.profile.voting.enabled).toBe(true);
    // Ek satır üretilen listeyi ezer, tek tanım kalır
    const cfg = generateServerCfg(r.profile, fixed);
    expect(cfg.match(/allowedVoteCmds/g)).toHaveLength(1);
    expect(cfg).toContain('{"kick", false, false, 0.75}');
  });

  it('dolu allowedVotedAdminCmds ek satırlarda korunur', () => {
    const r = importServerCfg('voteThreshold = 0.3;\nallowedVotedAdminCmds[] = {{"kick", true, true}};');
    expect(r.profile.advanced.extraServerCfg).toContain('allowedVotedAdminCmds[]');
  });

  it('cfg oylamadan bahsetmiyorsa mevcut profilin oylama ayarına dokunulmaz', () => {
    const base = createProfile({ voting: { enabled: false } });
    const r = importServerCfg('hostname = "x";', base);
    expect(r.profile.voting.enabled).toBe(false);
    const base2 = createProfile({ voting: { enabled: true, allowAdminVote: false } });
    expect(importServerCfg('hostname = "x";', base2).profile.voting.allowAdminVote).toBe(false);
  });
});

describe('3) forcedDifficulty', () => {
  it('doluysa her görevin difficulty değeri forcedDifficulty olur', () => {
    const p = createProfile({
      missions: {
        forcedDifficulty: 'veteran',
        rotation: [
          { template: 'a.Altis', difficulty: 'recruit' },
          { template: 'b.Tanoa', difficulty: 'custom' },
        ],
      },
    });
    const { entries } = parseConfig(generateServerCfg(p, fixed));
    expect(findValue(entries, 'forcedDifficulty')).toBe('veteran');
    const ms = findClass(entries, 'Missions')!;
    expect(findValue(findClass(ms.entries, 'Mission_1')!.entries, 'difficulty')).toBe('veteran');
    expect(findValue(findClass(ms.entries, 'Mission_2')!.entries, 'difficulty')).toBe('veteran');
  });
  it('boşsa görevin kendi zorluğu yazılır', () => {
    const p = createProfile({ missions: { rotation: [{ template: 'a.Altis', difficulty: 'recruit' }] } });
    const { entries } = parseConfig(generateServerCfg(p, fixed));
    expect(findValue(findClass(findClass(entries, 'Missions')!.entries, 'Mission_1')!.entries, 'difficulty')).toBe('recruit');
  });
});

describe('4) terrainGrid / viewDistance Arma3Profile\'a yazılır', () => {
  const p = createProfile({ basic: { terrainGrid: 25, viewDistance: 3000 } });
  it('basic.cfg\'de yok, Arma3Profile\'ın en üst seviyesinde var', () => {
    expect(generateBasicCfg(p, fixed)).not.toMatch(/terrainGrid|viewDistance/);
    const { entries, issues } = parseConfig(generateArma3Profile(p, fixed));
    expect(issues).toEqual([]);
    expect(findValue(entries, 'viewDistance')).toBe(3000);
    expect(findValue(entries, 'terrainGrid')).toBe(25);
    expect(findClass(entries, 'DifficultyPresets')).toBeDefined();
  });
  it('0 ise yazılmaz', () => {
    expect(generateArma3Profile(createProfile(), fixed)).not.toMatch(/terrainGrid|viewDistance/);
  });
  it('Arma3Profile içe aktarma bunları modele alır (geri dönüş kararlı)', () => {
    const r = importArma3Profile(generateArma3Profile(p, fixed), createProfile());
    expect(r.profile.basic.viewDistance).toBe(3000);
    expect(r.profile.basic.terrainGrid).toBe(25);
  });
  it('eski basic.cfg içindeki değerler de modele alınır, ek satırlara gitmez', () => {
    const r = importBasicCfg(
      'MaxMsgSend = 256;\nterrainGrid = 12.5;\nviewDistance = 2500;\nclass sockets { maxPacketSize = 1300; initBandwidth = 5000; };\nfoo = 1;',
      createProfile(),
    );
    expect(r.profile.basic).toMatchObject({ maxMsgSend: 256, terrainGrid: 12.5, viewDistance: 2500, maxPacketSize: 1300 });
    expect(r.profile.basic.extraBasicCfg).not.toMatch(/terrainGrid|viewDistance|maxPacketSize/);
    expect(r.profile.basic.extraBasicCfg).toContain('initBandwidth = 5000;');
    expect(r.profile.basic.extraBasicCfg).toContain('foo = 1;');
    const { entries } = parseConfig(generateBasicCfg(r.profile, fixed));
    const sockets = findClass(entries, 'sockets')!;
    expect(findValue(sockets.entries, 'maxPacketSize')).toBe(1300);
    expect(findValue(sockets.entries, 'initBandwidth')).toBe(5000);
  });
});

describe('5) boş uzantı listeleri', () => {
  it('her boş liste için uyarı (ilgili alan yolu ile)', () => {
    const p = createProfile({
      paths: { serverDir: 'C:\\server' },
      security: { allowedLoadFileExtensions: [], allowedPreprocessFileExtensions: [], allowedHTMLLoadExtensions: [] },
    });
    const w = validateProfile(p, 'windows').filter((i) => i.code === 'extensions.empty');
    expect(w.map((i) => i.path)).toEqual([
      'security.allowedLoadFileExtensions',
      'security.allowedPreprocessFileExtensions',
      'security.allowedHTMLLoadExtensions',
    ]);
    expect(w.every((i) => i.severity === 'warning' && i.message.tr && i.message.en)).toBe(true);
  });
  it('varsayılan profilde uyarı yok', () => {
    expect(validateProfile(createProfile(), 'windows').some((i) => i.code === 'extensions.empty')).toBe(false);
  });
});

describe('6) ek satırlardaki class üretilen class\'la birleşir', () => {
  it('basic.cfg sockets: initBandwidth eklenir, maxPacketSize kalır', () => {
    const p = createProfile({ basic: { extraBasicCfg: 'class sockets { initBandwidth = 1000; };' } });
    const cfg = generateBasicCfg(p, fixed);
    const { entries } = parseConfig(cfg);
    const sockets = findClass(entries, 'sockets')!;
    expect(findValue(sockets.entries, 'maxPacketSize')).toBe(1400);
    expect(findValue(sockets.entries, 'initBandwidth')).toBe(1000);
    expect(cfg.match(/class sockets/g)).toHaveLength(1);
  });
  it('aynı adlı üye ekten gelir', () => {
    const p = createProfile({ basic: { extraBasicCfg: 'class sockets { maxPacketSize = 1300; };' } });
    const { entries } = parseConfig(generateBasicCfg(p, fixed));
    expect(findValue(findClass(entries, 'sockets')!.entries, 'maxPacketSize')).toBe(1300);
  });
  it('AdvancedOptions ve Missions de birleşir', () => {
    const p = createProfile({
      missions: { rotation: [{ template: 'a.Altis' }] },
      advanced: {
        extraServerCfg: 'class AdvancedOptions { queueSizeLogG = 5; newOpt = 1; };\nclass Missions { class Extra { template = "b.Tanoa"; difficulty = "veteran"; }; };',
      },
    });
    const { entries } = parseConfig(generateServerCfg(p, fixed));
    const adv = findClass(entries, 'AdvancedOptions')!;
    expect(findValue(adv.entries, 'queueSizeLogG')).toBe(5);
    expect(findValue(adv.entries, 'newOpt')).toBe(1);
    expect(findValue(adv.entries, 'LogObjectNotFound')).toBe(true);
    const ms = findClass(entries, 'Missions')!;
    expect(findClass(ms.entries, 'Mission_1')).toBeDefined();
    expect(findClass(ms.entries, 'Extra')).toBeDefined();
  });
  it('değer/class ad çakışmasında ek satır kazanır', () => {
    const p = createProfile({ basic: { extraBasicCfg: 'sockets = 1;' } });
    const cfg = generateBasicCfg(p, fixed);
    expect(cfg).not.toContain('class sockets');
    expect(findValue(parseConfig(cfg).entries, 'sockets')).toBe(1);
  });
});

describe('7) TADST kaçırılmamış tırnakları', () => {
  it('içe aktarılınca dış tırnak kalmaz, çıktıda doğru kaçırılır', () => {
    const r = importServerCfg('hostName = "[TR] "ArmaTurk" Altis Life";\nmaxPlayers = 10;');
    expect(r.profile.general.hostname).toBe('[TR] "ArmaTurk" Altis Life');
    expect(r.issues.some((i) => i.severity === 'warning')).toBe(true);
    expect(generateServerCfg(r.profile, fixed)).toContain('hostname = "[TR] ""ArmaTurk"" Altis Life";');
  });
  it('dizi elemanlarında da çalışır', () => {
    const { entries, issues } = parseConfig('motd[] = {"Hos geldin "Asker"", "ikinci"};');
    expect(errors(issues)).toEqual([]);
    expect(findValue(entries, 'motd')).toEqual(['Hos geldin "Asker"', 'ikinci']);
  });
});

describe('8) geçersiz dizi elemanları içe aktarmayı bozmaz', () => {
  it('filePatchingExceptions içindeki geçersiz ID\'ler atılır, geçerli olan kalır', () => {
    const r = importServerCfg('filePatchingExceptions[] = {"abc","def","76561198000000001"};');
    expect(r.profile.security.filePatchingExceptions).toEqual(['76561198000000001']);
    expect(r.issues.filter((i) => /filePatchingExceptions/.test(i.message))).toHaveLength(2);
  });
  it('bozuk girdilerde asla istisna fırlatmaz', () => {
    const inputs = [
      'filePatchingExceptions[] = {"1","2","3","4","76561198000000001","x"};',
      'class Missions { class M { template = "a.Altis"; class Params { 1 = 2; }; }; };',
      'maxPlayers = 1e999;\nfoo = 1e999;',
      '}}}{{{ = = ;;; "',
      'headlessClients[] = {{1,2},{3}};\nmotd[] = {{"a"}};',
      'kickTimeout[] = {{0, "x"}, {9, 1}};',
    ];
    for (const input of inputs) {
      expect(() => importServerCfg(input)).not.toThrow();
      expect(() => importServerCfg(input, createProfile())).not.toThrow();
    }
  });
});

describe('9) template\'siz (kampanya tarzı) Missions', () => {
  const src = 'class Missions { class Apex {}; class EXP_m01 { difficulty="veteran"; }; };';
  it('Missions sınıfının tamamı ek satırlarda kalır, rotasyon değişmez, uyarı verilir', () => {
    const base = createProfile({ missions: { rotation: [{ template: 'eski.Altis' }] } });
    const r = importServerCfg(src, base);
    expect(r.profile.missions.rotation.map((m) => m.template)).toEqual(['eski.Altis']);
    expect(r.profile.advanced.extraServerCfg).toContain('class Missions');
    expect(r.profile.advanced.extraServerCfg).toContain('class EXP_m01');
    expect(r.unknownKeys).toContain('Missions');
    expect(r.issues.some((i) => i.severity === 'warning' && /Missions/.test(i.message))).toBe(true);
  });
  it('yeni profile aktarılınca üretilen cfg kampanya görevlerini içerir', () => {
    const r = importServerCfg(src);
    expect(r.profile.missions.rotation).toEqual([]);
    const ms = findClass(parseConfig(generateServerCfg(r.profile, fixed)).entries, 'Missions')!;
    expect(findClass(ms.entries, 'Apex')).toBeDefined();
    expect(findValue(findClass(ms.entries, 'EXP_m01')!.entries, 'difficulty')).toBe('veteran');
  });
  it('modellenebilen Missions eskisi gibi rotasyona gider', () => {
    const r = importServerCfg('class Missions { class M1 { template = "a.Altis"; }; };');
    expect(r.profile.missions.rotation.map((m) => m.template)).toEqual(['a.Altis']);
    expect(r.profile.advanced.extraServerCfg).toBe('');
  });
});

describe('10) ek satırlarda önişlemci ve ayrıştırıcı uyarıları', () => {
  it('#include / #define doğrulama hatasıdır', () => {
    const p = createProfile({ paths: { serverDir: 'C:\\server' }, advanced: { extraServerCfg: '#include "x.hpp"\n#define FOO 1\nfoo = 1;' } });
    const errs = validateProfile(p, 'windows').filter((i) => i.code === 'extra.preprocessor');
    expect(errs).toHaveLength(2);
    expect(errs.every((i) => i.severity === 'error' && i.path === 'advanced.extraServerCfg')).toBe(true);
  });
  it('diğer ayrıştırıcı uyarıları doğrulama uyarısı olarak görünür (TR/EN)', () => {
    const p = createProfile({ paths: { serverDir: 'C:\\server' }, basic: { extraBasicCfg: 'foo = 1' } });
    const w = validateProfile(p, 'windows').filter((i) => i.code === 'extra.parseWarning');
    expect(w).toHaveLength(1);
    expect(w[0]!.severity).toBe('warning');
    expect(w[0]!.message.en).toMatch(/Missing ';'/);
    expect(w[0]!.path).toBe('basic.extraBasicCfg');
  });
});

describe('11) headless doğrulamaları', () => {
  it('-ip loopback değilken 127.0.0.1\'e bağlanan HC uyarılır', () => {
    const p = createProfile({ paths: { serverDir: 'C:\\server' }, network: { bindIp: '203.0.113.5' }, headless: { count: 1 } });
    const v = validateProfile(p, 'windows');
    expect(v.find((i) => i.code === 'headless.bindIp')?.severity).toBe('warning');
  });
  it('-ip boş/loopback ise ya da HC doğru IP\'ye bağlanıyorsa uyarı yok', () => {
    for (const p of [
      createProfile({ headless: { count: 1 } }),
      createProfile({ network: { bindIp: '127.0.0.1' }, headless: { count: 1 } }),
      createProfile({ network: { bindIp: '203.0.113.5' }, headless: { count: 1, connectIp: '203.0.113.5', allowedIps: ['203.0.113.5'] } }),
    ]) {
      expect(validateProfile(p, 'windows').some((i) => i.code === 'headless.bindIp')).toBe(false);
    }
  });
  it('HC varsa slot bilgisi verilir', () => {
    const v = validateProfile(createProfile({ headless: { count: 2 } }), 'windows');
    expect(v.find((i) => i.code === 'headless.slots')?.severity).toBe('info');
    expect(validateProfile(createProfile(), 'windows').some((i) => i.code === 'headless.slots')).toBe(false);
  });
});

describe('12) tırnaksız uzun Steam ID\'ler', () => {
  it('17 haneli ID hassasiyet kaybetmez', () => {
    const { entries } = parseConfig('admins[] = {76561198012345679};\nsid = 76561198012345679;\nsmall = 123;');
    expect(asStringArray(findValue(entries, 'admins'))).toEqual(['76561198012345679']);
    expect(asString(findValue(entries, 'sid'))).toBe('76561198012345679');
    expect(findValue(entries, 'small')).toBe(123);
  });
  it('içe aktarmada admin ve filePatching istisnası olarak doğru gelir', () => {
    const r = importServerCfg('admins[] = {76561198012345679};\nfilePatchingExceptions[] = {76561198012345679};');
    expect(r.profile.general.admins).toEqual(['76561198012345679']);
    expect(r.profile.security.filePatchingExceptions).toEqual(['76561198012345679']);
  });
});

describe('13) aynı profil klasörü', () => {
  it('aynı makinede aynı profil klasörü hatadır (Windows\'ta büyük/küçük harf duyarsız)', () => {
    const a = createProfile({ name: 'A', paths: { serverDir: 'C:\\Arma', profilesDir: 'C:\\Arma\\prof' } });
    const b = createProfile({ name: 'B', network: { port: 2402 }, paths: { serverDir: 'C:\\arma', profilesDir: 'c:\\arma\\PROF\\' } });
    expect(validateProfile(a, 'windows', [a, b]).find((i) => i.code === 'profilesDir.clash')?.severity).toBe('error');
    // Linux'ta büyük/küçük harf farklı klasördür
    const la = createProfile({ name: 'A', paths: { serverDir: '/srv/arma', profilesDir: 'prof' } });
    const lb = createProfile({ name: 'B', network: { port: 2402 }, paths: { serverDir: '/srv/arma', profilesDir: 'PROF' } });
    expect(validateProfile(la, 'linux', [la, lb]).some((i) => i.code === 'profilesDir.clash')).toBe(false);
    const lc = createProfile({ name: 'C', network: { port: 2402 }, paths: { serverDir: '/srv/arma', profilesDir: '/srv/arma/prof' } });
    expect(validateProfile(la, 'linux', [la, lc]).some((i) => i.code === 'profilesDir.clash')).toBe(true);
  });
  it('farklı host ya da varsayılan (id\'ye bağlı) klasörler çakışmaz', () => {
    const a = createProfile({ name: 'A', paths: { serverDir: 'C:\\Arma', profilesDir: 'prof' } });
    const b = createProfile({ name: 'B', hostId: 'ssh-1', network: { port: 2402 }, paths: { serverDir: 'C:\\Arma', profilesDir: 'prof' } });
    const c = createProfile({ name: 'C', network: { port: 2502 }, paths: { serverDir: 'C:\\Arma' } });
    const d = createProfile({ name: 'D', network: { port: 2602 }, paths: { serverDir: 'C:\\Arma' } });
    expect(validateProfile(a, 'windows', [a, b]).some((i) => i.code === 'profilesDir.clash')).toBe(false);
    expect(validateProfile(c, 'windows', [c, d]).some((i) => i.code === 'profilesDir.clash')).toBe(false);
  });
});

describe('14) eski / yeni sürüm profilleri', () => {
  it('yeni alanları olmayan eski profil varsayılanlarla açılır, bilinmeyen anahtarlar atılır', () => {
    const old = {
      schemaVersion: 1,
      id: 'abc',
      name: 'Eski',
      voting: { enabled: true, voteThreshold: 0.4 },
      supervisor: { autoRestart: false },
      difficulty: { options: { thirdPersonView: 1, mapContent: 1 } },
      someRemovedField: 42,
    };
    const { profile, errors: errs } = parseProfile(old);
    expect(errs).toEqual([]);
    expect(profile!.voting).toMatchObject({ enabled: true, voteThreshold: 0.4, allowAdminVote: false });
    expect(profile!.supervisor.startTimeoutSec).toBe(300);
    expect(profile!.difficulty.options.tacticalPing).toBe(0);
    expect(profile!.difficulty.options.thirdPersonView).toBe(1);
    expect('someRemovedField' in profile!).toBe(false);
    expect('mapContent' in profile!.difficulty.options).toBe(false);
  });
  it('tacticalPing 3 kabul edilir', () => {
    expect(parseProfile({ difficulty: { options: { tacticalPing: 3 } } }).profile?.difficulty.options.tacticalPing).toBe(3);
  });
  it('daha yeni bir sürümün kaydettiği profil (schemaVersion 2, yeni anahtarlar) reddedilmez', () => {
    const { profile, errors: errs } = parseProfile({ schemaVersion: 2, name: 'Yeni', general: { futureKey: true }, futureSection: {} });
    expect(errs).toEqual([]);
    expect(profile!.schemaVersion).toBe(1);
    expect(profile!.name).toBe('Yeni');
  });
});
