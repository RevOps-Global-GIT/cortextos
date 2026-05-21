import { revalidatePath } from 'next/cache';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function POST() {
  revalidatePath('/');
  return NextResponse.json({ revalidated: true, at: new Date().toISOString() });
}

export async function GET() {
  revalidatePath('/');
  return NextResponse.json({ revalidated: true, at: new Date().toISOString() });
}
