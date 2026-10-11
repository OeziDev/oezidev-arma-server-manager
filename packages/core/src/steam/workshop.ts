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

interface PublishedFileDetails {
  publishedfileid: string;
  result: number;
  title?: string;
  file_size?: string | number;
  time_updated?: number;
  file_type?: number;
  creator_app_id?: number;
  consumer_app_id?: number;
}

/** Steam'in koleksiyonlar için kullandığı uygulama kimliği (creator_app_id) */
const COLLECTION_CREATOR_APP_ID = 766;

async function postForm(url: string, body: URLSearchParams, fetchImpl: typeof fetch): Promise<Response> {
  return fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });
}

/**
 * Birden fazla öğe için GetCollectionDetails (tek istek): çocuğu olan öğeler koleksiyondur.
 * Hata olursa boş küme döner (koleksiyon tespiti yardımcı bilgidir, mod bilgisini engellemesin).
 */
async function collectionsAmong(ids: string[], fetchImpl: typeof fetch): Promise<Set<string>> {
  const found = new Set<string>();
  if (!ids.length) return found;
  try {
    const body = new URLSearchParams({ collectioncount: String(ids.length) });
    ids.forEach((id, idx) => body.set(`publishedfileids[${idx}]`, id));
    const res = await postForm(`${API}/GetCollectionDetails/v1/`, body, fetchImpl);
    if (!res.ok) return found;
    const json = (await res.json()) as {
      response?: { collectiondetails?: { publishedfileid?: string; result: number; children?: unknown[] }[] };
    };
    (json.response?.collectiondetails ?? []).forEach((d, idx) => {
      const id = d.publishedfileid ?? ids[idx];
      if (id && d.result === 1 && Array.isArray(d.children) && d.children.length > 0) found.add(id);
    });
  } catch {
    /* yok say */
  }
  return found;
}

