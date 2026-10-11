import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useI18n } from '../i18n';

export function Button(props: {
  children: ReactNode;
  onClick?: () => unknown;
  kind?: 'primary' | 'danger' | 'ghost';
  size?: 'sm';
  disabled?: boolean;
  title?: string;
  type?: 'button' | 'submit';
  className?: string;
  icon?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => void (mounted.current = false), []);
  const cls = ['btn', props.kind, props.size, props.icon ? 'icon' : '', props.className].filter(Boolean).join(' ');
  return (
    <button
      type={props.type ?? 'button'}
      className={cls}
      title={props.title}
      aria-label={props.icon ? props.title : undefined}
      disabled={props.disabled || busy}
      onClick={async () => {
        if (!props.onClick) return;
        const r = props.onClick();
        if (r instanceof Promise) {
          setBusy(true);
          try {
            await r;
          } finally {
            if (mounted.current) setBusy(false);
          }
        }
      }}
    >
      {busy && <span className="spin" aria-hidden />}
      {props.children}
    </button>
  );
}

export function Toggle(props: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; id?: string; disabled?: boolean }) {
  return (
    <label className="toggle">
      <input id={props.id} type="checkbox" checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange(e.target.checked)} />
      <span className="toggle-track" aria-hidden />
      {props.label !== undefined && <span className="toggle-text">{props.label}</span>}
    </label>
  );
}

