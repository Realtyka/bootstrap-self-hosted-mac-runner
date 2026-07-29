import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, type OnboardStep } from '@/lib/api';
import { cn } from '@/lib/utils';

const STEP_LABEL: Record<OnboardStep['step'], string> = {
  connect: 'Connect (password)',
  'install-key': 'Install SSH key',
  sudoers: 'Enable passwordless sudo',
  verify: 'Verify key-only login + sudo -n',
};

export function OnboardDialog({ open, onOpenChange, onDone }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDone: () => void;
}) {
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [username, setUsername] = useState('administrator');
  const [password, setPassword] = useState('');
  const [steps, setSteps] = useState<OnboardStep[]>([]);
  const [running, setRunning] = useState(false);

  const reset = () => { setSteps([]); setPassword(''); setRunning(false); };

  const close = (o: boolean) => { if (!running) { reset(); onOpenChange(o); } };

  const submit = async () => {
    setRunning(true);
    setSteps([]);
    try {
      await api.onboard({ host, username, password, name }, s => setSteps(prev => [...prev, s]));
    } finally {
      setPassword('');
      setRunning(false);
      onDone();
    }
  };

  const allOk = steps.length === 4 && steps.every(s => s.ok);
  const failed = steps.some(s => !s.ok);

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Onboard host</DialogTitle>
          <DialogDescription>
            Installs your SSH key and passwordless sudo. The password is used once and never stored.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Input placeholder="Name (e.g. mac-09)" value={name} onChange={e => setName(e.target.value)} disabled={running} />
          <Input placeholder="IP address" value={host} onChange={e => setHost(e.target.value)} disabled={running} />
          <Input placeholder="Username" value={username} onChange={e => setUsername(e.target.value)} disabled={running} />
          <Input type="password" autoComplete="off" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} disabled={running} />
        </div>
        {steps.length > 0 && (
          <ul className="space-y-1 text-sm">
            {steps.map((s, i) => (
              <li key={i} className={cn('flex items-center gap-2', s.ok ? 'text-green-700' : 'text-red-700')}>
                <span>{s.ok ? '✓' : '✗'}</span>
                <span>{STEP_LABEL[s.step]}</span>
                {s.detail && <span className="truncate text-xs text-muted-foreground">{s.detail}</span>}
              </li>
            ))}
          </ul>
        )}
        {allOk && <p className="text-sm text-green-700">Host onboarded — card added to the grid.</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)} disabled={running}>Close</Button>
          <Button onClick={() => void submit()} disabled={running || !name || !host || !username || !password}>
            {running ? 'Onboarding…' : failed ? 'Retry' : 'Onboard'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
