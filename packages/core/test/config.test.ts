import { describe, expect, it } from 'vitest';
import {
  ConfigSyntaxError,
  createProfile,
  findClass,
  findValue,
  formatNumber,
  generateArma3Profile,
  generateBasicCfg,
  generateBeServerCfg,
  generateServerCfg,
  importArma3Profile,
  importServerCfg,
  parseConfig,
  quoteString,
  serializeEntries,
  validateProfile,
} from '../src/index.js';

const fixed = { generatedAt: new Date('2026-10-11T10:00:00Z') };

describe('armaConfig yazıcı', () => {
  it('çift tırnakları Arma kuralına göre "" ile kaçırır', () => {
    expect(quoteString('[TR] "ArmaTürk" Altis')).toBe('"[TR] ""ArmaTürk"" Altis"');
  });
  it('satır sonlarını tek satıra indirir', () => {
    expect(quoteString('a\r\nb\nc')).toBe('"a b c"');
  });
  it('sayıları kültürden bağımsız ve üstel gösterimsiz yazar', () => {
    expect(formatNumber(0.001)).toBe('0.001');
    expect(formatNumber(1e-7)).toBe('0.0000001');
    expect(formatNumber(2147483647)).toBe('2147483647');
    expect(formatNumber(-1)).toBe('-1');
    expect(formatNumber(0.33)).toBe('0.33');
    expect(() => formatNumber(Number.NaN)).toThrow();
  });
  it('geçersiz anahtar adını reddeder', () => {
    expect(() => serializeEntries([{ kind: 'value', name: 'bad name', value: 1 }])).toThrow();
  });
});

describe('armaConfig okuyucu', () => {
  it('class, dizi, iç içe dizi, yorum ve kaçışlı string okur', () => {
    const src = `
      // yorum
      hostname = "A ""B"" C"; /* blok
      yorum */
      maxPlayers = 64;
      motd[] = {"bir", "iki",};
      kickTimeout[] = {{0, -1}, {1, 180}};
      loopback = true;
      class Missions {
        class M1 { template = co10_Escape.Altis; difficulty = "veteran"; };
      };
    `;
    const { entries, issues } = parseConfig(src);
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(findValue(entries, 'hostname')).toBe('A "B" C');
    expect(findValue(entries, 'maxplayers')).toBe(64);
    expect(findValue(entries, 'motd')).toEqual(['bir', 'iki']);
    expect(findValue(entries, 'kickTimeout')).toEqual([
      [0, -1],
      [1, 180],
    ]);
    expect(findValue(entries, 'loopback')).toBe(true);
    const m1 = findClass(findClass(entries, 'Missions')!.entries, 'M1')!;
    expect(findValue(m1.entries, 'template')).toBe('co10_Escape.Altis');
  });
  it('TADST\'nin bozuk çıktısını (kaçırılmamış tırnak) uyarıyla kurtarır', () => {
    const { entries, issues } = parseConfig('hostName = "[TR] "ArmaTürk" Altis Life";\nmaxPlayers = 10;');
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(issues.some((i) => i.severity === 'warning' && /tırnak/.test(i.message))).toBe(true);
    expect(findValue(entries, 'hostName')).toBe('[TR] "ArmaTürk" Altis Life');
    expect(findValue(entries, 'maxPlayers')).toBe(10);
  });
  it('string sonrası tırnakla bitmeyen fazlalık hâlâ hatadır', () => {
    const { issues } = parseConfig('hostName = "abc" def;');
    expect(issues.some((i) => i.severity === 'error')).toBe(true);
  });
  it('kapanmamış class bloğunu hata olarak bildirir', () => {
    const { issues } = parseConfig('class A { x = 1;');
    expect(issues.some((i) => i.severity === 'error' && /Kapanmamış/.test(i.message))).toBe(true);
  });
  it('önişlemci satırını uyarıyla atlar', () => {
    const { entries, issues } = parseConfig('#include "x.hpp"\nx = 1;');
    expect(findValue(entries, 'x')).toBe(1);
    expect(issues[0]?.severity).toBe('warning');
  });
});

