import { useMemo } from 'react';
import { PasswordF, SelectF, TextF, ToggleF, useDraft } from '../components/draft';
import { JobCard } from '../components/JobsPanel';
import { Button, Empty, Section } from '../components/ui';
import { useI18n } from '../i18n';
import { api, attempt, setState, toast, useStore } from '../state';

const BRANCHES = ['public', 'creatordlc', 'profiling', 'contact'];

const STEAMCLIENT_RESULTS = ['ok', 'copied', 'missing'];

export function SteamTab({ id }: { id: string }) {
  const { t } = useI18n();
  const { draft, ensureSaved, jobActive } = useDraft();
  const status = useStore((s) => s.statuses[id]?.status ?? 'stopped');
  const platform = useStore((s) => s.info?.platform);
  const allJobs = useStore((s) => s.jobs);
  const jobs = useMemo(() => Object.values(allJobs).filter((j) => j.profileId === id).sort((a, b) => b.startedAt - a.startedAt), [allJobs, id]);
  const stopped = status === 'stopped' || status === 'crashed';
  const linux = draft.hostId !== 'local' || platform === 'linux';
  const branchOptions = BRANCHES.includes(draft.steam.branch) ? BRANCHES : [...BRANCHES, draft.steam.branch];

  return (
    <>
      <Section
        title={t('st.server')}
        intro={t('st.serverIntro')}
        actions={
          <Button
            kind="primary"
            disabled={!stopped || !draft.paths.serverDir || jobActive}
            title={jobActive ? t('job.activeHint') : !stopped ? t('st.stopFirst') : undefined}
            onClick={async () => {
              if (!(await ensureSaved())) return;
              await attempt(() => api.steam.updateServer(id));
            }}
          >
            {t('st.update')}
          </Button>
        }
      >
        {!stopped && (
          <div className="banner" data-level="info">
            {t('st.stopFirst')}
          </div>
        )}
        {jobActive && (
          <div className="banner" data-level="info">
            {t('job.activeHint')}
          </div>
        )}
        <div className="fields">
          <SelectF path="steam.branch" options={branchOptions.map((b) => ({ value: b, label: b }))} />
          {draft.steam.branch !== 'public' && <PasswordF path="steam.branchPassword" />}
          <ToggleF path="steam.validate" />
          <TextF path="steam.workshopDir" mono />
        </div>
        <p className="small muted" style={{ marginTop: 10 }}>
          {t('st.account')}
        </p>
        {linux && (
          <div className="hstack mt">
            <Button
              size="sm"
              onClick={async () => {
                const r = await attempt(() => api.steam.fixSteamClient(id));
                if (r) toast(r === 'missing' ? 'warning' : r === 'ok' || r === 'copied' ? 'success' : 'info', STEAMCLIENT_RESULTS.includes(r) ? t(`st.sc.${r}`) : `steamclient.so: ${r}`);
              }}
            >
              {t('st.steamclient')}
            </Button>
            <span className="small muted">{t('st.steamclientHelp')}</span>
          </div>
        )}
      </Section>

      <Section title={t('st.jobs')}>
        {jobs.length === 0 ? (
          <Empty title={t('st.noJobs')} />
        ) : (
          <div className="vstack" style={{ maxWidth: 980 }}>
            {jobs.map((j, i) => (
              <JobCard
                key={j.id}
                job={j}
                expanded={i === 0}
                onDismiss={() =>
                  setState((s) => {
                    const next = { ...s.jobs };
                    delete next[j.id];
                    return { jobs: next };
                  })
                }
              />
            ))}
          </div>
        )}
      </Section>
    </>
  );
}
