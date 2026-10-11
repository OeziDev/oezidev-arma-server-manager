import { Button } from '../components/ui';
import { useI18n } from '../i18n';

export function Welcome({ onNew, onHosts }: { onNew: () => void; onHosts: () => void }) {
  const { t } = useI18n();
  return (
    <div className="content">
      <div className="welcome">
        <h1>{t('welcome.title')}</h1>
        <p>{t('welcome.text')}</p>
        <ol>
          <li>{t('welcome.step1')}</li>
          <li>{t('welcome.step2')}</li>
          <li>{t('welcome.step3')}</li>
          <li>{t('welcome.step4')}</li>
        </ol>
        <div className="hstack mt">
          <Button kind="primary" onClick={onNew}>
            {t('app.newServer')}
          </Button>
          <Button onClick={onHosts}>{t('app.hosts')}</Button>
        </div>
      </div>
    </div>
  );
}
