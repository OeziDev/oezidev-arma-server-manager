import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  ByteLineSplitter,
  LocalHost,
  decodeLogLine,
  encodePowerShellCommand,
  parseWinCommandLineOutput,
  winCommandLineScript,
} from '../src/host/local.js';
import { SshHost, parseRemoteDate } from '../src/host/ssh.js';
import { SYSTEMD_STATUS_TIMEOUT_MS, createSystemdApi } from '../src/host/systemd.js';
import type { ExecResult } from '../src/host/types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean | Promise<boolean>, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await sleep(50);
  }
  throw new Error('zaman aşımı');
}

describe('SSH bağlantı hataları yakalanmamış istisnaya dönüşmez', () => {
  it('el sıkışma zaman aşımı (sessiz sunucu): tek hata, ikinci "Connection lost" dinleyicisiz kalmaz', async () => {
    const sockets: net.Socket[] = [];
    const server = net.createServer((s) => {
      sockets.push(s);
      s.on('error', () => undefined);
      // Hiç cevap verme; bir süre sonra bağlantıyı kopar (ssh2 ikinci 'error' yayar)
      setTimeout(() => s.destroy(), 400);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => uncaught.push(e);
    process.on('uncaughtException', onUncaught);
    try {
      const host = new SshHost({ id: 't', host: '127.0.0.1', port, username: 'x', password: 'y', readyTimeoutMs: 200 });
      await expect(host.connect()).rejects.toMatchObject({ code: 'connect_failed' });
      await sleep(700);
      expect(uncaught).toEqual([]);
      expect(host.isConnected()).toBe(false);
    } finally {
      process.off('uncaughtException', onUncaught);
      sockets.forEach((s) => s.destroy());
      await new Promise((r) => server.close(r));
    }
  });

  it('sunucu bağlantıyı hemen kapatırsa connect() takılmaz, reddedilir', async () => {
    const server = net.createServer((s) => s.destroy());
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const host = new SshHost({ id: 't', host: '127.0.0.1', port, username: 'x', password: 'y', readyTimeoutMs: 3000 });
      await expect(host.connect()).rejects.toMatchObject({ code: 'connect_failed' });
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('bozuk özel anahtar: eşzamanlı hata da HostError olarak döner', async () => {
    const host = new SshHost({ id: 't', host: '127.0.0.1', port: 1, username: 'x', privateKey: 'bu bir anahtar değil' });
    await expect(host.connect()).rejects.toMatchObject({ code: 'connect_failed' });
  });
});

describe('Windows süreç komut satırı (PowerShell, UTF-8/base64)', () => {
  it('Türkçe karakterli yol bozulmadan çözülür', () => {
    const cmd = '"C:\\Arma 3\\arma3server_x64.exe" "-profiles=C:\\Users\\Halit Özcan\\Belgeler\\şğüİı" -name=server';
    const out = `B64:${Buffer.from(cmd, 'utf8').toString('base64')}\r\n`;
    expect(parseWinCommandLineOutput(out)).toBe(cmd);
    // tasklist gibi UTF-16 çıktı (NUL baytları) da tolere edilir
    expect(parseWinCommandLineOutput(out.split('').join('\u0000'))).toBe(cmd);
  });
  it('komut satırı bilinmiyorsa (erişim yok / süreç yok) undefined', () => {
    expect(parseWinCommandLineOutput('NONE\r\n')).toBeUndefined();
    expect(parseWinCommandLineOutput('')).toBeUndefined();
  });
  it('betik -EncodedCommand için UTF-16LE base64, çıktı saf ASCII (B64:)', () => {
    const script = winCommandLineScript(4242);
    expect(script).toContain("ProcessId=4242");
    expect(script).toContain('[Text.Encoding]::UTF8.GetBytes');
    expect(Buffer.from(encodePowerShellCommand(script), 'base64').toString('utf16le')).toBe(script);
  });
});

describe('log satırı çözme', () => {
  it('UTF-8, CRLF ve parçalı çok baytlı karakterler', () => {
    const sp = new ByteLineSplitter();
    const data = Buffer.from('ğüşİı satır\r\nikinci', 'utf8');
    // "ğ" ortasından böl
    expect(sp.push(data.subarray(0, 1))).toEqual([]);
    expect(sp.push(data.subarray(1))).toEqual(['ğüşİı satır']);
    expect(sp.hasPartial).toBe(true);
    expect(sp.push(Buffer.from('\n'))).toEqual(['ikinci']);
    expect(sp.flush()).toEqual([]);
  });
  it('geçersiz UTF-8 satırı ANSI (cp1254/latin1) olarak çözülür, diğer satırlar etkilenmez', () => {
    const ansi = Buffer.from([0x4b, 0x61, 0x72, 0x61, 0x20, 0xfe, 0x65, 0x68, 0x69, 0x72]); // "Kara şehir" cp1254
    const line = decodeLogLine(ansi);
    expect(['Kara şehir', 'Kara þehir']).toContain(line);
    const sp = new ByteLineSplitter();
    expect(sp.push(Buffer.concat([ansi, Buffer.from('\nçalışıyor\n', 'utf8')]))).toEqual([line, 'çalışıyor']);
  });
});

describe('LocalHost tail', () => {
  const host = new LocalHost();

  it('dosya kesilince eski yarım satır yeni içeriğe yapışmaz', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oezi-tail-'));
    const log = path.join(dir, 'server.rpt');
    try {
      fs.writeFileSync(log, 'eski satır\nyarım kalan');
      const lines: string[] = [];
      const t = host.tail(log, (l) => lines.push(...l), { initialLines: 10 });
      await waitFor(() => lines.includes('eski satır'));
      // yerinde kesme (aynı inode, daha kısa)
      fs.writeFileSync(log, 'kısa\n');
      await waitFor(() => lines.includes('kısa'));
      // yeniden oluşturma (yeni inode, eskisinden uzun)
      fs.writeFileSync(log + '.new', 'yarım');
      fs.renameSync(log + '.new', log);
      await sleep(700);
      fs.appendFileSync(log, ' değil, yeni dosya ve oldukça uzun bir satır\n');
      await waitFor(() => lines.some((l) => l.startsWith('yarım değil')));
      t.stop();
      expect(lines).toEqual(['eski satır', 'kısa', 'yarım değil, yeni dosya ve oldukça uzun bir satır']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fromStart: ANSI kodlu RPT satırı bozulmadan gelir', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oezi-tail-'));
    const log = path.join(dir, 'arma.rpt');
    try {
      fs.writeFileSync(log, Buffer.concat([Buffer.from('Oyuncu ', 'utf8'), Buffer.from([0xdd, 0x73, 0x6d, 0x61, 0x69, 0x6c]), Buffer.from(' bağlandı\n', 'utf8')]));
      const lines: string[] = [];
      const t = host.tail(log, (l) => lines.push(...l), { fromStart: true });
      await waitFor(() => lines.length > 0);
      t.stop();
      // satırın kendisi geçersiz UTF-8 olduğu için tamamı ANSI çözülür ("ğ" bu durumda bozuk görünür; tek satır, NUL yok)
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^Oyuncu (İ|Ý)smail /);
      expect(lines[0]).not.toContain('\u0000');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('LocalHost exec', () => {
  it('arka plana atılmış torun boruyu tutsa da exec takılmaz', async () => {
    const host = new LocalHost();
    const start = Date.now();
    const res = await host.exec('sh', ['-c', 'sleep 30 & echo $!']);
    expect(Date.now() - start).toBeLessThan(8000);
    expect(res.code).toBe(0);
    const pid = Number(res.stdout.trim());
    if (pid > 0) await host.killProcess(pid, { force: true });
  });
});

describe('systemd status zaman aşımı', () => {
  it('systemctl show çağrısına zaman sınırı verilir; aşılırsa hata fırlatır (izleme kilitlenmez)', async () => {
    const seen: (number | undefined)[] = [];
    const exec = async (_f: string, _a: string[], o?: { timeoutMs?: number }): Promise<ExecResult> => {
      seen.push(o?.timeoutMs);
      return { code: null, stdout: '', stderr: '', timedOut: true };
    };
    const api = createSystemdApi(exec, async () => undefined, async () => undefined);
    await expect(api.status('oezi-arma-abc.service')).rejects.toMatchObject({ code: 'systemctl_timeout' });
    expect(seen).toEqual([SYSTEMD_STATUS_TIMEOUT_MS]);
  });
});

describe('uzak saat', () => {
  it('date çıktısı (GNU %3N ve yedek %s)', () => {
    expect(parseRemoteDate('1760000000123\n1760000000\n')).toBe(1760000000123);
    expect(parseRemoteDate('1760000000%3N\n1760000000\n')).toBe(1760000000000);
    expect(parseRemoteDate('17600000003N\n1760000000\n')).toBe(1760000000000);
    expect(parseRemoteDate('')).toBeNull();
  });
});
