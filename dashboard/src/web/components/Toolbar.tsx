import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { JobSource } from '@/lib/api';

export function Toolbar({ selectedCount, eligibleCount, source, busy, onSourceChange, onBootstrap, onLaunchAgent, onRefresh, onSelectAll, onClear, onOnboard }: {
  selectedCount: number;
  eligibleCount: number;
  source: JobSource;
  busy: boolean;
  onSourceChange: (s: JobSource) => void;
  onBootstrap: () => void;
  onLaunchAgent: () => void;
  onRefresh: () => void;
  onSelectAll: () => void;
  onClear: () => void;
  onOnboard: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2">
      <span className="font-semibold text-sm">mac-fleet</span>
      <Badge variant="outline">{selectedCount} selected</Badge>
      <Button variant="ghost" size="sm" onClick={onSelectAll}>all</Button>
      <Button variant="ghost" size="sm" onClick={onClear}>none</Button>
      <div className="flex-1" />
      <Tabs value={source} onValueChange={v => onSourceChange(v as JobSource)}>
        <TabsList className="h-8">
          <TabsTrigger value="github" className="text-xs">GitHub main</TabsTrigger>
          <TabsTrigger value="local" className="text-xs">Local copy</TabsTrigger>
        </TabsList>
      </Tabs>
      <Button size="sm" disabled={busy || eligibleCount === 0} onClick={onBootstrap}>
        ▶ Bootstrap{eligibleCount > 0 ? ` (${eligibleCount})` : ''}
      </Button>
      <Button size="sm" variant="secondary" disabled={busy || eligibleCount === 0} onClick={onLaunchAgent}>
        LaunchAgent
      </Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={onRefresh}>↻ Health</Button>
      <Button size="sm" variant="outline" onClick={onOnboard}>+ Onboard host</Button>
    </div>
  );
}
