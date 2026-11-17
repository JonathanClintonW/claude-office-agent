import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import type { OfficeStore, StoreSnapshot } from './store';

export const StoreContext = createContext<OfficeStore | null>(null);

export function useStoreInstance(): OfficeStore {
  const s = useContext(StoreContext);
  if (!s) throw new Error('StoreContext missing');
  return s;
}

export function useOffice(): StoreSnapshot {
  const store = useStoreInstance();
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

/** Re-render periodically so relative times ("12s ago") stay current. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function usePersistentState<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(`agent-office:${key}`);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  const set = (v: T) => {
    setValue(v);
    try {
      localStorage.setItem(`agent-office:${key}`, JSON.stringify(v));
    } catch {
      /* storage unavailable (some webviews) */
    }
  };
  return [value, set];
}

export function ago(ts: number | undefined, now: number): string {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function clock(ts: number | undefined): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
