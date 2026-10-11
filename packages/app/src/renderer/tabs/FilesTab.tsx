import { useEffect, useState } from 'react';
import type { PreviewFiles, ServerProfile } from '../../shared/api';
import { useDraft } from '../components/draft';
import { ImportSummary, hasImportDetails, type ImportSummaryData } from '../components/ImportSummary';
import { Button, Section, copyText, useConfirm } from '../components/ui';
import { useI18n } from '../i18n';
import { api, attempt, errorText, refreshSummaries, toast } from '../state';

type FileKey = 'serverCfg' | 'basicCfg' | 'arma3Profile' | 'beServerCfg' | 'commandLine' | 'headlessCommandLine' | 'systemdUnit' | 'paths';

export function FilesTab({ id, onImported, onDeleted, onDuplicated }: { id: string; onImported: (p: ServerProfile) => void; onDeleted: () => void; onDuplicated: (id: string) => void }) {
  const { t } = useI18n();
  const { draft, ensureSaved, jobActive } = useDraft();
  const [preview, setPreview] = useState<PreviewFiles | null>(null);
  const [summary, setSummary] = useState<ImportSummaryData | null>(null);
  const [which, setWhich] = useState<FileKey>('serverCfg');
  const { confirm, node } = useConfirm();

  useEffect(() => {
    const h = setTimeout(() => {
      api.profiles
        .preview(draft)
        .then(setPreview)
        .catch((e) => setPreview({ error: errorText(e) }));
    }, 250);
    return () => clearTimeout(h);
  }, [draft]);

  const tabs: { key: FileKey; label: string }[] = [
    { key: 'serverCfg', label: 'server.cfg' },
    { key: 'basicCfg', label: 'basic.cfg' },
    { key: 'arma3Profile', label: `${draft.paths.profileName}.Arma3Profile` },
    ...(preview?.beServerCfg ? [{ key: 'beServerCfg' as const, label: 'beserver_x64.cfg' }] : []),
    { key: 'commandLine', label: t('fl.cmd') },
    ...(preview?.headlessCommandLine ? [{ key: 'headlessCommandLine' as const, label: t('fl.hc') }] : []),
    ...(preview?.systemdUnit ? [{ key: 'systemdUnit' as const, label: t('fl.unit') }] : []),
    { key: 'paths', label: t('fl.paths') },
  ];
  const content =
    which === 'paths'
      ? Object.entries(preview?.paths ?? {})
          .map(([k, v]) => `${k.padEnd(14)} ${v}`)
          .join('\n')
      : ((preview?.[which] as string | null | undefined) ?? '');

  const importFile = async (kind: 'cfg' | 'profile') => {
    const file = await api.app.pickFile({
      title: kind === 'cfg' ? t('fl.importCfg') : t('fl.importProfile'),
      filters: kind === 'cfg' ? [{ name: 'Arma config', extensions: ['cfg', 'txt'] }] : [{ name: 'Arma3Profile', extensions: ['Arma3Profile', 'ArmA3Profile', 'arma3profile'] }],
    });
    if (!file) return;
    const what = kind === 'cfg' ? 'server.cfg' : 'Arma3Profile';
    try {
      const text = await api.app.readPickedFile(file);
      const res = kind === 'cfg' ? await api.profiles.importServerCfg(draft, text) : await api.profiles.importArma3Profile(draft, text);
      // Sadece taslak değişir; kalıcı olması için Kaydet gerekir
      onImported(res.profile);
      const data: ImportSummaryData = { what, issues: res.issues, unknownKeys: res.unknownKeys, needsSave: true };
      if (hasImportDetails(data)) setSummary(data);
      else toast('success', t('fl.imported'));
    } catch (err) {
      setSummary({ what, issues: [], unknownKeys: [], error: errorText(err) });
    }
  };

  return (
    <>
      <Section
        title={t('fl.preview')}
        intro={t('fl.previewIntro')}
        actions={
          <div className="hstack">
            <Button size="sm" disabled={!content} onClick={() => copyText(content, t('common.copied'))}>
              {t('common.copy')}
            </Button>
            <Button
              size="sm"
              disabled={jobActive}
              title={jobActive ? t('job.activeHint') : t('fl.deployHelp')}
              onClick={async () => {
                if (!(await ensureSaved())) return;
                const files = await attempt(() => api.server.deploy(id));
                if (files) toast('success', t('action.deployed', { n: files.length }));
              }}
            >
              {t('action.deploy')}
            </Button>
          </div>
        }
      >
        <div className="tabs" style={{ marginTop: 0, marginBottom: 10 }} role="tablist">
          {tabs.map((x) => (
            <button key={x.key} role="tab" className="tab" aria-selected={which === x.key} onClick={() => setWhich(x.key)} style={{ fontSize: 14 }}>
              {x.label}
            </button>
          ))}
        </div>
        {preview?.error && (
          <div className="banner" data-level="error">
            {preview.error}
          </div>
        )}
        <pre className={`code ${which === 'commandLine' || which === 'headlessCommandLine' ? 'wrap' : ''}`}>{content || '—'}</pre>
      </Section>

      <Section title={t('fl.import')}>
        <div className="fields">
          <div className="field">
            <div className="field-label">
              <span className="lbl">{t('fl.importCfg')}</span>
              <div className="field-help">{t('fl.importCfgHelp')}</div>
            </div>
            <div className="field-control">
              <div>
                <Button size="sm" onClick={() => importFile('cfg')}>
                  server.cfg
                </Button>
              </div>
            </div>
          </div>
          <div className="field">
            <div className="field-label">
              <span className="lbl">{t('fl.importProfile')}</span>
            </div>
            <div className="field-control">
              <div>
                <Button size="sm" onClick={() => importFile('profile')}>
                  .Arma3Profile
                </Button>
              </div>
            </div>
          </div>
          <div className="field">
            <div className="field-label">
              <span className="lbl">{t('fl.export')}</span>
            </div>
            <div className="field-control">
              <div>
                <Button
                  size="sm"
                  onClick={async () => {
                    if (!(await ensureSaved())) return;
                    const json = await attempt(() => api.profiles.exportJson(id));
                    if (json) await api.app.saveFile({ defaultName: `${draft.name.replace(/[^\w.-]+/g, '_')}.oezi.json`, content: json });
                  }}
                >
                  .json
                </Button>
              </div>
            </div>
          </div>
        </div>
      </Section>

      <Section title={t('fl.dangerZone')}>
        <div className="hstack">
          <Button
            onClick={async () => {
              if (!(await ensureSaved())) return;
              const p = await attempt(() => api.profiles.duplicate(id));
              if (!p) return;
              // Kenar çubuğu listesi yeni profili içermeden gidersek App ilk sunucuya geri döner
              await refreshSummaries().catch(() => undefined);
              onDuplicated(p.id);
            }}
          >
            {t('fl.duplicate')}
          </Button>
          <Button
            kind="danger"
            onClick={async () => {
              if (!(await confirm(t('fl.deleteConfirm', { name: draft.name }), true))) return;
              if ((await attempt(async () => (await api.profiles.remove(id), true))) === true) onDeleted();
            }}
          >
            {t('fl.deleteProfile')}
          </Button>
        </div>
      </Section>
      {summary && <ImportSummary data={summary} onClose={() => setSummary(null)} />}
      {node}
    </>
  );
}
