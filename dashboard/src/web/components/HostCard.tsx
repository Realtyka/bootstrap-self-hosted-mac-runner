import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import type { HostView } from '@/lib/api';

export type CardTone = 'healthy' | 'running' | 'attention' | 'offline' | 'unknown';

export function cardTone(v: HostView): CardTone {
  if (v.runningJob) return 'running';
  if (!v.health) return 'unknown';
  if (!v.health.reachable) return 'offline';
  if (!v.health.sudoOk || v.health.drift.length > 0) return 'attention';
  return 'healthy';
}

const toneBorder: Record<CardTone, string> = {
  healthy: 'border-border',
  running: 'border-blue-500',
  attention: 'border-amber-500',
  offline: 'border-red-500',
  unknown: 'border-border border-dashed',
};

function ago(ts: number): string {
  const m = Math.round((Date.now() - ts) / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

function VersionLine({ label, value, drift }: { label: string; value: string | null; drift?: string }) {
  // drift string looks like "xcode: want 26.0, got 16.4" — surface the expected version
  const want = drift?.match(/want ([^,]+)/)?.[1];
  return (
    <span className={cn('whitespace-nowrap', drift ? 'text-red-600 font-medium' : 'text-muted-foreground')}>
      {label} {value ?? '—'}{drift ? ` ✗ (want ${want})` : ' ✓'}
    </span>
  );
}

export function HostCard({ v, selected, onToggle, onOpenHistory, lastLogLine }: {
  v: HostView;
  selected: boolean;
  onToggle: () => void;
  onOpenHistory: () => void;
  lastLogLine?: string;
}) {
  const tone = cardTone(v);
  const h = v.health;
  const driftFor = (key: string) => h?.drift.find(d => d.startsWith(key));

  return (
    <Card className={cn('gap-2 py-4 cursor-pointer transition-shadow hover:shadow-md', toneBorder[tone])} onClick={onOpenHistory}>
      <CardHeader className="px-4">
        <CardTitle className="flex items-center justify-between text-sm">
          <span className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
            <Checkbox checked={selected} onCheckedChange={onToggle} disabled={tone === 'running'} />
            {v.host.name}
          </span>
          {tone === 'healthy' && <Badge className="bg-green-100 text-green-700 border-green-200" variant="outline">healthy</Badge>}
          {tone === 'running' && <Badge className="bg-blue-100 text-blue-700 border-blue-200" variant="outline">{v.runningJob!.action} · {ago(v.runningJob!.startedAt)}</Badge>}
          {tone === 'attention' && <Badge className="bg-amber-100 text-amber-700 border-amber-200" variant="outline">needs attention</Badge>}
          {tone === 'offline' && <Badge variant="destructive">offline</Badge>}
          {tone === 'unknown' && <Badge variant="outline">never probed</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 text-xs space-y-1">
        {tone === 'offline' && (
          <p className="text-muted-foreground">unreachable · checked {h ? ago(h.checkedAt) : '—'}</p>
        )}
        {h && h.reachable && (
          <>
            <p className="flex flex-wrap gap-x-3 gap-y-0.5">
              <VersionLine label="Xcode" value={h.versions.xcode} drift={driftFor('xcode')} />
              <VersionLine label="Node" value={h.versions.node} drift={driftFor('node')} />
              <VersionLine label="Ruby" value={h.versions.ruby} drift={driftFor('ruby')} />
              <VersionLine label="Pods" value={h.versions.cocoapods} drift={driftFor('cocoapods')} />
            </p>
            <p className="flex flex-wrap gap-x-3 text-muted-foreground">
              <span>disk {h.diskFreeGb ?? '—'}G</span>
              <span className={cn(!h.sudoOk && 'text-red-600 font-medium')}>sudo {h.sudoOk ? '✓' : '✗'}</span>
              <span>runner {h.runnerListening ? '●' : '○'}</span>
              <span className={cn(!h.simRuntimeOk && 'text-red-600 font-medium')}>sim {h.simRuntimeOk ? '✓' : '✗'}</span>
              <span>checked {ago(h.checkedAt)}</span>
            </p>
          </>
        )}
        {v.runningJob && lastLogLine && (
          <p className="rounded bg-zinc-950 px-2 py-1 font-mono text-[10px] text-zinc-400 truncate">{lastLogLine}</p>
        )}
      </CardContent>
    </Card>
  );
}
