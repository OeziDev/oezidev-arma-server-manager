import { HostError } from './types.js';

/**
 * Bir UDP portunu dinleyen süreç. `pid`/`process` bilinmeyebilir (Linux'ta root olmadan başka kullanıcının
 * süreçleri görünmez); port yine de "kullanımda" sayılır.
 */
export interface UdpPortOwner {
  port: number;
  pid?: number;
  process?: string;
}

/** Geçerli port listesi (1..65535, tekrarsız, sıralı) */
export function normalizePorts(ports: number[]): number[] {
  return [...new Set(ports.filter((p) => Number.isInteger(p) && p > 0 && p < 65536))].sort((a, b) => a - b);
}

/** Aynı port + PID tekrarlarını (IPv4 / IPv6 ayrı satırları) teke indirir, istenmeyen portları atar. */
function finalize(rows: UdpPortOwner[], ports: number[]): UdpPortOwner[] {
  const want = new Set(ports);
  const seen = new Map<string, UdpPortOwner>();
  for (const r of rows) {
    if (!want.has(r.port)) continue;
    const key = `${r.port}:${r.pid ?? '?'}`;
    const prev = seen.get(key);
    if (!prev) seen.set(key, r);
    else if (!prev.process && r.process) seen.set(key, { ...prev, process: r.process });
  }
  // PID'i bilinen satır varsa aynı portun PID'siz satırı fazlalıktır
  const out = [...seen.values()].filter((r) => r.pid !== undefined || ![...seen.values()].some((o) => o.port === r.port && o.pid !== undefined));
  return out.sort((a, b) => a.port - b.port || (a.pid ?? 0) - (b.pid ?? 0));
}

/** "0.0.0.0:2302", "[::]:2302", "*:2302", "127.0.0.1%lo:53" -> port */
function portOf(addr: string): number | undefined {
  const m = /:(\d+)$/.exec(addr.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  return n > 0 && n < 65536 ? n : undefined;
}

/* ---------------- Windows ---------------- */

/**
 * Tek PowerShell çağrısı: Get-NetUDPEndpoint + Get-Process. Komut yoksa (eski Windows) "NOCMD" yazar,
 * o zaman netstat'a düşülür. Başarıyla biterse son satır "DONE" olur (boş sonuç ile hatayı ayırmak için).
 */
export function winUdpPortsScript(ports: number[]): string {
  const list = normalizePorts(ports).join(',');
  return (
    `$ErrorActionPreference='SilentlyContinue';` +
    `if(-not (Get-Command Get-NetUDPEndpoint -ErrorAction SilentlyContinue)){'NOCMD';exit 0};` +
    `$e=Get-NetUDPEndpoint -LocalPort ${list} -ErrorAction SilentlyContinue | Select-Object LocalPort,OwningProcess;` +
    `foreach($x in $e){$n='';try{$n=(Get-Process -Id $x.OwningProcess -ErrorAction Stop).ProcessName}catch{};` +
    `'P:'+$x.LocalPort+':'+$x.OwningProcess+':'+$n};` +
    `'DONE'`
  );
}

/** winUdpPortsScript çıktısı. Get-NetUDPEndpoint yoksa 'nocmd', çıktı tamamlanmadıysa null. */
export function parseWinUdpPortsOutput(stdout: string, ports: number[]): UdpPortOwner[] | 'nocmd' | null {
  const lines = stdout.replace(/\u0000/g, '').split(/\r?\n/).map((l) => l.trim());
  if (lines.includes('NOCMD')) return 'nocmd';
  if (!lines.includes('DONE')) return null;
  const rows: UdpPortOwner[] = [];
  for (const l of lines) {
    const m = /^P:(\d+):(\d+):(.*)$/.exec(l);
    if (!m) continue;
    const pid = Number(m[2]);
    const name = m[3]!.trim();
    // Get-Process uzantısız ad verir ("arma3server_x64"); tasklist/Görev Yöneticisi ile aynı görünsün
    rows.push({ port: Number(m[1]), ...(pid > 0 ? { pid } : {}), ...(name ? { process: /\.exe$/i.test(name) ? name : `${name}.exe` } : {}) });
  }
  return finalize(rows, normalizePorts(ports));
}

/** `netstat -ano -p UDP` çıktısı: "  UDP    0.0.0.0:2302    *:*    1234" */
export function parseWinNetstat(stdout: string, ports: number[]): UdpPortOwner[] {
  const rows: UdpPortOwner[] = [];
  for (const raw of stdout.replace(/\u0000/g, '').split(/\r?\n/)) {
    const cols = raw.trim().split(/\s+/);
    if (cols.length < 3 || !/^UDP/i.test(cols[0]!)) continue;
    const port = portOf(cols[1]!);
    const pid = Number(cols[cols.length - 1]);
    if (port === undefined) continue;
    rows.push({ port, ...(Number.isInteger(pid) && pid > 0 ? { pid } : {}) });
  }
  return finalize(rows, normalizePorts(ports));
}

/** `tasklist /FO CSV /NH` çıktısı -> PID -> ad */
export function parseTasklistCsv(stdout: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const line of stdout.replace(/\u0000/g, '').split(/\r?\n/)) {
    const m = /^"([^"]*)","(\d+)"/.exec(line.trim());
    if (m) map.set(Number(m[2]), m[1]!);
  }
  return map;
}