export function Seg<T extends string | number>(props: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label?: string }) {
  return (
    <div className="seg" role="group" aria-label={props.label}>
      {props.options.map((o) => (
        <button key={String(o.value)} type="button" aria-pressed={o.value === props.value} onClick={() => props.onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Field(props: { label: ReactNode; help?: ReactNode; children: ReactNode; error?: string; issues?: { sev: string; text: string }[]; htmlFor?: string }) {
  return (
    <div className="field">
      <div className="field-label">
        {props.htmlFor ? <label htmlFor={props.htmlFor}>{props.label}</label> : <span className="lbl">{props.label}</span>}
        {props.help && <div className="field-help">{props.help}</div>}
      </div>
      <div className="field-control">
        {props.children}
        {props.error && <div className="field-error">{props.error}</div>}
        {props.issues?.map((i, n) => (
          <div key={n} className="field-issue" data-sev={i.sev}>
            {i.text}
          </div>
        ))}
      </div>
    </div>
  );
}

export function Section(props: { title: ReactNode; intro?: ReactNode; children: ReactNode; id?: string; actions?: ReactNode }) {
  return (
    <section className="section" id={props.id}>
      <div className="hstack" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ font: '600 20px/1.2 var(--font-cond)', margin: '0 0 4px' }}>{props.title}</h2>
        {props.actions}
      </div>
      {props.intro && <p className="section-intro">{props.intro}</p>}
      {props.children}
    </section>
  );
}

export function NumberInput(props: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  id?: string;
  className?: string;
  invalid?: boolean;
}) {
  // Kullanıcı yazarken ara durumları (boş, "0.") koru; sayıya çevrilebildiğinde bildir.
  const [text, setText] = useState(String(props.value));
  useEffect(() => {
    if (Number(text.replace(',', '.')) !== props.value) setText(String(props.value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.value]);
  return (
    <input
      id={props.id}
      className={`input ${props.className ?? 'short'}`}
      inputMode="decimal"
      value={text}
      aria-invalid={props.invalid || undefined}
      onChange={(e) => {
        // Türkçe/Almanca klavyede virgül de ondalık ayırıcı kabul edilir (TADST'deki hata burada yok)
        const raw = e.target.value;
        setText(raw);
        const n = Number(raw.replace(',', '.'));
        if (raw.trim() !== '' && Number.isFinite(n)) props.onChange(n);
      }}
      onBlur={() => setText(String(props.value))}
    />
  );
}

export function PasswordInput(props: { value: string; onChange: (v: string) => void; id?: string; onGenerate?: () => void; placeholder?: string; invalid?: boolean }) {
  const { t } = useI18n();
  const [show, setShow] = useState(false);
  return (
    <div className="input-row">
      <input
        id={props.id}
        className="input mono"
        type={show ? 'text' : 'password'}
        value={props.value}
        placeholder={props.placeholder}
        autoComplete="new-password"
        spellCheck={false}
        aria-invalid={props.invalid || undefined}
        onChange={(e) => props.onChange(e.target.value)}
      />
      <Button size="sm" kind="ghost" onClick={() => setShow((s) => !s)}>
        {show ? t('common.hide') : t('common.show')}
      </Button>
      {props.onGenerate && (
        <Button size="sm" onClick={props.onGenerate}>
          {t('common.generate')}
        </Button>
      )}
    </div>
  );
}

/** Her satır bir öğe (string[]) */
export function LinesInput(props: { value: string[]; onChange: (v: string[]) => void; id?: string; rows?: number; placeholder?: string; mono?: boolean; invalid?: boolean }) {
  const [text, setText] = useState(props.value.join('\n'));
  useEffect(() => {
    const current = text.split('\n').map((x) => x.trim()).filter(Boolean);
    if (JSON.stringify(current) !== JSON.stringify(props.value)) setText(props.value.join('\n'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.value]);
  return (
    <textarea
      id={props.id}
      className={`textarea ${props.mono ? 'mono' : ''}`}
      rows={props.rows ?? 4}
      value={text}
      placeholder={props.placeholder}
      spellCheck={false}
      aria-invalid={props.invalid || undefined}
      onChange={(e) => {
        setText(e.target.value);
        props.onChange(e.target.value.split('\n').map((x) => x.trim()).filter(Boolean));
      }}
    />
  );
}

/** "a, b c" -> ['a','b','c'] */
export function ListInput(props: { value: string[]; onChange: (v: string[]) => void; id?: string }) {
  const [text, setText] = useState(props.value.join(', '));
  useEffect(() => {
    const current = text.split(/[\s,;]+/).filter(Boolean);
    if (JSON.stringify(current) !== JSON.stringify(props.value)) setText(props.value.join(', '));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.value]);
  return (
    <input
      id={props.id}
      className="input mono"
      value={text}
      spellCheck={false}
      onChange={(e) => {
        setText(e.target.value);
        props.onChange(e.target.value.split(/[\s,;]+/).filter(Boolean));
      }}
    />
  );
}

export function Modal(props: { title: ReactNode; intro?: ReactNode; children: ReactNode; footer?: ReactNode; onClose: () => void; wide?: boolean }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('input, select, textarea, button');
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className={`modal ${props.wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={id} ref={ref}>
        <div className="modal-head">
          <h2 id={id}>{props.title}</h2>
          {props.intro && <p>{props.intro}</p>}
        </div>
        <div className="modal-body">{props.children}</div>
        {props.footer && <div className="modal-foot">{props.footer}</div>}
      </div>
    </div>
  );
}

/** Basit onay penceresi */
export function useConfirm() {
  const { t } = useI18n();
  const [req, setReq] = useState<{ text: string; danger?: boolean; resolve: (v: boolean) => void } | null>(null);
  const confirm = (text: string, danger = false) => new Promise<boolean>((resolve) => setReq({ text, danger, resolve }));
  const node = req ? (
    <Modal
      title={t('common.confirm')}
      onClose={() => {
        req.resolve(false);
        setReq(null);
      }}
      footer={
        <>
          <Button
            kind="ghost"
            onClick={() => {
              req.resolve(false);
              setReq(null);
            }}
          >
            {t('common.cancel')}
          </Button>
          <Button
            kind={req.danger ? 'danger' : 'primary'}
            onClick={() => {
              req.resolve(true);
              setReq(null);
            }}
          >
            {t('common.confirm')}
          </Button>
        </>
      }
    >
      <p style={{ margin: '4px 0 8px' }}>{req.text}</p>
    </Modal>
  ) : null;
  return { confirm, node };
}

export function StatusMark({ status, large }: { status: string; large?: boolean }) {
  return <span className={`mark ${large ? 'lg' : ''}`} data-s={status} aria-hidden />;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children}
    </div>
  );
}

export function copyText(text: string) {
  void navigator.clipboard.writeText(text);
}

export function randomPassword(len = 20): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}
