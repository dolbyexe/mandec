import { NextResponse } from 'next/server';
import { ReadOnlyStoreError, forgetAlias, saveAlias } from '@/lib/localAliases';

export const runtime = 'nodejs';
export const maxDuration = 15;

const asString = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const asStringArray = (v: unknown) =>
  Array.isArray(v) ? v.map(asString).filter(Boolean) : ([] as string[]);

/** Remember a hand-confirmed ingredient list for this job line. */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 });
  }

  const raw = body as Record<string, unknown>;
  const match = asString(raw.match);
  const description = asString(raw.description);
  const ingredients = asString(raw.ingredients);

  if (!match) {
    return NextResponse.json({ error: 'Missing the job line description.' }, { status: 400 });
  }
  if (!description || !ingredients) {
    return NextResponse.json(
      { error: 'Fill in both the item description and the ingredients before saving.' },
      { status: 400 },
    );
  }

  try {
    const saved = await saveAlias({
      match,
      description,
      ingredients,
      notes: asStringArray(raw.notes),
    });
    return NextResponse.json({ saved });
  } catch (err) {
    if (err instanceof ReadOnlyStoreError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    console.error('save-alias failed', err);
    return NextResponse.json({ error: 'Could not save that entry.' }, { status: 500 });
  }
}

/** Forget a saved entry so the job line falls back to the catalogue. */
export async function DELETE(request: Request) {
  const match = new URL(request.url).searchParams.get('match')?.trim();
  if (!match) {
    return NextResponse.json({ error: 'Missing the job line description.' }, { status: 400 });
  }

  try {
    const removed = await forgetAlias(match);
    return NextResponse.json({ removed });
  } catch (err) {
    if (err instanceof ReadOnlyStoreError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    console.error('forget-alias failed', err);
    return NextResponse.json({ error: 'Could not remove that entry.' }, { status: 500 });
  }
}
