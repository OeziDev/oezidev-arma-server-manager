import type { ExecResult, SystemdApi, SystemdStatus } from './types.js';
import { HostError } from './types.js';
import { quoteSystemdArg } from '../launch/commandLine.js';

type ExecFn = (file: string, args: string[]) => Promise<ExecResult>;

const UNIT_DIR = '/etc/systemd/system';
const UNIT_NAME_RE = /^[A-Za-z0-9:_.\\@-]+\.service$/;

/**
 * systemctl çıktısını okur. "--timestamp=unix" kullanılmaz (systemd 251 öncesinde yok,
 * Ubuntu 22.04 = 249). Başlangıç zamanı monotonik saatten /proc/uptime ile hesaplanır.
 */
export function parseSystemdShow(stdout: string, nowMs = Date.now()): SystemdStatus {
  const map = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) map.set(line.slice(0, i), line.slice(i + 1).trim());
  }
  const active = map.get('ActiveState') ?? 'inactive';
  const mono = Number(map.get('ActiveEnterTimestampMonotonic') ?? 0);
  const uptime = Number(map.get('__UPTIME') ?? 0);
  let startedAt = 0;
  if (active === 'active' && mono > 0 && uptime > 0) {
    const elapsedSec = Math.max(0, uptime - mono / 1e6);
    startedAt = Math.round(nowMs - elapsedSec * 1000);
  }
  return {
    exists: (map.get('LoadState') ?? 'not-found') !== 'not-found',
    activeState: active,
    subState: map.get('SubState') ?? '',
    mainPid: Number(map.get('MainPID') ?? 0) || 0,
    restarts: Number(map.get('NRestarts') ?? 0) || 0,
    startedAt,
  };
}

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
    async startNoBlock(...units) {
      units.forEach(check);
      if (!units.length) return;
      await run(['start', '--no-block', ...units]);
    },
    async status(name): Promise<SystemdStatus> {
      check(name);
      const props = 'LoadState,ActiveState,SubState,MainPID,NRestarts,ActiveEnterTimestampMonotonic';
      const res = await exec('sh', ['-c', `systemctl show "$1" --property=${props} && echo "__UPTIME=$(cut -d' ' -f1 /proc/uptime)"`, 'sh', name]);
      if (res.code !== 0 || !res.stdout.includes('ActiveState=')) {
        // Sorgu başarısız: "durdu" sanma, hata fırlat (bağlantı kopması vb.)
        throw new HostError(`systemctl show ${name} başarısız: ${(res.stderr || res.stdout).trim() || 'cevap yok'}`, 'systemctl_failed');
      }
      return parseSystemdShow(res.stdout);
    },
  };
}

export interface UnitOptions {
  description: string;
  executable: string;
  args: string[];
  workingDirectory: string;
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
  /** journald'da görünen ad */
  identifier?: string;
}

/** Yönerge değerindeki yol: tırnaklanmaz (WorkingDirectory tırnağı kaldırmaz), sadece % kaçırılır. */
function unitPathValue(p: string): string {
  if (/[\x00-\x1f]/.test(p)) throw new HostError(`Yol kontrol karakteri içeremez: ${JSON.stringify(p)}`, 'invalid_path');
  if (!p.startsWith('/')) throw new HostError(`systemd için mutlak yol gerekli: ${p}`, 'invalid_path');
  return p.replace(/%/g, '%%');
}

/**
 * Sunucu / headless client için systemd servis dosyası üretir.
 * Çıktı journald'a gider (dosya yolu sorunları ve log dönüşümü systemd'nin işi), journalctl ile okunur.
 */
export function generateSystemdUnit(o: UnitOptions): string {
  const exec = [o.executable, ...o.args].map(quoteSystemdArg).join(' ');
  const lines = [
    '# OeziDev Arma Server Manager tarafından oluşturuldu.',
    '[Unit]',
    `Description=${o.description.replace(/[\r\n%]/g, ' ')}`,
    'After=network-online.target',
    'Wants=network-online.target',
    'StartLimitIntervalSec=3600',
    `StartLimitBurst=${Math.max(1, o.startLimitBurst)}`,
  ];
  if (o.partOf) lines.push(`PartOf=${o.partOf}`, `After=${o.partOf}`);
  lines.push('', '[Service]', 'Type=simple');
  if (o.user) {
    if (!/^[a-z_][a-z0-9_-]*$/i.test(o.user)) throw new HostError(`Geçersiz kullanıcı adı: ${o.user}`, 'invalid_user');
    lines.push(`User=${o.user}`);
  }
  lines.push(`WorkingDirectory=${unitPathValue(o.workingDirectory)}`);
  const delay = Math.max(0, Math.round(o.startDelaySec ?? 0));
  if (delay > 0) {
    lines.push(`ExecStartPre=/bin/sleep ${delay}`);
    // Gecikme başlangıç zaman aşımına sayılır (varsayılan 90 sn)
    lines.push(`TimeoutStartSec=${delay + 120}`);
  }
  lines.push(`ExecStart=${exec}`);
  lines.push('StandardOutput=journal', 'StandardError=journal', `SyslogIdentifier=${(o.identifier ?? 'oezi-arma').replace(/[^\w.-]/g, '_')}`);
  lines.push(`Restart=${o.restart}`, `RestartSec=${Math.max(0, Math.round(o.restartSec))}`);
  lines.push(`TimeoutStopSec=${o.stopTimeoutSec ?? 30}`, 'KillMode=control-group', 'LimitNOFILE=100000');
  lines.push('', '[Install]', 'WantedBy=multi-user.target', '');
  return lines.join('\n');
}
