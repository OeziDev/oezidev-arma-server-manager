import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { motionOn } from './motion';

const MIN_MS = 900;
const MAX_MS = 1800;
const FADE_MS = 300;

/**
 * Açılış ekranı: ilk durum yüklenirken en az ~0,9 sn, en fazla ~1,8 sn görünür, sonra solar ve DOM'dan
 * tamamen kalkar. Tıklama / tuş ile geçilir. Solarken tıklamaları engellemez (pointer-events: none).
 * Hareket kapalıysa hiç gösterilmez.
 */
export function Splash({ ready }: { ready: boolean }) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<'show' | 'out' | 'gone'>(() => (motionOn() ? 'show' : 'gone'));
  const startedAt = useRef(performance.now());

  // Üst sınır: veri gelmese de asla takılı kalmaz
  useEffect(() => {
    if (phase !== 'show') return;
    const h = setTimeout(() => setPhase((p) => (p === 'show' ? 'out' : p)), MAX_MS);
    return () => clearTimeout(h);
  }, [phase]);

  useEffect(() => {
    if (!ready || phase !== 'show') return;
    const wait = Math.max(0, MIN_MS - (performance.now() - startedAt.current));
    const h = setTimeout(() => setPhase((p) => (p === 'show' ? 'out' : p)), wait);
    return () => clearTimeout(h);
  }, [ready, phase]);

  useEffect(() => {
    if (phase !== 'out') return;
    const h = setTimeout(() => setPhase('gone'), FADE_MS);
    return () => clearTimeout(h);
  }, [phase]);

  useEffect(() => {
    if (phase !== 'show') return;
    const skip = () => setPhase('out');
    window.addEventListener('keydown', skip);
    return () => window.removeEventListener('keydown', skip);
  }, [phase]);

  if (phase === 'gone') return null;
  return (
    <div className={`splash ${phase === 'out' ? 'out' : ''}`} onClick={() => setPhase('out')} aria-hidden>
      <div className="splash-frame">
        <div className="splash-mark">OeziDev</div>
        <div className="splash-title">Arma Server Manager</div>
        <div className="splash-bar">
          <span />
        </div>
        <div className="splash-log">
          <div className="splash-line" style={{ ['--d' as string]: '120ms' }}>
            <span className="tag">[ OK ]</span> {t('splash.boot')}
          </div>
          <div className="splash-line" style={{ ['--d' as string]: '420ms' }}>
            <span className={`tag ${ready ? '' : 'wait'}`}>{ready ? '[ OK ]' : '[ .. ]'}</span> {t('splash.scan')}
          </div>
          {ready && (
            <div className="splash-line now">
              <span className="tag">[ OK ]</span> {t('splash.ready')}
            </div>
          )}
        </div>
      </div>
      <div className="splash-skip">{t('splash.skip')}</div>
    </div>
  );
}
