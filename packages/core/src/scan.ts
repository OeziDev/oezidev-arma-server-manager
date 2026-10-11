import type { Host } from './host/types.js';
import { type HostOs, pathLib } from './launch/paths.js';
import { asString, findValue, parseConfig } from './config/armaConfig.js';

export interface FoundMission {
  /** server.cfg template değeri (.pbo olmadan) */
  template: string;
  /** Dosya/klasör adı */
  fileName: string;
  island: string;
  kind: 'pbo' | 'folder';
  size: number;
  mtimeMs: number;
}

/** Klasörü büyük/küçük harf duyarsız bul (Windows'ta "MPMissions", Linux'ta "mpmissions"). */
export async function findDirCaseInsensitive(host: Host, parent: string, name: string): Promise<string | null> {
  const p = pathLib(host.os);
  const direct = p.join(parent, name);
  if (await host.exists(direct)) return direct;
  try {
    const entries = await host.list(parent);
    const hit = entries.find((e) => e.isDir && e.name.toLowerCase() === name.toLowerCase());
    return hit ? p.join(parent, hit.name) : null;
  } catch {
    return null;
  }
}

export function islandOf(template: string): string {
  const parts = template.split('.');
  return parts.length > 1 ? parts[parts.length - 1]! : '';
}

export interface MissionsDirResult {
  /** Sunucunun gerçekten okuduğu görev klasörü (yoksa null) */
  dir: string | null;
  /** Linux: farklı harfle yazılmış (sunucunun OKUMADIĞI) klasör, ör. ".../MPMissions" */
  wrongCaseDir?: string;
  /** Kullanıcıya gösterilecek uyarı */
  warning?: string;
}

/**
 * Görev klasörü. Windows'ta harf duyarsız. Linux sunucusu SADECE küçük harfli "mpmissions" okur:
 * yalnızca "MPMissions" varsa sessizce kullanılmaz, uyarı döner.
 */
export async function findMissionsDir(host: Host, serverDir: string): Promise<MissionsDirResult> {
  if (host.os === 'windows') return { dir: await findDirCaseInsensitive(host, serverDir, 'mpmissions') };
  const p = pathLib(host.os);
  const exact = p.join(serverDir, 'mpmissions');
  const exactIsDir = !!(await host.stat(exact))?.isDir;
  const other = (await host.list(serverDir).catch(() => [])).find((e) => e.isDir && e.name !== 'mpmissions' && e.name.toLowerCase() === 'mpmissions');
  if (!other) return { dir: exactIsDir ? exact : null };
  const wrongCaseDir = p.join(serverDir, other.name);
  const warning = exactIsDir
    ? `"${other.name}" klasöründeki görevler sunucu tarafından okunmaz: Linux sunucusu sadece küçük harfli "mpmissions" klasörünü kullanır.`
    : `"${other.name}" klasörü bulundu ama Linux sunucusu sadece küçük harfli "mpmissions" klasörünü okur. Klasörün adını "mpmissions" olarak değiştir.`;
  return { dir: exactIsDir ? exact : null, wrongCaseDir, warning };
}

export async function scanMissions(
  host: Host,
  serverDir: string,
): Promise<{ dir: string | null; missions: FoundMission[]; warning?: string; wrongCaseDir?: string }> {
  const found = await findMissionsDir(host, serverDir);
  const extra = { ...(found.warning ? { warning: found.warning } : {}), ...(found.wrongCaseDir ? { wrongCaseDir: found.wrongCaseDir } : {}) };
  const dir = found.dir;
  if (!dir) return { dir: null, missions: [], ...extra };
  const entries = await host.list(dir);
  const missions: FoundMission[] = [];
  for (const e of entries) {
    if (!e.isDir && /\.pbo$/i.test(e.name)) {
      const template = e.name.replace(/\.pbo$/i, '');
      missions.push({ template, fileName: e.name, island: islandOf(template), kind: 'pbo', size: e.size, mtimeMs: e.mtimeMs });
    } else if (e.isDir && e.name.includes('.')) {
      missions.push({ template: e.name, fileName: e.name, island: islandOf(e.name), kind: 'folder', size: 0, mtimeMs: e.mtimeMs });
    }
  }
  missions.sort((a, b) => a.template.localeCompare(b.template));
  return { dir, missions, ...extra };
}

