import { afterEach, describe, expect, it } from 'vitest';
import type { DirEntry, Host } from '../src/host/types.js';
import { createProfile } from '../src/model/profile.js';
import { ServerManager } from '../src/supervisor/manager.js';

/** Windows: yeniden başlatmadan sonra önceki çalıştırmanın .rpt dosyası izlenmemeli. */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean, timeoutMs = 3000, label = '') {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await sleep(20);
  }
  throw new Error(`zaman aşımı ${label}`);
}

class FakeWindowsHost {
  readonly id = 'local';
  readonly kind = 'local' as const;
  readonly label = 'local';
  readonly os = 'windows' as const;
  readonly generation = 1;
  dirs = new Map<string, DirEntry[]>();
  tails: { path: string; opts: unknown; push: (l: string[]) => void; stopped: boolean }[] = [];
  async list(dir: string): Promise<DirEntry[]> {
    return (this.dirs.get(dir) ?? []).map((e) => ({ ...e }));
  }
  addRpt(dir: string, name: string, mtimeMs = Date.now()) {
    const list = this.dirs.get(dir) ?? [];
    list.push({ name, isDir: false, isSymlink: false, size: 10, mtimeMs });
    this.dirs.set(dir, list);
  }
  tail(path: string, onLines: (l: string[]) => void, opts: unknown) {
    const t = { path, opts, push: onLines, stopped: false };
    this.tails.push(t);
    return { stop: () => void (t.stopped = true) };
  }
  active() {
    return this.tails.filter((t) => !t.stopped);
  }
}

const managers: ServerManager[] = [];
afterEach(() => managers.splice(0).forEach((m) => m.dispose()));

function make(host: FakeWindowsHost) {
  const profile = createProfile({ name: 'W', paths: { serverDir: 'C:\\server\\A3Server' } });
  const mgr = new ServerManager({ profile, host: host as unknown as Host, timers: { rptPollMs: 40, schedulerMs: 3_600_000, errorMessageGraceMs: 100 } });
  managers.push(mgr);
  const priv = mgr as unknown as {
    snapshotRpts(): Promise<void>;
    rptWatcher(dir: string, source: string, kind: 'new' | 'attach' | 'resume'): { stop(): void };
  };
  return { mgr, priv };
}

describe('Windows .rpt takibi', () => {
  it('yeni başlatmada önceki çalıştırmanın .rpt dosyasını izlemez; yenisi çıkınca ona, daha yenisi çıkınca ona geçer', async () => {
    const host = new FakeWindowsHost();
    const { mgr, priv } = make(host);
    const dir = mgr.paths.rptDir;
    // Önceki çalıştırmanın dosyası "şimdi" değiştirilmiş görünüyor (eski kod bunu seçiyordu)
    host.addRpt(dir, 'arma3server_x64_2026-10-11_10-00-00.rpt', Date.now() + 1000);
    await priv.snapshotRpts();
    const w = priv.rptWatcher(dir, 'server', 'new');
    await sleep(200);
    expect(host.active()).toHaveLength(0);
    host.addRpt(dir, 'arma3server_x64_2026-10-11_12-00-00.rpt');
    await waitFor(() => host.active().length === 1, 2000, 'new rpt');
    expect(host.active()[0]!.path).toBe(`${dir}\\arma3server_x64_2026-10-11_12-00-00.rpt`);
    expect(host.active()[0]!.opts).toEqual({ fromStart: true });
    host.addRpt(dir, 'arma3server_x64_2026-10-11_12-30-00.rpt');
    await waitFor(() => host.active()[0]?.path.endsWith('12-30-00.rpt') ?? false, 2000, 'newer rpt');
    expect(host.active()).toHaveLength(1);
    w.stop();
    expect(host.active()).toHaveLength(0);
  });

  it('takipte (attach) en yeni dosyayı son satırlarıyla izler', async () => {
    const host = new FakeWindowsHost();
    const { mgr, priv } = make(host);
    const dir = mgr.paths.rptDir;
    host.addRpt(dir, 'a.rpt', 1000);
    host.addRpt(dir, 'b.rpt', 2000);
    const w = priv.rptWatcher(dir, 'server', 'attach');
    await waitFor(() => host.active().length === 1, 2000, 'attach');
    expect(host.active()[0]!.path.endsWith('b.rpt')).toBe(true);
    expect(host.active()[0]!.opts).toEqual({ initialLines: 300 });
    w.stop();
  });

  it('yeni .rpt satırlarında ölümcül hata da aranır (doğru dosya)', async () => {
    const host = new FakeWindowsHost();
    const { mgr, priv } = make(host);
    const dir = mgr.paths.rptDir;
    await priv.snapshotRpts();
    priv.rptWatcher(dir, 'server', 'new');
    host.addRpt(dir, 'yeni.rpt');
    await waitFor(() => host.active().length === 1, 2000, 'rpt');
    const internal = mgr as unknown as { status: string; awaitingReady: boolean; handleCrash: (kind: string, detail?: string) => Promise<void> };
    internal.status = 'starting';
    internal.awaitingReady = true;
    const calls: [string, string | undefined][] = [];
    internal.handleCrash = async (kind, detail) => void calls.push([kind, detail]);
    host.active()[0]!.push([
      ' 7:00:00 Reading server.cfg',
      ' 7:00:01 File C:\\server\\A3Server\\A3Master\\oezi-profiles\\57-alay\\server.cfg, line 107: .regularCheck: Member already defined.',
      ' 7:00:01 Host identity created.',
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe('fatal');
    expect(calls[0]![1]).toContain('Reading server.cfg\n 7:00:01 File C:\\server');
    // Hata görüldükten sonra "hazır" satırı çalışıyor durumuna geçirmez
    expect(internal.status).toBe('starting');
    // Mod/görev config'lerindeki aynı biçimli satırlar zararsızdır (gerçek RPT'lerde bolca var)
    calls.length = 0;
    (mgr as unknown as { fatalDetail: string | null }).fatalDetail = null;
    host.active()[0]!.push([
      " 7:00:02 File @mod\\mod.cpp, line 5: '.action': Missing ';' at the end of line",
      " 7:00:02 File usaf_all\\config.cpp, line 186: '/CfgVehicles/x/EventHandlers.init': Missing ';' prior '}'",
      ' 7:00:03 Warning Message: File x.hpp, line 3: bir uyarı',
    ]);
    expect(calls).toHaveLength(0);
    // ErrorMessage: hemen öldürmez, kısa süre içinde hazır olmazsa başarısız sayılır
    host.active()[0]!.push([' 7:00:04 ErrorMessage: Include file x.hpp not found.']);
    expect(calls).toHaveLength(0);
    await waitFor(() => calls.length === 1, 2000, 'grace');
    expect(calls[0]![0]).toBe('fatal');
    // Çalışan sunucuda (bağlanırken tekrar okunan eski satırlar dahil) hiçbir satır öldürmez
    calls.length = 0;
    (mgr as unknown as { fatalDetail: string | null }).fatalDetail = null;
    internal.status = 'running';
    internal.awaitingReady = false;
    host.active()[0]!.push([' 7:10:02 ErrorMessage: Include file x.hpp not found.', ' 7:10:03 File C:\\x\\server.cfg, line 1: .a: Member already defined.']);
    await new Promise((r) => setTimeout(r, 300));
    expect(calls).toHaveLength(0);
  });
});
