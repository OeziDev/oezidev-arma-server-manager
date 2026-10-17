import { useEffect, useRef, useState } from 'react';
import type { BackupFileInfo } from '../../shared/api';
import { LinesF, NumberF, PasswordF, TextF, ToggleF, useDraft } from '../components/draft';
import { Button, Empty, Field, Section, useConfirm } from '../components/ui';
import { useI18n } from '../i18n';
import { api, attempt, errorText, formatBytes, formatDateTime, tryRun, useStore } from '../state';
import { RemoteBrowser } from '../views/RemoteBrowser';

/** Varsayılan yedek klasörü ipucu: <serverDir'in üstü>/oezi-backups/… */
function defaultDirHint(serverDir: string, windows: boolean): string {
  const sep = windows ? '\\' : '/';
  const trimmed = serverDir.trim().replace(/[\\/]+$/, '');
  const i = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  const parent = i > 0 ? trimmed.slice(0, i) : i === 0 ? sep : '…';
  return `${parent}${parent.endsWith(sep) ? '' : sep}oezi-backups${sep}…`;
}

export function BackupsTab({ id }: { id: string }) {
  const { t, lang } = useI18n();
  const { draft, set, dirty, ensureSaved } = useDraft();
  const platform = useStore((s) => s.info?.platform);
  // Bu profilin son biten işi: bitince liste yenilenir (elle ya da zamanlı yedek)
  const lastFinished = useStore((s) => Object.values(s.jobs).reduce((m, j) => (j.profileId === id && j.finishedAt ? Math.max(m, j.finishedAt) : m), 0));
  const [list, setList] = useState<BackupFileInfo[] | null>(null);
  const [listError, setListError] = useState('');
  const [next, setNext] = useState<number | null>(null);
  const [time, setTime] = useState('04:30');
  const [browse, setBrowse] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const jobs = useStore((s) => s.jobs);
  const { confirm, node } = useConfirm();
  const local = draft.hostId === 'local';
  const windows = local ? platform === 'windows' : false;
  const times = draft.backup.times;
  const db = draft.backup.database;

  const load = async () => {
    try {
      setList(await api.backup.list(id));
      setListError('');
    } catch (err) {
      setList([]);
      setListError(errorText(err));
    }
    setNext(await api.backup.next(id).catch(() => null));
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, lastFinished]);

  // Kaydedildikten sonra (ayarlar değişmiş olabilir) sonraki zamanı ve listeyi tazele
  const wasDirty = useRef(dirty);
  useEffect(() => {
    if (wasDirty.current && !dirty) void load();
    wasDirty.current = dirty;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);

  const runningJob = running ? jobs[running] : undefined;
  const busy = !!runningJob && (runningJob.status === 'running' || runningJob.status === 'waiting-input');

  const pickDir = async () => {
    if (local) {
      const d = await api.app.pickFolder({ title: t('field.backup.targetDir') });
      if (d) set('backup.targetDir', d);
    } else setBrowse(true);
  };

  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <h3>{t('bk.title')}</h3>
          <span className="muted small">{list ? t('bk.count', { n: list.length }) : ''}</span>
          <span className="spacer" />
          <span className="small muted">
            {draft.backup.enabled && next ? t('bk.next', { time: formatDateTime(next, lang) }) : t('bk.noNext')}
          </span>
          {local && (
            <Button size="sm" onClick={() => attempt(() => api.backup.openFolder(id))}>
              {t('bk.openFolder')}
            </Button>
          )}
          <Button size="sm" onClick={load}>
            {t('common.refresh')}
          </Button>
          <Button
            size="sm"
            kind="primary"
            disabled={busy}
            onClick={async () => {
              if (!(await ensureSaved())) return;
              const jobId = await attempt(() => api.backup.run(id));
              if (jobId) setRunning(jobId);
            }}
          >
            {t('bk.runNow')}
          </Button>
        </div>
        {listError && (
          <div className="banner" data-level="error" style={{ margin: 12 }}>
            {listError}
          </div>
        )}
        {list === null ? (
          <p className="muted" style={{ padding: '0 16px' }}>
            {t('common.loading')}
          </p>
        ) : list.length === 0 ? (
          !listError && <Empty title={t('bk.empty')}>{t('bk.emptyHint')}</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('bk.name')}</th>
                <th>{t('bk.date')}</th>
                <th className="num">{t('bk.size')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((b) => (
                <tr key={b.file}>
                  <td className="mono small" title={b.file}>
                    {b.name}
                  </td>
                  <td>{formatDateTime(b.createdAt, lang)}</td>
                  <td className="num">{formatBytes(b.sizeBytes)}</td>
                  <td className="actions">
                    <Button
                      size="sm"
                      kind="danger"
                      onClick={async () => {
                        if (!(await confirm(t('bk.deleteConfirm', { name: b.name }), true))) return;
                        if (await tryRun(() => api.backup.delete(id, b.file), t('bk.deleted'))) void load();
                      }}
                    >
                      {t('common.delete')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Section title={t('bk.settings')} intro={t('bk.settingsIntro')}>
        <div className="fields">
          <ToggleF path="backup.enabled" />
          <Field label={t('field.backup.times')} help={t('help.backup.times')}>
            <div className="hstack">
              {times.length === 0 && <span className="muted">{t('common.none')}</span>}
              {times.map((x) => (
                <span key={x} className="time-chip">
                  <span className="mono">{x}</span>
                  <button className="btn ghost sm icon" title={t('common.remove')} onClick={() => set('backup.times', times.filter((y) => y !== x))}>
                    ✕
                  </button>
                </span>
              ))}
            </div>
            <div className="input-row">
              <input type="time" className="input short" value={time} onChange={(e) => setTime(e.target.value)} aria-label={t('ln.addTime')} />
              <Button size="sm" disabled={!/^\d{2}:\d{2}$/.test(time) || times.includes(time)} onClick={() => set('backup.times', [...times, time].sort())}>
                {t('ln.addTime')}
              </Button>
            </div>
          </Field>
          <TextF
            path="backup.targetDir"
            mono
            help={t('help.backup.targetDir', { dir: defaultDirHint(draft.paths.serverDir, windows) })}
            after={
              <Button size="sm" onClick={pickDir}>
                {t('common.browse')}
              </Button>
            }
          />
          <NumberF path="backup.keep" />
          <ToggleF path="backup.includeProfile" />
          <ToggleF path="backup.includeMissions" />
          <ToggleF path="backup.includeBattlEye" />
          <ToggleF path="backup.includeKeys" />
          <LinesF path="backup.extraPaths" mono rows={3} placeholder={windows ? 'C:\\arma3server\\@extDB3\\sql_custom' : '@extDB3/sql_custom'} />
        </div>
      </Section>

      <Section title={t('bk.db')} intro={t('bk.dbIntro')}>
        <div className="fields">
          <ToggleF path="backup.database.enabled" />
          {db.enabled && (
            <>
              <TextF path="backup.database.host" mono width="mid" placeholder="127.0.0.1" />
              <NumberF path="backup.database.port" />
              <TextF path="backup.database.user" mono width="mid" />
              <PasswordF path="backup.database.password" />
              <TextF path="backup.database.database" mono width="mid" placeholder="altislife" />
              <TextF path="backup.database.dumpPath" mono placeholder={windows ? 'C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\mysqldump.exe' : '/usr/bin/mysqldump'} />
            </>
          )}
        </div>
      </Section>

      {browse && (
        <RemoteBrowser
          hostId={draft.hostId}
          start={draft.backup.targetDir || draft.paths.serverDir}
          onClose={() => setBrowse(false)}
          onPick={(p) => {
            set('backup.targetDir', p);
            setBrowse(false);
          }}
        />
      )}
      {node}
    </>
  );
}