describe('server.cfg üretimi', () => {
  it('varsayılan profil kendi okuyucumuzla hatasız ayrışır', () => {
    const cfg = generateServerCfg(createProfile(), fixed);
    const { issues } = parseConfig(cfg);
    expect(issues).toEqual([]);
  });

  it('tırnaklı sunucu adı ve MOTD\'yi doğru kaçırır', () => {
    const p = createProfile({ general: { hostname: '[TR] "ArmaTürk" Altis Life', motd: ['Hoş geldin!', 'Discord: "x"'] } });
    const cfg = generateServerCfg(p, fixed);
    expect(cfg).toContain('hostname = "[TR] ""ArmaTürk"" Altis Life";');
    const { entries } = parseConfig(cfg);
    expect(findValue(entries, 'hostname')).toBe('[TR] "ArmaTürk" Altis Life');
    expect(findValue(entries, 'motd')).toEqual(['Hoş geldin!', 'Discord: "x"']);
  });

  it('kickClientsOnSlowNetwork dizisini {ping, paketKaybı, desync, timeout} sırasıyla yazar', () => {
    const p = createProfile({
      connection: {
        maxPing: { enabled: true, value: 300, kick: true },
        maxDesync: { enabled: true, value: 200, kick: false },
        disconnectTimeout: { enabled: true, value: 30, kick: true },
      },
    });
    const { entries } = parseConfig(generateServerCfg(p, fixed));
    expect(findValue(entries, 'maxPing')).toBe(300);
    expect(findValue(entries, 'maxPacketLoss')).toBeUndefined();
    expect(findValue(entries, 'kickClientsOnSlowNetwork')).toEqual([1, 0, 0, 1]);
  });

  it('onUserDisconnected kendi değerini yazar (TADST kopyala-yapıştır hatası yok)', () => {
    const p = createProfile({ security: { onUserConnected: 'connect_script', onUserDisconnected: 'disconnect_script' } });
    const { entries } = parseConfig(generateServerCfg(p, fixed));
    expect(findValue(entries, 'onUserConnected')).toBe('connect_script');
    expect(findValue(entries, 'onUserDisconnected')).toBe('disconnect_script');
  });

  it('oylama kapalıyken izinli oy komutlarını boşaltır', () => {
    const { entries } = parseConfig(generateServerCfg(createProfile({ voting: { enabled: false } }), fixed));
    expect(findValue(entries, 'allowedVoteCmds')).toEqual([]);
    // Arma 0..1 dışını reddedip 0.5'e düşer: 1 yazılmalı
    expect(findValue(entries, 'voteThreshold')).toBe(1);
  });

  it('görevleri parametreleriyle yazar, kapalı görevleri atlar', () => {
    const p = createProfile({
      missions: {
        rotation: [
          { template: 'altislife.Altis', difficulty: 'custom', params: [{ name: 'Daytime', value: 12 }] },
          { template: 'kapali.Stratis', enabled: false },
          { template: 'co10.Tanoa' },
        ],
      },
    });
    const { entries } = parseConfig(generateServerCfg(p, fixed));
    const missions = findClass(entries, 'Missions')!;
    expect(missions.entries).toHaveLength(2);
    const m1 = findClass(missions.entries, 'Mission_1')!;
    expect(findValue(m1.entries, 'template')).toBe('altislife.Altis');
    expect(findValue(m1.entries, 'difficulty')).toBe('custom');
    expect(findValue(findClass(m1.entries, 'Params')!.entries, 'Daytime')).toBe(12);
    expect(findValue(findClass(missions.entries, 'Mission_2')!.entries, 'template')).toBe('co10.Tanoa');
  });

  it('headless IP\'lerini tırnaklı string olarak yazar', () => {
    const cfg = generateServerCfg(createProfile({ headless: { count: 2 } }), fixed);
    expect(cfg).toContain('headlessClients[] = {"127.0.0.1"};');
    expect(cfg).toContain('localClient[] = {"127.0.0.1"};');
  });

  it('ek satırlar aynı adlı üretilen değerin yerine geçer', () => {
    const p = createProfile({ general: { maxPlayers: 10 }, advanced: { extraServerCfg: 'maxPlayers = 99;\nsomeNewSetting = "x";' } });
    const cfg = generateServerCfg(p, fixed);
    const { entries } = parseConfig(cfg);
    expect(cfg.match(/maxPlayers/g)).toHaveLength(1);
    expect(findValue(entries, 'maxPlayers')).toBe(99);
    expect(findValue(entries, 'someNewSetting')).toBe('x');
  });

  it('ek satırlarda sözdizimi hatası varsa config üretmez', () => {
    const p = createProfile({ advanced: { extraServerCfg: 'class Broken { x = 1;' } });
    expect(() => generateServerCfg(p, fixed)).toThrow(ConfigSyntaxError);
  });

  it('AdvancedOptions sınıfını yazar', () => {
    const { entries } = parseConfig(generateServerCfg(createProfile(), fixed));
    const adv = findClass(entries, 'AdvancedOptions')!;
    expect(findValue(adv.entries, 'LogObjectNotFound')).toBe(true);
    expect(findValue(adv.entries, 'queueSizeLogG')).toBe(1000000);
  });
});

