import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { LogLine } from '../../shared/api';
import { Button, Toggle, copyText } from '../components/ui';
import { useI18n } from '../i18n';
import { api, errorText, formatTime, loadLogs, pushLocalLog, type LocalLogLine, useStore } from '../state';

type ViewLine = (LogLine | LocalLogLine) & { key: string };

/** Sunucu satırları ve arayüzün kendi satırları (her ikisi de zamana göre sıralı) zamana göre birleşir. */
function mergeByTime(server: LogLine[], local: LocalLogLine[]): ViewLine[] {
  const out: ViewLine[] = [];
  let i = 0;
  let j = 0;
  while (i < server.length || j < local.length) {
    const a = server[i];
    const b = local[j];
    if (a && (!b || a.t <= b.t)) {
      out.push({ ...a, key: `s${a.seq}` });
      i++;
    } else if (b) {
      out.push({ ...b, key: `l${j}` });
      j++;
    }
  }
  return out;
}

const MAX_RENDER = 1500;

function kindOf(source: string, line: string): string {
  if (source === 'app') return 'app';
  if (/\b(error|exception|crash|fatal|cannot|failed|missing)\b/i.test(line)) return 'error';
  if (/\bwarning\b/i.test(line)) return 'warn';
  return '';
}

export function ConsoleTab({ id }: { id: string }) {
  const { t } = useI18n();
  const logs = useStore((s) => s.logs[id]);
  const localLogs = useStore((s) => s.localLogs[id]);
  const rcon = useStore((s) => s.statuses[id]?.rcon);
  const [filter, setFilter] = useState('');
  const [source, setSource] = useState('');
  const [follow, setFollow] = useState(true);
  const [since, setSince] = useState(0);
  const [cmd, setCmd] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [hIndex, setHIndex] = useState(-1);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void loadLogs(id);
  }, [id]);

  const all = useMemo(() => mergeByTime(logs ?? [], localLogs ?? []), [logs, localLogs]);
  const sources = useMemo(() => [...new Set(all.map((l) => l.source))].sort(), [all]);
  const lines = useMemo(() => {
    const f = filter.toLowerCase();
    const out = all.filter((l) => l.t >= since && (!source || l.source === source) && (!f || l.line.toLowerCase().includes(f)));
    return out.slice(-MAX_RENDER);
  }, [all, filter, source, since]);

  useLayoutEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines, follow]);

  const send = async () => {
    const c = cmd.trim();
    if (!c) return;
    setHistory((h) => [c, ...h.filter((x) => x !== c)].slice(0, 50));
    setHIndex(-1);
    setCmd('');
    // Sunucu tamponunda olmayan satırlar: ayrı tutulur, sekme değişince ya da log yenilenince kaybolmaz
    const push = (text: string) => pushLocalLog(id, text);
    push(`> ${c}`);
    try {
      const res = await api.rcon.command(id, c);
      if (res.trim()) push(res.trimEnd());
    } catch (err) {
      push(`! ${errorText(err)}`);
    }
  };

  return (
    <>
      <div className="console-bar">
        <input className="input" style={{ maxWidth: 280 }} placeholder={t('con.filter')} value={filter} onChange={(e) => setFilter(e.target.value)} aria-label={t('con.filter')} />
        <select className="select" style={{ maxWidth: 160 }} value={source} onChange={(e) => setSource(e.target.value)} aria-label={t('con.source')}>
          <option value="">{t('common.all')}</option>
          {sources.map((s) => (
            <option key={s} value={s}>
              {s === 'app' ? t('con.app') : s}
            </option>
          ))}
        </select>
        <Toggle checked={follow} onChange={setFollow} label={t('con.follow')} />
        <span className="spacer" />
        <span className="small muted">{lines.length}</span>
        <Button size="sm" kind="ghost" onClick={() => setSince(Date.now())}>
          {t('con.clear')}
        </Button>
        <Button size="sm" kind="ghost" disabled={lines.length === 0} onClick={() => copyText(lines.map((l) => `${formatTime(l.t)} [${l.source}] ${l.line}`).join('\n'), t('common.copied'))}>
          {t('common.copy')}
        </Button>
      </div>
      <div
        className="console"
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          if (atBottom !== follow) setFollow(atBottom);
        }}
        role="log"
        aria-live="off"
      >
        {lines.length === 0 ? (
          <div className="empty">{t('con.empty')}</div>
        ) : (
          lines.map((l) => (
            <div key={l.key} className="log-line" data-k={kindOf(l.source, l.line)}>
              <span className="log-time">{formatTime(l.t)}</span>
              <span className="log-src">{l.source === 'app' ? t('con.app') : l.source}</span>
              <span className="log-text">{l.line}</span>
            </div>
          ))
        )}
      </div>
      <div className="console-input">
        <input
          className="input"
          placeholder={t('con.rcon')}
          value={cmd}
          disabled={rcon !== 'connected'}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void send();
            if (e.key === 'ArrowUp' && history.length) {
              const n = Math.min(hIndex + 1, history.length - 1);
              setHIndex(n);
              setCmd(history[n]!);
              e.preventDefault();
            }
            if (e.key === 'ArrowDown') {
              const n = hIndex - 1;
              setHIndex(Math.max(n, -1));
              setCmd(n >= 0 ? history[n]! : '');
              e.preventDefault();
            }
          }}
          aria-label={t('con.rcon')}
        />
        <Button onClick={send} disabled={rcon !== 'connected' || !cmd.trim()}>
          {t('con.send')}
        </Button>
      </div>
    </>
  );
}