export interface FoundMod {
  /** Sunucu klasörüne göre göreli yol (ör. "@cba_a3") */
  path: string;
  folderName: string;
  displayName: string;
  workshopId?: string;
  isSymlink: boolean;
  hasAddons: boolean;
  keys: string[];
}

/** meta.cpp / mod.cpp içinden ad ve Workshop id'si. */
export function parseModMeta(text: string): { name?: string; publishedId?: string } {
  const { entries } = parseConfig(text);
  const name = asString(findValue(entries, 'name'));
  const published = findValue(entries, 'publishedid');
  const publishedId = typeof published === 'number' ? String(Math.round(published)) : asString(published);
  return {
    ...(name ? { name } : {}),
    ...(publishedId && /^\d+$/.test(publishedId) && publishedId !== '0' ? { publishedId } : {}),
  };
}

async function readMeta(host: Host, modDir: string): Promise<{ name?: string; publishedId?: string }> {
  const p = pathLib(host.os);
  for (const file of ['meta.cpp', 'mod.cpp']) {
    const full = p.join(modDir, file);
    try {
      if (await host.exists(full)) {
        const meta = parseModMeta(await host.readText(full));
        if (meta.name || meta.publishedId) return meta;
      }
    } catch {
      /* okunamadı */
    }
  }
  return {};
}

/** Mod klasöründeki .bikey dosyaları (keys/ veya key/ altında, harf duyarsız). */
export async function findModKeys(host: Host, modDir: string): Promise<string[]> {
  const p = pathLib(host.os);
  const out: string[] = [];
  let entries;
  try {
    entries = await host.list(modDir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDir && /^(keys?|serverkeys?)$/i.test(e.name)) {
      const keyDir = p.join(modDir, e.name);
      for (const k of await host.list(keyDir).catch(() => [])) {
        if (!k.isDir && /\.bikey$/i.test(k.name)) out.push(p.join(keyDir, k.name));
      }
    }
  }
  return out;
}

/** Sunucu klasöründeki @mod klasörlerini tarar (Workshop bağlantıları dahil). */
export async function scanMods(host: Host, serverDir: string): Promise<FoundMod[]> {
  const p = pathLib(host.os);
  const entries = await host.list(serverDir);
  const mods: FoundMod[] = [];
  for (const e of entries) {
    if (!e.isDir || !e.name.startsWith('@')) continue;
    const dir = p.join(serverDir, e.name);
    const [meta, sub, keys] = await Promise.all([
      readMeta(host, dir),
      host.list(dir).catch(() => []),
      findModKeys(host, dir),
    ]);
    mods.push({
      path: e.name,
      folderName: e.name,
      displayName: meta.name ?? e.name.replace(/^@/, ''),
      ...(meta.publishedId ? { workshopId: meta.publishedId } : {}),
      isSymlink: e.isSymlink,
      hasAddons: sub.some((s) => s.isDir && s.name.toLowerCase() === 'addons'),
      keys,
    });
  }
  mods.sort((a, b) => a.folderName.localeCompare(b.folderName));
  return mods;
}

/** Görev dosyasını yükler; Linux'ta adı küçük harfe çevirir ve her zaman küçük harfli "mpmissions"a yazar. */
export async function uploadMission(host: Host, serverDir: string, localFile: string, os: HostOs = host.os): Promise<string> {
  const p = pathLib(os);
  const dir =
    os === 'windows'
      ? ((await findDirCaseInsensitive(host, serverDir, 'mpmissions')) ?? p.join(serverDir, 'MPMissions'))
      : p.join(serverDir, 'mpmissions');
  await host.mkdirp(dir);
  const base = (localFile.split(/[\\/]/).pop() ?? 'mission.pbo');
  const name = os === 'linux' ? base.toLowerCase() : base;
  if (!/\.pbo$/i.test(name)) throw new Error('Sadece .pbo dosyaları yüklenebilir');
  const target = p.join(dir, name);
  await host.upload(localFile, target);
  return name.replace(/\.pbo$/i, '');
}
