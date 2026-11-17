import { useEffect, useRef, useState } from 'react';
import { displayName, type Notice, type OfficeState } from '@agent-office/core';
import { ago, useStoreInstance } from '../hooks';

const ICON: Record<Notice['severity'], string> = { info: 'i', warning: '!', error: '✗' };

interface CenterProps {
  state: OfficeState;
  read: Set<string>;
  now: number;
  onSelect(key: string): void;
  onMarkAll(): void;
  onClose(): void;
}

export function NotificationCenter({ state, read, now, onSelect, onMarkAll, onClose }: CenterProps) {
  const items = [...state.notices].reverse();
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section className="modal notices" role="dialog" aria-label="Notifications" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>Alerts</h2>
          <button className="btn" onClick={onMarkAll}>
            Mark all read
          </button>
          <button className="btn icon" onClick={onClose} aria-label="Close alerts">
            ✕
          </button>
        </header>
        {items.length === 0 ? <p className="muted pad">No alerts yet. Permission requests, tool failures and API errors appear here.</p> : null}
        <ul className="notice-list">
          {items.map((n) => {
            const a = state.agents[n.agentKey];
            return (
              <li key={n.id} className={`notice sev-${n.severity} ${read.has(n.id) ? 'read' : ''}`}>
                <span className="notice-icon">{ICON[n.severity]}</span>
                <div className="notice-body">
                  <div className="notice-title">{n.title}</div>
                  {n.message ? <div className="small notice-msg">{n.message}</div> : null}
                  <div className="muted small">
                    {a ? (
                      <button
                        className="link"
                        onClick={() => {
                          onSelect(a.key);
                          onClose();
                        }}
                      >
                        {displayName(a)}
                      </button>
                    ) : (
                      'agent no longer tracked'
                    )}{' '}
                    · {ago(n.ts, now)}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

interface Toast {
  notice: Notice;
  name: string;
  expires: number;
}

/** Toasts for live warnings/errors (permission prompts, failures, input needed). */
export function Toasts({ state, onSelect }: { state: OfficeState; onSelect(key: string): void }) {
  const store = useStoreInstance();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(
    () =>
      store.onNotices((fresh) => {
        const important = fresh.filter((n) => n.severity !== 'info');
        if (!important.length) return;
        setToasts((cur) =>
          [
            ...cur,
            ...important.map((n) => {
              const a = stateRef.current.agents[n.agentKey];
              return { notice: n, name: a ? displayName(a) : n.sessionId, expires: Date.now() + (n.severity === 'error' ? 12_000 : 9_000) };
            }),
          ].slice(-4),
        );
      }),
    [store],
  );

  useEffect(() => {
    if (!toasts.length) return;
    const t = setInterval(
      () =>
        setToasts((cur) => {
          const now = Date.now();
          return cur.some((x) => x.expires <= now) ? cur.filter((x) => x.expires > now) : cur;
        }),
      1000,
    );
    return () => clearInterval(t);
  }, [toasts.length]);

  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.notice.id} className={`toast sev-${t.notice.severity}`}>
          <button
            className="toast-body"
            onClick={() => {
              onSelect(t.notice.agentKey);
              setToasts((cur) => cur.filter((x) => x !== t));
            }}
          >
            <strong>{t.notice.title}</strong>
            <span className="small ellipsis">{t.name}</span>
            {t.notice.message ? <span className="small muted ellipsis">{t.notice.message}</span> : null}
          </button>
          <button className="btn icon" aria-label="Dismiss" onClick={() => setToasts((cur) => cur.filter((x) => x !== t))}>
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
