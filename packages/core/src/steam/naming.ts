/** Workshop için saf yardımcılar (Node bağımlılığı yok; arayüzde de kullanılır). */

/** "https://steamcommunity.com/sharedfiles/filedetails/?id=450814997" veya "450814997" */
export function parseWorkshopId(input: string): string | null {
  const s = input.trim();
  if (/^\d{4,12}$/.test(s)) return s;
  const m = /[?&]id=(\d{4,12})/.exec(s);
  return m ? m[1]! : null;
}

export interface PresetMod {
  /** Workshop modunda görünen ad; yerel modda klasör adı (Link yolundaki son klasör, güvenli hale getirilmiş) */
  name: string;
  workshopId?: string;
  /** Launcher'daki görünen ad (DisplayName) */
  displayName?: string;
  /** Yerel modun klasör adı (ör. "@benim_modum") */
  folder?: string;
}

/** "local:C:\\Arma\\@mod\\" ya da "C:\\Arma\\@mod" -> "@mod" */
function lastFolderName(p: string): string | undefined {
  const clean = p.replace(/^local:/i, '').split('|')[0]!.trim();
  const parts = clean.split(/[\\/]+/).filter((x) => x && x !== '.' && x !== '..');
  const last = parts[parts.length - 1];
  return last && !/^[a-z]:$/i.test(last) ? last : undefined;
}

/**
 * Klasör adı olarak kullanılacak metni güvenli yapar: ";" (mod listesi ayırıcı), Windows'ta yasak
 * karakterler (<>:"/\\|?*) ve kontrol karakterleri "_" olur; sondaki nokta/boşluklar atılır,
 * Windows'un ayrılmış adları (CON, NUL, COM1...) değiştirilir.
 */
export function sanitizeFolderName(name: string): string {
  let s = name
    .replace(/[\u0000-\u001f\u007f;<>:"/\\|?*]/g, '_')
    .trim()
    .replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(s)) s = `_${s}`;
  if (s === '' || s === '.' || s === '..') return '';
  return s;
}

/** Arma 3 Launcher'dan dışa aktarılan mod listesi (.html) */
export function parseLauncherPreset(html: string): PresetMod[] {
  const out: PresetMod[] = [];
  const rows = html.split(/<tr\b/i).slice(1);
  for (const row of rows) {
    if (!/data-type="(Local)?ModContainer"/i.test(row)) continue;
    const rawName = /data-type="DisplayName"[^>]*>([^<]*)</i.exec(row)?.[1]?.trim();
    const id = /filedetails\/\?id=(\d+)/i.exec(row)?.[1];
    const displayName = rawName ? decodeEntities(rawName) : undefined;
    if (id) {
      if (!displayName) continue;
      out.push({ name: displayName, workshopId: id });
      continue;
    }
    // Yerel mod: klasör adı Link'teki "local:C:\\...\\@klasor\\" yolundan, yoksa görünen addan
    const link = /<[^>]*data-type="Link"[^>]*>([^<]*)</i.exec(row);
    const linkTag = link?.[0] ?? '';
    const meta = /data-meta="([^"]*)"/i.exec(linkTag)?.[1] ?? /href="([^"]*)"/i.exec(linkTag)?.[1];
    const candidates = [meta, link?.[1]].filter((x): x is string => !!x).map((x) => decodeEntities(x).trim());
    const fromPath = candidates.map((c) => (/^local:/i.test(c) || /[\\/]/.test(c) ? lastFolderName(c) : undefined)).find(Boolean);
    const folder = sanitizeFolderName(fromPath ?? displayName ?? '');
    if (!folder) continue;
    out.push({ name: folder, folder, ...(displayName ? { displayName } : {}) });
  }
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)));
}

/** Workshop başlığından güvenli @klasör adı: "Task Force Radio (BETA)" -> "@task_force_radio_beta" */
export function modFolderName(title: string, fallbackId: string): string {
  const map: Record<string, string> = { ç: 'c', ğ: 'g', ı: 'i', İ: 'i', ö: 'o', ş: 's', ü: 'u', ä: 'ae', ß: 'ss' };
  const base = title
    .split('')
    .map((c) => map[c] ?? map[c.toLowerCase()] ?? c)
    .join('')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  return '@' + (base || fallbackId);
}

