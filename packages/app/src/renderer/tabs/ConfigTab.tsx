import { DIFFICULTY_OPTIONS, type DifficultyOptionKey } from '@core-constants';
import { useState } from 'react';
import {
  LinesF,
  ListF,
  NumberF,
  PasswordF,
  SelectF,
  TextAreaF,
  TextF,
  ToggleF,
  getPath,
  useDraft,
} from '../components/draft';
import { Button, Field, NumberInput, Section, Seg, Toggle } from '../components/ui';
import { useI18n } from '../i18n';
import { api, useStore } from '../state';
import { RemoteBrowser } from '../views/RemoteBrowser';
import { locate } from '../views/ServerView';

export type ConfigSection = 'server' | 'general' | 'security' | 'voting' | 'connection' | 'difficulty' | 'network' | 'scripts' | 'advanced';
const SECTIONS: ConfigSection[] = ['server', 'general', 'security', 'voting', 'connection', 'difficulty', 'network', 'scripts', 'advanced'];

export function ConfigTab({ section, onSection }: { section: ConfigSection; onSection: (s: ConfigSection) => void }) {
  const { t, lang } = useI18n();
  const { errors, issues } = useDraft();
  const counts: Partial<Record<ConfigSection, { n: number; sev: 'error' | 'warning' }>> = {};
  const bump = (path: string, sev: 'error' | 'warning') => {
    const loc = locate(path);
    if (loc.tab !== 'config' || !loc.section) return;
    const c = counts[loc.section] ?? { n: 0, sev };
    c.n++;
    if (sev === 'error') c.sev = 'error';
    counts[loc.section] = c;
  };
  Object.keys(errors).forEach((p) => bump(p, 'error'));
  issues.filter((i) => i.path && i.severity !== 'info').forEach((i) => bump(i.path!, i.severity as 'error' | 'warning'));
  void lang;

  return (
    <div className="split">
      <nav className="subnav" aria-label={t('tab.config')}>
        {SECTIONS.map((s) => (
          <button key={s} aria-current={section === s} onClick={() => onSection(s)}>
            <span>{t(`cfg.${s}`)}</span>
            {counts[s] && (
              <span className="count" data-sev={counts[s]!.sev}>
                {counts[s]!.n}
              </span>
            )}
          </button>
        ))}
      </nav>
      <div>
        {section === 'server' && <ServerSection />}
        {section === 'general' && <GeneralSection />}
        {section === 'security' && <SecuritySection />}
        {section === 'voting' && <VotingSection />}
        {section === 'connection' && <ConnectionSection />}
        {section === 'difficulty' && <DifficultySection />}
        {section === 'network' && <NetworkSection />}
        {section === 'scripts' && <ScriptsSection />}
        {section === 'advanced' && <AdvancedSection />}
      </div>
    </div>
  );
}

function ServerSection() {
  const { t } = useI18n();
  const { draft, set } = useDraft();
  const hosts = useStore((s) => s.hosts);
  const [browse, setBrowse] = useState(false);
  const pick = async () => {
    if (draft.hostId === 'local') {
      const dir = await api.app.pickFolder({ title: t('field.paths.serverDir') });
      if (dir) set('paths.serverDir', dir);
    } else setBrowse(true);
  };
  return (
    <Section title={t('cfg.server')} intro={t('cfg.serverIntro')}>
      <div className="fields">
        <TextF path="name" />
        <SelectF
          path="hostId"
          options={[{ value: 'local', label: t('common.local') }, ...hosts.map((h) => ({ value: h.id, label: h.name || `${h.username}@${h.host}` }))]}
        />
        <TextF
          path="paths.serverDir"
          mono
          after={
            <Button size="sm" onClick={pick}>
              {t('common.browse')}
            </Button>
          }
        />
        <TextF path="paths.executable" mono placeholder="arma3server_x64" />
        <TextF path="paths.profilesDir" mono />
        <TextF path="paths.profileName" mono width="mid" />
        <NumberF path="network.port" />
        <TextF path="network.bindIp" mono width="mid" placeholder="0.0.0.0" />
      </div>
      {browse && (
        <RemoteBrowser
          hostId={draft.hostId}
          start={draft.paths.serverDir}
          onClose={() => setBrowse(false)}
          onPick={(p) => {
            set('paths.serverDir', p);
            setBrowse(false);
          }}
        />
      )}
    </Section>
  );
}

