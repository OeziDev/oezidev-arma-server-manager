import { createContext, type ReactNode, useContext, useId } from 'react';
import type { Issue, ServerProfile } from '../../shared/api';
import { hasKey, localizeError, useI18n } from '../i18n';
import { Field, LinesInput, ListInput, NumberInput, PasswordInput, randomPassword, Toggle } from './ui';

export function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}

export function setPath<T>(obj: T, path: string, value: unknown): T {
  const keys = path.split('.');
  const clone = (o: unknown) => (Array.isArray(o) ? [...o] : { ...(o as object) });
  const root = clone(obj) as Record<string, unknown>;
  let cur = root;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]!;
    cur[k] = clone(cur[k] ?? {});
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]!] = value;
  return root as T;
}

export interface DraftCtx {
  draft: ServerProfile;
  set: (path: string, value: unknown) => void;
  update: (fn: (p: ServerProfile) => ServerProfile) => void;
  errors: Record<string, string>;
  issues: Issue[];
  /** Kaydedilmemiş değişiklik (ya da geçersiz yerel metin) var */
  dirty: boolean;
  /** Kaydedilmiş profili kullanan işlemlerden önce: değişiklik varsa kaydet; başarısızsa false */
  ensureSaved: () => Promise<boolean>;
  /** Bu profil için bir SteamCMD işi sürüyor */
  jobActive: boolean;
}

export const DraftContext = createContext<DraftCtx | null>(null);
export function useDraft(): DraftCtx {
  const c = useContext(DraftContext);
  if (!c) throw new Error('DraftContext yok');
  return c;
}

/** Alan etiketi, yardım, hata ve sorun bilgisini yola göre toplar. */
export function useFieldMeta(path: string, labelKey?: string) {
  const { t, lang } = useI18n();
  const { errors, issues } = useDraft();
  const id = useId();
  const lk = labelKey ?? `field.${path}`;
  const hk = labelKey ? labelKey.replace(/^field\./, 'help.') : `help.${path}`;
  const raw = Object.entries(errors).find(([p]) => p === path || p.startsWith(path + '.'))?.[1];
  const error = raw === undefined ? undefined : localizeError(raw, t);
  const fieldIssues = issues.filter((i) => i.path === path).map((i) => ({ sev: i.severity, text: i.message[lang] }));
  /** Alt yol için (ör. "security.kickTimeout.manual") hata var mı */
  const errorAt = (sub: string) => Object.keys(errors).some((p) => p === sub || p.startsWith(sub + '.'));
  return { id, label: t(lk), help: hasKey(lang, hk) ? t(hk) : undefined, error, issues: fieldIssues, errorAt };
}

interface BaseProps {
  path: string;
  labelKey?: string;
  help?: ReactNode;
  after?: ReactNode;
}

export function TextF(props: BaseProps & { placeholder?: string; mono?: boolean; width?: 'short' | 'mid' }) {
  const { draft, set } = useDraft();
  const m = useFieldMeta(props.path, props.labelKey);
  return (
    <Field label={m.label} help={props.help ?? m.help} error={m.error} issues={m.issues} htmlFor={m.id}>
      <div className="input-row">
        <input
          id={m.id}
          className={`input ${props.mono ? 'mono' : ''} ${props.width ?? ''}`}
          value={String(getPath(draft, props.path) ?? '')}
          placeholder={props.placeholder}
          spellCheck={false}
          aria-invalid={!!m.error || undefined}
          onChange={(e) => set(props.path, e.target.value)}
        />
        {props.after}
      </div>
    </Field>
  );
}

export function NumberF(props: BaseProps & { min?: number; max?: number; unit?: string; className?: string }) {
  const { draft, set } = useDraft();
  const m = useFieldMeta(props.path, props.labelKey);
  return (
    <Field label={m.label} help={props.help ?? m.help} error={m.error} issues={m.issues} htmlFor={m.id}>
      <div className="input-row">
        <NumberInput id={m.id} className={props.className} value={Number(getPath(draft, props.path) ?? 0)} invalid={!!m.error} onChange={(v) => set(props.path, v)} />
        {props.unit && <span className="unit">{props.unit}</span>}
        {props.after}
      </div>
    </Field>
  );
}

export function ToggleF(props: BaseProps & { text?: string }) {
  const { draft, set } = useDraft();
  const m = useFieldMeta(props.path, props.labelKey);
  return (
    <Field label={m.label} help={props.help ?? m.help} error={m.error} issues={m.issues}>
      <Toggle id={m.id} checked={!!getPath(draft, props.path)} onChange={(v) => set(props.path, v)} label={props.text} />
    </Field>
  );
}

export function SelectF<T extends string | number>(props: BaseProps & { options: { value: T; label: string }[] }) {
  const { draft, set } = useDraft();
  const m = useFieldMeta(props.path, props.labelKey);
  const value = getPath(draft, props.path) as T;
  return (
    <Field label={m.label} help={props.help ?? m.help} error={m.error} issues={m.issues} htmlFor={m.id}>
      <select
        id={m.id}
        className="select mid"
        value={String(value)}
        onChange={(e) => {
          const opt = props.options.find((o) => String(o.value) === e.target.value);
          if (opt) set(props.path, opt.value);
        }}
      >
        {props.options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function PasswordF(props: BaseProps & { generate?: number }) {
  const { draft, set } = useDraft();
  const m = useFieldMeta(props.path, props.labelKey);
  return (
    <Field label={m.label} help={props.help ?? m.help} error={m.error} issues={m.issues} htmlFor={m.id}>
      <PasswordInput
        id={m.id}
        value={String(getPath(draft, props.path) ?? '')}
        invalid={!!m.error}
        onChange={(v) => set(props.path, v)}
        {...(props.generate ? { onGenerate: () => set(props.path, randomPassword(props.generate)) } : {})}
      />
    </Field>
  );
}

export function LinesF(props: BaseProps & { rows?: number; placeholder?: string; mono?: boolean }) {
  const { draft, set } = useDraft();
  const m = useFieldMeta(props.path, props.labelKey);
  return (
    <Field label={m.label} help={props.help ?? m.help} error={m.error} issues={m.issues} htmlFor={m.id}>
      <LinesInput id={m.id} rows={props.rows} mono={props.mono} placeholder={props.placeholder} invalid={!!m.error} value={(getPath(draft, props.path) as string[]) ?? []} onChange={(v) => set(props.path, v)} />
    </Field>
  );
}

export function ListF(props: BaseProps) {
  const { t } = useI18n();
  const { draft, set } = useDraft();
  const m = useFieldMeta(props.path, props.labelKey);
  return (
    <Field label={m.label} help={props.help ?? m.help ?? t('help.ext')} error={m.error} issues={m.issues} htmlFor={m.id}>
      <ListInput id={m.id} value={(getPath(draft, props.path) as string[]) ?? []} onChange={(v) => set(props.path, v)} />
    </Field>
  );
}

export function TextAreaF(props: BaseProps & { rows?: number; mono?: boolean; placeholder?: string }) {
  const { draft, set } = useDraft();
  const m = useFieldMeta(props.path, props.labelKey);
  return (
    <Field label={m.label} help={props.help ?? m.help} error={m.error} issues={m.issues} htmlFor={m.id}>
      <textarea
        id={m.id}
        className={`textarea ${props.mono ? 'mono' : ''}`}
        rows={props.rows ?? 4}
        spellCheck={false}
        placeholder={props.placeholder}
        value={String(getPath(draft, props.path) ?? '')}
        aria-invalid={!!m.error || undefined}
        onChange={(e) => set(props.path, e.target.value)}
      />
    </Field>
  );
}