describe('basic.cfg / Arma3Profile / BattlEye', () => {
  it('basic.cfg: sayıları noktalı yazar, sockets sınıfı var', () => {
    const cfg = generateBasicCfg(createProfile({ basic: { minErrorToSend: 0.001, maxBandwidth: 2_000_000_000 } }), fixed);
    expect(cfg).toContain('MinErrorToSend = 0.001;');
    expect(cfg).toContain('MaxBandwidth = 2000000000;');
    const { entries, issues } = parseConfig(cfg);
    expect(issues).toEqual([]);
    expect(findValue(findClass(entries, 'sockets')!.entries, 'maxPacketSize')).toBe(1400);
  });

  it('basic.cfg: 32-bit sınırını aşan bant genişliği şemada reddedilir', () => {
    expect(() => createProfile({ basic: { maxBandwidth: 3_145_728_000 } })).toThrow();
  });

  it('Arma3Profile: 0/1/2 değerler ve CustomAILevel doğru yerde', () => {
    const p = createProfile({ difficulty: { options: { thirdPersonView: 2, groupIndicators: 2 }, aiLevelPreset: 3, skillAI: 0.7, precisionAI: 0.3 } });
    const text = generateArma3Profile(p, fixed);
    const { entries, issues } = parseConfig(text);
    expect(issues).toEqual([]);
    const presets = findClass(entries, 'DifficultyPresets')!;
    const custom = findClass(presets.entries, 'CustomDifficulty')!;
    const options = findClass(custom.entries, 'Options')!;
    expect(findValue(options.entries, 'thirdPersonView')).toBe(2);
    expect(findValue(options.entries, 'groupIndicators')).toBe(2);
    expect(findValue(custom.entries, 'aiLevelPreset')).toBe(3);
    expect(findClass(custom.entries, 'CustomAILevel')).toBeUndefined();
    const ai = findClass(presets.entries, 'CustomAILevel')!;
    expect(findValue(ai.entries, 'skillAI')).toBe(0.7);
    expect(findValue(ai.entries, 'precisionAI')).toBe(0.3);
  });

  it('Arma3Profile: aralık dışı zorluk değeri şemada reddedilir', () => {
    expect(() => createProfile({ difficulty: { options: { staminaBar: 2 } } })).toThrow();
  });

  it('BattlEye cfg: RCON ayarları', () => {
    const p = createProfile({ network: { port: 2302 }, rcon: { password: 'GizliSifre123' } });
    expect(generateBeServerCfg(p)).toBe('RConPassword GizliSifre123\nRConPort 2307\nRConIP 0.0.0.0\n');
    expect(() => generateBeServerCfg(createProfile({ rcon: { password: 'iki kelime' } }))).toThrow();
    expect(() => generateBeServerCfg(createProfile({ rcon: { password: '' } }))).toThrow();
  });
});

