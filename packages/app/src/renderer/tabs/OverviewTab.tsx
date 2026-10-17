import { usedPorts } from '@core-constants';
import { useEffect } from 'react';
import type { Issue, ServerProfile } from '../../shared/api';
import { Button } from '../components/ui';
import { fieldLabel, localizeError, useI18n } from '../i18n';
import { formatMem, formatTime, fpsClass, loadLogs, useStore } from '../state';

export function OverviewTab({ id, profile, issues, errors, onFix, onPerf }: { id: string; profile: ServerProfile; issues: Issue[]; errors: Record<string, string>; onFix: (path: string) => void; onPerf: () => void }) {
  const { t, lang } = useI18n();
  const status = useStore((s) => s.statuses[id]);
  const logs = useStore((s) => s.logs[id]);
  useEffect(() => {
    void loadLogs(id);
  }, [id]);

  const order = { error: 0, warning: 1, info: 2 } as const;
  const all: { sev: 'error' | 'warning' | 'info'; text: string; path?: string }[] = [
    ...Object.entries(errors).map(([path, msg]) => ({ sev: 'error' as const, text: `${fieldLabel(path, lang, t)}: ${localizeError(msg, t)}`, path })),
    ...issues.map((i) => ({ sev: i.severity, text: i.message[lang], ...(i.path ? { path: i.path } : {}) })),
  ].sort((a, b) => order[a.sev] - order[b.sev]);

  const recent = (logs ?? []).slice(-12);
  const perf = status?.perf;
  const running = status?.status === 'running' || status?.status === 'starting';

  return (
    <div className="two-col wide-left">
      <div>
        <section className="section">
          <h2>{t('ov.issues')}</h2>
          {all.length === 0 ? (
            <p className="ok" style={{ marginTop: 8 }}>{t('ov.issuesNone')}</p>
          ) : (
            <ul className="issues">
              {all.map((i, n) => (
                <li key={n} className="issue" data-sev={i.sev}>
                  <span>{i.text}</span>
                  {i.path ? (
                    <Button size="sm" kind="ghost" onClick={() => onFix(i.path!)}>
                      {t('ov.fix')}
                    </Button>
                  ) : (
                    <span />
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="section">
          <h2>{t('ov.recent')}</h2>
          {recent.length === 0 ? (
            <p className="muted">{t('ov.noLog')}</p>
          ) : (
            <pre className="code wrap" style={{ maxHeight: 280 }}>
              {recent.map((l) => `${formatTime(l.t)}  ${l.line}`).join('\n')}
            </pre>
          )}
        </section>
      </div>

      <div>
        {running && perf && (
          <section className="section">
            <div className="hstack" style={{ justifyContent: 'space-between' }}>
              <h2>{t('ov.perf')}</h2>
              <Button size="sm" kind="ghost" onClick={onPerf}>
                {t('ov.perfMore')}
              </Button>
            </div>
            <div className="perf-mini">
              <div>
                <span className="muted small">FPS</span>
                <strong className={fpsClass(perf.fps)}>{perf.fps !== undefined ? perf.fps.toFixed(1) : '-'}</strong>
              </div>
              <div>
                <span className="muted small">CPU</span>
                <strong>{perf.cpu !== undefined ? `${Math.round(perf.cpu)}%` : '-'}</strong>
              </div>
              <div>
                <span className="muted small">RAM</span>
                <strong>{perf.memMB !== undefined ? formatMem(perf.memMB) : '-'}</strong>
              </div>
              <div>
                <span className="muted small">AI</span>
                <strong>{perf.ai ?? '-'}</strong>
              </div>
            </div>
          </section>
        )}
        <section className="section">
          <h2>{t('ov.facts')}</h2>
          <div className="diff-grid">
            <div className="muted">{t('ov.mode')}</div>
            <div className="diff-ctrl">{t(`ov.mode.${status?.mode ?? 'direct'}`)}</div>
            <div className="muted">{t('ov.autoRestarts')}</div>
            <div className="diff-ctrl">{status?.autoRestarts ?? 0}</div>
            <div className="muted">{t('ov.headless')}</div>
            <div className="diff-ctrl">
              {profile.headless.count === 0
                ? t('common.none')
                : `${status?.headless.filter((h) => h.alive).length ?? 0} / ${profile.headless.count}`}
            </div>
          </div>
        </section>

        <section className="section">
          <h2>{t('ov.ports')}</h2>
          <p className="section-intro">{t('ov.portsHelp')}</p>
          <table className="table">
            <tbody>
              {usedPorts(profile).map((p) => (
                <tr key={p.purpose}>
                  <td className="mono" style={{ width: 80 }}>
                    {p.port}
                  </td>
                  <td className={p.purpose === 'rcon' ? 'warn' : ''}>{t(`ov.port.${p.purpose}`)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
