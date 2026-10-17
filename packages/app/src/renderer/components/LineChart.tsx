import { type MouseEvent as RMouseEvent, useEffect, useMemo, useRef, useState } from 'react';

/** Grafikteki bir seri: zamana göre sıralı noktalar */
export interface ChartSeries {
  key: string;
  label: string;
  color: string;
  points: { t: number; v: number }[];
  /** Soluk ikinci çizgi (ör. FPS min) */
  faint?: boolean;
}

interface Props {
  series: ChartSeries[];
  tMin: number;
  tMax: number;
  /** Y ekseni alt sınırı (varsayılan 0) */
  yMin?: number;
  /** En az bu kadar yükseklik (ör. FPS için 50) */
  yMaxAtLeast?: number;
  /** Sabit üst sınır (ör. CPU için 100) */
  yMax?: number;
  format: (v: number) => string;
  /** Kesikli eşik çizgisi (ör. FPS uyarı sınırı) */
  threshold?: { v: number; label: string };
  height?: number;
  /** Bu süreden uzun boşluklarda çizgi kesilir (sunucu kapalıydı) */
  gapMs?: number;
  ariaLabel: string;
}

const PAD = { l: 46, r: 12, t: 12, b: 24 };

/** 1-2-5 dizisinden "güzel" adım */
function niceStep(range: number, ticks: number): number {
  const raw = range / Math.max(1, ticks);
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const n = raw / mag;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return step * mag;
}

function timeLabel(t: number, spanMs: number): string {
  const d = new Date(t);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (spanMs <= 20 * 60_000) return `${hh}:${mm}:${String(d.getSeconds()).padStart(2, '0')}`;
  return `${hh}:${mm}`;
}

/** Piksel başına çok nokta varsa zaman kovalarına ortala (çizim hızı için) */
function decimate(points: { t: number; v: number }[], tMin: number, tMax: number, buckets: number) {
  if (points.length <= buckets * 2) return points;
  const size = (tMax - tMin) / buckets;
  const out: { t: number; v: number }[] = [];
  let key = -1;
  let sumT = 0;
  let sumV = 0;
  let n = 0;
  for (const p of points) {
    const k = Math.floor((p.t - tMin) / size);
    if (k !== key && n > 0) {
      out.push({ t: sumT / n, v: sumV / n });
      sumT = sumV = n = 0;
    }
    key = k;
    sumT += p.t;
    sumV += p.v;
    n++;
  }
  if (n > 0) out.push({ t: sumT / n, v: sumV / n });
  return out;
}

