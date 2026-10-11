import { dismissToast, useStore } from '../state';
import { useI18n } from '../i18n';

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const { t } = useI18n();
  if (!toasts.length) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((x) => (
        <div key={x.id} className="toast" data-level={x.level}>
          <div>
            {x.who && <div className="who">{x.who}</div>}
            <div>{x.text}</div>
          </div>
          <button onClick={() => dismissToast(x.id)} aria-label={t('common.close')}>
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
