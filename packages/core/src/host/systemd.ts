import type { ExecResult, SystemdApi, SystemdStatus } from './types.js';
import { HostError } from './types.js';
import { quoteSystemdArg } from '../launch/commandLine.js';

type ExecFn = (file: string, args: string[]) => Promise<ExecResult>;

const UNIT_DIR = '/etc/systemd/system';
const UNIT_NAME_RE = /^[A-Za-z0-9:_.\\@-]+\.service$/;

export function createSystemdApi(
  exec: ExecFn,
  writeFile: (path: string, data: string) => Promise<void>,
  remove: (path: string) => Promise<void>,
): SystemdApi {
  const check = (name: string) => {
    if (!UNIT_NAME_RE.test(name)) throw new HostError(`Geçersiz servis adı: ${name}`, 'invalid_unit');
  };
  const run = async (args: string[]) => {
    const res = await exec('systemctl', args);
    if (res.code !== 0) {
      throw new HostError(`systemctl ${args.join(' ')} başarısız: ${(res.stderr || res.stdout).trim()}`, 'systemctl_failed');
    }
    return res;
  };
  return {
    unitPath: (name) => `${UNIT_DIR}/${name}`,
    async writeUnit(name, content) {
      check(name);
      await writeFile(`${UNIT_DIR}/${name}`, content);
    },
    async removeUnit(name) {
      check(name);
      await remove(`${UNIT_DIR}/${name}`);
    },
    async daemonReload() {
      await run(['daemon-reload']);
    },
    async action(action, ...units) {
      units.forEach(check);
      if (!units.length) return;
      await run([action, ...units]);
    },
    async status(name): Promise<SystemdStatus> {
      check(name);
      const res = await exec('systemctl', [
        'show',
        name,
        '--property=LoadState,ActiveState,SubState,MainPID,NRestarts,ExecMainStartTimestampMonotonic,ActiveEnterTimestamp',
        '--timestamp=unix',
      ]);
      const map = new Map<string, string>();
      for (const line of res.stdout.split('\n')) {
        const i = line.indexOf('=');
        if (i > 0) map.set(line.slice(0, i), line.slice(i + 1).trim());
      }
      const ts = map.get('ActiveEnterTimestamp') ?? '';
      const unix = /^@(\d+)/.exec(ts)?.[1];
      const active = map.get('ActiveState') ?? 'inactive';
      return {
        exists: (map.get('LoadState') ?? 'not-found') !== 'not-found',
        activeState: active,
        subState: map.get('SubState') ?? '',
        mainPid: Number(map.get('MainPID') ?? 0) || 0,
        restarts: Number(map.get('NRestarts') ?? 0) || 0,
        startedAt: active === 'active' && unix ? Number(unix) * 1000 : 0,
      };
    },
  };
}

export interface UnitOptions {
  description: string;
  executable: string;
  args: string[];
  workingDirectory: string;
  /** stdout/stderr eklenecek dosya */
  logFile: string;
  user?: string;
  restart: 'no' | 'on-failure' | 'always';
  restartSec: number;
  /** Bir saatte en fazla kaç restart (döngüye girmesin) */
  startLimitBurst: number;
  /** Bu servise bağlı (onunla durup başlayan) ana servis */
  partOf?: string;
  /** Başlamadan önce beklenecek saniye (headless client'lar için) */
  startDelaySec?: number;
  /** Kapatmada SIGTERM sonrası bekleme */
  stopTimeoutSec?: number;
}

/** Sunucu / headless client için systemd servis dosyası üretir. */
export function generateSystemdUnit(o: UnitOptions): string {
  if (/\s/.test(o.logFile)) throw new HostError(`systemd log dosyası yolu boşluk içeremez: ${o.logFile}`, 'invalid_path');
  const exec = [o.executable, ...o.args].map(quoteSystemdArg).join(' ');
  const lines = [
    '# OeziDev Arma Server Manager tarafından oluşturuldu.',
    '[Unit]',
    `Description=${o.description.replace(/[\r\n]/g, ' ')}`,
    'After=network-online.target',
    'Wants=network-online.target',
    'StartLimitIntervalSec=3600',
    `StartLimitBurst=${Math.max(1, o.startLimitBurst)}`,
  ];
  if (o.partOf) lines.push(`PartOf=${o.partOf}`, `After=${o.partOf}`);
  lines.push('', '[Service]', 'Type=simple');
  if (o.user) lines.push(`User=${o.user}`);
  lines.push(`WorkingDirectory=${quoteSystemdArg(o.workingDirectory)}`);
  if (o.startDelaySec && o.startDelaySec > 0) lines.push(`ExecStartPre=/bin/sleep ${Math.round(o.startDelaySec)}`);
  lines.push(`ExecStart=${exec}`);
  lines.push(`StandardOutput=append:${o.logFile}`, 'StandardError=inherit');
  lines.push(`Restart=${o.restart}`, `RestartSec=${Math.max(0, Math.round(o.restartSec))}`);
  lines.push(`TimeoutStopSec=${o.stopTimeoutSec ?? 30}`, 'KillMode=control-group', 'LimitNOFILE=100000');
  lines.push('', '[Install]', 'WantedBy=multi-user.target', '');
  return lines.join('\n');
}