export async function fetchWorkshopDetails(ids: string[], fetchImpl: typeof fetch = fetch): Promise<WorkshopItemInfo[]> {
  const unique = [...new Set(ids)].filter((id) => /^\d+$/.test(id));
  const out: WorkshopItemInfo[] = [];
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const body = new URLSearchParams({ itemcount: String(chunk.length) });
    chunk.forEach((id, idx) => body.set(`publishedfileids[${idx}]`, id));
    const res = await postForm(`${API}/GetPublishedFileDetails/v1/`, body, fetchImpl);
    if (!res.ok) throw new Error(`Steam Workshop bilgisi alınamadı (HTTP ${res.status})`);
    const json = (await res.json()) as { response?: { publishedfiledetails?: PublishedFileDetails[] } };
    const details = json.response?.publishedfiledetails ?? [];
    // file_type bu uç noktada genelde gelmez; kesin olmayan öğeleri tek bir GetCollectionDetails isteğiyle sor
    const sure = (d: PublishedFileDetails) => d.file_type === 2 || d.creator_app_id === COLLECTION_CREATOR_APP_ID;
    const unsure = details.filter(
      (d) => d.result === 1 && !sure(d) && (d.creator_app_id === undefined || d.consumer_app_id === undefined || d.creator_app_id !== d.consumer_app_id),
    );
    const collections = await collectionsAmong(
      unsure.map((d) => d.publishedfileid),
      fetchImpl,
    );
    for (const d of details) {
      out.push({
        id: d.publishedfileid,
        title: d.title ?? '',
        sizeBytes: Number(d.file_size ?? 0) || 0,
        updatedAt: (d.time_updated ?? 0) * 1000,
        found: d.result === 1,
        ...(sure(d) || collections.has(d.publishedfileid) ? { isCollection: true } : {}),
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
 * Alttan üste yeniden adlandırır. Aynı adın küçük harflisi zaten varsa (SteamCMD güncellemesi
 * sadece değişen dosyaları orijinal harflerle yazar) klasörler BİRLEŞTİRİLİR: değişmeyen dosyalar
 * korunur, sadece aynı adlı dosyalar yenisiyle değiştirilir.
 * POSIX sh ile çalışır (uzak Linux'ta da); boşluk/tırnak/yeni satır içeren adlar güvenlidir.
 */
export async function lowercaseTree(host: Host, dir: string): Promise<number> {
  if (host.os !== 'linux') return 0;
  // $1: hedef klasör, $2: find -exec ile çalışan iç betik (iç içe tırnaklama gerekmesin)
  const outer = `cd "$1" || exit 1
find . -depth -name '*[[:upper:]]*' -exec sh -c "$2" sh {} +`;
  const inner = `isdir() { [ -d "$1" ] && [ ! -L "$1" ]; }
exists() { [ -e "$1" ] || [ -L "$1" ]; }
merge() (
  for c in "$1"/* "$1"/.[!.]* "$1"/..?*; do
    exists "$c" || continue
    t="$2/\${c##*/}"
    if isdir "$c" && isdir "$t"; then merge "$c" "$t" || exit 1
    else rm -rf -- "$t" && mv -f -- "$c" "$t" || exit 1
    fi
  done
  rmdir -- "$1"
)
for f do
  d=\${f%/*}; b=\${f##*/}
  l=$(printf '%s' "$b" | tr '[:upper:]' '[:lower:]')
  [ "$b" = "$l" ] && continue
  t="$d/$l"
  if exists "$t"; then
    if isdir "$f" && isdir "$t"; then merge "$f" "$t" || exit 1
    else rm -rf -- "$t" && mv -f -- "$f" "$t" || exit 1
    fi
  else mv -f -- "$f" "$t" || exit 1
  fi
  echo R
done`;
  const res = await host.exec('sh', ['-c', outer, 'sh', dir, inner], { timeoutMs: 600_000 });
  if (res.code !== 0) throw new Error(`Küçük harfe çevirme başarısız: ${res.stderr.trim() || `çıkış kodu ${res.code}`}`);
  return res.stdout.split('\n').filter((l) => l === 'R').length;
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

/**
 * Modun .bikey dosyalarını sunucunun keys/ klasörüne kopyalar.
 * Mod güncellemesiyle anahtar adı değiştiyse (cba_3.18.bikey -> cba_3.19.bikey) bu modun artık
 * getirmediği anahtarlardan sahipliği düşer; sahibi kalmayan anahtar silinir. Sadece manifestte
 * kayıtlı (bizim koyduğumuz) anahtarlara dokunulur.
 */
export async function syncModKeys(host: Host, serverDir: string, modDir: string, modFolder: string): Promise<string[]> {
  const L = pathLib(host.os);
  const keysDir = L.join(serverDir, 'keys');
  await host.mkdirp(keysDir);
  const manifest = await readKeyManifest(host, keysDir);
  // Windows'ta dosya adları büyük/küçük harf duyarsız
  const norm = (n: string) => (host.os === 'windows' ? n.toLowerCase() : n);
  const copied: string[] = [];
  for (const key of await findModKeys(host, modDir)) {
    const name = host.os === 'linux' ? L.basename(key).toLowerCase() : L.basename(key);
    await host.copyFile(key, L.join(keysDir, name));
    const existing = Object.keys(manifest.keys).find((k) => norm(k) === norm(name)) ?? name;
    const owners = new Set(manifest.keys[existing] ?? []);
    owners.add(modFolder);
    if (existing !== name) delete manifest.keys[existing];
    manifest.keys[name] = [...owners];
    copied.push(name);
  }
  // Mod klasörü okunamıyorsa (silinmiş/bağlantı kopuk) eski anahtarlara dokunma
  if (await host.exists(modDir)) {
    const shipped = new Set(copied.map(norm));
    for (const [name, owners] of Object.entries(manifest.keys)) {
      if (shipped.has(norm(name)) || !owners.includes(modFolder)) continue;
      const rest = owners.filter((o) => o !== modFolder);
      if (rest.length) {
        manifest.keys[name] = rest;
      } else {
        await host.remove(L.join(keysDir, name)).catch(() => undefined);
        delete manifest.keys[name];
      }
    }
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
