/**
 * Arma config (server.cfg / basic.cfg / *.Arma3Profile) yazıcı ve okuyucu.
 *
 * Yazıcı: string değerlerdeki çift tırnak Arma kuralına göre "" olarak kaçırılır,
 * sayılar her zaman nokta ondalık ayırıcıyla ve üstel gösterim olmadan yazılır.
 * Okuyucu: hoşgörülü bir ayrıştırıcıdır; mevcut bir server.cfg'yi içe aktarmak ve
 * kullanıcının elle yazdığı ek satırları doğrulamak için kullanılır.
 */

export type CfgScalar = string | number | boolean;
export type CfgValue = CfgScalar | CfgValue[];

export type CfgEntry =
  | { kind: 'value'; name: string; value: CfgValue; comment?: string }
  | { kind: 'class'; name: string; base?: string; entries: CfgEntry[]; comment?: string }
  | { kind: 'comment'; text: string }
  | { kind: 'blank' };

/* ------------------------------------------------------------------ */
/* Yazıcı                                                              */
/* ------------------------------------------------------------------ */

/** Arma config string literal'i: " -> "" ; satır sonları boşluğa çevrilir. */
export function quoteString(value: string): string {
  const oneLine = value.replace(/\r\n|\r|\n/g, ' ');
  return '"' + oneLine.replace(/"/g, '""') + '"';
}

/** Kültürden bağımsız, üstel gösterimsiz sayı. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(`Config değeri sonlu bir sayı olmalı: ${value}`);
  }
  if (Number.isInteger(value)) {
    return Math.abs(value) < 1e21 ? value.toFixed(0) : BigInt(value).toString();
  }
  // En fazla 8 ondalık; sondaki sıfırları at.
  return value.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
}

function formatScalar(value: CfgScalar): string {
  if (typeof value === 'string') return quoteString(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return formatNumber(value);
}

function formatValue(value: CfgValue): string {
  if (Array.isArray(value)) {
    return '{' + value.map(formatValue).join(', ') + '}';
  }
  return formatScalar(value);
}

function formatArrayMultiline(value: CfgValue[], indent: string): string {
  if (value.length === 0) return '{}';
  const simple = value.every((v) => !Array.isArray(v));
  const short = simple && value.map(formatValue).join(', ').length <= 80;
  if (short) return formatValue(value);
  const inner = value.map((v) => indent + '\t' + formatValue(v)).join(',\n');
  return '{\n' + inner + '\n' + indent + '}';
}

export function serializeEntries(entries: CfgEntry[], depth = 0): string {
  const indent = '\t'.repeat(depth);
  const out: string[] = [];
  for (const entry of entries) {
    switch (entry.kind) {
      case 'blank':
        out.push('');
        break;
      case 'comment':
        for (const line of entry.text.split(/\r?\n/)) out.push(`${indent}// ${line}`.trimEnd());
        break;
      case 'value': {
        assertIdentifier(entry.name);
        const trailing = entry.comment ? ` // ${entry.comment}` : '';
        if (Array.isArray(entry.value)) {
          out.push(`${indent}${entry.name}[] = ${formatArrayMultiline(entry.value, indent)};${trailing}`);
        } else {
          out.push(`${indent}${entry.name} = ${formatScalar(entry.value)};${trailing}`);
        }
        break;
      }
      case 'class': {
        assertIdentifier(entry.name);
        if (entry.comment) out.push(`${indent}// ${entry.comment}`);
        const head = entry.base ? `class ${entry.name}: ${entry.base}` : `class ${entry.name}`;
        out.push(`${indent}${head}`);
        out.push(`${indent}{`);
        const body = serializeEntries(entry.entries, depth + 1);
        if (body) out.push(body);
        out.push(`${indent}};`);
        break;
      }
    }
  }
  return out.join('\n');
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isIdentifier(name: string): boolean {
  return IDENT_RE.test(name);
}

function assertIdentifier(name: string): void {
  if (!IDENT_RE.test(name)) {
    throw new Error(`Geçersiz config adı: "${name}" (sadece harf, rakam ve _ kullanılabilir)`);
  }
}

/* Kısa yardımcılar: üreticilerde okunabilirlik için. */
export const v = (name: string, value: CfgValue, comment?: string): CfgEntry =>
  comment ? { kind: 'value', name, value, comment } : { kind: 'value', name, value };
export const cls = (name: string, entries: CfgEntry[], comment?: string): CfgEntry =>
  comment ? { kind: 'class', name, entries, comment } : { kind: 'class', name, entries };
export const comment = (text: string): CfgEntry => ({ kind: 'comment', text });
export const blank = (): CfgEntry => ({ kind: 'blank' });

/* ------------------------------------------------------------------ */
/* Okuyucu                                                             */
/* ------------------------------------------------------------------ */

export interface ParseIssue {
  line: number;
  message: string;
  severity: 'error' | 'warning';
}

export interface ParseResult {
  entries: CfgEntry[];
  issues: ParseIssue[];
}

type TokKind = 'ident' | 'number' | 'string' | 'punct' | 'eof';
interface Token {
  kind: TokKind;
  text: string;
  value?: number | string;
  line: number;
  start: number;
  end: number;
}

const PUNCT = ['+=', '{', '}', '[', ']', '=', ';', ',', ':'];

function tokenize(src: string, issues: ParseIssue[]): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  const n = src.length;
  let atLineStart = true;

  while (i < n) {
    const ch = src[i]!;
    if (ch === '\n') {
      line++;
      i++;
      atLineStart = true;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '﻿') {
      i++;
      continue;
    }
    // Önişlemci satırı (#include, #define ...): atla, uyar.
    if (ch === '#' && atLineStart) {
      const endLine = src.indexOf('\n', i);
      const text = src.slice(i, endLine === -1 ? n : endLine).trim();
      issues.push({ line, message: `Önişlemci satırı yok sayıldı: ${text}`, severity: 'warning' });
      i = endLine === -1 ? n : endLine;
      continue;
    }
    atLineStart = false;
    // Yorumlar
    if (ch === '/' && src[i + 1] === '/') {
      const endLine = src.indexOf('\n', i);
      i = endLine === -1 ? n : endLine;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      for (let k = i; k < stop; k++) if (src[k] === '\n') line++;
      if (end === -1) issues.push({ line, message: 'Kapanmamış /* yorum', severity: 'error' });
      i = stop;
      continue;
    }
    // String: "..." ("" kaçış) veya '...'
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const startLine = line;
      let j = i + 1;
      let value = '';
      let closed = false;
      while (j < n) {
        const c = src[j]!;
        if (c === quote) {
          if (src[j + 1] === quote) {
            value += quote;
            j += 2;
            continue;
          }
          closed = true;
          j++;
          break;
        }
        if (c === '\n') line++;
        value += c;
        j++;
      }
      if (!closed) issues.push({ line: startLine, message: 'Kapanmamış string', severity: 'error' });
      tokens.push({ kind: 'string', text: src.slice(i, j), value, line: startLine, start: i, end: j });
      i = j;
      continue;
    }
    // Noktalama
    const p = PUNCT.find((x) => src.startsWith(x, i));
    if (p) {
      tokens.push({ kind: 'punct', text: p, line, start: i, end: i + p.length });
      i += p.length;
      continue;
    }
    // Sayı
    const numMatch = /^-?(?:0x[0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(src.slice(i, i + 64));
    if (numMatch) {
      const text = numMatch[0];
      const after = src[i + text.length];
      // "12abc" gibi tırnaksız metinleri sayı sanma
      if (after === undefined || !/[A-Za-z_.]/.test(after)) {
        const value = text.toLowerCase().includes('0x') ? parseInt(text, 16) : Number(text);
        tokens.push({ kind: 'number', text, value, line, start: i, end: i + text.length });
        i += text.length;
        continue;
      }
    }
    // Tanımlayıcı
    const idMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i, i + 256));
    if (idMatch) {
      const text = idMatch[0];
      tokens.push({ kind: 'ident', text, line, start: i, end: i + text.length });
      i += text.length;
      continue;
    }
    // Tanınmayan karakter: tırnaksız değerlerin bir parçası olabilir, tek karakterlik token olarak geç.
    tokens.push({ kind: 'ident', text: ch, line, start: i, end: i + 1 });
    i++;
  }
  tokens.push({ kind: 'eof', text: '', line, start: n, end: n });
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(
    private readonly src: string,
    private readonly tokens: Token[],
    private readonly issues: ParseIssue[],
  ) {}

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)]!;
  }
  private next(): Token {
    const t = this.peek();
    if (t.kind !== 'eof') this.pos++;
    return t;
  }
  private isPunct(t: Token, p: string): boolean {
    return t.kind === 'punct' && t.text === p;
  }
  private error(t: Token, message: string): void {
    this.issues.push({ line: t.line, message, severity: 'error' });
  }

  /** Hata sonrası bir sonraki ';' veya '}' karakterine kadar ilerle. */
  private recover(): void {
    while (true) {
      const t = this.peek();
      if (t.kind === 'eof') return;
      if (this.isPunct(t, ';')) {
        this.next();
        return;
      }
      if (this.isPunct(t, '}')) return;
      this.next();
    }
  }

  private expectSemicolon(): void {
    const t = this.peek();
    if (this.isPunct(t, ';')) {
      this.next();
      return;
    }
    // Arma eksik ';' karakterini çoğu zaman tolere eder; uyar.
    this.issues.push({ line: t.line, message: "';' eksik", severity: 'warning' });
  }

  parseEntries(untilBrace: boolean): CfgEntry[] {
    const entries: CfgEntry[] = [];
    while (true) {
      const t = this.peek();
      if (t.kind === 'eof') {
        if (untilBrace) this.error(t, "Kapanmamış '{' (class bloğu)");
        return entries;
      }
      if (this.isPunct(t, '}')) {
        if (untilBrace) return entries;
        this.error(t, "Fazladan '}'");
        this.next();
        continue;
      }
      if (this.isPunct(t, ';')) {
        this.next();
        continue;
      }
      const entry = this.parseEntry();
      if (entry) entries.push(entry);
    }
  }

  private parseEntry(): CfgEntry | null {
    const t = this.next();
    if (t.kind !== 'ident' || !isIdentifier(t.text)) {
      this.error(t, `Beklenmeyen ifade: "${t.text}"`);
      this.recover();
      return null;
    }
    if (t.text === 'class') {
      const nameTok = this.next();
      if (nameTok.kind !== 'ident' || !isIdentifier(nameTok.text)) {
        this.error(nameTok, 'class adından sonra geçerli bir ad bekleniyordu');
        this.recover();
        return null;
      }
      let base: string | undefined;
      if (this.isPunct(this.peek(), ':')) {
        this.next();
        const baseTok = this.next();
        if (baseTok.kind === 'ident') base = baseTok.text;
        else this.error(baseTok, 'Temel class adı bekleniyordu');
      }
      if (this.isPunct(this.peek(), ';')) {
        // İleri bildirim: class Foo;
        this.next();
        return { kind: 'class', name: nameTok.text, ...(base ? { base } : {}), entries: [] };
      }
      if (!this.isPunct(this.peek(), '{')) {
        this.error(this.peek(), `class ${nameTok.text} için '{' bekleniyordu`);
        this.recover();
        return null;
      }
      this.next();
      const entries = this.parseEntries(true);
      if (this.isPunct(this.peek(), '}')) this.next();
      this.expectSemicolon();
      return { kind: 'class', name: nameTok.text, ...(base ? { base } : {}), entries };
    }
    if (t.text === 'delete') {
      this.next();
      this.expectSemicolon();
      return null;
    }

    const name = t.text;
    let isArray = false;
    if (this.isPunct(this.peek(), '[')) {
      this.next();
      if (!this.isPunct(this.peek(), ']')) {
        this.error(this.peek(), `${name}[ sonrasında ']' bekleniyordu`);
        this.recover();
        return null;
      }
      this.next();
      isArray = true;
    }
    const op = this.next();
    if (!(this.isPunct(op, '=') || (isArray && this.isPunct(op, '+=')))) {
      this.error(op, `${name} sonrasında '=' bekleniyordu`);
      this.recover();
      return null;
    }
    let value: CfgValue;
    if (isArray) {
      if (!this.isPunct(this.peek(), '{')) {
        this.error(this.peek(), `${name}[] için '{' bekleniyordu`);
        this.recover();
        return null;
      }
      value = this.parseArray();
    } else if (this.isPunct(this.peek(), '{')) {
      // name = {..} (köşeli parantezsiz dizi) - Arma bunu kabul etmez ama kurtar.
      this.issues.push({ line: t.line, message: `${name} bir dizi; "${name}[]" yazılmalı`, severity: 'warning' });
      value = this.parseArray();
    } else {
      value = this.parseScalarUntil([';', '}']);
    }
    this.expectSemicolon();
    return { kind: 'value', name, value };
  }

  private parseArray(): CfgValue[] {
    const open = this.next(); // '{'
    const items: CfgValue[] = [];
    while (true) {
      const t = this.peek();
      if (t.kind === 'eof') {
        this.error(open, "Kapanmamış dizi '{'");
        return items;
      }
      if (this.isPunct(t, '}')) {
        this.next();
        return items;
      }
      if (this.isPunct(t, ',')) {
        this.next();
        continue;
      }
      if (this.isPunct(t, '{')) {
        items.push(this.parseArray());
      } else {
        items.push(this.parseScalarUntil([',', '}']));
      }
    }
  }

  /** Tek bir değer oku. Tırnaksız metinler (ör. template = co10.Altis;) string olarak alınır. */
  private parseScalarUntil(stops: string[]): CfgScalar {
    const first = this.peek();
    const second = this.peek(1);
    const isStop = (tok: Token) => tok.kind === 'eof' || (tok.kind === 'punct' && stops.includes(tok.text));
    if ((first.kind === 'string' || first.kind === 'number') && isStop(second)) {
      this.next();
      return first.value as string | number;
    }
    if (first.kind === 'ident' && isStop(second)) {
      this.next();
      if (first.text.toLowerCase() === 'true') return true;
      if (first.text.toLowerCase() === 'false') return false;
      return first.text;
    }
    if (first.kind === 'string') {
      // "abc" "def" ya da "a "b" c" gibi: içteki tırnak kaçırılmamış.
      this.error(first, 'String değerden sonra beklenmeyen ifade (içteki tırnaklar "" olarak yazılmalı)');
    }
    // Tırnaksız ve birden fazla token'a yayılan değer: ham metni al.
    const startTok = first;
    let endTok = first;
    while (!isStop(this.peek())) endTok = this.next();
    if (startTok === endTok && isStop(startTok)) {
      this.error(startTok, 'Değer bekleniyordu');
      return '';
    }
    const raw = this.src.slice(startTok.start, endTok.end).trim();
    return raw;
  }
}

