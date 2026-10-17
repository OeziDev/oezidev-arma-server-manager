import { useState } from 'react';
import { Button, Field, Modal, NumberInput, Toggle } from '../components/ui';
import { useI18n } from '../i18n';
import { api, errorText, toast } from '../state';

export const BAN_VALUE_RE = /^([0-9a-fA-F]{32}|\d{1,3}(\.\d{1,3}){3})$/;

/**
 * GUID / IP ile ban. "Bütün sunucularda" seçilirse RCON'u bağlı her sunucuda banlanır (rcon.banEverywhere).
 * initial verilirse alan doldurulmuş gelir (oyuncu geçmişinden).
 */
export function BanDialog({ id, initial, name, onClose, onDone }: { id: string; initial?: string; name?: string; onClose: () => void; onDone?: () => void }) {
  const { t } = useI18n();
  const [value, setValue] = useState(initial ?? '');
  const [reason, setReason] = useState('');
  const [minutes, setMinutes] = useState(0);
  const [everywhere, setEverywhere] = useState(false);
  const valid = BAN_VALUE_RE.test(value.trim());

  const run = async () => {
    const v = value.trim();
    try {
      if (everywhere) {
        const res = await api.rcon.banEverywhere(v, minutes, reason);
        const ok = res.filter((r) => r.ok);
        const bad = res.filter((r) => !r.ok);
        if (res.length === 0) toast('warning', t('ban.noServers'));
        else toast(bad.length ? 'warning' : 'success', t('ban.everywhereDone', { ok: ok.length, n: res.length }));
        for (const b of bad) toast('error', `${b.name}: ${b.error ?? t('err.generic')}`);
        if (ok.length === 0) return;
      } else {
        await api.rcon.addBan(id, v, minutes, reason);
        toast('success', t('ban.done', { value: name ?? v }));
      }
      onClose();
      onDone?.();
    } catch (err) {
      toast('error', errorText(err));
    }
  };

  return (
    <Modal
      title={name ? t('ban.titleName', { name }) : t('pl.addBan')}
      onClose={onClose}
      footer={
        <>
          <Button kind="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button kind="danger" disabled={!valid} onClick={run}>
            {everywhere ? t('ban.banEverywhere') : t('pl.ban')}
          </Button>
        </>
      }
    >
      <div className="fields">
        <Field label={t('ban.value')} help={t('ban.valueHelp')}>
          <input className="input mono" value={value} onChange={(e) => setValue(e.target.value)} aria-invalid={!!value && !valid} spellCheck={false} />
        </Field>
        <Field label={t('pl.reason')}>
          <input className="input" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <Field label={t('pl.minutes')} help={`0 = ${t('pl.permanent')}`}>
          <div className="input-row">
            <NumberInput standalone value={minutes} onChange={(v) => setMinutes(Math.max(0, Math.round(v)))} />
            <span className="unit">{minutes === 0 ? t('pl.permanent') : t('common.minutes')}</span>
          </div>
        </Field>
        <Field label={t('ban.everywhere')} help={t('ban.everywhereHelp')}>
          <Toggle checked={everywhere} onChange={setEverywhere} />
        </Field>
      </div>
    </Modal>
  );
}
