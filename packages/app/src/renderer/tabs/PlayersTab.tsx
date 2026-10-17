import { classifyMessage } from '@core-rcon';
import { useEffect, useRef, useState } from 'react';
import type { RconBan, RconPlayer } from '../../shared/api';
import { Button, Empty, Field, Modal, NumberInput, Toggle } from '../components/ui';
import { useI18n } from '../i18n';
import { api, attempt, formatTime, setState, tryRun, useStore } from '../state';
import { BanDialog } from './BanDialog';
import { PlayerHistory } from './PlayerHistory';

type Action = { kind: 'kick' | 'ban' | 'msg'; player: RconPlayer } | null;
type Sub = 'online' | 'history' | 'bans';
const SUBS: Sub[] = ['online', 'history', 'bans'];

export function PlayersTab({ id }: { id: string }) {
  const { t } = useI18n();
  const [sub, setSub] = useState<Sub>('online');
  const count = useStore((s) => (s.statuses[id]?.rcon === 'connected' ? (s.players[id]?.length ?? 0) : null));
  return (
    <>
      <div className="subtabs" role="tablist" aria-label={t('tab.players')}>
        {SUBS.map((x) => (
          <button key={x} role="tab" aria-selected={sub === x} className="subtab" onClick={() => setSub(x)}>
            {t(`pl.sub.${x}`)}
            {x === 'online' && count !== null && <span className="subtab-count">{count}</span>}
          </button>
        ))}
      </div>
      {sub === 'online' && <OnlinePlayers id={id} />}
      {sub === 'history' && <PlayerHistory id={id} />}
      {sub === 'bans' && <BansPanel id={id} />}
    </>
  );
}

