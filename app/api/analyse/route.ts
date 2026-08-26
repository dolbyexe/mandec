import { NextResponse } from 'next/server';
import { ParseError, parseSheet } from '@/lib/parse';
import { catalogueGeneratedAt, resolveLines, supplier } from '@/lib/catalogue';
import type { AnalyseResult } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 30;

const MAX_BYTES = 5 * 1024 * 1024;

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Expected a file upload.' }, { status: 400 });
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'No spreadsheet was attached.' }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ error: 'That file is empty.' }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `That file is ${(file.size / 1e6).toFixed(1)} MB. The limit is 5 MB.` },
      { status: 413 },
    );
  }

  try {
    const { lines, columnUsed } = parseSheet(await file.arrayBuffer());
    const items = resolveLines(lines);

    const result: AnalyseResult = {
      supplier,
      totalLines: lines.length,
      columnUsed,
      items,
      catalogueGeneratedAt,
    };
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ParseError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error('analyse failed', err);
    return NextResponse.json({ error: 'Could not read that spreadsheet.' }, { status: 500 });
  }
}
