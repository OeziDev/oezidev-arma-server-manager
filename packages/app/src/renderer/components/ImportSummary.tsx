import type { ImportResultDto } from '../../shared/api';
import { useI18n } from '../i18n';
import { Button, Modal } from './ui';

export interface ImportSummaryData {
  /** Dosya adı / tür (başlıkta) */
  what: string;
  issues: ImportResultDto['issues'];
  unknownKeys: string[];
  /** İçe aktarma tamamen başarısız olduysa */
  error?: string;
  /** Taslak değişti, kalıcı olması için Kaydet gerekiyor */
  needsSave?: boolean;
}

export function hasImportDetails(d: ImportSummaryData): boolean {
  return !!d.error || d.issues.length > 0 || d.unknownKeys.length > 0;
}

/** server.cfg / Arma3Profile içe aktarma sonucu: bütün uyarı ve hatalar + ek satırlara taşınan anahtarlar. */
export function ImportSummary({ data, onClose }: { data: ImportSummaryData; onClose: () => void }) {
  const { t } = useI18n();
  const order: Record<string, number> = { error: 0, warning: 1, info: 2 };
  const issues = [...data.issues].sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3) || a.line - b.line);
  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.length - errors;
  return (
    <Modal
      title={t('imp.title', { what: data.what })}
      wide
      onClose={onClose}
      footer={
        <Button kind="primary" onClick={onClose}>
          {t('common.close')}
        </Button>
      }
    >
      <div className="vstack">
        {data.error ? (
          <div className="banner" data-level="error" style={{ marginBottom: 0 }}>
            <div className="vstack" style={{ gap: 4 }}>
              <strong>{t('imp.failed')}</strong>
              <span className="mono small" style={{ whiteSpace: 'pre-wrap' }}>
                {data.error}
              </span>
            </div>
          </div>
        ) : (
          data.needsSave && (
            <div className="banner" data-level="info" style={{ marginBottom: 0 }}>
              {t('imp.needsSave')}
            </div>
          )
        )}
        {!data.error && (
          <div className="small muted">
            {issues.length === 0 ? t('imp.noIssues') : t('imp.counts', { errors, warnings })}
          </div>
        )}
        {issues.length > 0 && (
          <ul className="issues">
            {issues.map((i, n) => (
              <li key={n} className="issue" data-sev={i.severity === 'error' || i.severity === 'warning' ? i.severity : 'info'}>
                <span>
                  {i.line > 0 && <span className="mono muted">{t('imp.line', { n: i.line })} </span>}
                  {i.message}
                </span>
                <span />
              </li>
            ))}
          </ul>
        )}
        {data.unknownKeys.length > 0 && (
          <div className="vstack" style={{ gap: 6 }}>
            <strong>{t('imp.unknownTitle')}</strong>
            <span className="small muted">{t('imp.unknownHelp')}</span>
            <div className="mono small" style={{ wordBreak: 'break-word' }}>
              {data.unknownKeys.join(', ')}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
