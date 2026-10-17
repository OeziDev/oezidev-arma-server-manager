import { effectiveRconPort } from '@core-constants';
import { useEffect, useState } from 'react';
import { LinesF, NumberF, PasswordF, TextF, ToggleF, useDraft, useFieldMeta } from '../components/draft';
import { Button, Field, Section, useFormReset, useLocalInvalid } from '../components/ui';
import { useI18n } from '../i18n';
import { api, attempt, tryRun } from '../state';

export function LaunchTab({ id }: { id: string }) {
  const { t } = useI18n();
  const { draft, set, dirty } = useDraft();
  const [time, setTime] = useState('06:00');
  const times = draft.supervisor.scheduledRestarts;

  return (
    <>
      <Section title={t('ln.params')}>
        <div className="fields">
          <ToggleF path="launch.loadMissionToMemory" />
          <ToggleF path="launch.autoInit" />
          <NumberF path="launch.limitFPS" />
          <ToggleF path="launch.enableHT" />
          <ToggleF path="launch.hugepages" />
          <NumberF path="launch.maxMem" unit="MB" className="mid" />
          <NumberF path="launch.cpuCount" />
          <NumberF path="launch.exThreads" />
          <TextF path="launch.malloc" mono width="mid" placeholder="mimalloc_v206_LockPages" />
          <ToggleF path="launch.filePatching" />
          <ToggleF path="launch.netlog" />
          <ToggleF path="launch.noLogs" />
          <ToggleF path="launch.showConsoleWindow" />
          <TextF path="launch.extraArgs" mono placeholder="-world=empty" />
        </div>
      </Section>

      <Section title={t('ln.headless')} intro={t('ln.headlessIntro')}>
        <div className="fields">
          <NumberF path="headless.count" />
          {draft.headless.count > 0 && (
            <>
              <LinesF path="headless.allowedIps" mono rows={2} />
              <LinesF path="headless.localClients" mono rows={2} />
              <TextF path="headless.connectIp" mono width="mid" />
              <NumberF path="headless.startDelaySec" unit={t('common.seconds')} />
              <NumberF path="headless.limitFPS" />
              <TextF path="headless.extraArgs" mono />
            </>
          )}
        </div>
      </Section>

      <Section title={t('ln.supervisor')}>
        <div className="fields">
          <ToggleF path="supervisor.autoRestart" />
          <NumberF path="supervisor.restartDelaySec" unit={t('common.seconds')} />
          <NumberF path="supervisor.maxRestartsPerHour" />
          <NumberF path="supervisor.gracefulShutdownSec" unit={t('common.seconds')} />
          <NumberF path="supervisor.startTimeoutSec" unit={t('common.seconds')} />
          <ToggleF path="autoStartOnLaunch" />
        </div>
      </Section>

      <Section title={t('ln.schedule')} intro={t('ln.scheduleIntro')}>
        <div className="fields">
          <Field label={t('field.supervisor.scheduledRestarts')}>
            <div className="hstack">
              {times.length === 0 && <span className="muted">{t('common.none')}</span>}
              {times.map((x) => (
                <span key={x} className="hstack" style={{ gap: 4, border: '1px solid var(--line-strong)', borderRadius: 4, padding: '2px 4px 2px 10px' }}>
                  <span className="mono">{x}</span>
                  <button className="btn ghost sm icon" title={t('common.remove')} onClick={() => set('supervisor.scheduledRestarts', times.filter((y) => y !== x))}>
                    ✕
                  </button>
                </span>
              ))}
            </div>
            <div className="input-row">
              <input type="time" className="input short" value={time} onChange={(e) => setTime(e.target.value)} aria-label={t('ln.addTime')} />
              <Button size="sm" disabled={!/^\d{2}:\d{2}$/.test(time) || times.includes(time)} onClick={() => set('supervisor.scheduledRestarts', [...times, time].sort())}>
                {t('ln.addTime')}
              </Button>
            </div>
          </Field>
          <WarnMinutesField />
          <TextF path="supervisor.warnMessage" />
          <ToggleF path="supervisor.updateOnScheduledRestart" />
        </div>
      </Section>

      <AnnouncementsSection />

      <Section title={t('ln.rcon')} intro={t('ln.rconIntro')}>
        <div className="fields">
          <ToggleF path="rcon.enabled" />
          <NumberF path="rcon.port" unit={`→ ${effectiveRconPort(draft)}`} />
          <PasswordF path="rcon.password" generate={20} />
          <TextF path="rcon.listenIp" mono width="mid" placeholder="0.0.0.0" />
          <TextF path="rcon.connectHost" mono width="mid" />
          <NumberF path="rcon.maxPing" unit="ms" />
        </div>
      </Section>

      <Section title={t('ln.notify')}>
        <div className="fields">
          <PasswordF path="notifications.discordWebhook" />
          <ToggleF path="notifications.onStart" />
          <ToggleF path="notifications.onStop" />
          <ToggleF path="notifications.onCrash" />
          <ToggleF path="notifications.onUpdate" />
          <Field label="">
            <div className="hstack">
              <Button size="sm" disabled={dirty || !draft.notifications.discordWebhook} onClick={() => attempt(() => api.notify.test(id), t('ln.testSent'))}>
                {t('ln.testNotify')}
              </Button>
              {dirty && <span className="small muted">{t('common.unsaved')}</span>}
            </div>
          </Field>
        </div>
      </Section>

      <DiscordStatusSection id={id} />
    </>
  );
}