describe('server.cfg içe aktarma', () => {
  it('üretilen config\'i geri okuyunca aynı ayarlar çıkar', () => {
    const original = createProfile({
      general: { hostname: 'Test "Sunucu"', admins: ['76561198000000001'], maxPlayers: 40, motd: ['a', 'b'] },
      security: { verifySignatures: 2, onUserDisconnected: 'x' },
      voting: { enabled: false },
      connection: { maxPing: { enabled: true, value: 400, kick: true } },
      missions: { rotation: [{ template: 'altislife.Altis', difficulty: 'custom', params: [{ name: 'P1', value: 3 }] }] },
    });
    const { profile, issues } = importServerCfg(generateServerCfg(original, fixed));
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(profile.general.hostname).toBe('Test "Sunucu"');
    expect(profile.general.admins).toEqual(['76561198000000001']);
    expect(profile.general.maxPlayers).toBe(40);
    expect(profile.voting.enabled).toBe(false);
    expect(profile.connection.maxPing).toEqual({ enabled: true, value: 400, kick: true });
    expect(profile.missions.rotation[0]).toMatchObject({ template: 'altislife.Altis', difficulty: 'custom', params: [{ name: 'P1', value: 3 }] });
    expect(profile.security.onUserDisconnected).toBe('x');
  });

  it('TADST tarzı eski config\'i anlar, tanınmayanları ek satırlara taşır', () => {
    const tadst = `
hostName = "Eski Sunucu";
password = "";
passwordAdmin = "admin123456";
maxPlayers = 10;
kickduplicate = 1;
verifySignatures = 1;
requiredSecureId = 0;
headlessClients[]={127.0.0.1};
maxPing = 250;
kickClientsOnSlowNetwork = 1;
battleyeLicense = 1;
class Missions
{
	class Mission_1
	{
		template = "B_coop.Tanoa";
		difficulty = "regular";
	};
};`;
    const { profile, unknownKeys } = importServerCfg(tadst);
    expect(profile.general.hostname).toBe('Eski Sunucu');
    expect(profile.security.verifySignatures).toBe(2);
    expect(profile.headless.allowedIps).toEqual(['127.0.0.1']);
    expect(profile.connection.maxPing).toEqual({ enabled: true, value: 250, kick: true });
    expect(profile.missions.rotation.map((m) => m.template)).toEqual(['B_coop.Tanoa']);
    expect(unknownKeys).toEqual(['battleyeLicense']);
    expect(profile.advanced.extraServerCfg).toContain('battleyeLicense = 1;');
  });

  it('dolu allowedVoteCmds listesi kaybolmaz (ek satırlara taşınır), boş liste oylamayı kapatır', () => {
    const r1 = importServerCfg('allowedVoteCmds[] = {{"missions", true, true}};');
    expect(r1.profile.advanced.extraServerCfg).toContain('allowedVoteCmds[]');
    expect(r1.profile.voting.enabled).toBe(true);
    const r2 = importServerCfg('allowedVoteCmds[] = {};');
    expect(r2.profile.voting.enabled).toBe(false);
    expect(r2.profile.advanced.extraServerCfg).not.toContain('allowedVoteCmds');
  });

  it('aralık dışı değerleri uyarıyla varsayılana çeker', () => {
    const { profile, issues } = importServerCfg('maxPlayers = 99999;\nhostname = "x";');
    expect(profile.general.maxPlayers).toBe(64);
    expect(issues.some((i) => i.message.includes('general.maxPlayers'))).toBe(true);
  });

  it('Arma3Profile içe aktarma: TADST\'nin iç içe CustomAILevel\'ını ve eski mapContent\'i anlar', () => {
    const text = `class DifficultyPresets { class CustomDifficulty { class Options { mapContent=1; thirdPersonView=1; };
      aiLevelPreset=3; class CustomAILevel { skillAI=0.75; precisionAI=0.55; }; }; };`;
    const { profile } = importArma3Profile(text, createProfile());
    expect(profile.difficulty.options.mapContentFriendly).toBe(1);
    expect(profile.difficulty.options.thirdPersonView).toBe(1);
    expect(profile.difficulty.skillAI).toBe(0.75);
    expect(profile.difficulty.aiLevelPreset).toBe(3);
  });

  it('aynı cfg iki kez içe aktarılınca ek satırlar çoğalmaz (regularCheck "Member already defined")', () => {
    const tadst = 'hostname = "57. Alay";\nregularCheck = "";\nbattleyeLicense = 1;\n';
    const first = importServerCfg(tadst, createProfile({ name: '57. Alay' })).profile;
    const second = importServerCfg(tadst, first).profile;
    const extra = second.advanced.extraServerCfg;
    expect(extra.match(/regularCheck/g)).toHaveLength(1);
    expect(extra.match(/battleyeLicense/g)).toHaveLength(1);
    const cfg = generateServerCfg(second, fixed);
    expect(cfg.match(/regularCheck/g)).toHaveLength(1);
  });

  it('kullanıcının elle yazdığı yorumlar, çakışma yoksa içe aktarmada korunur', () => {
    const base = createProfile({ advanced: { extraServerCfg: '// benim notum\nfoo = 1;' } });
    const { profile } = importServerCfg('bar = 2;', base);
    expect(profile.advanced.extraServerCfg).toContain('// benim notum');
    expect(profile.advanced.extraServerCfg).toContain('bar = 2;');
  });
});

