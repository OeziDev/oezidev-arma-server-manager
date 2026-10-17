/**
 * Arayüz hareketleri: tercih (localStorage), <html> sınıfı ve küçük yardımcı bileşenler.
 * Tüm CSS hareketleri `prefers-reduced-motion: no-preference` ve `:root:not(.no-motion)` altında tanımlı;
 * buradaki JS tarafı (yazı efekti, sayaç, açılış ekranı) aynı koşula `motionOn()` ile bakar.
 */
import { useEffect, useRef, useState } from 'react';

const KEY = 'oezi.motion';

export function getMotionPref(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setMotionPref(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    /* depolama kapalı: sadece bu oturum için uygula */
  }
  applyMotionClass(on);
}

export function applyMotionClass(on = getMotionPref()): void {
  document.documentElement.classList.toggle('no-motion', !on);
}

function osReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** Hareket açık mı (kullanıcı ayarı + işletim sistemi "hareketi azalt") */
export function motionOn(): boolean {
  return !document.documentElement.classList.contains('no-motion') && !osReducedMotion();
}

/** Değer her değiştiğinde artan sayaç (ilk değerde 0). key={n} ile CSS animasyonunu yeniden başlatmak için. */
export function useChangeCount<T>(value: T): number {
  const prev = useRef(value);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (prev.current !== value) {
      prev.current = value;
      setN((x) => x + 1);
    }
  }, [value]);
  return n;
}

/** Bir kez taranan amber çizgi. key değişince (sekme / görünüm) yeniden oynar. */
export function Sweep() {
  return <div className="sweep" aria-hidden />;
}

/**
 * Sunucu adı "yazılarak" gelir. Metin DOM'da her zaman tam ve doğru sırada durur (textContent değişmez);
 * harfler sadece görsel olarak sırayla açılır. ~1,2 sn sonra düz metne döner, sonraki render'lar etkilenmez.
 */
export function TypeTitle({ text }: { text: string }) {
  const [active, setActive] = useState(() => motionOn() && text.length > 0 && text.length <= 80);
  useEffect(() => {
    if (!active) return;
    const h = setTimeout(() => setActive(false), Math.min(1600, text.length * 34 + 1000));
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!active) return <>{text}</>;
  const step = Math.max(14, Math.min(34, 620 / text.length));
  return (
    <span className="tw" style={{ ['--step' as string]: `${step}ms` }}>
      {Array.from(text).map((ch, i) => (
        <span key={i} className="tw-ch" style={{ ['--i' as string]: i }}>
          {ch}
        </span>
      ))}
    </span>
  );
}

const NUM_RE = /-?\d+(?:[.,]\d+)?/;

/**
 * Metindeki ilk sayıyı, değer ilk kez göründüğünde kısa süre 0'dan yukarı sayar ("47.3" , "2.1 GB", "38%").
 * Sonraki canlı güncellemelerde doğrudan yeni değeri gösterir.
 */
export function useCountUp(value: string, duration = 520): string {
  const done = useRef(false);
  const [shown, setShown] = useState<string | null>(null);
  const m = NUM_RE.exec(value);
  const target = m ? Number(m[0].replace(',', '.')) : NaN;
  const hasNum = Number.isFinite(target);
  useEffect(() => {
    if (done.current || !hasNum) return;
    if (!motionOn() || target === 0) {
      done.current = true;
      return;
    }
    const decimals = (m![0].split(/[.,]/)[1] ?? '').length;
    const sep = m![0].includes(',') ? ',' : '.';
    const start = performance.now();
    let raf = 0;
    const frame = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      if (p >= 1) {
        done.current = true;
        setShown(null);
        return;
      }
      const v = (target * eased).toFixed(decimals).replace('.', sep);
      setShown(value.replace(NUM_RE, v));
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    // Yarıda kesilirse (StrictMode yeniden bağlama) bir sonraki bağlamada baştan oynar
    return () => {
      cancelAnimationFrame(raf);
      setShown(null);
    };
    // Sadece ilk sayısal değerde
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasNum]);
  return shown ?? value;
}
