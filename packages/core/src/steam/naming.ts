/** Workshop için saf yardımcılar (Node bağımlılığı yok; arayüzde de kullanılır). */

/** "https://steamcommunity.com/sharedfiles/filedetails/?id=450814997" veya "450814997" */
export function parseWorkshopId(input: string): string | null {
  const s = input.trim();
  if (/^\d{4,12}$/.test(s)) return s;
  const m = /[?&]id=(\d{4,12})/.exec(s);
  return m ? m[1]! : null;
}

export interface PresetMod {
  name: string;
  workshopId?: string;
}

/** Arma 3 Launcher'dan dışa aktarılan mod listesi (.html) */
export function parseLauncherPreset(html: string): PresetMod[] {
  const out: PresetMod[] = [];
  const rows = html.split(/<tr\b/i).slice(1);
  for (const row of rows) {
    if (!/data-type="(Local)?ModContainer"/i.test(row)) continue;
    const name = /data-type="DisplayName"[^>]*>([^<]*)</i.exec(row)?.[1]?.trim();
    const id = /filedetails\/\?id=(\d+)/i.exec(row)?.[1];
    if (!name) continue;
    out.push({ name: decodeEntities(name), ...(id ? { workshopId: id } : {}) });
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

