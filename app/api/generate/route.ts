import { NextResponse } from 'next/server';
import { buildDeclaration, declarationFilename } from '@/lib/docx';
import type { Confidence, GenerateRequest } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 30;

const asString = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const asStringArray = (v: unknown) =>
  Array.isArray(v) ? v.map(asString).filter(Boolean) : ([] as string[]);

const CONFIDENCES: Confidence[] = ['saved', 'alias', 'exact', 'fuzzy', 'unresolved', 'none'];
/** Anything unrecognised falls back to 'none', so the doc never claims a match it cannot back up. */
const asConfidence = (v: unknown): Confidence =>
  CONFIDENCES.includes(v as Confidence) ? (v as Confidence) : 'none';

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 });
  }

  const raw = body as Partial<GenerateRequest>;

  const consignmentLink = asString(raw.consignmentLink);
  if (!consignmentLink) {
    return NextResponse.json({ error: 'Enter a consignment link.' }, { status: 400 });
  }

  const supplierName = asString(raw.supplier?.name);
  if (!supplierName) {
    return NextResponse.json({ error: 'Enter the supplier name.' }, { status: 400 });
  }
  const addressLines = asStringArray(raw.supplier?.addressLines);
  if (!addressLines.length) {
    return NextResponse.json(
      { error: 'The letterhead must include the company address.' },
      { status: 400 },
    );
  }

  const items = (Array.isArray(raw.items) ? raw.items : [])
    .map((item) => ({
      linesLabel: asString(item?.linesLabel),
      entryDescription: asString(item?.entryDescription),
      description: asString(item?.description),
      ingredients: asString(item?.ingredients),
      components: asStringArray(item?.components),
      notes: asStringArray(item?.notes),
      confidence: asConfidence(item?.confidence),
    }))
    .filter((item) => item.entryDescription);

  if (!items.length) {
    return NextResponse.json({ error: 'There are no items to declare.' }, { status: 400 });
  }

  const totalLines =
    typeof raw.totalLines === 'number' && raw.totalLines > 0 ? raw.totalLines : items.length;

  try {
    const buffer = await buildDeclaration({
      consignmentLink,
      supplier: { name: supplierName, addressLines },
      totalLines,
      items,
    });

    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type':
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename="${declarationFilename(consignmentLink)}"`,
        'Content-Length': String(buffer.length),
      },
    });
  } catch (err) {
    console.error('generate failed', err);
    return NextResponse.json({ error: 'Could not build the document.' }, { status: 500 });
  }
}
