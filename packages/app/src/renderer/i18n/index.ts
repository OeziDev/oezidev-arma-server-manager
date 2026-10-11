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