/* ---------------- Linux ---------------- */

/** ss / netstat ile dinleyen UDP soketleri. İlk satır hangi aracın kullanıldığını söyler. */
export const LINUX_UDP_PORTS_COMMAND =
  'if command -v ss >/dev/null 2>&1; then echo TOOL:ss; ss -Hlunp 2>/dev/null; ' +
  'elif command -v netstat >/dev/null 2>&1; then echo TOOL:netstat; netstat -lunp 2>/dev/null; ' +
  'else echo TOOL:none; fi';

/**
 * `ss -Hlunp`: "UNCONN 0 0 0.0.0.0:2302 0.0.0.0:* users:(("arma3server_x64",pid=1234,fd=12))"
 * Başlık satırı (-H desteklenmeyen eski ss) ve süreç bilgisi olmayan satırlar (root değil) de işlenir.
 */
export function parseSsUdp(stdout: string, ports: number[]): UdpPortOwner[] {
  const rows: UdpPortOwner[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^(State|Netid|TOOL:)/i.test(line)) continue;
    const cols = line.split(/\s+/);
    // "udp UNCONN ..." (Netid sütunu olan sürümler) ya da "UNCONN ..."
    const start = /^(udp|udp6)$/i.test(cols[0]!) ? 1 : 0;
    const local = cols[start + 3];
    if (!local) continue;
    const port = portOf(local);
    if (port === undefined) continue;
    const users = [...line.matchAll(/\("([^"]*)",pid=(\d+)/g)];
    if (!users.length) {
      rows.push({ port });
      continue;
    }
    for (const u of users) rows.push({ port, pid: Number(u[2]), process: u[1]! });
  }
  return finalize(rows, normalizePorts(ports));
}

/** `netstat -lunp`: "udp  0  0 0.0.0.0:2302  0.0.0.0:*  1234/arma3server_x" (süreç bilinmiyorsa "-") */
export function parseNetstatLinuxUdp(stdout: string, ports: number[]): UdpPortOwner[] {
  const rows: UdpPortOwner[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const cols = raw.trim().split(/\s+/);
    if (cols.length < 4 || !/^udp6?$/i.test(cols[0]!)) continue;
    const port = portOf(cols[3]!);
    if (port === undefined) continue;
    const m = /^(\d+)\/(.+)$/.exec(cols[cols.length - 1]!);
    rows.push(m ? { port, pid: Number(m[1]), process: m[2]! } : { port });
  }
  return finalize(rows, normalizePorts(ports));
}

/** LINUX_UDP_PORTS_COMMAND çıktısı; araç yoksa hata fırlatır. */
export function parseLinuxUdpPortsOutput(stdout: string, ports: number[]): UdpPortOwner[] {
  const tool = /TOOL:(\w+)/.exec(stdout)?.[1];
  if (tool === 'ss') return parseSsUdp(stdout, ports);
  if (tool === 'netstat') return parseNetstatLinuxUdp(stdout, ports);
  throw new HostError('Port sorgulanamadı: ss/netstat bulunamadı', 'query_failed');
}

/** Süreç adı bir Arma 3 sunucusu mu? (arma3server.exe, arma3server_x64.exe, Linux'ta arma3server_x64) */
export function isArmaServerProcess(name: string | undefined): boolean {
  return !!name && /^arma3server/i.test(name.split(/[\\/]/).pop()!);
}
