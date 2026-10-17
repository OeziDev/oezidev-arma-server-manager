import type { Host } from '../host/types.js';
import { pathLib } from '../launch/paths.js';
import { buildPbo } from './pbo.js';

/**
 * @oezi_monitor: sadece sunucuda (-serverMod) yüklenen küçük mod. Her 10 saniyede bir RPT'ye tek satır yazar:
 *   [OEZI-PERF] {"fps":47.3,"fpsMin":31.0,"players":12,"ai":240,"groups":60,"vehicles":85,"objects":14,"time":3605,"mission":"..","world":".."}
 * Uygulama bu satırı logdan okuyup grafiğe çevirir (parsePerfLine). Sadece ucuz komutlar kullanılır.
 * config.cpp binarize edilmez (sunucu düz metin config.cpp'yi okur); imza gerekmez (serverMod istemciye gitmez).
 */

export const MONITOR_MOD_FOLDER = '@oezi_monitor';
export const MONITOR_PBO_PREFIX = 'oezi_monitor';
export const MONITOR_PBO_NAME = 'oezi_monitor.pbo';
/**
 * Script'in FPS satırı yazma aralığı (sn). Profilden bağımsız sabit: aynı sunucu klasörünü paylaşan profiller
 * bayt bayt aynı PBO üretir, ensureMonitorMod birbirinin dosyasını yeniden yazmaz.
 * profile.monitoring.sampleSec sadece uygulamanın CPU/RAM ölçüp birleşik örnek kaydetme aralığıdır.
 */
export const MONITOR_SCRIPT_INTERVAL_SEC = 10;

export function generateMonitorConfigCpp(): string {
  return `// OeziDev Monitor - OeziDev Arma Server Manager tarafindan uretildi, elle degistirmeyin.
class CfgPatches
{
    class oezi_monitor
    {
        name = "OeziDev Monitor";
        author = "OeziDev";
        units[] = {};
        weapons[] = {};
        requiredVersion = 1.60;
        requiredAddons[] = {"A3_Functions_F"};
    };
};

class CfgFunctions
{
    class oezi_monitor
    {
        tag = "oezi_monitor";
        class main
        {
            file = "\\oezi_monitor\\functions";
            class init
            {
                postInit = 1;
            };
        };
    };
};
`;
}

/** Ölçüm aralığı sabittir (MONITOR_SCRIPT_INTERVAL_SEC): profil ayarı PBO'ya gömülmez. */
export function generateMonitorScript(): string {
  const sec = MONITOR_SCRIPT_INTERVAL_SEC;
  return `// OeziDev Monitor - sunucu performansini RPT'ye yazar (OeziDev Arma Server Manager)
// Sadece sunucuda calisir; headless client ve oyuncularda hicbir sey yapmaz.
if (!isServer) exitWith {};
if (!isNil "oezi_monitor_running") exitWith {};
oezi_monitor_running = true;
oezi_monitor_sampleSec = ${sec};

// JSON icin metin kacisi: " ve \\ onune \\ eklenir, kontrol karakterleri atilir
oezi_monitor_fnc_esc = {
    params [["_s", "", [""]]];
    private _out = [];
    {
        if (_x == 34 || _x == 92) then {
            _out pushBack 92;
            _out pushBack _x;
        } else {
            if (_x >= 32) then { _out pushBack _x; };
        };
    } forEach (toArray _s);
    toString _out
};

[] spawn {
    while {true} do {
        uiSleep oezi_monitor_sampleSec;
        private _hcs = entities "HeadlessClient_F";
        private _json = format [
            '{"fps":%1,"fpsMin":%2,"players":%3,"ai":%4,"groups":%5,"vehicles":%6,"objects":%7,"time":%8,"mission":"%9","world":"%10"}',
            diag_fps toFixed 1,
            diag_fpsMin toFixed 1,
            (count (allPlayers - _hcs)) toFixed 0,
            ({!isPlayer _x} count allUnits) toFixed 0,
            (count allGroups) toFixed 0,
            (count vehicles) toFixed 0,
            (count allDead) toFixed 0,
            time toFixed 0,
            [missionName] call oezi_monitor_fnc_esc,
            [worldName] call oezi_monitor_fnc_esc
        ];
        diag_log text ("[OEZI-PERF] " + _json);
    };
};
`;
}

export function generateMonitorModCpp(): string {
  return `name = "OeziDev Monitor";
author = "OeziDev";
tooltip = "OeziDev Arma Server Manager - sunucu performans izleme";
overview = "Sunucu FPS, oyuncu ve AI sayilarini RPT'ye yazar. Sadece -serverMod ile kullanilir.";
`;
}

export function buildMonitorPbo(): Buffer {
  return buildPbo(
    [
      { path: 'config.cpp', data: generateMonitorConfigCpp() },
      { path: 'functions\\fn_init.sqf', data: generateMonitorScript() },
    ],
    { prefix: MONITOR_PBO_PREFIX, product: 'OeziDev Arma Server Manager' },
  );
}

/**
 * <serverDir>/@oezi_monitor/addons/oezi_monitor.pbo ve mod.cpp'yi yazar; içerik aynıysa dokunmaz.
 * Dönen `folder` mutlak klasör yoludur; -serverMod için göreli "@oezi_monitor" kullanılır (cwd = serverDir).
 */
export async function ensureMonitorMod(host: Host, serverDir: string): Promise<{ folder: string; changed: boolean }> {
  const L = pathLib(host.os);
  const folder = L.join(serverDir, MONITOR_MOD_FOLDER);
  const want: [string, Buffer][] = [
    [L.join(folder, 'addons', MONITOR_PBO_NAME), buildMonitorPbo()],
    [L.join(folder, 'mod.cpp'), Buffer.from(generateMonitorModCpp(), 'utf8')],
  ];
  let changed = false;
  for (const [file, data] of want) {
    let current: Buffer | null = null;
    try {
      current = await host.readFile(file);
    } catch {
      /* yok ya da okunamadı: yaz */
    }
    if (current && Buffer.compare(current, data) === 0) continue;
    await host.writeFile(file, data);
    changed = true;
  }
  return { folder, changed };
}
