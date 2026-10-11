/**
 * Ana süreç ile arayüz arasındaki sözleşme. Arayüz sadece bu tipleri görür;
 * Node/Electron API'lerine doğrudan erişimi yoktur (sandbox + contextIsolation).
 */
import type {
  DirEntry,
  FoundMission,
  FoundMod,
  Issue,
  LogLine,
  Notice,
  PresetMod,
  RconBan,
  RconPlayer,
  ServerProfile,
  ServerProfileInput,
  StatusInfo,
  WorkshopItemInfo,
} from '@oezi/arma-core';

export type {
  DirEntry,
  FoundMission,
  FoundMod,
  Issue,
  LogLine,
  Notice,
  PresetMod,
  RconBan,
  RconPlayer,
  ServerProfile,
  ServerProfileInput,
  StatusInfo,
  WorkshopItemInfo,
};

export type Lang = 'tr' | 'en';

export interface HostConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: 'password' | 'key';
  privateKeyPath: string;
  /** Kayıtlı sunucu parmak izi (SHA256:...) */
  fingerprint: string;
  useSudo: boolean;
  useSystemd: boolean;
  serviceUser: string;
  steamcmdPath: string;
  /** Sadece kaydederken gönderilir; okurken boş gelir */
  password?: string;
  passphrase?: string;
  hasPassword?: boolean;
}

export interface HostTestResult {
  ok: boolean;
  fingerprint?: string;
  fingerprintChanged?: boolean;
  os?: string;
  isRoot?: boolean;
  hasSystemd?: boolean;
  error?: string;
}

export interface AppSettings {
  language: Lang;
  minimizeToTray: boolean;
  localSteamcmdPath: string;
  steamUsername: string;
  /** Sadece kaydederken; okurken boş */
  steamPassword?: string;
  hasSteamPassword?: boolean;
  clearSteamPassword?: boolean;
}

export interface AppInfo {
  version: string;
  platform: 'windows' | 'linux' | 'mac';
  insecureSecrets: boolean;
  dataDir: string;
}

export interface SaveResult {
  profile?: ServerProfile;
  errors: { path: string; message: string }[];
  issues: Issue[];
}

export interface PreviewFiles {
  serverCfg?: string;
  basicCfg?: string;
  arma3Profile?: string;
  beServerCfg?: string | null;
  commandLine?: string;
  headlessCommandLine?: string;
  systemdUnit?: string;
  paths?: Record<string, string>;
  error?: string;
}

export interface ImportResultDto {
  profile: ServerProfile;
  issues: { line: number; message: string; severity: string }[];
  unknownKeys: string[];
}

export type JobStatus = 'running' | 'waiting-input' | 'done' | 'failed' | 'cancelled';

export interface JobInfo {
  id: string;
  profileId?: string;
  title: string;
  status: JobStatus;
  progress?: number;
  progressLabel?: string;
  lines: string[];
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

export interface ServerSummary {
  id: string;
  name: string;
  hostId: string;
  port: number;
  status: StatusInfo;
}

export type AppEvent =
  | { type: 'status'; profileId: string; status: StatusInfo }
  | { type: 'log'; profileId: string; lines: LogLine[] }
  | { type: 'notice'; profileId: string; notice: Notice }
  | { type: 'players'; profileId: string; players: RconPlayer[] }
  | { type: 'rconMessage'; profileId: string; message: string; t: number }
  | { type: 'job'; job: JobInfo }
  | { type: 'profiles-changed' }
  | { type: 'hosts-changed' };

export interface OeziApi {
  app: {
    info(): Promise<AppInfo>;
    getSettings(): Promise<AppSettings>;
    saveSettings(s: AppSettings): Promise<AppSettings>;
    openExternal(url: string): Promise<void>;
    pickFile(opts: { title?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null>;
    pickFolder(opts?: { title?: string }): Promise<string | null>;
    saveFile(opts: { title?: string; defaultName: string; content: string }): Promise<boolean>;
    /** Sadece pickFile ile seçilmiş dosyalar okunabilir */
    readPickedFile(path: string): Promise<string>;
  };
  hosts: {
    list(): Promise<HostConfig[]>;
    save(h: HostConfig): Promise<HostConfig>;
    remove(id: string): Promise<void>;
    test(h: HostConfig): Promise<HostTestResult>;
    browse(hostId: string, path: string): Promise<{ path: string; entries: DirEntry[] }>;
  };
  profiles: {
    list(): Promise<ServerSummary[]>;
    get(id: string): Promise<ServerProfile>;
    create(input: ServerProfileInput): Promise<ServerProfile>;
    save(p: unknown): Promise<SaveResult>;
    remove(id: string): Promise<void>;
    duplicate(id: string): Promise<ServerProfile>;
    validate(p: unknown): Promise<SaveResult>;
    preview(p: unknown): Promise<PreviewFiles>;
    importServerCfg(base: unknown, text: string): Promise<ImportResultDto>;
    importArma3Profile(base: unknown, text: string): Promise<ImportResultDto>;
    exportJson(id: string): Promise<string>;
    importJson(text: string): Promise<ServerProfile>;
  };
  server: {
    start(id: string): Promise<void>;
    stop(id: string): Promise<void>;
    restart(id: string, update?: boolean): Promise<void>;
    deploy(id: string): Promise<string[]>;
    status(id: string): Promise<StatusInfo>;
    logs(id: string): Promise<LogLine[]>;
  };
  missions: {
    scan(id: string): Promise<{ dir: string | null; missions: FoundMission[] }>;
    upload(id: string): Promise<string | null>;
  };
  mods: {
    scan(id: string): Promise<FoundMod[]>;
  };
  rcon: {
    command(id: string, cmd: string): Promise<string>;
    players(id: string): Promise<RconPlayer[]>;
    bans(id: string): Promise<RconBan[]>;
    say(id: string, message: string, playerId?: number): Promise<void>;
    kick(id: string, playerId: number, reason: string): Promise<void>;
    ban(id: string, playerId: number, minutes: number, reason: string): Promise<void>;
    addBan(id: string, guidOrIp: string, minutes: number, reason: string): Promise<void>;
    removeBan(id: string, banId: number): Promise<void>;
    setLock(id: string, locked: boolean): Promise<void>;
    reconnect(id: string): Promise<void>;
  };
  steam: {
    updateServer(profileId: string): Promise<string>;
    syncWorkshop(profileId: string, ids?: string[]): Promise<string>;
    removeWorkshopMod(profileId: string, folder: string): Promise<void>;
    workshopInfo(ids: string[]): Promise<WorkshopItemInfo[]>;
    collection(id: string): Promise<string[]>;
    parsePreset(html: string): Promise<PresetMod[]>;
    installSteamCmd(hostId: string, dir: string): Promise<string>;
    fixSteamClient(profileId: string): Promise<string>;
    answerGuard(jobId: string, code: string | null): Promise<void>;
    cancel(jobId: string): Promise<void>;
    jobs(): Promise<JobInfo[]>;
  };
  notify: {
    test(profileId: string): Promise<void>;
  };
  onEvent(cb: (e: AppEvent) => void): () => void;
}

/** IPC kanal adları: "alan:metod" */
export function channel(area: string, method: string): string {
  return `oezi:${area}:${method}`;
}
export const EVENT_CHANNEL = 'oezi:event';
