import { useState } from 'react';
import type { AppSettings, UpdateState } from '../../shared/api';
import { Button, Field, PasswordInput, Section, Seg, Toggle } from '../components/ui';
import { useI18n } from '../i18n';
import { api, attempt, setState, tryRun, useStore } from '../state';
import { InstallSteamCmdDialog } from './HostsView';
import { getMotionPref, setMotionPref } from '../components/motion';

type SteamEdits = Partial<Pick<AppSettings, 'steamUsername' | 'localSteamcmdPath'>>;

export function SettingsView() {
  const { t } = useI18n();
  const settings = useStore((s) => s.settings);
  const info = useStore((s) => s.info);
  // Sadece kullanıcının dokunduğu alanlar yerelde tutulur; gerisi her zaman güncel ayarlardan okunur
  // (ör. "SteamCMD kur" bittiğinde ana süreç localSteamcmdPath'i yazar ve settings-changed gönderir).
  const [edits, setEdits] = useState<SteamEdits>({});
  const [password, setPassword] = useState('');
  const [install, setInstall] = useState(false);
  // Sadece bu bilgisayarda (localStorage) tutulur; <html class="no-motion"> ile uygulanır
  const [motion, setMotion] = useState(getMotionPref);
  if (!settings || !info) return null;

  /** Sadece değişen alanları gönder (ana süreç birleştirir). */
  const save = async (patch: Partial<AppSettings>, okText?: string): Promise<boolean> => {
    let saved: AppSettings | undefined;
    const ok = await tryRun(async () => (saved = await api.app.saveSettings(patch)), okText);
    if (ok && saved) setState({ settings: saved });
    return ok;
  };

  const steamUsername = edits.steamUsername ?? settings.steamUsername;
  const localSteamcmdPath = edits.localSteamcmdPath ?? settings.localSteamcmdPath;
  const steamPatch: Partial<AppSettings> = {
    ...(steamUsername !== settings.steamUsername ? { steamUsername } : {}),
    ...(localSteamcmdPath !== settings.localSteamcmdPath ? { localSteamcmdPath } : {}),
    ...(password ? { steamPassword: password } : {}),
  };
  const steamDirty = Object.keys(steamPatch).length > 0;

  return (
    <div className="content">
      <Section title={t('set.title')}>
        <div className="fields">
          <Field label={t('set.language')}>
            <Seg
              value={settings.language}
              options={[
                { value: 'tr', label: 'Türkçe' },
                { value: 'en', label: 'English' },
              ]}
              onChange={(v) => void save({ language: v })}
            />
          </Field>
          <Field label={t('set.tray')} help={t('help.set.tray')}>
            <Toggle checked={settings.minimizeToTray} onChange={(v) => void save({ minimizeToTray: v })} />
          </Field>
          <Field label={t('set.motion')} help={t('help.set.motion')}>
            <Toggle
              checked={motion}
              onChange={(v) => {
                setMotionPref(v);
                setMotion(v);
              }}
            />
          </Field>
          {/* Oturum açılışında başlatma sadece Windows'ta (giriş öğesi) destekleniyor */}
          {info.platform === 'windows' && (
            <Field label={t('set.launchAtLogin')} help={t('help.set.launchAtLogin')}>
              <Toggle checked={!!settings.launchAtLogin} onChange={(v) => void save({ launchAtLogin: v })} />
            </Field>
          )}
        </div>
      </Section>

      <Section title={t('set.steam')} intro={t('set.steamIntro')}>
        <div className="fields">
          <Field label={t('set.steamUser')}>
            <input className="input mid mono" value={steamUsername} autoComplete="off" onChange={(e) => setEdits((x) => ({ ...x, steamUsername: e.target.value.trim() }))} />
          </Field>
          <Field label={t('set.steamPassword')} help={settings.hasSteamPassword ? t('set.steamPasswordSet') : undefined}>
            <div className="input-row">
              <PasswordInput value={password} onChange={setPassword} />
              {settings.hasSteamPassword && (
                <Button
                  size="sm"
                  kind="danger"
                  onClick={async () => {
                    if (await save({ clearSteamPassword: true })) setPassword('');
                  }}
                >
                  {t('set.clearPassword')}
                </Button>
              )}
            </div>
          </Field>
          <Field label={t('set.steamcmd')}>
            <div className="input-row">
              <input
                className="input mono"
                value={localSteamcmdPath}
                onChange={(e) => setEdits((x) => ({ ...x, localSteamcmdPath: e.target.value }))}
                placeholder={info.platform === 'windows' ? 'C:\\steamcmd\\steamcmd.exe' : '/home/steam/steamcmd/steamcmd.sh'}
              />
              <Button
                size="sm"
                onClick={async () => {
                  const f = await api.app.pickFile({ title: t('set.steamcmd') });
                  if (f) setEdits((x) => ({ ...x, localSteamcmdPath: f }));
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
            <div className="hstack">
              <Button
                kind="primary"
                disabled={!steamDirty}
                onClick={async () => {
                  if (await save(steamPatch, t('common.saved'))) {
                    setEdits({});
                    setPassword('');
                  }
                }}
              >
                {t('common.save')}
              </Button>
              {steamDirty && (
                <Button
                  kind="ghost"
                  onClick={() => {
                    setEdits({});
                    setPassword('');
                  }}
                >
                  {t('common.discard')}
                </Button>
              )}
            </div>
          </Field>
        </div>
      </Section>

      <UpdatesSection version={info.version} />

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

function updateText(u: UpdateState | null, t: (k: string, v?: Record<string, string | number>) => string): string {
  if (!u) return t('upd.idle');
  const version = u.version ?? '';
  switch (u.status) {
    case 'disabled':
      return u.disabledReason === 'portable' ? t('upd.disabledPortable') : u.disabledReason === 'dev' ? t('upd.disabledDev') : t('upd.disabled');
    case 'checking':
      return t('upd.checking');
    case 'available':
      return t('upd.available', { version });
    case 'downloading':
      return t('upd.downloading', { version, percent: Math.round(u.percent ?? 0) });
    case 'ready':
      return t('upd.ready', { version });
    case 'none':
      return t('upd.none');
    case 'error':
      return t('upd.error', { error: u.error ?? '' });
    default:
      return t('upd.idle');
  }
}

function UpdatesSection({ version }: { version: string }) {
  const { t } = useI18n();
  const update = useStore((s) => s.update);
  const status = update?.status ?? 'idle';
  const disabled = status === 'disabled';
  const busy = status === 'checking' || status === 'downloading' || status === 'available';
  return (
    <Section title={t('upd.title')} intro={t('upd.intro')}>
      <div className="fields">
        <Field label={t('upd.current')}>
          <span>v{version}</span>
        </Field>
        <Field label={t('upd.status')}>
          <div className="vstack" style={{ gap: 8 }}>
            <span className={status === 'error' ? 'bad' : status === 'ready' ? 'ok' : undefined}>{updateText(update, t)}</span>
            {status === 'downloading' && (
              <div className="bar" style={{ maxWidth: 360 }} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(update?.percent ?? 0)}>
                <span style={{ width: `${update?.percent ?? 0}%` }} />
              </div>
            )}
          </div>
        </Field>
        <Field label="">
          <div className="vstack" style={{ gap: 10 }}>
            <div className="hstack">
              <Button
                disabled={disabled || busy}
                onClick={async () => {
                  const s = await attempt(() => api.app.checkForUpdates());
                  if (s) setState({ update: s });
                }}
              >
                {t('upd.check')}
              </Button>
              {status === 'ready' && (
                <Button kind="primary" onClick={() => attempt(() => api.app.installUpdate())}>
                  {t('upd.install')}
                </Button>
              )}
            </div>
            {status === 'ready' && <span className="small muted">{t('upd.installNote')}</span>}
          </div>
        </Field>
      </div>
    </Section>
  );
}
