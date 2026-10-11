import path from 'node:path';
import type { ServerProfile } from '../model/profile.js';

export type HostOs = 'windows' | 'linux';

export function pathLib(os: HostOs): path.PlatformPath {
  return os === 'windows' ? path.win32 : path.posix;
}

export function isAbsoluteFor(os: HostOs, p: string): boolean {
  return pathLib(os).isAbsolute(p);
}

export interface ResolvedPaths {
  os: HostOs;
  serverDir: string;
  executable: string;
  profilesDir: string;
  serverCfg: string;
  basicCfg: string;
  /** Arma3Profile dosyası(ları). Linux'ta hem home/ hem Users/ altına yazılır. */
  arma3Profiles: string[];
  beDir: string;
  beCfg: string;
  /** Sunucunun stdout/stderr çıktısı (Linux'ta RPT içeriği buraya gelir) */
  stdoutLog: string;
  /** RPT dosyalarının arandığı klasör (Windows) */
  rptDir: string;
  missionsDir: string;
  keysDir: string;
  workshopDir: string;
  /** Uygulamanın durum dosyası (PID vb.) */
  stateFile: string;
  headlessProfilesDir(index: number): string;
  headlessStdoutLog(index: number): string;
}

export function defaultExecutable(os: HostOs): string {
  return os === 'windows' ? 'arma3server_x64.exe' : 'arma3server_x64';
}

/** Profil klasörü belirtilmemişse kullanılan, profil id'sine bağlı kararlı varsayılan. */
export function defaultProfilesDir(os: HostOs, serverDir: string, profileId: string): string {
  return pathLib(os).join(serverDir, 'oezi-profiles', profileId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'default');
}

export function resolvePaths(profile: ServerProfile, os: HostOs): ResolvedPaths {
  const p = pathLib(os);
  const serverDir = profile.paths.serverDir.trim();
  if (!serverDir) throw new Error('Sunucu klasörü (serverDir) ayarlanmamış');
  if (!p.isAbsolute(serverDir)) throw new Error(`Sunucu klasörü mutlak bir yol olmalı: ${serverDir}`);

  const exeSetting = profile.paths.executable.trim() || defaultExecutable(os);
  const executable = p.isAbsolute(exeSetting) ? exeSetting : p.join(serverDir, exeSetting);

  const profilesSetting = profile.paths.profilesDir.trim();
  const profilesDir = profilesSetting
    ? p.isAbsolute(profilesSetting)
      ? profilesSetting
      : p.join(serverDir, profilesSetting)
    : defaultProfilesDir(os, serverDir, profile.id);

  const name = profile.paths.profileName;
  const arma3Profiles =
    os === 'windows'
      ? [p.join(profilesDir, 'Users', name, `${name}.Arma3Profile`)]
      : [p.join(profilesDir, 'home', name, `${name}.Arma3Profile`), p.join(profilesDir, 'Users', name, `${name}.Arma3Profile`)];

  const beDir = p.join(profilesDir, 'BattlEye');
  const exeBase = p.basename(executable).toLowerCase();
  const beCfgName = exeBase.includes('_x64') ? 'beserver_x64.cfg' : 'beserver.cfg';

  const workshopSetting = profile.steam.workshopDir.trim();
  const workshopDir = workshopSetting
    ? p.isAbsolute(workshopSetting)
      ? workshopSetting
      : p.join(serverDir, workshopSetting)
    : p.join(p.dirname(serverDir), 'oezi-workshop');

  return {
    os,
    serverDir,
    executable,
    profilesDir,
    serverCfg: p.join(profilesDir, 'server.cfg'),
    basicCfg: p.join(profilesDir, 'basic.cfg'),
    arma3Profiles,
    beDir,
    beCfg: p.join(beDir, beCfgName),
    stdoutLog: p.join(profilesDir, 'server-stdout.log'),
    rptDir: profilesDir,
    // Linux sunucusu küçük harfli "mpmissions" bekler; Windows büyük/küçük harfe duyarsız.
    missionsDir: p.join(serverDir, os === 'windows' ? 'MPMissions' : 'mpmissions'),
    keysDir: p.join(serverDir, 'keys'),
    workshopDir,
    stateFile: p.join(profilesDir, 'oezi-state.json'),
    headlessProfilesDir: (i: number) => p.join(profilesDir, `hc${i}`),
    headlessStdoutLog: (i: number) => p.join(profilesDir, `hc${i}`, 'hc-stdout.log'),
  };
}

/** Mod yolunu sunucu klasörüne göre çözer (komut satırında göreli bırakılabilir). */
export function resolveModPath(os: HostOs, serverDir: string, modPath: string): string {
  const p = pathLib(os);
  return p.isAbsolute(modPath) ? modPath : p.join(serverDir, modPath);
}
