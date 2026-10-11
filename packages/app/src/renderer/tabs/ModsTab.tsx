import { modFolderName, parseWorkshopId } from '@core-naming';
import { useState } from 'react';
import type { FoundMod, ServerProfile } from '../../shared/api';
import { useDraft } from '../components/draft';
import { Button, Empty, Toggle, useConfirm } from '../components/ui';
import { useI18n } from '../i18n';
import { api, attempt, errorText, toast } from '../state';

type ModRef = ServerProfile['launch']['mods'][number];
type ListKey = 'mods' | 'serverMods';

export function ModsTab({ id, dirty, onSave }: { id: string; dirty: boolean; onSave: () => Promise<boolean> }) {
  const { t } = useI18n();
  const { draft, update } = useDraft();
  const [found, setFound] = useState<FoundMod[] | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const { confirm, node } = useConfirm();

  const setList = (key: ListKey, fn: (l: ModRef[]) => ModRef[]) => update((p) => ({ ...p, launch: { ...p.launch, [key]: fn(p.launch[key]) } }));
  const all = [...draft.launch.mods, ...draft.launch.serverMods];
  const hasPath = (path: string) => all.some((m) => m.path.toLowerCase() === path.toLowerCase());
  const hasWorkshop = (wid: string) => all.some((m) => m.workshopId === wid);

  const folderFor = (title: string, wid: string) => {
    // Klasör adları her iki sistemde de küçük harf: Linux'a taşınınca bozulmasın
    let f = modFolderName(title, wid);
    let n = 2;
    const base = f;
    while (hasPath(f)) f = `${base}_${n++}`;
    return f;
  };

  const addWorkshop = async (ids: string[]) => {
    const fresh = ids.filter((x) => !hasWorkshop(x));
    if (!fresh.length) return 0;
    const info = await api.steam.workshopInfo(fresh);
    const byId = new Map(info.map((i) => [i.id, i]));
    const items: ModRef[] = [];
    const used = new Set(all.map((m) => m.path.toLowerCase()));
    for (const wid of fresh) {
      const i = byId.get(wid);
      if (i && !i.found) continue;
      if (i?.isCollection) continue;
      const title = i?.title || wid;
      let folder = folderFor(title, wid);
      for (let n = 2; used.has(folder); n++) folder = `${modFolderName(title, wid)}_${n}`;
      used.add(folder);
      items.push({ id: crypto.randomUUID(), path: folder, enabled: true, displayName: title, source: 'workshop', workshopId: wid });
    }
    setList('mods', (l) => [...l, ...items]);
    return items.length;
  };

  const onAdd = async () => {
    const wid = parseWorkshopId(input);
    if (!wid) {
      toast('error', t('mods.workshopHelp'));
      return;
    }
    setBusy(true);
    try {
      const [info] = await api.steam.workshopInfo([wid]);
      let ids = [wid];
      if (info?.isCollection || (info && !info.found)) {
        // Koleksiyon olabilir
        ids = await api.steam.collection(wid).catch(() => [wid]);
      }
      const n = await addWorkshop(ids);
      toast('success', t('mods.added', { n }));
      setInput('');
    } catch (err) {
      toast('error', errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const importPreset = async () => {
    const file = await api.app.pickFile({ title: t('mods.importPreset'), filters: [{ name: 'HTML', extensions: ['html', 'htm'] }] });
    if (!file) return;
    await attempt(async () => {
      const html = await api.app.readPickedFile(file);
      const mods = await api.steam.parsePreset(html);
      const wids = mods.filter((m) => m.workshopId).map((m) => m.workshopId!);
      let n = await addWorkshop(wids);
      const locals = mods.filter((m) => !m.workshopId).map((m) => (m.name.startsWith('@') ? m.name : `@${m.name}`)).filter((p) => !hasPath(p));
      if (locals.length) {
        setList('mods', (l) => [...l, ...locals.map((p) => ({ id: crypto.randomUUID(), path: p, enabled: true, displayName: p.replace(/^@/, ''), source: 'local' as const }))]);
        n += locals.length;
      }
      toast('success', t('mods.added', { n }));
    });
  };

  const sync = async () => {
    if (dirty && !(await onSave())) return;
    await attempt(() => api.steam.syncWorkshop(id));
  };

  const remove = async (key: ListKey, mod: ModRef) => {
    if (!(await confirm(t('mods.removeConfirm', { name: mod.displayName || mod.path }), true))) return;
    if (mod.source === 'workshop') await api.steam.removeWorkshopMod(id, mod.path).catch(() => undefined);
    setList(key, (l) => l.filter((m) => m.id !== mod.id));
  };

  const moveBetween = (from: ListKey, mod: ModRef) => {
    const to: ListKey = from === 'mods' ? 'serverMods' : 'mods';
    update((p) => ({ ...p, launch: { ...p.launch, [from]: p.launch[from].filter((m) => m.id !== mod.id), [to]: [...p.launch[to], mod] } }));
  };

  const scan = async () => {
    const r = await attempt(() => api.mods.scan(id));
    if (r) setFound(r);
  };

  const workshopCount = all.filter((m) => m.source === 'workshop').length;

  return (
    <>
      <div className="panel" style={{ marginBottom: 20, maxWidth: 1100 }}>
        <div className="panel-head">
          <h3>{t('mods.workshopAdd')}</h3>
          <span className="spacer" />
          <Button size="sm" onClick={importPreset}>
            {t('mods.importPreset')}
          </Button>
          <Button size="sm" kind="primary" disabled={workshopCount === 0} onClick={sync}>
            {t('mods.sync')}
          </Button>
        </div>
        <div className="panel-body">
          <div className="input-row" style={{ maxWidth: 'none' }}>
            <input
              className="input mono"
              style={{ maxWidth: 'none' }}
              placeholder={t('mods.workshopPlaceholder')}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !busy && void onAdd()}
              aria-label={t('mods.workshopAdd')}
            />
            <Button onClick={onAdd} disabled={busy || !input.trim()}>
              {t('common.add')}
            </Button>
          </div>
          <div className="small muted" style={{ marginTop: 6 }}>
            {t('mods.workshopHelp')} {t('mods.importPresetHelp')}
          </div>
        </div>
      </div>

      <div className="two-col">
        <ModList title={t('mods.client')} help={t('mods.clientHelp')} list={draft.launch.mods} listKey="mods" setList={setList} onRemove={remove} onMove={moveBetween} />
        <ModList title={t('mods.server')} help={t('mods.serverHelp')} list={draft.launch.serverMods} listKey="serverMods" setList={setList} onRemove={remove} onMove={moveBetween} />
      </div>

      <div className="panel mt" style={{ maxWidth: 1100 }}>
        <div className="panel-head">
          <h3>{t('mods.found')}</h3>
          <span className="spacer" />
          <Button size="sm" onClick={scan}>
            {t('ms.scan')}
          </Button>
        </div>
        {found === null ? (
          <Empty title={t('ms.notScanned')} />
        ) : found.length === 0 ? (
          <Empty title={t('mods.empty')} />
        ) : (
          <table className="table">
            <tbody>
              {found.map((m) => (
                <tr key={m.path}>
                  <td>
                    <div style={{ fontWeight: 500 }}>{m.displayName}</div>
                    <div className="small muted mono">
                      {m.path}
                      {m.workshopId ? `  #${m.workshopId}` : ''}
                    </div>
                  </td>
                  <td className="small muted">
                    {t('mods.keys', { n: m.keys.length })}
                    {!m.hasAddons && <span className="warn"> {t('mods.noAddons')}</span>}
                  </td>
                  <td className="actions">
                    {hasPath(m.path) ? (
                      <span className="small ok">✓</span>
                    ) : (
                      <span className="hstack" style={{ justifyContent: 'flex-end' }}>
                        {(['mods', 'serverMods'] as const).map((k) => (
                          <Button
                            key={k}
                            size="sm"
                            onClick={() =>
                              setList(k, (l) => [
                                ...l,
                                { id: crypto.randomUUID(), path: m.path, enabled: true, displayName: m.displayName, source: m.workshopId && m.isSymlink ? 'workshop' : 'local', ...(m.workshopId ? { workshopId: m.workshopId } : {}) },
                              ])
                            }
                          >
                            {t(k === 'mods' ? 'mods.addClient' : 'mods.addServer')}
                          </Button>
                        ))}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {node}
    </>
  );
}

function ModList(props: {
  title: string;
  help: string;
  list: ModRef[];
  listKey: ListKey;
  setList: (k: ListKey, fn: (l: ModRef[]) => ModRef[]) => void;
  onRemove: (k: ListKey, m: ModRef) => void;
  onMove: (from: ListKey, m: ModRef) => void;
}) {
  const { t } = useI18n();
  const { list, listKey, setList } = props;
  const move = (i: number, d: number) =>
    setList(listKey, (l) => {
      const n = [...l];
      const j = i + d;
      if (j < 0 || j >= n.length) return l;
      [n[i], n[j]] = [n[j]!, n[i]!];
      return n;
    });
  return (
    <div className="panel">
      <div className="panel-head">
        <h3>{props.title}</h3>
        <span className="muted small">{list.filter((m) => m.enabled).length}</span>
      </div>
      <div className="small muted" style={{ padding: '8px 16px 0' }}>
        {props.help}
      </div>
      {list.length === 0 ? (
        <Empty title={t('mods.empty')} />
      ) : (
        list.map((m, i) => (
          <div key={m.id} className={`rot-item ${m.enabled ? '' : 'disabled'}`}>
            <span className="order">
              <button disabled={i === 0} onClick={() => move(i, -1)} aria-label="↑">
                ▲
              </button>
              <button disabled={i === list.length - 1} onClick={() => move(i, 1)} aria-label="↓">
                ▼
              </button>
            </span>
            <Toggle checked={m.enabled} onChange={(v) => setList(listKey, (l) => l.map((x) => (x.id === m.id ? { ...x, enabled: v } : x)))} />
            <div style={{ minWidth: 0 }}>
              <div className="rot-name" title={m.displayName || m.path}>
                {m.displayName || m.path}
              </div>
              <div className="rot-sub mono">
                {m.path}
                {m.source === 'workshop' && (
                  <>
                    {'  '}
                    <button className="link small" onClick={() => void api.app.openExternal(`https://steamcommunity.com/sharedfiles/filedetails/?id=${m.workshopId}`)}>
                      #{m.workshopId}
                    </button>
                  </>
                )}
              </div>
            </div>
            <span className="small muted">{t(m.source === 'workshop' ? 'mods.workshop' : 'mods.local')}</span>
            <span className="hstack" style={{ gap: 4, flexWrap: 'nowrap' }}>
              <Button size="sm" kind="ghost" title={t(listKey === 'mods' ? 'mods.moveToServer' : 'mods.moveToClient')} onClick={() => props.onMove(listKey, m)}>
                {listKey === 'mods' ? '→ -serverMod' : '→ -mod'}
              </Button>
              <Button size="sm" kind="ghost" onClick={() => props.onRemove(listKey, m)}>
                {t('common.remove')}
              </Button>
            </span>
          </div>
        ))
      )}
    </div>
  );
}