export function parseConfig(src: string): ParseResult {
  const issues: ParseIssue[] = [];
  const tokens = tokenize(src, issues);
  const parser = new Parser(src, tokens, issues);
  const entries = parser.parseEntries(false);
  return { entries, issues };
}

/* ------------------------------------------------------------------ */
/* Ağaç yardımcıları                                                   */
/* ------------------------------------------------------------------ */

export function findValue(entries: CfgEntry[], name: string): CfgValue | undefined {
  const lower = name.toLowerCase();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.kind === 'value' && e.name.toLowerCase() === lower) return e.value;
  }
  return undefined;
}

export function findClass(entries: CfgEntry[], name: string): Extract<CfgEntry, { kind: 'class' }> | undefined {
  const lower = name.toLowerCase();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.kind === 'class' && e.name.toLowerCase() === lower) return e;
  }
  return undefined;
}

export interface DuplicateName {
  /** Örn. "regularCheck" ya da "Missions.Mission_1.template" */
  path: string;
  count: number;
}

/**
 * Aynı kapsamda birden fazla kez tanımlanan adlar (büyük/küçük harf duyarsız; değer ve
 * class aynı ad alanını paylaşır). Arma bunlarda "Member already defined" diyip açılmaz.
 */
export function findDuplicateNames(entries: CfgEntry[], prefix = ''): DuplicateName[] {
  const out: DuplicateName[] = [];
  const seen = new Map<string, { name: string; count: number }>();
  for (const e of entries) {
    if (e.kind !== 'value' && e.kind !== 'class') continue;
    const key = e.name.toLowerCase();
    const prev = seen.get(key);
    if (prev) prev.count++;
    else seen.set(key, { name: e.name, count: 1 });
    if (e.kind === 'class') out.push(...findDuplicateNames(e.entries, `${prefix}${e.name}.`));
  }
  for (const { name, count } of seen.values()) if (count > 1) out.unshift({ path: prefix + name, count });
  return out;
}