describe('tekrar eden anahtarlar', () => {
  it('daha önce kaydedilmiş tekrarlı ek satırlarla da sunucu config\'i tek tanımla üretilir', () => {
    const p = createProfile({
      advanced: { extraServerCfg: 'regularCheck = "";\nbattleyeLicense = 1;\nregularCheck = "";\nRegularCheck = "x";' },
    });
    const cfg = generateServerCfg(p, fixed);
    expect(cfg.match(/regularCheck/gi)).toHaveLength(1);
    expect(cfg).toContain('RegularCheck = "x";');
    const { entries } = parseConfig(cfg);
    expect(findValue(entries, 'battleyeLicense')).toBe(1);
  });

  it('ek satırlardaki iç içe tekrarlar da temizlenir', () => {
    const p = createProfile({ advanced: { extraServerCfg: 'class Foo { a = 1; a = 2; };' } });
    const cfg = generateServerCfg(p, fixed);
    expect(cfg).toMatch(/class Foo\s*\{\s*a = 2;\s*\};/);
  });

  it('doğrulama tekrarlı ek satırı uyarır', () => {
    const p = createProfile({
      paths: { serverDir: 'C:\\server' },
      advanced: { extraServerCfg: 'regularCheck = "";\nregularCheck = "";' },
      basic: { extraBasicCfg: 'class sockets { maxPacketSize = 1400; maxPacketSize = 1300; };' },
    });
    const dup = validateProfile(p, 'windows').filter((i) => i.code === 'extra.duplicate');
    expect(dup.map((i) => i.path)).toEqual(['advanced.extraServerCfg', 'basic.extraBasicCfg']);
    expect(dup[1]!.message.tr).toContain('sockets.maxPacketSize');
  });

  it('aynı görev parametresi iki kez girilse de config bozulmaz', () => {
    const p = createProfile({
      missions: { rotation: [{ template: 'a.Altis', difficulty: 'regular', params: [{ name: 'P1', value: 1 }, { name: 'p1', value: 2 }] }] },
    });
    const cfg = generateServerCfg(p, fixed);
    expect(cfg.match(/P1 =/gi)).toHaveLength(1);
  });
});
