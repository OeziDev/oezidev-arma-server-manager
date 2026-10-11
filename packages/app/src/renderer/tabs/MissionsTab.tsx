import { DIFFICULTY_PRESETS } from '@core-constants';
import { useEffect, useMemo, useState } from 'react';
import type { FoundMission, ServerProfile } from '../../shared/api';
import { LinesF, SelectF, ToggleF, useDraft } from '../components/draft';
import { Button, Empty, Section, Toggle, useFormReset, useLocalInvalid } from '../components/ui';
import { useI18n } from '../i18n';
import { api, attempt, formatBytes, toast } from '../state';

type Mission = ServerProfile['missions']['rotation'][number];

function newId() {
  return crypto.randomUUID();
}

export function MissionsTab({ id }: { id: string }) {
  const { t } = useI18n();
  const { draft, update, ensureSaved } = useDraft();
  const [found, setFound] = useState<FoundMission[] | null>(null);
  const [dir, setDir] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [island, setIsland] = useState('');
  const [manual, setManual] = useState('');
  const [openParams, setOpenParams] = useState<string | null>(null);
  const rotation = draft.missions.rotation;
  const inRotation = useMemo(() => new Set(rotation.map((m) => m.template.toLowerCase())), [rotation]);

  // Tarama / yükleme kayıtlı profildeki klasörü kullanır: önce taslağı kaydet
  const scan = async () => {
    if (!(await ensureSaved())) return;
    const r = await attempt(() => api.missions.scan(id));
    if (r) {
      setFound(r.missions);
      setDir(r.dir);
    }
  };

  const setRotation = (fn: (r: Mission[]) => Mission[]) => update((p) => ({ ...p, missions: { ...p.missions, rotation: fn(p.missions.rotation) } }));
  const add = (template: string) => {
    const tpl = template.trim().replace(/\.pbo$/i, '');
    if (!tpl) return;
    setRotation((r) => [...r, { id: newId(), template: tpl, enabled: true, difficulty: 'regular', params: [] }]);
  };
  const move = (i: number, d: number) =>
    setRotation((r) => {
      const next = [...r];
      const j = i + d;
      if (j < 0 || j >= next.length) return r;
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  const patch = (i: number, p: Partial<Mission>) => setRotation((r) => r.map((m, k) => (k === i ? { ...m, ...p } : m)));

  const islands = useMemo(() => [...new Set((found ?? []).map((m) => m.island).filter(Boolean))].sort(), [found]);
  const visible = (found ?? []).filter((m) => (!island || m.island === island) && (!filter || m.template.toLowerCase().includes(filter.toLowerCase())));

  return (
    <>
      <div className="two-col">
        <div className="panel">
          <div className="panel-head">
            <h3>{t('ms.available')}</h3>
            <span className="spacer" />
            <Button size="sm" onClick={scan}>
              {t('ms.scan')}
            </Button>
            <Button
              size="sm"
              onClick={async () => {
                if (!(await ensureSaved())) return;
                const name = await attempt(() => api.missions.upload(id));
                if (name) {
                  toast('success', t('ms.uploaded', { name }));
                  await scan();
                }
              }}
            >
              {t('ms.upload')}
            </Button>
          </div>
          {found === null ? (
            <Empty title={t('ms.notScanned')} />
          ) : dir === null ? (
            <Empty title={t('ms.noDir')} />
          ) : (
            <>
              <div className="hstack" style={{ padding: '10px 16px', borderBottom: '1px solid var(--line)' }}>
                <input className="input" style={{ maxWidth: 240 }} placeholder={t('common.search')} value={filter} onChange={(e) => setFilter(e.target.value)} aria-label={t('common.search')} />
                <select className="select" style={{ maxWidth: 160 }} value={island} onChange={(e) => setIsland(e.target.value)} aria-label={t('ms.island')}>
                  <option value="">{t('common.all')}</option>
                  {islands.map((i) => (
                    <option key={i} value={i}>
                      {i}
                    </option>
                  ))}
                </select>
                <span className="muted small right">{visible.length}</span>
              </div>
              <div style={{ maxHeight: 520, overflowY: 'auto' }}>
                {visible.map((m) => (
                  <div key={m.fileName} className="rot-item" style={{ gridTemplateColumns: 'minmax(0,1fr) auto auto' }}>
                    <div style={{ minWidth: 0 }}>
                      <div className="rot-name">{m.template}</div>
                      <div className="rot-sub">
                        {m.island} {m.kind === 'pbo' ? formatBytes(m.size) : t('ms.folder')}
                      </div>
                    </div>
                    <span />
                    {inRotation.has(m.template.toLowerCase()) ? (
                      <span className="small ok">{t('ms.inRotation')}</span>
                    ) : (
                      <Button size="sm" onClick={() => add(m.template)}>
                        {t('ms.addToRotation')}
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="panel">
          <div className="panel-head">
            <h3>{t('ms.rotation')}</h3>
            <span className="muted small">{t('ms.rotationHelp')}</span>
          </div>
          {rotation.length === 0 ? (
            <Empty title={t('ms.empty')}>{t('ms.emptyHelp')}</Empty>
          ) : (
            rotation.map((m, i) => (
              <div key={m.id}>
                <div className={`rot-item ${m.enabled ? '' : 'disabled'}`}>
                  <span className="order">
                    <button disabled={i === 0} onClick={() => move(i, -1)} aria-label="↑">
                      ▲
                    </button>
                    <button disabled={i === rotation.length - 1} onClick={() => move(i, 1)} aria-label="↓">
                      ▼
                    </button>
                  </span>
                  <Toggle checked={m.enabled} onChange={(v) => patch(i, { enabled: v })} />
                  <div style={{ minWidth: 0 }}>
                    <div className="rot-name" title={m.template}>
                      {i + 1}. {m.template}
                    </div>
                    {m.params.length > 0 && <div className="rot-sub">{m.params.map((p) => `${p.name}=${p.value}`).join(', ')}</div>}
                  </div>
                  <select className="select" style={{ width: 120 }} value={m.difficulty} onChange={(e) => patch(i, { difficulty: e.target.value as Mission['difficulty'] })} aria-label={t('ms.difficulty')}>
                    {DIFFICULTY_PRESETS.map((d) => (
                      <option key={d} value={d}>
                        {t(`opt.preset.${d}`)}
                      </option>
                    ))}
                  </select>
                  <span className="hstack" style={{ gap: 4, flexWrap: 'nowrap' }}>
                    <Button size="sm" kind="ghost" onClick={() => setOpenParams(openParams === m.id ? null : m.id)}>
                      {t('ms.params')}
                    </Button>
                    <Button size="sm" kind="ghost" onClick={() => setRotation((r) => r.filter((_, k) => k !== i))}>
                      {t('common.remove')}
                    </Button>
                  </span>
                </div>
                {openParams === m.id && <ParamsEditor mission={m} onChange={(params) => patch(i, { params })} />}
              </div>
            ))
          )}
          <div className="hstack" style={{ padding: '10px 12px', borderTop: '1px solid var(--line)' }}>
            <input
              className="input mono"
              placeholder={t('ms.manual')}
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  add(manual);
                  setManual('');
                }
              }}
              aria-label={t('ms.manual')}
            />
            <Button
              size="sm"
              disabled={!manual.trim()}
              onClick={() => {
                add(manual);
                setManual('');
              }}
            >
              {t('common.add')}
            </Button>
          </div>
        </div>
      </div>

      <div className="mt">
        <Section title={t('tab.missions')}>
          <div className="fields">
            <ToggleF path="missions.autoSelectMission" />
            <ToggleF path="missions.randomMissionOrder" />
            <SelectF path="missions.forcedDifficulty" options={[{ value: '', label: t('common.none') }, ...DIFFICULTY_PRESETS.map((d) => ({ value: d, label: t(`opt.preset.${d}`) }))]} />
            <LinesF path="missions.missionWhitelist" mono rows={3} />
          </div>
        </Section>
      </div>
    </>
  );
}

const PARAM_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(-?\d+(?:[.,]\d+)?)\s*;?\s*$/;
const paramsText = (params: Mission['params']) => params.map((p) => `${p.name} = ${p.value}`).join('\n');

/** Metni çöz: geçersiz satır varsa { bad } döner (taslak değişmez, Kaydet engellenir). */
function parseParams(v: string): { params: Mission['params'] } | { bad: { line: number; text: string } } {
  const out: Mission['params'] = [];
  for (const [n, line] of v.split('\n').entries()) {
    if (!line.trim()) continue;
    const m = PARAM_RE.exec(line);
    if (!m) return { bad: { line: n + 1, text: line.trim() } };
    out.push({ name: m[1]!, value: Number(m[2]!.replace(',', '.')) });
  }
  return { params: out };
}

function ParamsEditor({ mission, onChange }: { mission: Mission; onChange: (p: Mission['params']) => void }) {
  const { t } = useI18n();
  const [text, setText] = useState(paramsText(mission.params));
  const parsed = parseParams(text);
  const bad = 'bad' in parsed ? parsed.bad : null;
  useLocalInvalid(!!bad);
  // Taslak dışarıdan değiştiyse (Değişiklikleri at, içe aktarma) metni yeniden eşitle
  useEffect(() => {
    const cur = parseParams(text);
    if (!('params' in cur) || JSON.stringify(cur.params) !== JSON.stringify(mission.params)) setText(paramsText(mission.params));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mission.params]);
  useFormReset(() => setText(paramsText(mission.params)));
  return (
    <div style={{ padding: '6px 12px 12px 58px', borderBottom: '1px solid var(--line)' }}>
      <div className="small muted" style={{ marginBottom: 6 }}>
        {t('ms.paramsHelp')}
      </div>
      <textarea
        className="textarea mono"
        rows={4}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const r = parseParams(e.target.value);
          if ('params' in r) onChange(r.params);
        }}
        placeholder={'Daytime = 12\nWeather = 0'}
        aria-invalid={!!bad || undefined}
      />
      {bad && <div className="field-error">{t('ms.paramsInvalid', { line: bad.line, text: bad.text })}</div>}
    </div>
  );
}
