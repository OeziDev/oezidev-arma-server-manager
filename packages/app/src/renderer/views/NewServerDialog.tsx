import { useState } from 'react';
import { Button, Field, Modal } from '../components/ui';
import { useI18n } from '../i18n';
import { api, attempt, refreshSummaries, toast, useStore } from '../state';
import { RemoteBrowser } from './RemoteBrowser';

export function NewServerDialog({ onClose, onCreated, onAddHost }: { onClose: () => void; onCreated: (id: string) => void; onAddHost: () => void }) {
  const { t } = useI18n();
  const hosts = useStore((s) => s.hosts);
  const [name, setName] = useState('');
  const [hostId, setHostId] = useState('local');
  const [dir, setDir] = useState('');
  const [port, setPort] = useState(2302);
  const [cfgFile, setCfgFile] = useState<string | null>(null);
  const [browse, setBrowse] = useState(false);

  const pick = async () => {
    if (hostId === 'local') {
      const d = await api.app.pickFolder({ title: t('new.folder') });
      if (d) setDir(d);
    } else setBrowse(true);
  };

  const create = async () => {
    const p = await attempt(async () => {
      const created = await api.profiles.create({ name: name.trim() || 'Arma 3', hostId, paths: { serverDir: dir.trim() }, network: { port } });
      if (cfgFile) {
        const text = await api.app.readPickedFile(cfgFile);
        const imported = await api.profiles.importServerCfg(created, text);
        const r = await api.profiles.save({ ...imported.profile, name: created.name, hostId: created.hostId, paths: created.paths, network: created.network, rcon: created.rcon });
        if (imported.unknownKeys.length) toast('info', t('fl.unknownKeys', { keys: imported.unknownKeys.join(', ') }));
        return r.profile ?? created;
      }
      return created;
    });
    if (p) {
      await refreshSummaries();
      onCreated(p.id);
    }
  };

  const importJson = async () => {
    const f = await api.app.pickFile({ title: t('new.importJson'), filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (!f) return;
    const p = await attempt(async () => api.profiles.importJson(await api.app.readPickedFile(f)));
    if (p) {
      await refreshSummaries();
      onCreated(p.id);
    }
  };

  return (
    <Modal
      title={t('new.title')}
      intro={t('new.intro')}
      wide
      onClose={onClose}
      footer={
        <>
          <Button kind="ghost" onClick={importJson}>
            {t('new.importJson')}
          </Button>
          <span className="spacer" />
          <Button kind="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button kind="primary" disabled={!dir.trim()} onClick={create}>
            {t('new.create')}
          </Button>
        </>
      }
    >
      <div className="fields">
        <Field label={t('field.name')}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="ArmaTürk Altis Life" />
        </Field>
        <Field label={t('new.machine')}>
          <select
            className="select mid"
            value={hostId}
            onChange={(e) => {
              if (e.target.value === '__add') onAddHost();
              else {
                setHostId(e.target.value);
                setDir('');
              }
            }}
          >
            <option value="local">{t('common.local')}</option>
            {hosts.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name || `${h.username}@${h.host}`}
              </option>
            ))}
            <option value="__add">{t('new.addMachine')}</option>
          </select>
        </Field>
        <Field label={t('new.folder')} help={t('help.paths.serverDir')}>
          <div className="input-row">
            <input className="input mono" value={dir} onChange={(e) => setDir(e.target.value)} placeholder={hostId === 'local' ? 'C:\\arma3server' : '/home/arma/server'} />
            <Button size="sm" onClick={pick}>
              {t('common.browse')}
            </Button>
          </div>
        </Field>
        <Field label={t('field.network.port')} help={t('help.network.port')}>
          <input className="input short mono" value={port} onChange={(e) => setPort(Number(e.target.value.replace(/\D/g, '')) || 0)} />
        </Field>
        <Field label={t('new.importCfg')} help={t('fl.importCfgHelp')}>
          <div className="input-row">
            <span className="mono small muted" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {cfgFile ?? '—'}
            </span>
            <Button
              size="sm"
              onClick={async () => setCfgFile(await api.app.pickFile({ title: 'server.cfg', filters: [{ name: 'Arma config', extensions: ['cfg', 'txt'] }] }))}
            >
              {t('common.browse')}
            </Button>
          </div>
        </Field>
      </div>
      {browse && (
        <RemoteBrowser
          hostId={hostId}
          start=""
          onClose={() => setBrowse(false)}
          onPick={(p) => {
            setDir(p);
            setBrowse(false);
          }}
        />
      )}
    </Modal>
  );
}
