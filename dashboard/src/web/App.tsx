import { useCallback, useEffect, useState } from 'react';
import { api, type HostView, type Job, type JobSource } from './lib/api';
import { useEvents } from './lib/useEvents';
import { toggle, selectAll, clear, eligible } from './lib/selection';
import { HostCard } from './components/HostCard';
import { Toolbar } from './components/Toolbar';

export default function App() {
  const [views, setViews] = useState<HostView[]>([]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [source, setSource] = useState<JobSource>('github');
  const [busy, setBusy] = useState(false);
  const [lastLine, setLastLine] = useState<Record<string, string>>({});
  const [jobHost, setJobHost] = useState<Record<string, string>>({});

  const reload = useCallback(() => api.hosts().then(v => {
    setViews(v);
    setJobHost(prev => {
      const next = { ...prev };
      for (const view of v) if (view.runningJob) next[view.runningJob.id] = view.host.name;
      return next;
    });
  }), []);

  useEffect(() => { void reload(); }, [reload]);

  useEvents({
    onLog: e => {
      const host = jobHost[e.jobId];
      if (host) setLastLine(prev => ({ ...prev, [host]: e.line }));
    },
    onState: (job: Job) => {
      setJobHost(prev => ({ ...prev, [job.id]: job.host }));
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
      if (res.refused.length) {
        alert(res.refused.map(r => `${r.host}: ${r.reason}`).join('\n'));
      }
      await reload();
    } finally { setBusy(false); }
  };

  const refreshHealth = async () => {
    setBusy(true);
    try { await api.refreshHealth(); await reload(); } finally { setBusy(false); }
  };

  return (
    <main className="mx-auto max-w-7xl p-4 pb-72 space-y-4">
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
        onOnboard={() => { /* dialog added with onboarding UI task */ }}
      />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
        {views.map(v => (
          <HostCard
            key={v.host.name}
            v={v}
            selected={sel.has(v.host.name)}
            onToggle={() => setSel(s => toggle(s, v.host.name))}
            onOpenHistory={() => { /* history drawer added later */ }}
            lastLogLine={lastLine[v.host.name]}
          />
        ))}
        {views.length === 0 && (
          <p className="col-span-full rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            No hosts yet. Copy hosts.example.yaml → hosts.yaml, or use “+ Onboard host”.
          </p>
        )}
      </div>
    </main>
  );
}
