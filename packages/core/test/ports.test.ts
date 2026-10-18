import { describe, expect, it } from 'vitest';
import {
  describePortConflicts,
  isArmaServerProcess,
  parseLinuxUdpPortsOutput,
  parseNetstatLinuxUdp,
  parseSsUdp,
  parseTasklistCsv,
  parseWinNetstat,
  parseWinUdpPortsOutput,
  winUdpPortsScript,
} from '../src/index.js';

const PORTS = [2302, 2303, 2304, 2305, 2306, 2307];

describe('UDP port sahipleri: Windows', () => {
  it('PowerShell betiği portları tek Get-NetUDPEndpoint çağrısında sorar', () => {
    const s = winUdpPortsScript([2303, 2302, 2302, 0, 70000]);
    expect(s).toContain('Get-NetUDPEndpoint -LocalPort 2302,2303 ');
    expect(s).toContain('Get-Process -Id');
    expect(s).toContain("'NOCMD'");
  });

  it('Get-NetUDPEndpoint çıktısı: IPv4/IPv6 tekrarı teke iner, .exe eklenir', () => {
    const out = 'P:2302:1234:arma3server_x64\r\nP:2302:1234:arma3server_x64\r\nP:2303:1234:arma3server_x64\r\nP:9999:1:x\r\nP:2307:0:\r\nDONE\r\n';
    expect(parseWinUdpPortsOutput(out, PORTS)).toEqual([
      { port: 2302, pid: 1234, process: 'arma3server_x64.exe' },
      { port: 2303, pid: 1234, process: 'arma3server_x64.exe' },
      { port: 2307 },
    ]);
    expect(parseWinUdpPortsOutput('DONE', PORTS)).toEqual([]);
    expect(parseWinUdpPortsOutput('NOCMD', PORTS)).toBe('nocmd');
    // Yarım çıktı (PowerShell hata verdi): sonuç yok, netstat'a düşülür
    expect(parseWinUdpPortsOutput('P:2302:1:a', PORTS)).toBeNull();
  });

  it('netstat -ano -p UDP + tasklist', () => {
    const ns = [
      '',
      'Active Connections',
      '',
      '  Proto  Local Address          Foreign Address        State           PID',
      '  UDP    0.0.0.0:2302           *:*                                    5120',
      '  UDP    0.0.0.0:2306           *:*                                    5120',
      '  UDP    [::]:2303              *:*                                    5120',
      '  UDP    0.0.0.0:5353           *:*                                    880',
      '  TCP    0.0.0.0:2302           0.0.0.0:0              LISTENING       77',
    ].join('\r\n');
    expect(parseWinNetstat(ns, PORTS)).toEqual([
      { port: 2302, pid: 5120 },
      { port: 2303, pid: 5120 },
      { port: 2306, pid: 5120 },
    ]);
    const tl = parseTasklistCsv('"arma3server_x64.exe","5120","Console","1","2.000.000 K"\r\n"svchost.exe","880","Services","0","10 K"');
    expect(tl.get(5120)).toBe('arma3server_x64.exe');
    expect(tl.get(880)).toBe('svchost.exe');
  });
});

describe('UDP port sahipleri: Linux', () => {
  it('ss -Hlunp: süreçli ve (root olmadan) süreçsiz satırlar', () => {
    const out = [
      'TOOL:ss',
      'UNCONN 0      0            0.0.0.0:2302       0.0.0.0:*    users:(("arma3server_x64",pid=4321,fd=33))',
      'UNCONN 0      0               [::]:2303          [::]:*    users:(("arma3server_x64",pid=4321,fd=34))',
      'UNCONN 0      0                  *:2304             *:*',
      'UNCONN 0      0      127.0.0.53%lo:53         0.0.0.0:*    users:(("systemd-resolve",pid=500,fd=13))',
    ].join('\n');
    expect(parseLinuxUdpPortsOutput(out, PORTS)).toEqual([
      { port: 2302, pid: 4321, process: 'arma3server_x64' },
      { port: 2303, pid: 4321, process: 'arma3server_x64' },
      { port: 2304 },
    ]);
  });

  it('eski ss (başlıklı, Netid sütunlu)', () => {
    const out = 'Netid State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process\nudp   UNCONN 0      0      0.0.0.0:2305       0.0.0.0:*  users:(("x",pid=9,fd=1))';
    expect(parseSsUdp(out, PORTS)).toEqual([{ port: 2305, pid: 9, process: 'x' }]);
  });

  it('netstat -lunp yedeği', () => {
    const out = [
      'TOOL:netstat',
      'Active Internet connections (only servers)',
      'Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name',
      'udp        0      0 0.0.0.0:2302            0.0.0.0:*                           777/arma3server_x64',
      'udp6       0      0 :::2307                 :::*                                -',
    ].join('\n');
    expect(parseLinuxUdpPortsOutput(out, PORTS)).toEqual([{ port: 2302, pid: 777, process: 'arma3server_x64' }, { port: 2307 }]);
    expect(parseNetstatLinuxUdp(out, [2302])).toHaveLength(1);
  });

  it('araç yoksa hata fırlatır (başlatma yine de sürer)', () => {
    expect(() => parseLinuxUdpPortsOutput('TOOL:none', PORTS)).toThrow(/ss\/netstat/);
  });
});

describe('port çakışması açıklaması', () => {
  it('arma3server sahibini açıkça söyler (TR/EN)', () => {
    const m = describePortConflicts([
      { port: 2303, pid: 1234, process: 'arma3server_x64.exe' },
      { port: 2302, pid: 1234, process: 'arma3server_x64.exe' },
    ]);
    expect(m.tr).toContain('Portlar 2302, 2303 (UDP) kullanımda: arma3server_x64.exe (PID 1234)');
    expect(m.tr).toContain('TADST');
    expect(m.tr).toContain('önce onu kapat');
    expect(m.en).toContain('Ports 2302, 2303 (UDP) are in use: arma3server_x64.exe (PID 1234)');
    expect(m.en).toContain('Another Arma 3 server');
  });

  it('başka program / bilinmeyen süreç', () => {
    const other = describePortConflicts([{ port: 2302, pid: 9, process: 'node.exe' }]);
    expect(other.tr).toContain('Port 2302 (UDP) kullanımda: node.exe (PID 9)');
    expect(other.tr).toContain('farklı bir oyun portu');
    const unknown = describePortConflicts([{ port: 2302 }]);
    expect(unknown.tr).toContain('süreç bilinmiyor');
    expect(unknown.en).toContain('unknown process');
    expect(unknown.tr).toContain('TADST');
  });

  it('isArmaServerProcess', () => {
    expect(isArmaServerProcess('arma3server_x64.exe')).toBe(true);
    expect(isArmaServerProcess('arma3server')).toBe(true);
    expect(isArmaServerProcess('C:\\A3\\arma3server.exe')).toBe(true);
    expect(isArmaServerProcess('arma3.exe')).toBe(false);
    expect(isArmaServerProcess(undefined)).toBe(false);
  });
});
