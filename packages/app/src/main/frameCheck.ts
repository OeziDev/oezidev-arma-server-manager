import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * İstek uygulamanın kendi ana çerçevesinden mi? URL karşılaştırması yol üzerinden yapılır:
 * pathToFileURL `~ [ ] %` gibi karakterleri kodlar, Chromium ise kodlamayabilir (8.3 kısa yollar: C:\Users\HALITH~1\...).
 */
export function isOwnFrame(frameUrl: string, indexHtml: string, devUrl: string | null, platform: NodeJS.Platform = process.platform): boolean {
  if (devUrl) {
    try {
      return new URL(frameUrl).origin === new URL(devUrl).origin;
    } catch {
      return false;
    }
  }
  if (!frameUrl.startsWith('file:')) return false;
  let p: string;
  try {
    p = path.resolve(fileURLToPath(frameUrl));
  } catch {
    return false;
  }
  const want = path.resolve(indexHtml);
  return platform === 'win32' ? p.toLowerCase() === want.toLowerCase() : p === want;
}
