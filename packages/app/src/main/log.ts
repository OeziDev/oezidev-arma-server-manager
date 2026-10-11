import fs from 'node:fs';
import path from 'node:path';
import { inspect } from 'node:util';

/**
 * Ana süreç günlüğü: <userData>/logs/main.log (5 MB'ı geçince main.log.1 olarak döndürülür).
 * Yakalanmamış hatalar da buraya yazılır; Electron'un hata penceresi gösterilmez.
 */

export type LogLevel = 'info' | 'warn' | 'error';

const MAX_SIZE = 5 * 1024 * 1024;

let file: string | null = null;
let size = 0;
const original = { error: console.error.bind(console), warn: console.warn.bind(console), log: console.log.bind(console) };

function fmt(v: unknown): string {
  if (v instanceof Error) return v.stack ?? `${v.name}: ${v.message}`;
  if (typeof v === 'string') return v;
  return inspect(v, { depth: 4, breakLength: 160 });
}

function append(level: LogLevel, parts: unknown[]) {
  if (!file) return;
  try {
    const line = `${new Date().toISOString()} [${level}] ${parts.map(fmt).join(' ')}\n`;
    if (size + line.length > MAX_SIZE) {
      try {
        fs.renameSync(file, `${file}.1`);
      } catch {
        /* eski dosya yoksa sorun değil */
      }
      size = 0;
    }
    fs.appendFileSync(file, line, 'utf8');
    size += Buffer.byteLength(line);
  } catch {
    /* günlük yazılamıyorsa uygulama yine çalışsın */
  }
}

/** Günlük dosyasını hazırla ve console.error/warn çıktısını da dosyaya yönlendir. */
export function initLog(userDataDir: string) {
  try {
    const dir = path.join(userDataDir, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, 'main.log');
    size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  } catch {
    file = null;
    return;
  }
  console.error = (...args: unknown[]) => {
    original.error(...args);
    append('error', args);
  };
  console.warn = (...args: unknown[]) => {
    original.warn(...args);
    append('warn', args);
  };
}

export function log(level: LogLevel, ...parts: unknown[]) {
  const out = level === 'error' ? original.error : level === 'warn' ? original.warn : original.log;
  out(...parts);
  append(level, parts);
}

export function logFilePath(): string | null {
  return file;
}
