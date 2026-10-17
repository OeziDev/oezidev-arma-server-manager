import { useEffect, useRef, useState } from 'react';
import type { PlayerHistoryStats, PlayerSession, PlayerSummary } from '../../shared/api';
import { Button, Empty, Modal, Toggle, copyText } from '../components/ui';
import { useI18n } from '../i18n';
import { api, errorText, formatDateTime, formatPlaytime, formatTime, tryRun, useStore } from '../state';
import { BanDialog } from './BanDialog';

const PAGE = 100;
const DAY = 24 * 3600_000;

export function PlayerHistory({ id }: { id: string }) {
  const { t, lang } = useI18n();
  const rev = useStore((s) => s.historyRev[id] ?? 0);
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [onlineOnly, setOnlineOnly] = useState(false);
  const [rows, setRows] = useState<PlayerSummary[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');
  const [stats, setStats] = useState<{ day: PlayerHistoryStats; week: PlayerHistoryStats } | null>(null);
  const [open, setOpen] = useState<PlayerSummary | null>(null);
  const [ban, setBan] = useState<PlayerSummary | null>(null);
  const reqId = useRef(0);
  const shown = useRef(PAGE);

  // Arama kutusu: yazmayı bitirince ara
  useEffect(() => {
    const h = setTimeout(() => setQuery(text.trim()), 300);
    return () => clearTimeout(h);
  }, [text]);

  const load = async (limit: number) => {
    const my = ++reqId.current;
    try {
      const [list, day, week] = await Promise.all([
        api.history.search(id, { text: query || undefined, limit: limit + 1, offset: 0, onlineOnly }),
        api.history.stats(id, Date.now() - DAY),
        api.history.stats(id, Date.now() - 7 * DAY),
      ]);
      if (my !== reqId.current) return;
      setRows(list.slice(0, limit));
      setMore(list.length > limit);
      setStats({ day, week });
      setError('');
    } catch (err) {
      if (my !== reqId.current) return;
      setRows([]);
      setError(errorText(err));
    }
  };

  useEffect(() => {
    shown.current = PAGE;
    void load(PAGE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, query, onlineOnly]);

  // Canlı yenileme (giriş/çıkış olayları sık gelebilir: en fazla 3 sn'de bir)
  const lastLoad = useRef(0);
  useEffect(() => {
    if (rev === 0) return;
    const wait = Math.max(0, 3000 - (Date.now() - lastLoad.current));
    const h = setTimeout(() => {
      lastLoad.current = Date.now();
      void load(shown.current);
    }, wait);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rev]);

  // Açık ayrıntı penceresi güncel özeti görsün
  const openRow = open ? rows?.find((r) => r.guid === open.guid) ?? open : null;

  return (
    <>
      {stats && (
        <div className="stat-strip">
          <StatGroup title={t('hist.last24h')} s={stats.day} lang={lang} />
          <StatGroup title={t('hist.last7d')} s={stats.week} lang={lang} />
        </div>
      )}

      <div className="panel">
        <div className="panel-head">
          <input className="input" style={{ maxWidth: 380 }} placeholder={t('hist.search')} aria-label={t('hist.search')} value={text} onChange={(e) => setText(e.target.value)} />
          <Toggle checked={onlineOnly} onChange={setOnlineOnly} label={t('hist.onlineOnly')} />
          <span className="spacer" />
          <span className="muted small">{rows ? t('hist.shown', { n: rows.length }) : ''}</span>
        </div>
        {error && (
          <div className="banner" data-level="error" style={{ margin: 12 }}>
            {error}
          </div>
        )}
        {rows === null ? (
          <p className="muted" style={{ padding: '0 16px' }}>
            {t('common.loading')}
          </p>
        ) : rows.length === 0 ? (
          !error && <Empty title={query || onlineOnly ? t('hist.noMatch') : t('hist.empty')}>{!query && !onlineOnly && t('hist.emptyHint')}</Empty>
        ) : (
          <div className="table-scroll">
            <table className="table hist-table">
              <thead>
                <tr>
                  <th>{t('pl.name')}</th>
                  <th>{t('pl.guid')}</th>
                  <th>{t('hist.lastIp')}</th>
                  <th>{t('hist.firstSeen')}</th>
                  <th>{t('hist.lastSeen')}</th>
                  <th className="num">{t('hist.playtime')}</th>
                  <th className="num">{t('hist.sessions')}</th>
                  <th className="num">{t('hist.kicks')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const others = r.names.filter((n) => n !== r.name);
                  return (
                    <tr key={r.guid} className="clickable" onClick={() => setOpen(r)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setOpen(r)}>
                      <td>
                        <div className="hstack" style={{ gap: 6, flexWrap: 'nowrap' }}>
                          {r.online && <span className="online-dot" title={t('hist.online')} />}
                          <span style={{ fontWeight: 500 }}>{r.name}</span>
                          {others.length > 0 && (
                            <span className="small muted" title={others.join('\n')}>
                              +{others.length}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="mono small nowrap">
                        <span title={r.guid}>{r.guid ? `${r.guid.slice(0, 10)}…` : '-'}</span>
                        {r.guid && (
                          <button
                            className="btn ghost sm icon"
                            title={t('hist.copyGuid')}
                            aria-label={t('hist.copyGuid')}
                            onClick={(e) => {
                              e.stopPropagation();
                              void copyText(r.guid, t('common.copied'));
                            }}
                          >
                            ⧉
                          </button>
                        )}
                      </td>
                      <td className="mono small">{r.ips[r.ips.length - 1] ?? '-'}</td>
                      <td className="small nowrap">{formatDateTime(r.firstSeen, lang)}</td>
                      <td className="small nowrap">{r.online ? <span className="ok">{t('hist.online')}</span> : formatDateTime(r.lastSeen, lang)}</td>
                      <td className="num nowrap">{formatPlaytime(r.totalPlaytimeMs, lang)}</td>
                      <td className="num">{r.sessionCount}</td>
                      <td className={`num ${r.kickCount ? 'warn' : ''}`} title={r.lastKickReason}>
                        {r.kickCount}
                      </td>
                      <td className="actions">{r.note ? <span className="note-mark" title={r.note}>✎</span> : null}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {more && (
          <div style={{ padding: 12, textAlign: 'center' }}>
            <Button
              size="sm"
              onClick={() => {
                shown.current += PAGE;
                return load(shown.current);
              }}
            >
              {t('hist.loadMore')}
            </Button>
          </div>
        )}
      </div>

      {openRow && <PlayerDetail id={id} player={openRow} rev={rev} onClose={() => setOpen(null)} onBan={() => setBan(openRow)} onNoteSaved={() => load(shown.current)} />}
      {ban && <BanDialog id={id} initial={ban.guid} name={ban.name} onClose={() => setBan(null)} />}
    </>
  );
}

function StatGroup({ title, s, lang }: { title: string; s: PlayerHistoryStats; lang: 'tr' | 'en' }) {
  const { t } = useI18n();
  return (
    <div className="stat-group">
      <div className="stat-group-title">{title}</div>
      <div className="stat-items">
        <div>
          <div className="stat-value">{s.uniquePlayers}</div>
          <div className="stat-label">{t('hist.unique')}</div>
        </div>
        <div title={s.peakAt ? formatDateTime(s.peakAt, lang) : undefined}>
          <div className="stat-value">{s.peakConcurrent}</div>
          <div className="stat-label">{t('hist.peak')}</div>
        </div>
        <div>
          <div className="stat-value">{s.totalSessions}</div>
          <div className="stat-label">{t('hist.totalSessions')}</div>
        </div>
      </div>
    </div>
  );
}

function PlayerDetail({ id, player, rev, onClose, onBan, onNoteSaved }: { id: string; player: PlayerSummary; rev: number; onClose: () => void; onBan: () => void; onNoteSaved: () => void }) {
  const { t, lang } = useI18n();
  const [sessions, setSessions] = useState<PlayerSession[] | null>(null);
  const [note, setNote] = useState(player.note ?? '');
  const noteDirty = note !== (player.note ?? '');

  useEffect(() => {
    let cancelled = false;
    api.history
      .sessions(id, player.guid, 200)
      .then((s) => !cancelled && setSessions(s))
      .catch(() => !cancelled && setSessions([]));
    return () => {
      cancelled = true;
    };
  }, [id, player.guid, rev]);

  return (
    <Modal
      wide
      title={player.name}
      intro={player.names.length > 1 ? t('hist.alsoKnown', { names: player.names.filter((n) => n !== player.name).join(', ') }) : undefined}
      onClose={onClose}
      footer={
        <>
          <Button kind="danger" onClick={onBan} disabled={!player.guid}>
            {t('hist.banGuid')}
          </Button>
          <span className="spacer" />
          <Button kind="ghost" onClick={onClose}>
            {t('common.close')}
          </Button>
        </>
      }
    >
      <div className="diff-grid" style={{ maxWidth: 'none' }}>
        <div className="muted">{t('pl.guid')}</div>
        <div className="diff-ctrl hstack" style={{ gap: 6 }}>
          <span className="mono small">{player.guid || '-'}</span>
          {player.guid && (
            <Button size="sm" kind="ghost" onClick={() => copyText(player.guid, t('common.copied'))}>
              {t('common.copy')}
            </Button>
          )}
        </div>
        <div className="muted">{t('hist.ips')}</div>
        <div className="diff-ctrl mono small" style={{ flexWrap: 'wrap', gap: 8 }}>
          {player.ips.join(', ') || '-'}
        </div>
        <div className="muted">{t('hist.firstSeen')}</div>
        <div className="diff-ctrl">{formatDateTime(player.firstSeen, lang)}</div>
        <div className="muted">{t('hist.lastSeen')}</div>
        <div className="diff-ctrl">{player.online ? <span className="ok">{t('hist.online')}</span> : formatDateTime(player.lastSeen, lang)}</div>
        <div className="muted">{t('hist.playtime')}</div>
        <div className="diff-ctrl">
          {formatPlaytime(player.totalPlaytimeMs, lang)} · {t('hist.sessionsN', { n: player.sessionCount })}
        </div>
        {player.kickCount > 0 && (
          <>
            <div className="muted">{t('hist.kicks')}</div>
            <div className="diff-ctrl warn">
              {player.kickCount}
              {player.lastKickReason ? ` · ${player.lastKickReason}` : ''}
            </div>
          </>
        )}
      </div>

      <h3 className="sub-h">{t('hist.note')}</h3>
      <textarea className="textarea" style={{ maxWidth: 'none' }} rows={3} value={note} maxLength={2000} placeholder={t('hist.notePlaceholder')} onChange={(e) => setNote(e.target.value)} />
      <div className="hstack" style={{ marginTop: 8 }}>
        <Button
          size="sm"
          kind="primary"
          disabled={!noteDirty}
          onClick={async () => {
            if (await tryRun(() => api.history.setNote(id, player.guid, note.trim()), t('hist.noteSaved'))) onNoteSaved();
          }}
        >
          {t('hist.saveNote')}
        </Button>
        {noteDirty && <span className="small muted">{t('common.unsaved')}</span>}
      </div>

      <h3 className="sub-h">{t('hist.sessionList')}</h3>
      {sessions === null ? (
        <p className="muted">{t('common.loading')}</p>
      ) : sessions.length === 0 ? (
        <Empty title={t('common.none')} />
      ) : (
        <div className="table-scroll" style={{ maxHeight: 320 }}>
          <table className="table">
            <thead>
              <tr>
                <th>{t('hist.join')}</th>
                <th>{t('hist.leave')}</th>
                <th className="num">{t('hist.duration')}</th>
                <th>{t('pl.ip')}</th>
                <th>{t('hist.kickReason')}</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => {
                const end = s.leaveAt ?? Date.now();
                return (
                  <tr key={s.id}>
                    <td className="small nowrap">{formatDateTime(s.joinAt, lang)}</td>
                    <td className="small nowrap">
                      {s.leaveAt ? (
                        new Date(s.leaveAt).toDateString() === new Date(s.joinAt).toDateString() ? formatTime(s.leaveAt).slice(0, 5) : formatDateTime(s.leaveAt, lang)
                      ) : (
                        <span className="ok">{t('hist.online')}</span>
                      )}
                      {s.approx && (
                        <span className="muted" title={t('hist.approx')}>
                          {' '}
                          ~
                        </span>
                      )}
                    </td>
                    <td className="num nowrap">{formatPlaytime(end - s.joinAt, lang)}</td>
                    <td className="mono small">{s.ip || '-'}</td>
                    <td className={s.kicked ? 'warn small' : 'muted small'}>{s.kicked ?? ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
