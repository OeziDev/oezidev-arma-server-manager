/**
 * Profil başına küçük dosyalar: performans geçmişi (metrics/<id>.json) ve oyuncu geçmişi (history/<id>.jsonl).
 * Electron'a bağlı değildir (birim testlerinde doğrudan kullanılır).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { MetricsJSON, PlayerHistoryStorage } from '@oezi/arma-core';
import { writeAtomic } from './store.js';

/** Profil kimliği dosya adında güvenle kullanılabilsin (yol ayırıcı vb. olmasın) */
function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_') || '_';
}

export function metricsFile(dataDir: string, profileId: string): string {
  return path.join(dataDir, 'metrics', `${safeId(profileId)}.json`);
}

export function historyFile(dataDir: string, profileId: string): string {
  return path.join(dataDir, 'history', `${safeId(profileId)}.jsonl`);
}

/** Kayıtlı performans geçmişi; yoksa / bozuksa null (yeni geçmişle başlanır) */
export function loadMetrics(dataDir: string, profileId: string): MetricsJSON | null {
  try {
    const raw = JSON.parse(fs.readFileSync(metricsFile(dataDir, profileId), 'utf8')) as Partial<MetricsJSON> | null;
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.samples)) return null;
    return { v: 1, samples: raw.samples };
  } catch {
    return null;
  }
}

/** Atomik yazma (geçici dosya + yeniden adlandırma). Boş geçmiş için dosya yoksa oluşturulmaz. */
export function saveMetrics(dataDir: string, profileId: string, data: MetricsJSON): void {
  const file = metricsFile(dataDir, profileId);
  if (!data.samples.length && !fs.existsSync(file)) return;
  // .bak tutulmaz: performans geçmişi kaybolsa da sorun değil, gereksiz dosya birikmesin
  writeAtomic(file, JSON.stringify(data), { isValid: () => false });
}

/** Dosyayı ve olası artıklarını (.bak, yarım kalmış .tmp) siler */
export function removeWithLeftovers(file: string): void {
  const dir = path.dirname(file);
  const base = path.basename(file);
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name === base || name === `${base}.bak` || (name.startsWith(`${base}.`) && name.endsWith('.tmp'))) {
        fs.rmSync(path.join(dir, name), { force: true });
      }
    }
  } catch {
    /* klasör yok */
  }
}

/** JSONL depo: her satır bir kayıt; ekleme appendFile ile, okuma satırlara bölerek. */
export class JsonlHistoryStorage implements PlayerHistoryStorage {
  private dirReady = false;
  constructor(readonly file: string) {}

  async append(line: string): Promise<void> {
    if (!this.dirReady) {
      await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
      this.dirReady = true;
    }
    await fs.promises.appendFile(this.file, line.replace(/[\r\n]+/g, ' ') + '\n', 'utf8');
  }

  async readAll(): Promise<string[]> {
    let text: string;
    try {
      text = await fs.promises.readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    return text.split(/\r?\n/).filter((l) => l.trim());
  }

  /** Sıkıştırılmış içeriği atomik olarak yaz (bütün dosyanın yerine) */
  rewrite(lines: string[]): void {
    writeAtomic(this.file, lines.length ? lines.join('\n') + '\n' : '', { isValid: () => false });
  }
}
