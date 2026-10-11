import { createContext, useContext } from 'react';
import { en } from './en';
import { tr, type Dict } from './tr';

export type Lang = 'tr' | 'en';
export type TKey = keyof typeof tr;
const dicts: Record<Lang, Dict> = { tr, en };

export type TFn = (key: TKey | string, vars?: Record<string, string | number>) => string;

export function makeT(lang: Lang): TFn {
  const d = dicts[lang] as Record<string, string>;
  const fallback = tr as Record<string, string>;
  return (key, vars) => {
    let s = d[key] ?? fallback[key] ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
    return s;
  };
}

/** Sadece varsa döner (yardım metinleri isteğe bağlı) */
export function hasKey(lang: Lang, key: string): boolean {
  return key in dicts[lang] || key in tr;
}

export const I18nContext = createContext<{ lang: Lang; t: TFn }>({ lang: 'tr', t: makeT('tr') });
export const useI18n = () => useContext(I18nContext);

/**
 * Doğrulama (zod) mesajlarını arayüz diline çevirir. Ana süreç sadece yol + İngilizce mesaj gönderir;
 * yaygın kalıplar burada eşlenir, özel (Türkçe yazılmış) mesajlar olduğu gibi kalır.
 */
export function localizeError(msg: string, t: TFn): string {
  let m: RegExpExecArray | null;
  if ((m = /^Too (big|small): expected (\w+) to (?:be|have) ([<>]=?)\s*([-\d.,e+]+)\s*(\w+)?/i.exec(msg))) {
    const big = m[1]!.toLowerCase() === 'big';
    const kind = m[2]!.toLowerCase();
    const op = m[3]!;
    const v = m[4]!;
    if (kind === 'string') {
      if (!big && Number(v) === 1 && op === '>=') return t('zod.required');
      return t(big ? 'zod.tooLongString' : 'zod.tooShortString', { v });
    }
    if (kind === 'array' || kind === 'set') return t(big ? 'zod.tooManyItems' : 'zod.tooFewItems', { v });
    if (op === '<') return t('zod.lessThan', { v });
    if (op === '>') return t('zod.greaterThan', { v });
    return t(big ? 'zod.max' : 'zod.min', { v });
  }
  if ((m = /^Invalid input: expected (\w+)/i.exec(msg))) {
    const kind = m[1]!.toLowerCase();
    if (kind === 'int') return t('zod.int');
    if (kind === 'number') return t('zod.number');
    if (kind === 'boolean') return t('zod.boolean');
    if (kind === 'string') return t('zod.string');
    return t('zod.invalid');
  }
  if (/^Invalid (string|format)/i.test(msg)) return t('zod.format');
  if (/^Invalid option/i.test(msg)) return t('zod.option');
  if (/^Invalid input/i.test(msg)) return t('zod.invalid');
  return msg;
}

/** Bir alan yolu için okunur etiket (ör. "supervisor.warnMinutes.2" -> "Uyarı zamanları") */
export function fieldLabel(path: string, lang: Lang, t: TFn): string {
  const parts = path.split('.');
  for (let n = parts.length; n > 0; n--) {
    const key = `field.${parts.slice(0, n).join('.')}`;
    if (hasKey(lang, key)) return t(key);
  }
  return path;
}
