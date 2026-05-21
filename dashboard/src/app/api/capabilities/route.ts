import { NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';

export const dynamic = 'force-dynamic';

const MONITOR_PATH = path.resolve(process.cwd(), 'src/data/capability-monitor.json');

export async function GET() {
  try {
    const raw = fs.readFileSync(MONITOR_PATH, 'utf8');
    const data = JSON.parse(raw);
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: 'capability-monitor.json not found' }, { status: 404 });
  }
}