const MAX_ANNOUNCE = 400;

function AnnouncementsSection() {
  const { t } = useI18n();
  const { draft } = useDraft();
  const a = draft.announcements;
  const tooLong = a.messages.filter((m) => m.length > MAX_ANNOUNCE).length;
  return (
    <Section title={t('an.title')} intro={t('an.intro')}>
      <div className="fields">
        <ToggleF path="announcements.enabled" />
        <NumberF path="announcements.intervalMin" unit={t('common.minutes')} />
        <LinesF
          path="announcements.messages"
          rows={5}
          placeholder={t('an.placeholder')}
          help={
            <>
              {t('help.announcements.messages')}
              <br />
              <span className={tooLong ? 'bad' : undefined}>
                {t('an.count', { n: a.messages.length })}
                {tooLong > 0 && ` · ${t('an.tooLong', { n: tooLong, max: MAX_ANNOUNCE })}`}
              </span>
            </>
          }
        />
      </div>
    </Section>
  );
}

function DiscordStatusSection({ id }: { id: string }) {
  const { t } = useI18n();
  const { draft, ensureSaved } = useDraft();
  const ds = draft.discordStatus;
  const hasWebhook = !!(ds.webhook || draft.notifications.discordWebhook);
  return (
    <Section title={t('ds.title')} intro={t('ds.intro')}>
      <div className="fields">
        <ToggleF path="discordStatus.enabled" />
        <PasswordF path="discordStatus.webhook" placeholder={t('ds.webhookPlaceholder')} />
        <NumberF path="discordStatus.intervalSec" unit={t('common.seconds')} />
        <ToggleF path="discordStatus.showPlayers" />
        <Field label="">
          <div className="hstack">
            <Button
              size="sm"
              disabled={!ds.enabled || !hasWebhook}
              title={!hasWebhook ? t('ds.noWebhook') : undefined}
              onClick={async () => {
                if (!(await ensureSaved())) return;
                await tryRun(() => api.notify.refreshStatus(id), t('ds.refreshed'));
              }}
            >
              {t('ds.refresh')}
            </Button>
            {!hasWebhook && <span className="small muted">{t('ds.noWebhook')}</span>}
          </div>
        </Field>
      </div>
    </Section>
  );
}

/** "15, 10, 5, 1" -> [15, 10, 5, 1]; geçersiz parça varsa onu döner */
function parseWarnMinutes(text: string): { values: number[] } | { bad: string } {
  const parts = text.split(/[\s,;]+/).filter(Boolean);
  const out: number[] = [];
  for (const p of parts) {
    const n = /^\d+$/.test(p) ? Number(p) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > 120) return { bad: p };
    out.push(n);
  }
  return { values: [...new Set(out)].sort((a, b) => b - a) };
}

function WarnMinutesField() {
  const { t } = useI18n();
  const { draft, set } = useDraft();
  const m = useFieldMeta('supervisor.warnMinutes');
  const value = draft.supervisor.warnMinutes;
  const [text, setText] = useState(value.join(', '));
  const parsed = parseWarnMinutes(text);
  const bad = 'bad' in parsed ? parsed.bad : null;
  useLocalInvalid(bad !== null);
  // Taslak dışarıdan değiştiyse (at / içe aktar / yeniden yükle) metni eşitle
  useEffect(() => {
    const cur = parseWarnMinutes(text);
    if (!('values' in cur) || JSON.stringify(cur.values) !== JSON.stringify(value)) setText(value.join(', '));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  useFormReset(() => setText(value.join(', ')));
  return (
    <Field label={m.label} help={m.help} error={bad !== null ? t('ln.warnInvalid', { value: bad }) : m.error} issues={m.issues} htmlFor={m.id}>
      <input
        id={m.id}
        className="input mid mono"
        value={text}
        aria-invalid={bad !== null || !!m.error || undefined}
        onChange={(e) => {
          setText(e.target.value);
          const r = parseWarnMinutes(e.target.value);
          if ('values' in r) set('supervisor.warnMinutes', r.values);
        }}
        onBlur={() => {
          if (bad === null) setText(value.join(', '));
        }}
      />
    </Field>
  );
}
