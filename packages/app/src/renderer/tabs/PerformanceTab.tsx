import { type ReactNode, useEffect, useMemo, useState } from 'react';
import type { MetricSample } from '../../shared/api';
import { NumberF, ToggleF, useDraft } from '../components/draft';
import { type ChartSeries, LineChart } from '../components/LineChart';
import { Empty, Section, Seg } from '../components/ui';
import { useCountUp } from '../components/motion';
import { useI18n } from '../i18n';
import { api, fpsClass, formatMem, useStore } from '../state';

type Range = 15 | 60 | 360 | 1440;
const RANGES: Range[] = [15, 60, 360, 1440];

const C = {
  amber: '#e9b44c',
  olive: '#a9bd6b',
  sand: '#d8c690',
  sky: '#84d2ee',
};

type NumKey = 'fps' | 'fpsMin' | 'cpu' | 'memMB' | 'players' | 'ai';
const pick = (list: MetricSample[], key: NumKey) => list.flatMap((s) => (s[key] === undefined ? [] : [{ t: s.t, v: s[key]! }]));

export function PerformanceTab({ id }: { id: string }) {
  const { t } = useI18n();
  const { draft } = useDraft();
  const status = useStore((s) => s.statuses[id]);
  const live = useStore((s) => s.metrics[id]);
  const [range, setRange] = useState<Range>(15);
  const [base, setBase] = useState<MetricSample[] | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setBase(null);
    api.server
      .metrics(id, Date.now() - range * 60_000)
      .then((list) => !cancelled && setBase(list))
      .catch(() => !cancelled && setBase([]));
    return () => {
      cancelled = true;
    };
  }, [id, range]);

  // Yüklenen geçmiş + sonradan canlı gelen örnekler
  const samples = useMemo(() => {
    const b = base ?? [];
    const lastT = b[b.length - 1]?.t ?? 0;
    const tail = (live ?? []).filter((s) => s.t > lastT);
    return tail.length ? b.concat(tail) : b;
  }, [base, live]);

  // Her saniye değil, örnek geldikçe kayan pencere (grafik sürekli titremesin)
  const tMax = Math.max(now - (now % 5000) + 5000, samples[samples.length - 1]?.t ?? 0);
  const tMin = tMax - range * 60_000;
  const visible = samples.filter((s) => s.t >= tMin);

  const latest = samples[samples.length - 1];
  const perf = status?.perf;
  const lastT = Math.max(latest?.t ?? 0, perf?.t ?? 0);
  const ago = lastT ? Math.max(0, Math.round((now - lastT) / 1000)) : null;
  const fps = latest?.fps ?? perf?.fps;
  const cpu = latest?.cpu ?? perf?.cpu;
  const mem = latest?.memMB ?? perf?.memMB;
  const ai = latest?.ai ?? perf?.ai;
  const running = status?.status === 'running' || status?.status === 'starting';
  const players = latest?.players ?? (status?.rcon === 'connected' ? status.players : undefined);
  const hasFps = visible.some((s) => s.fps !== undefined);
  const hasAny = samples.length > 0 || !!perf;

  const dash = (v: number | undefined, f: (n: number) => string = (n) => String(Math.round(n))) => (v === undefined ? '-' : f(v));

  const fpsSeries: ChartSeries[] = [
    { key: 'fps', label: t('perf.fps'), color: C.amber, points: pick(visible, 'fps') },
    { key: 'fpsMin', label: t('perf.fpsMin'), color: C.amber, faint: true, points: pick(visible, 'fpsMin') },
  ];
  const threshold = draft.monitoring.fpsAlertMinutes > 0 && draft.monitoring.fpsAlertBelow > 0 ? { v: draft.monitoring.fpsAlertBelow, label: t('perf.alertLine', { v: draft.monitoring.fpsAlertBelow }) } : undefined;
  const gapMs = Math.max(draft.monitoring.sampleSec * 4000, 90_000);

  return (
    <>
      {!draft.monitoring.enabled && (
        <div className="banner" data-level="info">
          {t('perf.disabled')}
        </div>
      )}

      <div className="perf-tiles">
        <Tile label={t('perf.fps')} value={dash(fps, (n) => n.toFixed(1))} cls={fpsClass(fps)} big />
        <Tile label={t('perf.fpsMin')} value={dash(latest?.fpsMin, (n) => n.toFixed(1))} cls={fpsClass(latest?.fpsMin)} />
        <Tile label={t('perf.cpu')} value={dash(cpu, (n) => `${n.toFixed(0)}%`)} />
        <Tile label={t('perf.ram')} value={dash(mem, formatMem)} />
        <Tile label={t('perf.players')} value={dash(players)} />
        <Tile label={t('perf.ai')} value={dash(ai)} />
        <Tile label={t('perf.groups')} value={dash(latest?.groups)} />
        <Tile label={t('perf.vehicles')} value={dash(latest?.vehicles)} />
      </div>
      <div className="hstack perf-bar">
        <span className="small muted">
          {ago === null ? t('perf.noSample') : t('perf.lastSample', { n: ago })}
          {!running && ago !== null && ` · ${t('perf.notRunning')}`}
        </span>
        <span className="spacer" />
        <Seg<Range> value={range} label={t('perf.range')} options={RANGES.map((r) => ({ value: r, label: t(`perf.range.${r}`) }))} onChange={setRange} />
      </div>

      {base === null ? (
        <p className="muted">{t('common.loading')}</p>
      ) : !hasAny ? (
        <div className="panel perf-empty">
          <Empty title={t('perf.emptyTitle')}>
            <p className="small" style={{ maxWidth: '70ch', margin: '8px auto 0' }}>
              {t('perf.emptyText')}
            </p>
          </Empty>
        </div>
      ) : (
        <>
          {!hasFps && visible.length > 0 && (
            <div className="banner" data-level="info">
              {t('perf.noFps')}
            </div>
          )}
          <div className="perf-charts">
            <ChartPanel title={t('perf.chart.fps')} wide legend={fpsSeries}>
              <LineChart series={fpsSeries} tMin={tMin} tMax={tMax} yMaxAtLeast={50} format={(v) => v.toFixed(v < 10 && v % 1 ? 1 : 0)} threshold={threshold} gapMs={gapMs} height={210} ariaLabel={t('perf.chart.fps')} />
            </ChartPanel>
            <ChartPanel title={t('perf.chart.cpu')}>
              <LineChart series={[{ key: 'cpu', label: t('perf.cpu'), color: C.olive, points: pick(visible, 'cpu') }]} tMin={tMin} tMax={tMax} yMax={100} format={(v) => `${Math.round(v)}%`} gapMs={gapMs} ariaLabel={t('perf.chart.cpu')} />
            </ChartPanel>
            <ChartPanel title={t('perf.chart.ram')}>
              <LineChart series={[{ key: 'mem', label: t('perf.ram'), color: C.sand, points: pick(visible, 'memMB') }]} tMin={tMin} tMax={tMax} yMaxAtLeast={1024} format={formatMem} gapMs={gapMs} ariaLabel={t('perf.chart.ram')} />
            </ChartPanel>
            <ChartPanel title={t('perf.chart.players')}>
              <LineChart series={[{ key: 'players', label: t('perf.players'), color: C.amber, points: pick(visible, 'players') }]} tMin={tMin} tMax={tMax} yMaxAtLeast={10} format={(v) => String(Math.round(v))} gapMs={gapMs} ariaLabel={t('perf.chart.players')} />
            </ChartPanel>
            <ChartPanel title={t('perf.chart.ai')}>
              <LineChart series={[{ key: 'ai', label: t('perf.ai'), color: C.olive, points: pick(visible, 'ai') }]} tMin={tMin} tMax={tMax} yMaxAtLeast={10} format={(v) => String(Math.round(v))} gapMs={gapMs} ariaLabel={t('perf.chart.ai')} />
            </ChartPanel>
          </div>
        </>
      )}

      <Section title={t('perf.settings')} intro={t('perf.settingsIntro')}>
        <div className="fields">
          <ToggleF path="monitoring.enabled" />
          <NumberF path="monitoring.sampleSec" unit={t('common.seconds')} />
          <NumberF path="monitoring.fpsAlertBelow" unit="FPS" />
          <NumberF path="monitoring.fpsAlertMinutes" unit={t('common.minutes')} />
          <ToggleF path="notifications.onPerformance" />
        </div>
      </Section>
    </>
  );
}

function Tile({ label, value, cls, big }: { label: string; value: string; cls?: string; big?: boolean }) {
  // İlk görünüşte kısa sayma; canlı güncellemelerde doğrudan değer
  const shown = useCountUp(value);
  return (
    <div className={`perf-tile ${big ? 'big' : ''}`}>
      <div className="perf-tile-label">{label}</div>
      <div className={`perf-tile-value ${cls ?? ''}`}>{shown}</div>
    </div>
  );
}

function ChartPanel({ title, children, wide, legend }: { title: string; children: ReactNode; wide?: boolean; legend?: ChartSeries[] }) {
  return (
    <div className={`panel perf-chart ${wide ? 'wide' : ''}`}>
      <div className="panel-head">
        <h3>{title}</h3>
        <span className="spacer" />
        {legend && legend.length > 1 && (
          <span className="chart-legend">
            {legend.map((s) => (
              <span key={s.key}>
                <span className="chart-swatch" style={{ background: s.color, opacity: s.faint ? 0.55 : 1 }} />
                {s.label}
              </span>
            ))}
          </span>
        )}
      </div>
      <div className="perf-chart-body">{children}</div>
    </div>
  );
}
