import monitor from '@/data/capability-monitor.json';
import { Badge } from '@/components/ui/badge';

export const dynamic = 'force-static';

type CapabilityStatus = 'ok' | 'warn' | 'fail' | 'blocked' | 'pending_wiring';

type Capability = {
  id: string;
  label: string;
  userCapability: string;
  authority: string;
  sentinels: string[];
  currentStatus: CapabilityStatus;
  freshnessTarget: string;
  warnWhen: string;
  failWhen: string;
  renewalPath: string;
  proofRequired: string;
};

const statusLabels: Record<CapabilityStatus, string> = {
  ok: 'OK',
  warn: 'Warn',
  fail: 'Fail',
  blocked: 'Blocked',
  pending_wiring: 'Pending wiring',
};

const statusClasses: Record<CapabilityStatus, string> = {
  ok: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  warn: 'border-amber-200 bg-amber-50 text-amber-700',
  fail: 'border-red-200 bg-red-50 text-red-700',
  blocked: 'border-slate-300 bg-slate-100 text-slate-700',
  pending_wiring: 'border-blue-200 bg-blue-50 text-blue-700',
};

export default function CortexCapabilitiesPage() {
  const capabilities = monitor.capabilities as Capability[];
  const pendingCount = capabilities.filter((item) => item.currentStatus === 'pending_wiring').length;

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">Capability Monitor</h1>
          <Badge variant="secondary">STACK-2</Badge>
          <Badge variant="outline">v{monitor.version}</Badge>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">{monitor.purpose}</p>
      </header>

      <section className="grid gap-3 md:grid-cols-3">
        <div className="rounded-lg border bg-card p-4">
          <p className="text-xs font-medium uppercase text-muted-foreground">Capabilities</p>
          <p className="mt-2 text-2xl font-semibold">{capabilities.length}</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <p className="text-xs font-medium uppercase text-muted-foreground">Pending Wiring</p>
          <p className="mt-2 text-2xl font-semibold">{pendingCount}</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <p className="text-xs font-medium uppercase text-muted-foreground">Event Contract</p>
          <p className="mt-2 font-mono text-sm">{monitor.eventName}</p>
        </div>
      </section>

      <section className="rounded-lg border bg-card">
        <div className="border-b px-4 py-3">
          <h2 className="text-sm font-semibold">Greg-Facing Readiness</h2>
          <p className="mt-1 text-xs text-muted-foreground">{monitor.defaultCadence}</p>
        </div>
        <div className="divide-y">
          {capabilities.map((capability) => (
            <article key={capability.id} className="grid gap-4 p-4 lg:grid-cols-[minmax(220px,0.8fr)_minmax(0,1.4fr)_minmax(280px,1fr)]">
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-semibold">{capability.label}</h3>
                  <span
                    className={`rounded-full border px-2 py-0.5 text-xs font-medium ${statusClasses[capability.currentStatus]}`}
                  >
                    {statusLabels[capability.currentStatus]}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground">{capability.userCapability}</p>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <p className="text-xs font-medium uppercase text-muted-foreground">Authority</p>
                  <p className="mt-1 text-sm">{capability.authority}</p>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase text-muted-foreground">Freshness</p>
                  <p className="mt-1 text-sm">{capability.freshnessTarget}</p>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase text-muted-foreground">Warn</p>
                  <p className="mt-1 text-sm text-muted-foreground">{capability.warnWhen}</p>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase text-muted-foreground">Fail</p>
                  <p className="mt-1 text-sm text-muted-foreground">{capability.failWhen}</p>
                </div>
              </div>

              <div className="space-y-3">
                <div>
                  <p className="text-xs font-medium uppercase text-muted-foreground">Sentinels</p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {capability.sentinels.map((sentinel) => (
                      <Badge key={sentinel} variant="outline" className="font-mono text-[11px] font-normal">
                        {sentinel}
                      </Badge>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase text-muted-foreground">Renewal Path</p>
                  <p className="mt-1 text-sm">{capability.renewalPath}</p>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase text-muted-foreground">Proof Required</p>
                  <p className="mt-1 text-sm text-muted-foreground">{capability.proofRequired}</p>
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
