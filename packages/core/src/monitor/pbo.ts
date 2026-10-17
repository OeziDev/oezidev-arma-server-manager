import { createHash } from 'node:crypto';

/**
 * Arma PBO yazıcı (sıkıştırmasız).
 *
 * Biçim (community.bistudio.com "PBO File Format", armake/HEMTT ile aynı):
 *   [başlık girdileri] [veri bloğu] 0x00 [SHA1(öncesindeki bütün baytlar), 20 bayt]
 * Başlık girdisi: asciiz dosya adı + 5 x uint32 LE (PackingMethod, OriginalSize, Reserved, TimeStamp, DataSize).
 * - İlk girdi "Vers" ürün girdisi: ad boş, PackingMethod 0x56657273, diğerleri 0; ardından
 *   anahtar/değer asciiz dizileri (ör. "prefix", "oezi_monitor") ve boş dizi ile biter.
 * - Her dosya için bir girdi (ad ters bölülü, PackingMethod 0 = sıkıştırmasız, DataSize = dosya boyu).
 * - Sonlandırıcı: adı boş, bütün alanları 0 olan girdi.
 * - Veri bloğu dosyaları başlıktaki sırayla art arda içerir.
 */

export interface PboFile {
  /** PBO içindeki yol ("functions/fn_init.sqf" de verilebilir, ters bölüye çevrilir) */
  path: string;
  data: Buffer | string;
}

const PRODUCT_ENTRY = 0x56657273; // "Vers"

function asciiz(s: string): Buffer {
  if (s.includes('\0')) throw new Error(`PBO: ad/değer NUL karakteri içeremez: ${s}`);
  return Buffer.concat([Buffer.from(s, 'utf8'), Buffer.alloc(1)]);
}

function entry(name: string, packing: number, originalSize: number, reserved: number, timestamp: number, dataSize: number): Buffer {
  const fields = Buffer.alloc(20);
  fields.writeUInt32LE(packing >>> 0, 0);
  fields.writeUInt32LE(originalSize >>> 0, 4);
  fields.writeUInt32LE(reserved >>> 0, 8);
  fields.writeUInt32LE(timestamp >>> 0, 12);
  fields.writeUInt32LE(dataSize >>> 0, 16);
  return Buffer.concat([asciiz(name), fields]);
}

/** PBO içi yol: ters bölü, baştaki ayraçlar atılır */
function pboPath(p: string): string {
  return p.replace(/\//g, '\\').replace(/^\\+/, '');
}

/**
 * Sıkıştırmasız PBO üretir. `timestamp` verilmezse 0 yazılır: aynı içerik her zaman aynı baytları
 * üretir (sunucudaki dosya ile karşılaştırıp gereksiz yere yeniden yazmamak için).
 */
export function buildPbo(files: PboFile[], props: Record<string, string>, opts: { timestamp?: number } = {}): Buffer {
  const ts = Math.max(0, Math.floor(opts.timestamp ?? 0));
  const parts: Buffer[] = [];
  parts.push(entry('', PRODUCT_ENTRY, 0, 0, 0, 0));
  for (const [k, v] of Object.entries(props)) {
    if (!k) throw new Error('PBO: boş özellik adı');
    parts.push(asciiz(k), asciiz(v));
  }
  parts.push(Buffer.alloc(1)); // özellik listesinin sonu (boş dizi)
  const seen = new Set<string>();
  const datas: Buffer[] = [];
  for (const f of files) {
    const name = pboPath(f.path);
    if (!name) throw new Error('PBO: boş dosya adı');
    const key = name.toLowerCase();
    if (seen.has(key)) throw new Error(`PBO: aynı dosya iki kez: ${name}`);
    seen.add(key);
    const data = typeof f.data === 'string' ? Buffer.from(f.data, 'utf8') : f.data;
    parts.push(entry(name, 0, 0, 0, ts, data.length));
    datas.push(data);
  }
  parts.push(entry('', 0, 0, 0, 0, 0)); // sonlandırıcı
  const body = Buffer.concat([...parts, ...datas]);
  const sha1 = createHash('sha1').update(body).digest();
  return Buffer.concat([body, Buffer.alloc(1), sha1]);
}

export interface ParsedPbo {
  props: Record<string, string>;
  files: { path: string; data: Buffer; timestamp: number; packing: number }[];
  /** Sondaki SHA1 içerikle eşleşiyor mu */
  checksumOk: boolean;
}

/** Sıkıştırmasız PBO okuyucu (test ve doğrulama için). */
export function parsePbo(buf: Buffer): ParsedPbo {
  let off = 0;
  const readZ = (): string => {
    const end = buf.indexOf(0, off);
    if (end < 0) throw new Error('PBO bozuk: ad sonlandırılmamış');
    const s = buf.subarray(off, end).toString('utf8');
    off = end + 1;
    return s;
  };
  const readEntry = () => {
    const name = readZ();
    if (off + 20 > buf.length) throw new Error('PBO bozuk: başlık kısa');
    const e = {
      name,
      packing: buf.readUInt32LE(off),
      originalSize: buf.readUInt32LE(off + 4),
      reserved: buf.readUInt32LE(off + 8),
      timestamp: buf.readUInt32LE(off + 12),
      dataSize: buf.readUInt32LE(off + 16),
    };
    off += 20;
    return e;
  };
  const props: Record<string, string> = {};
  const entries: ReturnType<typeof readEntry>[] = [];
  for (;;) {
    const e = readEntry();
    if (e.name === '' && e.packing === PRODUCT_ENTRY) {
      for (;;) {
        const k = readZ();
        if (!k) break;
        props[k] = readZ();
      }
      continue;
    }
    if (e.name === '') break;
    entries.push(e);
  }
  const files: ParsedPbo['files'] = [];
  for (const e of entries) {
    if (off + e.dataSize > buf.length) throw new Error('PBO bozuk: veri kısa');
    files.push({ path: e.name, data: buf.subarray(off, off + e.dataSize), timestamp: e.timestamp, packing: e.packing });
    off += e.dataSize;
  }
  let checksumOk = false;
  if (buf.length === off + 21 && buf[off] === 0) {
    const want = createHash('sha1').update(buf.subarray(0, off)).digest();
    checksumOk = want.equals(buf.subarray(off + 1));
  }
  return { props, files, checksumOk };
}
