import matrix from '@/data/source-authority-matrix.json';
import { Badge } from '@/components/ui/badge';

export const dynamic = 'force-static';

type SourceDomain = {
  domain: string;
  authoritativeSource: string;
  mirrorSource: string;
  allowedFallback: string;
  forbiddenSources: string[];
  stalenessThresholdMinutes: number;
};

function formatThreshold(minutes: number) {
  if (minutes >= 1440) return `${Math.round(minutes / 1440)}d`;
  if (minutes >= 60) return `${Math.round(minutes / 60)}h`;
  return `${minutes}m`;
}

export default function CortexSourcesPage() {
  const domains = matrix.domains as SourceDomain[];

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">Source Authority</h1>
          <Badge variant="secondary">mode: {matrix.enforcementMode}</Badge>
          <Badge variant="outline">v{matrix.version}</Badge>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">{matrix.purpose}</p>
      </header>

      <section className="grid gap-3 md:grid-cols-3">
        <div className="rounded-lg border bg-card p-4">
          <p className="text-xs font-medium uppercase text-muted-foreground">Domains</p>
          <p className="mt-2 text-2xl font-semibold">{domains.length}</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <p className="text-xs font-medium uppercase text-muted-foreground">Guardrail Event</p>
          <p className="mt-2 font-mono text-sm">{matrix.guardrailEvent}</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <p className="text-xs font-medium uppercase text-muted-foreground">Monitor Entries</p>
          <p className="mt-2 text-2xl font-semibold">{matrix.monitors.length}</p>
        </div>
      </section>

      <section className="rounded-lg border bg-card">
        <div className="border-b px-4 py-3">
          <h2 className="text-sm font-semibold">Authority Matrix</h2>
          <p className="mt-1 text-xs text-muted-foreground">{matrix.minimumRule}</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1120px] text-left text-sm">
            <thead className="border-b bg-muted/40 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="w-[14%] px-4 py-3 font-medium">Domain</th>
                <th className="w-[24%] px-4 py-3 font-medium">Authority</th>
                <th className="w-[20%] px-4 py-3 font-medium">Mirror</th>
                <th className="w-[18%] px-4 py-3 font-medium">Fallback</th>
                <th className="w-[18%] px-4 py-3 font-medium">Forbidden</th>
                <th className="w-[6%] px-4 py-3 font-medium">Fresh</th>
              </tr>
            </thead>
            <tbody>
              {domains.map((row) => (
                <tr key={row.domain} className="border-b align-top last:border-0">
                  <td className="px-4 py-3 font-medium">{row.domain}</td>
                  <td className="px-4 py-3 text-muted-foreground">{row.authoritativeSource}</td>
                  <td className="px-4 py-3 text-muted-foreground">{row.mirrorSource}</td>
                  <td className="px-4 py-3 text-muted-foreground">{row.allowedFallback}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {row.forbiddenSources.map((source) => (
                        <Badge key={source} variant="outline" className="font-normal">
                          {source}
                        </Badge>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                    {formatThreshold(row.stalenessThresholdMinutes)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
