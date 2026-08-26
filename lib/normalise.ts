/**
 * String normalisation used for matching job descriptions to catalogue products.
 * Deterministic, no model involved: exact keys first, token overlap as a fallback
 * that only ever produces a *suggestion* for a human to confirm.
 */

/** Destination-market suffixes that appear on job lines but never on the product. */
const MARKET_SUFFIXES = new Set(['AUS', 'AU', 'NZ', 'US', 'USA', 'UK', 'IN', 'EU', 'CA']);

/**
 * Packaging vocabulary. These words carry no product identity -- every tea has
 * them -- so they are dropped before scoring. Numbers are deliberately KEPT:
 * "100 count" vs "30 count" is a real distinction between two catalogue rows.
 */
const NOISE = new Set([
  'TEA', 'TEAS', 'TB', 'TBS', 'TEABAG', 'TEABAGS', 'BAG', 'BAGS', 'COUNT', 'CT',
  'PYRAMID', 'LOOSE', 'LEAF', 'LONG', 'PACK', 'PACKS', 'PK', 'BOX', 'TIN', 'CADDY',
  'POUCH', 'RETAIL', 'GIFT', 'SET', 'SETS', 'VARIANT', 'VARIANTS', 'VARIETY',
  'FLAVOR', 'FLAVORS', 'FLAVOUR', 'FLAVOURS', 'G', 'GM', 'GMS', 'GRAM', 'GRAMS',
  'KG', 'OZ', 'ML', 'X', 'THE', 'AND', 'OF', 'WITH', 'FREE', 'MBZ',
]);

/** Uppercase, strip punctuation, drop the market suffix. Used for exact keys. */
export function normKey(input: string): string {
  const cleaned = input
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();

  const parts = cleaned.split(' ').filter(Boolean);
  while (parts.length > 1 && MARKET_SUFFIXES.has(parts[parts.length - 1])) parts.pop();
  return parts.join(' ');
}

/**
 * Crude suffix stripper so grammatical variants of the same word collide.
 * Vahdam name the same tea "Double Spice" in one place and "Double Spiced" in
 * another; without this they score as unrelated words.
 *
 * Order matters -- plural, then past tense, then trailing vowel -- so that
 * SPICE and SPICED both land on SPIC.
 */
function stem(token: string): string {
  if (/^\d+$/.test(token)) return token;

  let t = token;
  if (t.length > 3 && t.endsWith('S') && !t.endsWith('SS')) t = t.slice(0, -1);
  if (t.length > 4 && t.endsWith('ED')) t = t.slice(0, -2);
  if (t.length > 3 && t.endsWith('E')) t = t.slice(0, -1);
  return t.length >= 3 ? t : token;
}

/**
 * Content tokens for fuzzy scoring. Splits letter/digit runs apart so "100TB"
 * becomes "100" + "TB", drops packaging noise, then stems what is left.
 */
export function tokens(input: string): string[] {
  const key = normKey(input);
  const split: string[] = [];
  for (const part of key.split(' ')) {
    const pieces = part.match(/\d+|[A-Z]+/g);
    if (pieces) split.push(...pieces);
  }
  return split
    .filter((t) => !NOISE.has(t) && !MARKET_SUFFIXES.has(t))
    .map(stem);
}

/**
 * Sørensen–Dice coefficient over the two token sets, 0..1.
 * Symmetric, cheap, and stable -- the same inputs always give the same score.
 */
export function similarity(a: string, b: string): number {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;

  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return (2 * shared) / (A.size + B.size);
}

/** Collapse [1,2,3,7,9,10] into "Lines 1-3, 7, 9-10". */
export function formatLineLabel(lines: number[]): string {
  const sorted = [...lines].sort((a, b) => a - b);
  const runs: string[] = [];

  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i <= sorted.length; i++) {
    const n = sorted[i];
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    runs.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = n;
    prev = n;
  }

  return `${sorted.length === 1 ? 'Line' : 'Lines'} ${runs.join(', ')}`;
}
