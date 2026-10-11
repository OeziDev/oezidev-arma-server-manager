import type { Host } from '../host/types.js';
import { type HostOs, pathLib } from '../launch/paths.js';
import { findModKeys } from '../scan.js';
import { workshopContentDir } from './steamcmd.js';

export * from './naming.js';

/* ---------------- Workshop id / koleksiyon / launcher preset ---------------- */

/* ---------------- Steam Web API (anahtar gerektirmez) ---------------- */

export interface WorkshopItemInfo {
  id: string;
  title: string;
  sizeBytes: number;
  /** Unix ms */
  updatedAt: number;
  found: boolean;
  isCollection?: boolean;
}

const API = 'https://api.steampowered.com/ISteamRemoteStorage';

export async function fetchWorkshopDetails(ids: string[], fetchImpl: typeof fetch = fetch): Promise<WorkshopItemInfo[]> {
  const unique = [...new Set(ids)].filter((id) => /^\d+$/.test(id));
  const out: WorkshopItemInfo[] = [];
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const body = new URLSearchParams({ itemcount: String(chunk.length) });
    chunk.forEach((id, idx) => body.set(`publishedfileids[${idx}]`, id));
    const res = await fetchImpl(`${API}/GetPublishedFileDetails/v1/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Steam Workshop bilgisi alınamadı (HTTP ${res.status})`);
    const json = (await res.json()) as {
      response?: { publishedfiledetails?: { publishedfileid: string; result: number; title?: string; file_size?: string | number; time_updated?: number; file_type?: number }[] };
    };
    for (const d of json.response?.publishedfiledetails ?? []) {
      out.push({
        id: d.publishedfileid,
        title: d.title ?? '',
        sizeBytes: Number(d.file_size ?? 0) || 0,
        updatedAt: (d.time_updated ?? 0) * 1000,
        found: d.result === 1,
        ...(d.file_type === 2 ? { isCollection: true } : {}),
      });
    }
  }
  return out;
}

/** Workshop koleksiyonundaki mod id'leri (iç içe koleksiyonlar dahil). */
export async function fetchCollectionItems(collectionId: string, fetchImpl: typeof fetch = fetch, depth = 0): Promise<string[]> {
  if (depth > 3) return [];
  const body = new URLSearchParams({ collectioncount: '1', 'publishedfileids[0]': collectionId });
  const res = await fetchImpl(`${API}/GetCollectionDetails/v1/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Koleksiyon bilgisi alınamadı (HTTP ${res.status})`);
  const json = (await res.json()) as {
    response?: { collectiondetails?: { result: number; children?: { publishedfileid: string; filetype: number }[] }[] };
  };
  const details = json.response?.collectiondetails?.[0];
  if (!details || details.result !== 1) throw new Error('Koleksiyon bulunamadı (gizli olabilir)');
  const ids: string[] = [];
  for (const child of details.children ?? []) {
    if (child.filetype === 2) ids.push(...(await fetchCollectionItems(child.publishedfileid, fetchImpl, depth + 1)));
    else ids.push(child.publishedfileid);
  }
  return [...new Set(ids)];
}

/* ---------------- Sunucuya kurulum ---------------- */

/**
 * Linux Arma sunucusu mod içindeki klasör ve dosya adlarının küçük harf olmasını ister.
 * Alttan üste yeniden adlandırır; aynı adın küçük harflisi varsa (SteamCMD güncellemesi sonrası) eskisini değiştirir.
 */
export async function lowercaseTree(host: Host, dir: string): Promise<number> {
  if (host.os !== 'linux') return 0;
  const script = `cd "$1" || exit 1; n=0
find . -depth -mindepth 1 -name '*[[:upper:]]*' -print0 | while IFS= read -r -d '' f; do
  d=$(dirname "$f"); b=$(basename "$f"); l=$(printf '%s' "$b" | tr '[:upper:]' '[:lower:]')
  [ "$b" = "$l" ] && continue
  if [ -e "$d/$l" ]; then rm -rf -- "$d/$l"; fi
  mv -f -- "$d/$b" "$d/$l"; n=$((n+1)); echo "$n"
done | tail -n1`;
  const res = await host.exec('bash', ['-c', script, 'bash', dir], { timeoutMs: 600_000 });
  if (res.code !== 0) throw new Error(`Küçük harfe çevirme başarısız: ${res.stderr.trim()}`);
  return Number(res.stdout.trim()) || 0;
}

