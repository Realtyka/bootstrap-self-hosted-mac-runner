import { useCallback, useEffect, useReducer, useState } from 'react';
import { api, type HostView, type Job, type JobSource } from './lib/api';
import { useEvents } from './lib/useEvents';
import { toggle, selectAll, clear, eligible } from './lib/selection';
import { dockReducer, emptyDock } from './lib/dock';
import { HostCard } from './components/HostCard';
import { Toolbar } from './components/Toolbar';
import { LogDock } from './components/LogDock';
import { OnboardDialog } from './components/OnboardDialog';
import { HistoryDrawer } from './components/HistoryDrawer';

export default function App() {
  const [views, setViews] = useState<HostView[]>([]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [source, setSource] = useState<JobSource>('github');
  const [busy, setBusy] = useState(false);
  const [lastLine, setLastLine] = useState<Record<string, string>>({});
  const [dock, dispatch] = useDock();
  const [onboardOpen, setOnboardOpen] = useState(false);
  const [historyHost, setHistoryHost] = useState<string | null>(null);

  const reload = useCallback(() => api.hosts().then(setViews), []);
  useEffect(() => { void reload(); }, [reload]);

  // On first load, resurface running jobs into the dock with their history
  useEffect(() => {
    void api.hosts().then(async v => {
      for (const view of v) {
        if (view.runningJob) {
          dispatch({ type: 'job-started', job: view.runningJob });
          const log = await api.jobLog(view.runningJob.id);
          dispatch({ type: 'hydrate', jobId: view.runningJob.id, lines: log.split('\n').filter(Boolean) });
        }
      }
    });
  }, [dispatch]);

  useEvents({
    onLog: e => {
      dispatch({ type: 'log', jobId: e.jobId, line: e.line });
      const tab = dock.tabs.find(t => t.jobId === e.jobId);
      if (tab) setLastLine(prev => ({ ...prev, [tab.host]: e.line }));
    },
    onState: (job: Job) => {
      dispatch({ type: 'state', job });
      void reload();
    },
    onHealth: () => void reload(),
  });

  const startAction = async (action: 'bootstrap' | 'launchagent') => {
    const targets = eligible(views, sel);
    if (!targets.length) return;
    setBusy(true);
    try {
      const res = await api.startJobs(targets, action, source);
      for (const job of res.started) dispatch({ type: 'job-started', job });
      if (res.refused.length) alert(res.refused.map(r => `${r.host}: ${r.reason}`).join('\n'));
      await reload();
    } finally { setBusy(false); }
  };

  const refreshHealth = async () => {
    setBusy(true);
    try { await api.refreshHealth(); await reload(); } finally { setBusy(false); }
  };

  return (
    <main className="mx-auto max-w-7xl p-4 pb-96 space-y-4">
      <Toolbar
        selectedCount={sel.size}
        eligibleCount={eligible(views, sel).length}
        source={source}
        busy={busy}
        onSourceChange={setSource}
        onBootstrap={() => void startAction('bootstrap')}
        onLaunchAgent={() => void startAction('launchagent')}
        onRefresh={() => void refreshHealth()}
        onSelectAll={() => setSel(selectAll(views.map(v => v.host.name)))}
        onClear={() => setSel(clear())}
        onOnboard={() => setOnboardOpen(true)}
      />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
        {views.map(v => (
          <HostCard
            key={v.host.name}
            v={v}
            selected={sel.has(v.host.name)}
            onToggle={() => setSel(s => toggle(s, v.host.name))}
            onOpenHistory={() => setHistoryHost(v.host.name)}
            lastLogLine={lastLine[v.host.name]}
          />
        ))}
        {views.length === 0 && (
          <p className="col-span-full rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            No hosts yet. Copy hosts.example.yaml → hosts.yaml, or use “+ Onboard host”.
          </p>
        )}
      </div>
      <LogDock
        dock={dock}
        sshDestFor={host => views.find(v => v.host.name === host)?.host.sshDest}
        onSelect={id => dispatch({ type: 'select', jobId: id })}
        onClose={id => dispatch({ type: 'close', jobId: id })}
      />
      <OnboardDialog open={onboardOpen} onOpenChange={setOnboardOpen} onDone={() => void reload()} />
      <HistoryDrawer host={historyHost} onOpenChange={o => { if (!o) setHistoryHost(null); }} />
    </main>
  );
}

function useDock() {
  return useReducer(dockReducer, emptyDock);
}
