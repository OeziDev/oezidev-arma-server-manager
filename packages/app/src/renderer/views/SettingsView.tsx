import { useEffect, useState } from 'react';
import type { AppSettings } from '../../shared/api';
import { Button, Field, PasswordInput, Section, Seg, Toggle } from '../components/ui';
import { useI18n } from '../i18n';
import { api, setState, tryRun, useStore } from '../state';
import { InstallSteamCmdDialog } from './HostsView';

export function SettingsView() {
  const { t } = useI18n();
  const settings = useStore((s) => s.settings);
  const info = useStore((s) => s.info);
  const [s, setS] = useState<AppSettings | null>(settings);
  const [install, setInstall] = useState(false);
  useEffect(() => setS(settings), [settings]);
  if (!s || !info) return null;

  const save = async (next: AppSettings) => {
    setS(next);
    let saved: AppSettings | undefined;
    if (await tryRun(async () => (saved = await api.app.saveSettings(next)))) {
      setState({ settings: saved! });
    }
  };
  const field = <K extends keyof AppSettings>(k: K, v: AppSettings[K]) => setS({ ...s, [k]: v });
  const steamDirty = s.steamUsername !== settings?.steamUsername || s.localSteamcmdPath !== settings?.localSteamcmdPath || !!s.steamPassword;

  return (
    <div className="content">
      <Section title={t('set.title')}>
        <div className="fields">
          <Field label={t('set.language')}>
            <Seg
              value={s.language}
              options={[
                { value: 'tr', label: 'Türkçe' },
                { value: 'en', label: 'English' },
              ]}
              onChange={(v) => save({ ...s, language: v, steamPassword: '' })}
            />
          </Field>
          <Field label={t('set.tray')} help={t('help.set.tray')}>
            <Toggle checked={s.minimizeToTray} onChange={(v) => save({ ...s, minimizeToTray: v, steamPassword: '' })} />
          </Field>
        </div>
      </Section>

      <Section title={t('set.steam')} intro={t('set.steamIntro')}>
        <div className="fields">
          <Field label={t('set.steamUser')}>
            <input className="input mid mono" value={s.steamUsername} autoComplete="off" onChange={(e) => field('steamUsername', e.target.value.trim())} />
          </Field>
          <Field label={t('set.steamPassword')} help={s.hasSteamPassword ? t('set.steamPasswordSet') : undefined}>
            <div className="input-row">
              <PasswordInput value={s.steamPassword ?? ''} onChange={(v) => field('steamPassword', v)} />
              {s.hasSteamPassword && (
                <Button size="sm" kind="danger" onClick={() => save({ ...s, steamPassword: '', clearSteamPassword: true })}>
                  {t('set.clearPassword')}
                </Button>
              )}
            </div>
          </Field>
          <Field label={t('set.steamcmd')}>
            <div className="input-row">
              <input className="input mono" value={s.localSteamcmdPath} onChange={(e) => field('localSteamcmdPath', e.target.value)} placeholder={info.platform === 'windows' ? 'C:\\steamcmd\\steamcmd.exe' : '/home/steam/steamcmd/steamcmd.sh'} />
              <Button
                size="sm"
                onClick={async () => {
                  const f = await api.app.pickFile({ title: t('set.steamcmd') });
                  if (f) field('localSteamcmdPath', f);
                }}
              >
                {t('common.browse')}
              </Button>
            </div>
            <div>
              <Button size="sm" kind="ghost" onClick={() => setInstall(true)}>
                {t('set.installSteamcmd')}
              </Button>
            </div>
          </Field>
          <Field label="">
            <div>
              <Button kind="primary" disabled={!steamDirty} onClick={() => save(s)}>
                {t('common.save')}
              </Button>
            </div>
          </Field>
        </div>
      </Section>

      <Section title={t('set.about')}>
        {info.insecureSecrets ? (
          <div className="banner">{t('set.insecure')}</div>
        ) : info.platform === 'windows' ? (
          <p className="small muted">{t('set.secretsOk')}</p>
        ) : null}
        <div className="fields">
          <Field label={t('set.version')}>
            <span>OeziDev Arma Server Manager {info.version}</span>
          </Field>
          <Field label={t('set.data')}>
            <span className="mono small">{info.dataDir}</span>
          </Field>
          <Field label={t('app.developedBy')}>
            <div>
              <button className="link" onClick={() => void api.app.openExternal('https://discord.gg/JNnkdBN5GP')}>
                discord.gg/JNnkdBN5GP
              </button>
            </div>
          </Field>
        </div>
      </Section>
      {install && <InstallSteamCmdDialog hostId="local" defaultDir={info.platform === 'windows' ? 'C:\\steamcmd' : '/opt/steamcmd'} onClose={() => setInstall(false)} />}
    </div>
  );
}