/** Bağımlılıksız satır grafiği (SVG): ızgara, zaman ekseni, üzerine gelince değer kutusu. */
export function LineChart(props: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null);
  const height = props.height ?? 180;

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.floor(entries[0]?.contentRect.width ?? 600);
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const innerW = Math.max(10, width - PAD.l - PAD.r);
  const innerH = Math.max(10, height - PAD.t - PAD.b);
  const { tMin, tMax } = props;
  const span = Math.max(1, tMax - tMin);

  const series = useMemo(
    () => props.series.map((s) => ({ ...s, points: decimate(s.points.filter((p) => p.t >= tMin && p.t <= tMax), tMin, tMax, Math.floor(innerW)) })),
    [props.series, tMin, tMax, innerW],
  );

  const { yMin, yMax, ticks } = useMemo(() => {
    const lo = props.yMin ?? 0;
    let hi = props.yMax ?? Math.max(props.yMaxAtLeast ?? 1, ...series.flatMap((s) => s.points.map((p) => p.v)));
    if (props.threshold && props.yMax === undefined) hi = Math.max(hi, props.threshold.v);
    const step = niceStep(hi - lo, 4);
    const top = props.yMax ?? Math.ceil((hi * 1.05) / step) * step;
    const list: number[] = [];
    for (let v = lo; v <= top + step / 1000; v += step) list.push(v);
    return { yMin: lo, yMax: top || 1, ticks: list };
  }, [series, props.yMin, props.yMax, props.yMaxAtLeast, props.threshold]);

  const x = (t: number) => PAD.l + ((t - tMin) / span) * innerW;
  const y = (v: number) => PAD.t + innerH - ((Math.min(Math.max(v, yMin), yMax) - yMin) / (yMax - yMin || 1)) * innerH;

  const gap = props.gapMs ?? Math.max(60_000, span / 40);
  const pathFor = (pts: { t: number; v: number }[]) => {
    let d = '';
    let prev: number | null = null;
    for (const p of pts) {
      d += `${prev === null || p.t - prev > gap ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`;
      prev = p.t;
    }
    return d;
  };

  // Zaman ekseni etiketleri
  const xTicks = useMemo(() => {
    const count = Math.max(2, Math.min(6, Math.floor(innerW / 110)));
    const steps = [60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000, 7_200_000, 10_800_000, 21_600_000];
    const step = steps.find((s) => span / s <= count) ?? 21_600_000;
    const out: number[] = [];
    const tzOffset = new Date(tMin).getTimezoneOffset() * 60_000;
    for (let t = Math.ceil((tMin - tzOffset) / step) * step + tzOffset; t <= tMax; t += step) out.push(t);
    return out;
  }, [tMin, tMax, span, innerW]);

  const primary = series.find((s) => !s.faint) ?? series[0];
  const hoverPoint = (s: (typeof series)[number]) => {
    if (hover === null || !s.points.length) return null;
    let best = s.points[0]!;
    for (const p of s.points) if (Math.abs(p.t - hover) < Math.abs(best.t - hover)) best = p;
    return Math.abs(best.t - hover) <= gap ? best : null;
  };
  const hp = primary ? hoverPoint(primary) : null;
  const hoverT = hp?.t ?? null;

  const onMove = (e: RMouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    if (px < PAD.l || px > PAD.l + innerW) return setHover(null);
    setHover(tMin + ((px - PAD.l) / innerW) * span);
  };

  const tipLeft = hoverT !== null ? x(hoverT) : 0;
  const tipRight = tipLeft > width - 170;

  return (
    <div className="chart" ref={wrap}>
      <svg width={width} height={height} role="img" aria-label={props.ariaLabel} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {ticks.map((v) => (
          <g key={v}>
            <line className="chart-grid" x1={PAD.l} x2={PAD.l + innerW} y1={y(v)} y2={y(v)} />
            <text className="chart-axis" x={PAD.l - 6} y={y(v) + 4} textAnchor="end">
              {props.format(v)}
            </text>
          </g>
        ))}
        {xTicks.map((t) => (
          <g key={t}>
            <line className="chart-grid faint" x1={x(t)} x2={x(t)} y1={PAD.t} y2={PAD.t + innerH} />
            <text className="chart-axis" x={x(t)} y={height - 6} textAnchor="middle">
              {timeLabel(t, span)}
            </text>
          </g>
        ))}
        {props.threshold && props.threshold.v > yMin && props.threshold.v < yMax && (
          <g>
            <line className="chart-threshold" x1={PAD.l} x2={PAD.l + innerW} y1={y(props.threshold.v)} y2={y(props.threshold.v)} />
            <text className="chart-threshold-label" x={PAD.l + innerW - 4} y={y(props.threshold.v) - 4} textAnchor="end">
              {props.threshold.label}
            </text>
          </g>
        )}
        {series.map((s) => (
          <path key={s.key} className={`line ${s.faint ? 'faint' : ''}`} d={pathFor(s.points)} stroke={s.color} />
        ))}
        {series.map((s) => {
          // En son nokta: az veri varken de çizgi görünsün
          const last = s.points[s.points.length - 1];
          return last && !s.faint ? <circle key={`${s.key}-last`} cx={x(last.t)} cy={y(last.v)} r={2.5} fill={s.color} /> : null;
        })}
        {hoverT !== null && (
          <g>
            <line className="chart-cursor" x1={x(hoverT)} x2={x(hoverT)} y1={PAD.t} y2={PAD.t + innerH} />
            {series.map((s) => {
              const p = hoverPoint(s);
              return p ? <circle key={s.key} cx={x(p.t)} cy={y(p.v)} r={3.5} fill={s.color} className="chart-dot" /> : null;
            })}
          </g>
        )}
      </svg>
      {hoverT !== null && (
        <div className="chart-tip" style={tipRight ? { right: width - tipLeft + 10 } : { left: tipLeft + 10 }}>
          <div className="chart-tip-time">{new Date(hoverT).toLocaleTimeString()}</div>
          {series.map((s) => {
            const p = hoverPoint(s);
            return p ? (
              <div key={s.key} className="chart-tip-row">
                <span className="chart-swatch" style={{ background: s.color, opacity: s.faint ? 0.55 : 1 }} />
                <span className="muted">{s.label}</span>
                <strong>{props.format(p.v)}</strong>
              </div>
            ) : null;
          })}
        </div>
      )}
    </div>
  );
}
