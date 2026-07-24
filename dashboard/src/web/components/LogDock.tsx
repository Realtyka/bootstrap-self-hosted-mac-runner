import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import type { DockState, DockTab } from '@/lib/dock';

const stateColor: Record<string, string> = {
  starting: 'bg-blue-600 text-white',
  running: 'bg-blue-600 text-white',
  stalled: 'bg-amber-500 text-black',
  passed: 'bg-green-700 text-white',
  failed: 'bg-red-700 text-white',
  killed: 'bg-red-700 text-white',
};

function TabButton({ tab, active, onSelect, onClose }: {
  tab: DockTab; active: boolean; onSelect: () => void; onClose: () => void;
}) {
  return (
    <button
      className={cn(
        'flex items-center gap-2 rounded-t-md px-3 py-1 text-xs font-mono',
        active ? stateColor[tab.state] ?? 'bg-zinc-800 text-zinc-200' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200',
      )}
      onClick={onSelect}
    >
      {tab.host} · {tab.action} · {tab.state}
      <span className="opacity-60 hover:opacity-100" onClick={e => { e.stopPropagation(); onClose(); }}>✕</span>
    </button>
  );
}

export function LogDock({ dock, sshDestFor, onSelect, onClose }: {
  dock: DockState;
  sshDestFor: (host: string) => string | undefined;
  onSelect: (jobId: string) => void;
  onClose: (jobId: string) => void;
}) {
  const [input, setInput] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const preRef = useRef<HTMLPreElement>(null);

  const active = dock.tabs.find(t => t.jobId === dock.active) ?? null;
  const lines = active ? dock.buffers[active.jobId] ?? [] : [];

  useEffect(() => {
    if (autoScroll && preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [lines, autoScroll]);

  if (dock.tabs.length === 0) return null;

  const jobRunning = active && ['starting', 'running', 'stalled'].includes(active.state);

  const send = async () => {
    if (!active || !input) return;
    await api.sendInput(active.jobId, input);
    setInput('');
  };

  const copyRescue = () => {
    if (!active) return;
    const dest = sshDestFor(active.host) ?? active.host;
    void navigator.clipboard.writeText(`ssh ${dest} 'tail -f ~/.mac-fleet/jobs/${active.jobId}/out.log'`);
  };

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-zinc-800 bg-zinc-950/95 backdrop-blur">
      <div className="mx-auto max-w-7xl px-4 pt-2">
        <div className="flex items-end gap-1 overflow-x-auto">
          {dock.tabs.map(t => (
            <TabButton key={t.jobId} tab={t} active={t.jobId === dock.active}
              onSelect={() => onSelect(t.jobId)} onClose={() => onClose(t.jobId)} />
          ))}
          <div className="flex-1" />
          {active && (
            <div className="flex items-center gap-2 pb-1">
              <Button size="sm" variant="ghost" className="h-6 text-xs text-zinc-400 hover:text-zinc-100" onClick={copyRescue}>
                Copy rescue cmd
              </Button>
              {jobRunning && (
                <Button size="sm" variant="destructive" className="h-6 text-xs" onClick={() => void api.kill(active.jobId)}>
                  ■ Kill
                </Button>
              )}
            </div>
          )}
        </div>
        <pre
          ref={preRef}
          onScroll={e => {
            const el = e.currentTarget;
            setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
          }}
          className="h-56 overflow-y-auto whitespace-pre-wrap rounded-t-md bg-zinc-950 p-3 font-mono text-xs leading-5 text-zinc-300"
        >
          {lines.join('\n') || '— waiting for output —'}
        </pre>
        <div className="flex gap-2 py-2">
          <Input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void send(); }}
            placeholder={jobRunning ? 'Send input to job stdin (e.g. 2FA code) — not recorded' : 'job finished'}
            disabled={!jobRunning}
            className="h-8 border-zinc-700 bg-zinc-900 font-mono text-xs text-zinc-100 placeholder:text-zinc-500"
          />
          <Button size="sm" className="h-8" disabled={!jobRunning || !input} onClick={() => void send()}>Send</Button>
        </div>
      </div>
    </div>
  );
}