function GeneralSection() {
  const { t } = useI18n();
  return (
    <Section title={t('cfg.general')} intro={t('cfg.generalIntro')}>
      <div className="fields">
        <TextF path="general.hostname" />
        <PasswordF path="general.password" />
        <PasswordF path="general.passwordAdmin" generate={16} />
        <PasswordF path="general.serverCommandPassword" generate={16} />
        <LinesF path="general.admins" mono rows={3} placeholder="76561198000000000" />
        <NumberF path="general.maxPlayers" />
        <LinesF path="general.motd" rows={4} />
        <NumberF path="general.motdInterval" unit={t('common.seconds')} />
        <TextF path="general.logFile" mono width="mid" />
        <SelectF path="general.timeStampFormat" options={['none', 'short', 'full'].map((v) => ({ value: v, label: v }))} />
        <ToggleF path="general.persistent" />
        <ToggleF path="general.statisticsEnabled" />
        <ToggleF path="general.drawingInMap" />
        <SelectF path="general.forceRotorLibSimulation" options={[0, 1, 2].map((v) => ({ value: v, label: t(`opt.rotor.${v}`) }))} />
      </div>
    </Section>
  );
}

function SecuritySection() {
  const { t } = useI18n();
  const { draft, set } = useDraft();
  const kt = draft.security.kickTimeout;
  return (
    <Section title={t('cfg.security')} intro={t('cfg.securityIntro')}>
      <div className="fields">
        <ToggleF path="security.battlEye" />
        <SelectF path="security.verifySignatures" options={[0, 2].map((v) => ({ value: v, label: t(`opt.sig.${v}`) }))} />
        <ToggleF path="security.kickDuplicate" />
        <SelectF path="security.allowedFilePatching" options={[0, 1, 2].map((v) => ({ value: v, label: t(`opt.fp.${v}`) }))} />
        <LinesF path="security.filePatchingExceptions" mono rows={2} />
        <NumberF path="security.requiredBuild" className="mid" />
        <Field label={t('field.security.kickTimeout')} help={t('help.security.kickTimeout')}>
          <div className="vstack">
            {(['manual', 'connectivity', 'battlEye', 'harmless'] as const).map((k) => (
              <div key={k} className="input-row">
                <NumberInput value={kt[k]} onChange={(v) => set(`security.kickTimeout.${k}`, Math.round(v))} />
                <span className="unit">{t(`kick.${k}`)}</span>
              </div>
            ))}
          </div>
        </Field>
        <ListF path="security.allowedLoadFileExtensions" />
        <ListF path="security.allowedPreprocessFileExtensions" />
        <ListF path="security.allowedHTMLLoadExtensions" />
        <LinesF path="security.allowedHTMLLoadURIs" mono rows={2} />
      </div>
    </Section>
  );
}

function VotingSection() {
  const { t } = useI18n();
  const { draft, set } = useDraft();
  return (
    <Section title={t('cfg.voting')}>
      <div className="fields">
        <ToggleF path="voting.enabled" />
        <NumberF path="voting.voteMissionPlayers" />
        <Field label={t('field.voting.voteThreshold')} help={t('help.voting.voteThreshold')}>
          <div className="input-row">
            <input
              type="range"
              className="range"
              min={0}
              max={100}
              step={1}
              disabled={!draft.voting.enabled}
              value={Math.round(draft.voting.voteThreshold * 100)}
              onChange={(e) => set('voting.voteThreshold', Number(e.target.value) / 100)}
              aria-label={t('field.voting.voteThreshold')}
            />
            <span className="unit">%{Math.round(draft.voting.voteThreshold * 100)}</span>
          </div>
        </Field>
        <ToggleF path="von.disabled" />
        <SelectF path="von.codec" options={[1, 0].map((v) => ({ value: v, label: t(`opt.codec.${v}`) }))} />
        <Field label={t('field.von.quality')} help={t('help.von.quality')}>
          <div className="input-row">
            <input type="range" className="range" min={0} max={30} value={draft.von.quality} onChange={(e) => set('von.quality', Number(e.target.value))} aria-label={t('field.von.quality')} />
            <span className="unit">{draft.von.quality}</span>
          </div>
        </Field>
      </div>
    </Section>
  );
}

