import { useEffect, useRef } from 'react';
import type { Job, HealthReport } from './api';

export interface EventHandlers {
  onLog?: (e: { jobId: string; line: string }) => void;
  onState?: (job: Job) => void;
  onHealth?: (e: { host: string; report: HealthReport }) => void;
}

export function useEvents(handlers: EventHandlers): void {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const connect = () => {
      es = new EventSource('/api/events');
      es.addEventListener('log', ev => ref.current.onLog?.(JSON.parse((ev as MessageEvent).data)));
      es.addEventListener('state', ev => ref.current.onState?.(JSON.parse((ev as MessageEvent).data)));
      es.addEventListener('health', ev => ref.current.onHealth?.(JSON.parse((ev as MessageEvent).data)));
      es.onerror = () => {
        es?.close();
        if (!closed) retry = setTimeout(connect, 2000);
      };
    };
    connect();
    return () => { closed = true; es?.close(); if (retry) clearTimeout(retry); };
  }, []);
}
