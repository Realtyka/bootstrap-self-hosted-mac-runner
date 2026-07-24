import { useEffect, useState } from 'react';
import { api, type HostView } from './lib/api';

export default function App() {
  const [hosts, setHosts] = useState<HostView[]>([]);
  useEffect(() => { void api.hosts().then(setHosts); }, []);
  return (
    <main className="mx-auto max-w-6xl p-6">
      <h1 className="text-xl font-semibold">mac-fleet</h1>
      <ul className="mt-4 space-y-2">
        {hosts.map(v => (
          <li key={v.host.name} className="rounded-lg border p-3">{v.host.name}</li>
        ))}
      </ul>
    </main>
  );
}