function LimitField({ path, unit }: { path: string; unit: string }) {
  const { t } = useI18n();
  const { draft, set } = useDraft();
  const v = getPath(draft, path) as { enabled: boolean; value: number; kick: boolean };
  return (
    <Field label={t(`field.${path}`)}>
      <div className="hstack" style={{ gap: 18 }}>
        <Toggle checked={v.enabled} onChange={(x) => set(`${path}.enabled`, x)} label={t('limit.enabled')} />
        <span className="input-row" style={{ width: 'auto' }}>
          <NumberInput value={v.value} onChange={(x) => set(`${path}.value`, Math.round(x))} />
          <span className="unit">{unit}</span>
        </span>
        <Toggle checked={v.kick} disabled={!v.enabled} onChange={(x) => set(`${path}.kick`, x)} label={t('limit.kick')} />
      </div>
    </Field>
  );
}

function ConnectionSection() {
  const { t } = useI18n();
  return (
    <Section title={t('cfg.connection')} intro={t('cfg.connectionIntro')}>
      <div className="fields">
        <LimitField path="connection.maxPing" unit="ms" />
        <LimitField path="connection.maxPacketLoss" unit="%" />
        <LimitField path="connection.maxDesync" unit="" />
        <LimitField path="connection.disconnectTimeout" unit={t('common.seconds')} />
        <ToggleF path="connection.upnp" />
        <ToggleF path="connection.loopback" />
        <NumberF path="connection.steamProtocolMaxDataSize" className="mid" />
      </div>
    </Section>
  );
}

const LEVELS: Record<string, string[]> = {
  groupIndicators: ['lvl.off', 'lvl.limited', 'lvl.always'],
  friendlyTags: ['lvl.off', 'lvl.limited', 'lvl.always'],
  enemyTags: ['lvl.off', 'lvl.limited', 'lvl.always'],
  detectedMines: ['lvl.off', 'lvl.limited', 'lvl.always'],
  commands: ['lvl.off', 'lvl.fade', 'lvl.always'],
  waypoints: ['lvl.off', 'lvl.fade', 'lvl.always'],
  weaponInfo: ['lvl.off', 'lvl.fade', 'lvl.always'],
  stanceIndicator: ['lvl.off', 'lvl.fade', 'lvl.always'],
  thirdPersonView: ['lvl.off', 'lvl.on', 'lvl.vehicles'],
};

