import { useState } from 'react';
import type { HostConfig, HostTestResult } from '../../shared/api';
import { Button, Empty, Field, Modal, PasswordInput, Section, Seg, Toggle, useConfirm } from '../components/ui';
import { useI18n } from '../i18n';
import { api, attempt, refreshHosts, toast, tryRun, useStore } from '../state';

const EMPTY: HostConfig = {
  id: '',
  name: '',
  host: '',
  port: 22,
  username: 'root',
  authMethod: 'password',
  privateKeyPath: '',
  fingerprint: '',
  useSudo: false,
  useSystemd: true,
  serviceUser: '',
  steamcmdPath: '',
};

export function HostsView() {
  const { t } = useI18n();
  const hosts = useStore((s) => s.hosts);
  const summaries = useStore((s) => s.summaries);
  const [editing, setEditing] = useState<HostConfig | null>(null);
  const [installFor, setInstallFor] = useState<HostConfig | null>(null);
  const { confirm, node } = useConfirm();

  return (
    <div className="content">
      <Section
        title={t('hosts.title')}
        intro={t('hosts.intro')}
        actions={
          <Button kind="primary" onClick={() => setEditing({ ...EMPTY })}>
            {t('hosts.add')}
          </Button>
        }
      >
        {hosts.length === 0 ? (
          <div className="panel">
            <Empty title={t('hosts.empty')} />
          </div>
        ) : (
          <table className="table">
            <tbody>
              {hosts.map((h) => {
                const used = summaries.filter((s) => s.hostId === h.id);
                return (
                  <tr key={h.id}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{h.name}</div>
                      <div className="small muted mono">
                        {h.username}@{h.host}:{h.port}
                      </div>
                    </td>
                    <td className="small">
                      {h.useSystemd ? 'systemd' : 'nohup'}
                      {h.serviceUser ? ` (${h.serviceUser})` : ''}
                    </td>
                    <td className="small muted">{used.map((u) => u.name).join(', ')}</td>
                    <td className="small mono muted" title={h.fingerprint}>
                      {h.fingerprint ? `${h.fingerprint.slice(0, 18)}…` : ''}
                    </td>
                    <td className="actions">
                      <Button size="sm" kind="ghost" onClick={() => setInstallFor(h)}>
                        {t('hosts.installSteamcmd')}
                      </Button>
                      <Button size="sm" onClick={() => setEditing({ ...h })}>
                        {t('common.edit')}
                      </Button>
                      <Button
                        size="sm"
                        kind="danger"
                        disabled={used.length > 0}
                        onClick={async () => {
                          if (await confirm(`${h.name}?`, true)) await tryRun(() => api.hosts.remove(h.id));
                        }}
                      >
                        {t('common.delete')}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Section>
      {editing && <HostDialog initial={editing} onClose={() => setEditing(null)} />}
      {installFor && <InstallSteamCmdDialog hostId={installFor.id} defaultDir={installFor.username === 'root' ? '/opt/steamcmd' : `/home/${installFor.username}/steamcmd`} onClose={() => setInstallFor(null)} />}
      {node}
    </div>
  );
}

function HostDialog({ initial, onClose }: { initial: HostConfig; onClose: () => void }) {
  const { t } = useI18n();
  const [h, setH] = useState<HostConfig>({ ...initial, password: '', passphrase: '' });
  const [test, setTest] = useState<HostTestResult | null>(null);
  const set = <K extends keyof HostConfig>(k: K, v: HostConfig[K]) => setH((x) => ({ ...x, [k]: v }));
  const isNew = !initial.id;

  const runTest = async () => {
    setTest(null);
    const r = await attempt(() => api.hosts.test(h));
    if (r) {
      setTest(r);
      if (r.ok) toast('success', t('hosts.testOk'));
    }
  };

  const save = async () => {
    // İlk kayıtta parmak izini test sonucundan al (TOFU); sonra değişirse bağlantı reddedilir.
    const toSave = { ...h, fingerprint: h.fingerprint || test?.fingerprint || '' };
    if (await tryRun(() => api.hosts.save(toSave), t('common.saved'))) {
      await refreshHosts();
      onClose();
    }
  };

  return (
    <Modal
      title={isNew ? t('hosts.new') : t('hosts.edit')}
      wide
      onClose={onClose}
      footer={
        <>
          <Button kind="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={runTest} disabled={!h.host || !h.username}>
            {t('hosts.test')}
          </Button>
          <Button kind="primary" onClick={save} disabled={!h.host || !h.username || (isNew && !test?.ok)}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="fields">
        <Field label={t('field.h.name')}>
          <input className="input" value={h.name} onChange={(e) => set('name', e.target.value)} placeholder="ArmaTürk VPS" />
        </Field>
        <Field label={t('field.h.host')}>
          <div className="input-row">
            <input className="input mono" value={h.host} onChange={(e) => set('host', e.target.value.trim())} placeholder="203.0.113.10" />
            <span className="unit">{t('field.h.port')}</span>
            <input className="input short mono" style={{ maxWidth: 90 }} value={h.port} onChange={(e) => set('port', Number(e.target.value) || 22)} />
          </div>
        </Field>
        <Field label={t('field.h.username')}>
          <input className="input mono mid" value={h.username} onChange={(e) => set('username', e.target.value.trim())} />
        </Field>
        <Field label={t('field.h.authMethod')}>
          <Seg value={h.authMethod} options={[{ value: 'password', label: t('opt.auth.password') }, { value: 'key', label: t('opt.auth.key') }]} onChange={(v) => set('authMethod', v)} />
        </Field>
        {h.authMethod === 'password' ? (
          <Field label={t('field.h.password')} help={initial.hasPassword ? t('hosts.keepPassword') : undefined}>
            <PasswordInput value={h.password ?? ''} onChange={(v) => set('password', v)} />
          </Field>
        ) : (
          <>
            <Field label={t('field.h.privateKeyPath')}>
              <div className="input-row">
                <input className="input mono" value={h.privateKeyPath} onChange={(e) => set('privateKeyPath', e.target.value)} />
                <Button
                  size="sm"
                  onClick={async () => {
                    const f = await api.app.pickFile({ title: t('field.h.privateKeyPath') });
                    if (f) set('privateKeyPath', f);
                  }}
                >
                  {t('common.browse')}
                </Button>
              </div>
            </Field>
            <Field label={t('field.h.passphrase')} help={initial.hasPassword ? t('hosts.keepPassword') : undefined}>
              <PasswordInput value={h.passphrase ?? ''} onChange={(v) => set('passphrase', v)} />
            </Field>
          </>
        )}
        <Field label={t('field.h.useSystemd')} help={t('help.h.useSystemd')}>
          <Toggle checked={h.useSystemd} onChange={(v) => set('useSystemd', v)} />
        </Field>
        <Field label={t('field.h.serviceUser')} help={t('help.h.serviceUser')}>
          <input className="input mono mid" value={h.serviceUser} onChange={(e) => set('serviceUser', e.target.value.trim())} placeholder="arma" />
        </Field>
        <Field label={t('field.h.useSudo')} help={t('help.h.useSudo')}>
          <Toggle checked={h.useSudo} onChange={(v) => set('useSudo', v)} />
        </Field>
        <Field label={t('field.h.steamcmdPath')} help={t('help.h.steamcmdPath')}>
          <input className="input mono" value={h.steamcmdPath} onChange={(e) => set('steamcmdPath', e.target.value)} />
        </Field>
      </div>
      {test && (
        <div className="banner mt" data-level={test.ok ? 'info' : 'error'}>
          <div className="vstack" style={{ gap: 4 }}>
            <strong className={test.ok ? 'ok' : 'bad'}>{test.ok ? t('hosts.testOk') : test.error}</strong>
            {test.fingerprint && (
              <span className="small">
                {t('hosts.fingerprint')}: <span className="mono">{test.fingerprint}</span>
              </span>
            )}
            {test.ok && (
              <span className="small muted">
                Linux, {test.isRoot ? t('hosts.root') : 'user'}, {test.hasSystemd ? t('hosts.systemdYes') : t('hosts.systemdNo')}. {t('hosts.fingerprintNote')}
              </span>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

export function InstallSteamCmdDialog({ hostId, defaultDir, onClose }: { hostId: string; defaultDir: string; onClose: () => void }) {
  const { t } = useI18n();
  const [dir, setDir] = useState(defaultDir);
  return (
    <Modal
      title={t('hosts.installSteamcmd')}
      onClose={onClose}
      footer={
        <>
          <Button kind="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            kind="primary"
            disabled={!dir.trim()}
            onClick={async () => {
              if (await tryRun(() => api.steam.installSteamCmd(hostId, dir.trim()))) onClose();
            }}
          >
            {t('hosts.installSteamcmd')}
          </Button>
        </>
      }
    >
      <div className="fields">
        <Field label={t('hosts.installDir')}>
          <div className="input-row">
            <input className="input mono" value={dir} onChange={(e) => setDir(e.target.value)} />
            {hostId === 'local' && (
              <Button
                size="sm"
                onClick={async () => {
                  const d = await api.app.pickFolder();
                  if (d) setDir(d);
                }}
              >
                {t('common.browse')}
              </Button>
            )}
          </div>
        </Field>
      </div>
    </Modal>
  );
}
