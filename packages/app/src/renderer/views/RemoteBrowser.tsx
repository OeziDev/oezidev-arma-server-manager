import { useEffect, useState } from 'react';
import type { DirEntry } from '../../shared/api';
import { Button, Modal } from '../components/ui';
import { useI18n } from '../i18n';
import { api, errorText } from '../state';

/** SSH makinesinde klasör seçici */
export function RemoteBrowser({ hostId, start, onPick, onClose }: { hostId: string; start: string; onPick: (path: string) => void; onClose: () => void }) {
  const { t } = useI18n();
  const [path, setPath] = useState(start);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [typed, setTyped] = useState(start);

  const open = async (p: string) => {
    setLoading(true);
    setError('');
    try {
      const r = await api.hosts.browse(hostId, p);
      setPath(r.path);
      setTyped(r.path);
      setEntries(r.entries);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void open(start);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const parent = path.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/';
  const dirs = entries.filter((e) => e.isDir);
  const hasServer = entries.some((e) => /^arma3server(_x64)?$/.test(e.name));

  return (
    <Modal
      title={t('common.browse')}
      onClose={onClose}
      wide
      footer={
        <>
          <Button kind="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button kind="primary" onClick={() => onPick(path)} disabled={!!error}>
            {path}
          </Button>
        </>
      }
    >
      <div className="vstack">
        <div className="input-row" style={{ maxWidth: 'none' }}>
          <input className="input mono" style={{ maxWidth: 'none' }} value={typed} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void open(typed)} />
          <Button size="sm" onClick={() => open(typed)}>
            {t('common.refresh')}
          </Button>
        </div>
        {hasServer && <div className="ok small">arma3server_x64 ✓</div>}
        {error && <div className="bad">{error}</div>}
        <div className="browser-list" aria-busy={loading}>
          {path !== '/' && (
            <button onClick={() => open(parent)}>
              <span>..</span>
            </button>
          )}
          {dirs.map((d) => (
            <button key={d.name} onClick={() => open(`${path.replace(/\/+$/, '')}/${d.name}`)}>
              <span>{d.name}/</span>
              {d.isSymlink && <span className="muted small">→</span>}
            </button>
          ))}
          {!loading && dirs.length === 0 && <div className="empty">—</div>}
        </div>
      </div>
    </Modal>
  );
}