function DifficultySection() {
  const { t } = useI18n();
  const { draft, set } = useDraft();
  const groups = ['simulation', 'awareness', 'personal', 'view', 'multiplayer', 'misc'] as const;
  const keys = Object.keys(DIFFICULTY_OPTIONS) as DifficultyOptionKey[];
  return (
    <Section title={t('cfg.difficulty')} intro={t('cfg.difficultyIntro')}>
      <div className="diff-grid">
        {groups.map((g) => (
          <DiffGroup key={g} title={t(`diff.group.${g}`)}>
            {keys
              .filter((k) => DIFFICULTY_OPTIONS[k].group === g)
              .map((k) => {
                const max = DIFFICULTY_OPTIONS[k].max;
                const labels = LEVELS[k] ?? ['lvl.off', 'lvl.on'];
                return (
                  <DiffRow key={k} label={t(`diff.${k}`)}>
                    <Seg
                      label={t(`diff.${k}`)}
                      value={draft.difficulty.options[k]}
                      options={Array.from({ length: max + 1 }, (_, v) => ({ value: v, label: t(labels[v] ?? String(v)) }))}
                      onChange={(v) => set(`difficulty.options.${k}`, v)}
                    />
                  </DiffRow>
                );
              })}
          </DiffGroup>
        ))}
        <DiffGroup title={t('diff.ai')}>
          <DiffRow label={t('diff.aiPreset')}>
            <Seg value={draft.difficulty.aiLevelPreset} options={[0, 1, 2, 3].map((v) => ({ value: v, label: t(`opt.ai.${v}`) }))} onChange={(v) => set('difficulty.aiLevelPreset', v)} />
          </DiffRow>
          {draft.difficulty.aiLevelPreset === 3 &&
            (['skillAI', 'precisionAI'] as const).map((k) => (
              <DiffRow key={k} label={t(k === 'skillAI' ? 'diff.skill' : 'diff.precision')}>
                <span className="hstack">
                  <input type="range" className="range" style={{ width: 200 }} min={0} max={100} value={Math.round(draft.difficulty[k] * 100)} onChange={(e) => set(`difficulty.${k}`, Number(e.target.value) / 100)} aria-label={k} />
                  <span className="unit" style={{ width: 34 }}>
                    {draft.difficulty[k].toFixed(2)}
                  </span>
                </span>
              </DiffRow>
            ))}
        </DiffGroup>
      </div>
    </Section>
  );
}

function DiffGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <>
      <div className="diff-group">{title}</div>
      {children}
    </>
  );
}

function DiffRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <div className="diff-label">{label}</div>
      <div className="diff-ctrl">{children}</div>
    </>
  );
}

function NetworkSection() {
  const { t } = useI18n();
  const { draft } = useDraft();
  const mbit = (v: number) => t('bw.mbit', { v: (v / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 1 }) });
  return (
    <Section title={t('cfg.network')} intro={t('cfg.networkIntro')}>
      <div className="fields">
        <NumberF path="basic.maxMsgSend" />
        <NumberF path="basic.maxSizeGuaranteed" unit="B" />
        <NumberF path="basic.maxSizeNonguaranteed" unit="B" />
        <NumberF path="basic.minBandwidth" className="mid" unit={mbit(draft.basic.minBandwidth)} />
        <NumberF path="basic.maxBandwidth" className="mid" unit={mbit(draft.basic.maxBandwidth)} />
        <NumberF path="basic.minErrorToSend" />
        <NumberF path="basic.minErrorToSendNear" />
        <NumberF path="basic.maxCustomFileSize" className="mid" unit="B" />
        <NumberF path="basic.maxPacketSize" unit="B" />
        <NumberF path="basic.terrainGrid" />
        <NumberF path="basic.viewDistance" unit="m" />
      </div>
    </Section>
  );
}

function ScriptsSection() {
  const { t } = useI18n();
  return (
    <Section title={t('cfg.scripts')} intro={t('cfg.scriptsIntro')}>
      <div className="fields">
        {(['onUnsignedData', 'onHackedData', 'onDifferentData', 'doubleIdDetected', 'onUserConnected', 'onUserDisconnected', 'onUserKicked'] as const).map((k) => (
          <TextF key={k} path={`security.${k}`} mono />
        ))}
      </div>
    </Section>
  );
}

function AdvancedSection() {
  const { t } = useI18n();
  return (
    <Section title={t('cfg.advanced')} intro={t('cfg.advancedIntro')}>
      <div className="fields">
        <ToggleF path="advanced.logObjectNotFound" />
        <ToggleF path="advanced.skipDescriptionParsing" />
        <ToggleF path="advanced.ignoreMissionLoadErrors" />
        <NumberF path="advanced.queueSizeLogG" className="mid" />
        <TextAreaF path="advanced.extraServerCfg" mono rows={8} placeholder={'forcedDifficulty = "veteran";\nlobbyIdleTimeout = 300;'} />
        <TextAreaF path="basic.extraBasicCfg" mono rows={5} />
      </div>
    </Section>
  );
}