/**
 * Her kapsamda bir adın yalnızca son tanımını bırakır (Arma'nın "son yazılan geçerli"
 * beklentisiyle aynı sonuç, ama hata vermeden). Sıra, kalan girdilerin sırasıdır.
 */
export function dedupeEntries(entries: CfgEntry[]): CfgEntry[] {
  const lastIndex = new Map<string, number>();
  entries.forEach((e, i) => {
    if (e.kind === 'value' || e.kind === 'class') lastIndex.set(e.name.toLowerCase(), i);
  });
  return entries.flatMap((e, i): CfgEntry[] => {
    if (e.kind !== 'value' && e.kind !== 'class') return [e];
    if (lastIndex.get(e.name.toLowerCase()) !== i) return [];
    return e.kind === 'class' ? [{ ...e, entries: dedupeEntries(e.entries) }] : [e];
  });
}

export function asNumber(value: CfgValue | undefined): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) return Number(value);
  return undefined;
}

export function asString(value: CfgValue | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return formatNumber(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return undefined;
}

export function asBool(value: CfgValue | undefined): boolean | undefined {
  if (typeof value === 'boolean') return value;
  const n = asNumber(value);
  return n === undefined ? undefined : n !== 0;
}

export function asStringArray(value: CfgValue | undefined): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((x) => (Array.isArray(x) ? [] : [asString(x) ?? '']));
}
