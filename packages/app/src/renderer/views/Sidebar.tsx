import { type RefObject, useLayoutEffect, useRef, useState } from 'react';
import type { Navigate, Route } from '../App';
import { StatusMark } from '../components/ui';
import { useI18n } from '../i18n';
import { api, fpsClass, hostLabel, useStore } from '../state';

/**
 * Seçili öğenin arkasında kayan gösterge: konteyner içindeki aria-current="true" öğeyi ölçer.
 * İlk konumlandırma animasyonsuz, sonrakiler transform geçişiyle.
 */
function useIndicator(ref: RefObject<HTMLElement | null>, deps: unknown[]) {
  const [box, setBox] = useState<{ y: number; h: number; moved: boolean } | null>(null);
  useLayoutEffect(() => {
    const measure = () => {
      const el = ref.current?.querySelector<HTMLElement>('[aria-current="true"]');
      setBox((prev) => (el ? { y: el.offsetTop, h: el.offsetHeight, moved: !!prev } : null));
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return box ? (
    <span className={`side-ind ${box.moved ? 'moved' : ''}`} aria-hidden style={{ transform: `translateY(${box.y}px)`, height: box.h }} />
  ) : null;
}

export function Sidebar({ route, onNavigate, onNew }: { route: Route; onNavigate: Navigate; onNew: () => void }) {
  const { t } = useI18n();
  const summaries = useStore((s) => s.summaries);
  const statuses = useStore((s) => s.statuses);
  const hosts = useStore((s) => s.hosts);
  const version = useStore((s) => s.info?.version);
  const update = useStore((s) => s.update);
  const showUpdate = update && (update.status === 'downloading' || update.status === 'ready');
  const listRef = useRef<HTMLUListElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const routeKey = route.view === 'server' ? `s:${route.id}` : route.view;
  const listInd = useIndicator(listRef, [routeKey, summaries.length]);
  const navInd = useIndicator(navRef, [routeKey]);

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">OeziDev</div>
        <div className="brand-sub">{t('app.sub')}</div>
      </div>
      <div className="side-head">
        <span>{t('app.servers')}</span>
        <button className="btn sm" onClick={onNew}>
          {t('app.newServer')}
        </button>
      </div>
      <ul className="server-list" ref={listRef}>
        {listInd && <li className="side-ind-li">{listInd}</li>}
        {summaries.map((s) => {
          const st = statuses[s.id] ?? s.status;
          const current = route.view === 'server' && route.id === s.id;
          return (
            <li key={s.id}>
              <button
                className="server-item"
                aria-current={current}
                onClick={() => onNavigate({ view: 'server', id: s.id, tab: current && route.view === 'server' ? route.tab : 'overview' })}
                title={`${s.name} - ${t(`status.${st.status}`)}`}
              >
                <StatusMark status={st.status} />
                <span style={{ minWidth: 0 }}>
                  <div className="server-item-name">{s.name}</div>
                  <div className="server-item-meta">
                    {hostLabel(s.hostId, hosts, t('common.local'))} : {s.port}
                  </div>
                </span>
                {st.status === 'running' ? (
                  <span className="server-item-side">
                    {st.rcon === 'connected' && <span className="server-item-players">{st.players}</span>}
                    {st.perf?.fps !== undefined && (
                      <span className={`server-item-fps ${fpsClass(st.perf.fps)}`} title={t('side.fps')}>
                        {Math.round(st.perf.fps)} FPS
                      </span>
                    )}
                  </span>
                ) : (
                  <span />
                )}
              </button>
            </li>
          );
        })}
      </ul>
      <nav className="side-nav" ref={navRef}>
        {navInd}
        <button aria-current={route.view === 'hosts'} onClick={() => onNavigate({ view: 'hosts' })}>
          {t('app.hosts')}
        </button>
        <button aria-current={route.view === 'settings'} onClick={() => onNavigate({ view: 'settings' })}>
          {t('app.settings')}
        </button>
      </nav>
      {showUpdate && (
        <button
          className="update-pill"
          data-ready={update.status === 'ready' || undefined}
          onClick={() => onNavigate({ view: 'settings' })}
          title={update.status === 'ready' ? t('upd.pillReadyTitle') : undefined}
        >
          {update.status === 'ready'
            ? t('upd.pillReady', { version: update.version ?? '' })
            : t('upd.pillDownloading', { percent: Math.round(update.percent ?? 0) })}
        </button>
      )}
      <div className="side-foot">
        <div>{t('app.developedBy')}{version ? ` v${version}` : ''}</div>
        <button onClick={() => void api.app.openExternal('https://discord.gg/JNnkdBN5GP')}>{t('app.discord')}</button>
      </div>
    </aside>
  );
}
