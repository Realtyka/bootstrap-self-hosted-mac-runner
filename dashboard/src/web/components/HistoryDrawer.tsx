import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, type Job } from '@/lib/api';

function fmtDuration(j: Job): string {
  if (!j.finishedAt) return '—';
  const s = Math.round((j.finishedAt - j.startedAt) / 1000);
  return s < 90 ? `${s}s` : `${Math.round(s / 60)}m`;
}

export function HistoryDrawer({ host, onOpenChange }: {
  host: string | null;
  onOpenChange: (o: boolean) => void;
}) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [log, setLog] = useState<{ id: string; text: string } | null>(null);

  useEffect(() => {
    setLog(null);
    if (host) void api.hostJobs(host).then(setJobs);
  }, [host]);

  return (
    <Dialog open={host !== null} onOpenChange={o => { if (!o) setLog(null); onOpenChange(o); }}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{host} — run history</DialogTitle>
        </DialogHeader>
        {jobs.length === 0 && <p className="text-sm text-muted-foreground">No runs yet.</p>}
        {jobs.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Action</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Result</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.map(j => (
                <TableRow key={j.id} className="cursor-pointer" onClick={() => void api.jobLog(j.id).then(text => setLog({ id: j.id, text }))}>
                  <TableCell>{j.action}</TableCell>
                  <TableCell>{j.source}</TableCell>
                  <TableCell>{new Date(j.startedAt).toLocaleString()}</TableCell>
                  <TableCell>{fmtDuration(j)}</TableCell>
                  <TableCell>
                    {j.state === 'passed' && <Badge className="bg-green-100 text-green-700 border-green-200" variant="outline">pass</Badge>}
                    {j.state === 'failed' && <Badge variant="destructive">fail ({j.exitCode})</Badge>}
                    {j.state === 'killed' && <Badge variant="destructive">killed</Badge>}
                    {['starting', 'running', 'stalled'].includes(j.state) && <Badge className="bg-blue-100 text-blue-700 border-blue-200" variant="outline">{j.state}</Badge>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {log && (
          <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-md bg-zinc-950 p-3 font-mono text-xs text-zinc-300">
            {log.text || '— empty log —'}
          </pre>
        )}
      </DialogContent>
    </Dialog>
  );
}
