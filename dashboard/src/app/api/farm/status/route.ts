import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const ORGO_API_KEY = process.env.ORGO_API_KEY!;
const ORGO_VM_ID = process.env.ORGO_VM_CODEX_ID ?? '3ec3d7f3-a5da-4678-8b25-ce28b7aed829';
const ORGO_BASE = 'https://www.orgo.ai/api';

interface FarmStatus {
  updated_at: string;
  outstanding_tasks: number;
  active_run_capacity: number;
  runs_today: number;
  avg_run_duration_s: number;
  avg_task_duration_s: number;
  avg_speedup: number;
  success_rate: number;
  last_run: {
    run_id: string;
    wall_s: number;
    success: number;
    workers: number;
    speedup: number;
    finished_at: string;
  } | null;
}

async function getVmCredentials(): Promise<{ url: string; vncPassword: string }> {
  const res = await fetch(`${ORGO_BASE}/computers/${ORGO_VM_ID}`, {
    headers: { Authorization: `Bearer ${ORGO_API_KEY}` },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Orgo VM lookup failed: ${res.status}`);
  const vm = await res.json();
  return { url: vm.url as string, vncPassword: vm.vnc_password as string };
}

async function readStatusJson(vmUrl: string, vncPassword: string): Promise<FarmStatus> {
  const res = await fetch(`${vmUrl}/bash`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${vncPassword}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ command: 'cat /opt/claude-farm/status.json 2>/dev/null || echo NOT_FOUND' }),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`VM bash failed: ${res.status}`);
  const data = await res.json();
  const output: string = data.output ?? '';
  if (output.trim() === 'NOT_FOUND') throw new Error('status.json not found on VM');
  return JSON.parse(output) as FarmStatus;
}

export async function GET() {
  try {
    const { url, vncPassword } = await getVmCredentials();
    const status = await readStatusJson(url, vncPassword);
    return NextResponse.json({ ok: true, status });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