interface KeyManifest {
  /** anahtar dosya adı -> onu getiren mod klasörleri */
  keys: Record<string, string[]>;
}

async function readKeyManifest(host: Host, keysDir: string): Promise<KeyManifest> {
  try {
    const raw = JSON.parse(await host.readText(pathLib(host.os).join(keysDir, '.oezi-keys.json'))) as KeyManifest;
    return raw && typeof raw.keys === 'object' ? raw : { keys: {} };
  } catch {
    return { keys: {} };
  }
}

async function writeKeyManifest(host: Host, keysDir: string, m: KeyManifest) {
  await host.writeFile(pathLib(host.os).join(keysDir, '.oezi-keys.json'), JSON.stringify(m, null, 2));
}

/** Modun .bikey dosyalarını sunucunun keys/ klasörüne kopyalar. */
export async function syncModKeys(host: Host, serverDir: string, modDir: string, modFolder: string): Promise<string[]> {
  const L = pathLib(host.os);
  const keysDir = L.join(serverDir, 'keys');
  await host.mkdirp(keysDir);
  const manifest = await readKeyManifest(host, keysDir);
  const copied: string[] = [];
  for (const key of await findModKeys(host, modDir)) {
    const name = host.os === 'linux' ? L.basename(key).toLowerCase() : L.basename(key);
    await host.copyFile(key, L.join(keysDir, name));
    const owners = new Set(manifest.keys[name] ?? []);
    owners.add(modFolder);
    manifest.keys[name] = [...owners];
    copied.push(name);
  }
  await writeKeyManifest(host, keysDir, manifest);
  return copied;
}

/** Mod kaldırılınca sadece o modun getirdiği (başka modun kullanmadığı) anahtarları sil. */
export async function removeModKeys(host: Host, serverDir: string, modFolder: string): Promise<string[]> {
  const L = pathLib(host.os);
  const keysDir = L.join(serverDir, 'keys');
  const manifest = await readKeyManifest(host, keysDir);
  const removed: string[] = [];
  for (const [name, owners] of Object.entries(manifest.keys)) {
    const rest = owners.filter((o) => o !== modFolder);
    if (rest.length === owners.length) continue;
    if (rest.length === 0) {
      await host.remove(L.join(keysDir, name)).catch(() => undefined);
      delete manifest.keys[name];
      removed.push(name);
    } else {
      manifest.keys[name] = rest;
    }
  }
  await writeKeyManifest(host, keysDir, manifest);
  return removed;
}

export interface InstallModResult {
  folder: string;
  linkPath: string;
  keys: string[];
  renamed: number;
}

/**
 * İndirilmiş Workshop modunu sunucuya bağla: (Linux'ta küçük harf) + @klasör bağlantısı + anahtarlar.
 * Dosyalar kopyalanmaz; @klasör Workshop indirme klasörüne bağlantıdır, güncellemeler anında yansır.
 */
export async function installWorkshopMod(
  host: Host,
  o: { serverDir: string; workshopDir: string; id: string; folder: string; os?: HostOs },
): Promise<InstallModResult> {
  const L = pathLib(host.os);
  const src = workshopContentDir(host.os, o.workshopDir, o.id);
  if (!(await host.exists(src))) throw new Error(`Mod indirilmemiş: ${o.id} (${src})`);
  const renamed = await lowercaseTree(host, src);
  const folder = host.os === 'linux' ? o.folder.toLowerCase() : o.folder;
  const linkPath = L.join(o.serverDir, folder);
  await host.linkDir(src, linkPath);
  const keys = await syncModKeys(host, o.serverDir, src, folder);
  return { folder, linkPath, keys, renamed };
}

export async function uninstallWorkshopMod(host: Host, serverDir: string, folder: string): Promise<void> {
  const L = pathLib(host.os);
  const linkPath = L.join(serverDir, folder);
  if ((await host.readLink(linkPath)) !== null) await host.remove(linkPath);
  await removeModKeys(host, serverDir, folder);
}