function RconOff({ id }: { id: string }) {
  const { t } = useI18n();
  const status = useStore((s) => s.statuses[id]);
  return (
    <div className="banner" data-level="info">
      <div className="vstack">
        <span>{t('pl.rconOff')}</span>
        {(status?.status === 'running' || status?.status === 'starting') && (
          <div>
            <Button size="sm" onClick={() => attempt(() => api.rcon.reconnect(id))}>
              {t('pl.reconnect')}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function BansPanel({ id }: { id: string }) {
  const { t } = useI18n();
  const connected = useStore((s) => s.statuses[id]?.rcon === 'connected');
  const [bans, setBans] = useState<RconBan[] | null>(null);
  const [addBan, setAddBan] = useState(false);
  const load = async () => setBans((await attempt(() => api.rcon.bans(id))) ?? null);
  useEffect(() => {
    if (connected) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);
  if (!connected) return <RconOff id={id} />;
  return (
    <div className="panel">
      <div className="panel-head">
        <h3>{t('pl.bans')}</h3>
        <span className="muted small">{bans ? bans.length : ''}</span>
        <span className="spacer" />
        <Button size="sm" onClick={() => setAddBan(true)}>
          {t('pl.addBan')}
        </Button>
        <Button size="sm" onClick={load}>
          {t('common.refresh')}
        </Button>
      </div>
      {bans === null ? null : bans.length === 0 ? (
        <Empty title={t('pl.noBans')} />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>{t('ban.value')}</th>
              <th>{t('pl.minutes')}</th>
              <th>{t('pl.reason')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {bans.map((b) => (
              <tr key={b.id}>
                <td className="muted">{b.id}</td>
                <td className="mono small">{b.value}</td>
                <td>{b.minutesLeft < 0 ? t('pl.permanent') : `${b.minutesLeft} ${t('common.minutes')}`}</td>
                <td>{b.reason}</td>
                <td className="actions">
                  <Button
                    size="sm"
                    kind="ghost"
                    onClick={async () => {
                      await attempt(() => api.rcon.removeBan(id, b.id));
                      await load();
                    }}
                  >
                    {t('pl.unban')}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {addBan && <BanDialog id={id} onClose={() => setAddBan(false)} onDone={load} />}
    </div>
  );
}

function OnlinePlayers({ id }: { id: string }) {
  const { t } = useI18n();
  const status = useStore((s) => s.statuses[id]);
  const players = useStore((s) => s.players[id]) ?? [];
  const chat = useStore((s) => s.chat[id]) ?? [];
  const connected = status?.rcon === 'connected';
  const [broadcast, setBroadcast] = useState('');
  const [action, setAction] = useState<Action>(null);
  const [locked, setLocked] = useState(false);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const chatRef = useRef<HTMLDivElement>(null);

  // Enter + düğme ya da hızlı iki Enter aynı mesajı iki kez göndermesin; hata olursa metin kalsın
  const sendBroadcast = async () => {
    const text = broadcast.trim();
    if (!text || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    try {
      if (await tryRun(() => api.rcon.say(id, text))) setBroadcast((cur) => (cur.trim() === text ? '' : cur));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const refresh = async () => {
    const p = await attempt(() => api.rcon.players(id));
    if (p) setState((s) => ({ players: { ...s.players, [id]: p } }));
  };

  useEffect(() => {
    if (connected) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [chat.length]);

  if (!connected) return <RconOff id={id} />;

  return (
    <>
      <div className="two-col wide-left">
        <div className="panel">
          <div className="panel-head">
            <h3>{t('pl.title')}</h3>
            <span className="muted small">{players.length}</span>
            <span className="spacer" />
            <Button
              size="sm"
              onClick={async () => {
                const next = !locked;
                if (await tryRun(() => api.rcon.setLock(id, next))) setLocked(next);
              }}
            >
              {locked ? t('pl.unlock') : t('pl.lock')}
            </Button>
            <Button size="sm" onClick={refresh}>
              {t('common.refresh')}
            </Button>
          </div>
          {players.length === 0 ? (
            <Empty title={t('pl.empty')} />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>{t('pl.name')}</th>
                  <th className="num">{t('pl.ping')}</th>
                  <th>{t('pl.guid')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {players.map((p) => (
                  <tr key={p.id}>
                    <td className="muted">{p.id}</td>
                    <td>
                      <div style={{ fontWeight: 500 }}>{p.name}</div>
                      <div className="small muted">
                        {p.ip}
                        {p.inLobby && <span className="warn"> {t('pl.lobby')}</span>}
                      </div>
                    </td>
                    <td className={`num ${p.ping > 250 ? 'warn' : ''}`}>{p.ping >= 0 ? p.ping : '-'}</td>
                    <td className="mono small" title={p.guid}>
                      {p.guid ? `${p.guid.slice(0, 10)}…` : '-'} {p.verified && <span className="ok">✓</span>}
                    </td>
                    <td className="actions">
                      <Button size="sm" kind="ghost" onClick={() => setAction({ kind: 'msg', player: p })}>
                        {t('pl.message')}
                      </Button>
                      <Button size="sm" kind="ghost" onClick={() => setAction({ kind: 'kick', player: p })}>
                        {t('pl.kick')}
                      </Button>
                      <Button size="sm" kind="danger" onClick={() => setAction({ kind: 'ban', player: p })}>
                        {t('pl.ban')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="panel">
          <div className="panel-head">
            <h3>{t('pl.chat')}</h3>
          </div>
          <div className="chat" ref={chatRef}>
            {chat.length === 0 ? (
              <Empty title={t('pl.chatEmpty')} />
            ) : (
              chat.map((c, i) => {
                const m = classifyMessage(c.message);
                return (
                  <div key={i} className="chat-line" data-type={m.type}>
                    <span className="t">{formatTime(c.t).slice(0, 5)}</span>
                    <span className="m">
                      {m.type === 'chat' ? (
                        <>
                          <span className="chan">{m.channel}</span>
                          <strong>{m.name}:</strong> {m.text}
                        </>
                      ) : (
                        c.message
                      )}
                    </span>
                  </div>
                );
              })
            )}
          </div>
          <div className="hstack" style={{ padding: 12, borderTop: '1px solid var(--line)', flexWrap: 'nowrap' }}>
            <input
              className="input"
              placeholder={t('pl.broadcast')}
              value={broadcast}
              maxLength={400}
              onChange={(e) => setBroadcast(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.repeat) void sendBroadcast();
              }}
              aria-label={t('pl.broadcast')}
            />
            <Button disabled={!broadcast.trim() || sending} onClick={sendBroadcast}>
              {t('pl.send')}
            </Button>
          </div>
        </div>
      </div>

      {action && <ActionDialog id={id} action={action} onClose={() => setAction(null)} onDone={refresh} />}
    </>
  );
}

function ActionDialog({ id, action, onClose, onDone }: { id: string; action: NonNullable<Action>; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const [reason, setReason] = useState('');
  const [minutes, setMinutes] = useState(60);
  const [perm, setPerm] = useState(false);
  const name = action.player.name;
  const title = action.kind === 'kick' ? t('pl.kickTitle', { name }) : action.kind === 'ban' ? t('pl.banTitle', { name }) : t('pl.msgTitle', { name });
  const run = async () => {
    const ok =
      action.kind === 'kick'
        ? await tryRun(() => api.rcon.kick(id, action.player.id, reason), t('pl.kicked', { name }))
        : action.kind === 'ban'
          ? await tryRun(() => api.rcon.ban(id, action.player.id, perm ? 0 : minutes, reason), t('pl.banned', { name }))
          : await tryRun(() => api.rcon.say(id, reason, action.player.id));
    if (ok) {
      onClose();
      onDone();
    }
  };
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button kind="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button kind={action.kind === 'msg' ? 'primary' : 'danger'} disabled={action.kind === 'msg' && !reason.trim()} onClick={run}>
            {action.kind === 'kick' ? t('pl.kick') : action.kind === 'ban' ? t('pl.ban') : t('pl.send')}
          </Button>
        </>
      }
    >
      <div className="fields">
        <Field label={action.kind === 'msg' ? t('pl.message') : t('pl.reason')}>
          <input className="input" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
        </Field>
        {action.kind === 'ban' && (
          <Field label={t('pl.minutes')}>
            <div className="hstack">
              <NumberInput standalone value={minutes} onChange={(v) => setMinutes(Math.max(1, Math.round(v)))} />
              <span className="unit">{t('common.minutes')}</span>
              <Toggle checked={perm} onChange={setPerm} label={t('pl.permanent')} />
            </div>
          </Field>
        )}
      </div>
    </Modal>
  );
}
