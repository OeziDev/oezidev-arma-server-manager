import { useEffect, useRef, useState } from 'react';
import type { JobInfo } from '../../shared/api';
import { useI18n } from '../i18n';
import { api, setState, useStore } from '../state';
import { Button, Modal } from './ui';

/** Ekranın altında süren SteamCMD işleri + Steam Guard kodu penceresi. */
export function JobsPanel() {
  const jobs = useStore((s) => s.jobs);
  const list = Object.values(jobs).sort((a, b) => b.startedAt - a.startedAt);
  const visible = list.filter((j) => j.status === 'running' || j.status === 'waiting-input' || (j.finishedAt && Date.now() - j.finishedAt < 15000 && j.status !== 'done'));
  const waiting = list.find((j) => j.status === 'waiting-input');
  const [, tick] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => tick((x) => x + 1), 5000);
    return () => clearInterval(iv);
  }, []);

  return (
    <>
      {visible.length > 0 && (
        <div className="jobs">
          {visible.slice(0, 3).map((j) => (
            <JobCard key={j.id} job={j} />
          ))}
        </div>
      )}
      {waiting && <GuardDialog job={waiting} />}
    </>
  );
}

export function JobCard({ job, expanded: initial = false, onDismiss }: { job: JobInfo; expanded?: boolean; onDismiss?: () => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(initial);
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [job.lines.length, open]);
  const pct = job.status === 'done' ? 100 : job.progress ?? 0;
  const cls = job.status === 'failed' ? 'bad' : job.status === 'done' ? 'ok' : job.status === 'waiting-input' ? 'warn' : 'muted';
  return (
    <div className="job">
      <div className="job-head">
        <div className="job-title" title={job.title}>
          {job.title}
        </div>
        <span className={`small ${cls}`}>
          {t(`job.${job.status}`)}
          {job.status === 'running' && job.progress !== undefined ? ` ${job.progress.toFixed(0)}%` : ''}
        </span>
        <Button size="sm" kind="ghost" onClick={() => setOpen((o) => !o)}>
          {t('job.details')}
        </Button>
        {(job.status === 'running' || job.status === 'waiting-input') && (
          <Button size="sm" kind="danger" onClick={() => api.steam.cancel(job.id)}>
            {t('job.cancel')}
          </Button>
        )}
        {onDismiss && job.status !== 'running' && (
          <Button size="sm" kind="ghost" onClick={onDismiss}>
            {t('common.close')}
          </Button>
        )}
      </div>
      {(job.status === 'running' || job.status === 'waiting-input') && (
        <div className="bar" aria-hidden>
          <span style={{ width: `${pct}%` }} />
        </div>
      )}
      {job.error && <div className="small bad" style={{ padding: '0 12px 8px' }}>{job.error}</div>}
      {open && (
        <div className="job-log" ref={logRef}>
          {job.lines.join('\n')}
        </div>
      )}
    </div>
  );
}

function GuardDialog({ job }: { job: JobInfo }) {
  const { t } = useI18n();
  const [code, setCode] = useState('');
  const answer = async (value: string | null) => {
    await api.steam.answerGuard(job.id, value);
    setState((s) => ({ jobs: { ...s.jobs, [job.id]: { ...job, status: value ? 'running' : 'cancelled' } } }));
  };
  return (
    <Modal
      title={t('guard.title')}
      intro={t('guard.text')}
      onClose={() => void answer(null)}
      footer={
        <>
          <Button kind="ghost" onClick={() => answer(null)}>
            {t('common.cancel')}
          </Button>
          <Button kind="primary" disabled={code.trim().length < 4} onClick={() => answer(code.trim())}>
            {t('guard.send')}
          </Button>
        </>
      }
    >
      <div className="vstack">
        <div className="small muted">{job.title}</div>
        <input
          className="input mono"
          style={{ fontSize: 22, letterSpacing: '0.2em', maxWidth: 220, textTransform: 'uppercase' }}
          value={code}
          maxLength={10}
          aria-label={t('guard.code')}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          onKeyDown={(e) => e.key === 'Enter' && code.trim().length >= 4 && void answer(code.trim())}
        />
      </div>
    </Modal>
  );
}
