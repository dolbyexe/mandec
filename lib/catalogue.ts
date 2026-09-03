import catalogueJson from '@/data/catalogue.json';
import aliasesJson from '@/data/aliases.json';
import { formatLineLabel, normKey, similarity } from './normalise';
import type {
  AliasEntry,
  Aliases,
  Catalogue,
  CatalogueProduct,
  Confidence,
  ResolvedItem,
  SavedAlias,
  SheetLine,
  Supplier,
} from './types';

const catalogue = catalogueJson as unknown as Catalogue;
const aliases = aliasesJson as unknown as Aliases;

/** Fuzzy score below which we refuse to guess and ask the user instead. */
const SUGGEST_THRESHOLD = 0.55;
/** Fuzzy score below which a gift-set component is treated as unresolved. */
const COMPONENT_THRESHOLD = 0.5;

const byKey = new Map<string, CatalogueProduct>();
const byTitle = new Map<string, CatalogueProduct>();
for (const p of catalogue.products) {
  byKey.set(`${p.store}/${p.handle}`, p);
  const t = normKey(p.title);
  // First store listed wins, so www.vahdam.com takes precedence over the mirrors.
  if (!byTitle.has(t)) byTitle.set(t, p);
}

const aliasByKey = new Map<string, AliasEntry>();
for (const a of aliases.entries) aliasByKey.set(normKey(a.match), a);

/** Curated component-name -> catalogue-key overrides, for gift-set contents. */
const componentAliases = new Map<string, string>(
  Object.entries(aliases.componentAliases ?? {}).map(([name, key]) => [normKey(name), key]),
);

export const supplier: Supplier = aliases.supplier;
export const catalogueGeneratedAt = catalogue.generatedAt;

/** Products that actually carry a botanical ingredient list. */
const ingredientProducts = catalogue.products.filter(
  (p) => p.kind === 'ingredients' && p.entries.length,
);

function renderIngredients(p: CatalogueProduct): string {
  return p.entries.map((e) => e.name).join(', ') + '.';
}

/** Scores this close to the top are treated as a tie and broken on quality. */
const TIE_BAND = 0.06;

/**
 * Weight added to candidates from the same storefront as the parent product.
 * Size and count tokens ("100 Count", "3.53 oz") dilute the score of the very
 * products we want, so without this a bare gift-set component can land on a
 * mirror-site listing whose ingredient panel says "CTC" where the home store
 * says "Black Tea". Big enough to beat a size-token penalty, small enough that a
 * genuinely better match on another store still wins.
 */
const HOME_STORE_BONUS = 0.15;

/**
 * Best catalogue match for a free-text name, or null.
 * Prefers an exact title match, then the highest token-overlap score.
 *
 * Near-ties are broken on data quality rather than score alone. The mirror
 * storefronts list the same teas with truncated ingredient panels, so a match on
 * vahdam.co.uk can silently drop half a blend; prefer the store the parent
 * product came from, then the fullest ingredient list.
 */
function bestMatch(
  name: string,
  pool: CatalogueProduct[],
  threshold: number,
  preferStore?: string,
): { product: CatalogueProduct; score: number; exact: boolean } | null {
  const exact = byTitle.get(normKey(name));
  if (exact && pool.includes(exact)) return { product: exact, score: 1, exact: true };

  // Threshold is applied to the raw score; the bonus only orders what qualifies.
  const scored = pool
    .map((product) => {
      const score = similarity(name, product.title);
      const home = preferStore ? product.store === preferStore : false;
      return { product, score, ranked: score + (home ? HOME_STORE_BONUS : 0) };
    })
    .filter((c) => c.score >= threshold);
  if (!scored.length) return null;

  const topRanked = Math.max(...scored.map((c) => c.ranked));
  const contenders = scored.filter((c) => c.ranked >= topRanked - TIE_BAND);

  contenders.sort((a, b) => {
    if (a.ranked !== b.ranked) return b.ranked - a.ranked;
    if (a.product.entries.length !== b.product.entries.length) {
      return b.product.entries.length - a.product.entries.length;
    }
    // Shorter titles carry less packaging noise, so they are the tighter match.
    return a.product.title.length - b.product.title.length;
  });

  const winner = contenders[0];
  return { product: winner.product, score: winner.score, exact: false };
}

/**
 * For a gift set, roll the component teas up into one botanical list.
 * Union in first-seen order so the result is stable run to run.
 *
 * Component names inside a gift set often use Vahdam's older naming ("Saffron
 * Chai Spiced Black Tea" for what the catalogue calls "Saffron Premium Masala
 * Chai Tea"). Those are resolved from the curated map rather than guessed at.
 */
function consolidate(
  components: string[],
  preferStore: string,
): { ingredients: string; unmatched: string[] } {
  const seen = new Map<string, string>();
  const unmatched: string[] = [];

  for (const name of components) {
    const curated = componentAliases.get(normKey(name));
    const product = curated
      ? byKey.get(curated)
      : bestMatch(name, ingredientProducts, COMPONENT_THRESHOLD, preferStore)?.product;

    if (!product?.entries.length) {
      unmatched.push(name);
      continue;
    }
    for (const e of product.entries) {
      const k = normKey(e.name);
      if (!seen.has(k)) seen.set(k, e.name);
    }
  }

  return { ingredients: [...seen.values()].join(', ') + '.', unmatched };
}

function suggestionsFor(description: string) {
  return catalogue.products
    .filter((p) => p.entries.length)
    .map((p) => ({ p, score: similarity(description, p.title) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map(({ p }) => ({ key: `${p.store}/${p.handle}`, title: p.title, store: p.store }));
}

/** Build the declaration body for one product. */
function describe(p: CatalogueProduct) {
  if (p.kind === 'components') {
    const rolled = consolidate(
      p.entries.map((e) => e.name),
      p.store,
    );
    const notes = rolled.unmatched.length
      ? [
          `NOTE: ingredients for ${rolled.unmatched.join(', ')} are not on file and must be confirmed.`,
        ]
      : [];
    return { ingredients: rolled.ingredients, notes };
  }

  return { ingredients: renderIngredients(p), notes: [] as string[] };
}

/**
 * Group identical job lines, then resolve each group against the catalogue.
 * `saved` is the local overlay of hand-confirmed entries; it outranks everything
 * else, because a human has already looked at that exact job line.
 */
export function resolveLines(lines: SheetLine[], saved: SavedAlias[] = []): ResolvedItem[] {
  const savedByKey = new Map(saved.map((s) => [normKey(s.match), s]));
  const groups = new Map<string, { description: string; lines: number[] }>();
  for (const row of lines) {
    const key = normKey(row.description);
    if (!key) continue;
    const g = groups.get(key);
    if (g) g.lines.push(row.line);
    else groups.set(key, { description: row.description, lines: [row.line] });
  }

  return [...groups.values()]
    .sort((a, b) => a.lines[0] - b.lines[0])
    .map((g) => resolveOne(g.description, g.lines, savedByKey.get(normKey(g.description))));
}

function resolveOne(
  entryDescription: string,
  lines: number[],
  saved?: SavedAlias,
): ResolvedItem {
  const base = {
    lines,
    linesLabel: formatLineLabel(lines),
    entryDescription,
    suggestions: suggestionsFor(entryDescription),
    saved: false,
  };

  // 0. Confirmed by hand last time this job line came through.
  if (saved) {
    return {
      ...base,
      saved: true,
      description: saved.description,
      ingredients: saved.ingredients,
      notes: saved.notes,
      sourceUrl: null,
      confidence: 'saved',
      matchNote:
        `Confirmed by hand on ${new Date(saved.savedAt).toLocaleDateString('en-AU')} ` +
        'and remembered locally. Use Forget to fall back to the catalogue.',
    };
  }

  const alias = aliasByKey.get(normKey(entryDescription));

  // 1. Curated alias, explicitly marked as having no published product.
  if (alias?.unresolved) {
    return {
      ...base,
      description: alias.description,
      ingredients: '',
      notes: alias.notes ?? [],
      sourceUrl: null,
      confidence: 'unresolved',
      matchNote: alias.unresolved,
    };
  }

  // 2. Curated alias pointing at a catalogue product.
  if (alias?.product) {
    const p = byKey.get(alias.product);
    if (p) {
      const built = describe(p);
      return {
        ...base,
        description: alias.description || p.title,
        ingredients: built.ingredients,
        notes: [...(alias.notes ?? []), ...built.notes],
        sourceUrl: p.url,
        confidence: 'alias',
        matchNote: `Mapped by alias to ${p.title} (${p.store}).`,
      };
    }
  }

  // 3. Exact title match, then a fuzzy suggestion the user must confirm.
  const hit = bestMatch(
    entryDescription,
    catalogue.products.filter((p) => p.entries.length),
    SUGGEST_THRESHOLD,
  );

  if (hit) {
    const built = describe(hit.product);
    return {
      ...base,
      description: hit.product.title,
      ingredients: built.ingredients,
      notes: built.notes,
      sourceUrl: hit.product.url,
      confidence: hit.exact ? 'exact' : 'fuzzy',
      matchNote: hit.exact
        ? `Exact title match to ${hit.product.title} (${hit.product.store}).`
        : `Closest match is ${hit.product.title} (${hit.product.store}), ` +
          `${Math.round(hit.score * 100)}% token overlap. Confirm before issuing.`,
    };
  }

  // 4. Nothing close enough to guess at.
  return {
    ...base,
    description: '',
    ingredients: '',
    notes: [],
    sourceUrl: null,
    confidence: 'none',
    matchNote: 'No catalogue product matched this description. Enter the details manually.',
  };
}

/** Look up one product by '<store>/<handle>' -- used when the user overrides a match. */
export function productDetail(key: string) {
  const p = byKey.get(key);
  if (!p) return null;
  const built = describe(p);
  return {
    description: p.title,
    ingredients: built.ingredients,
    notes: built.notes,
    sourceUrl: p.url,
  };
}

export const confidenceRank: Record<Confidence, number> = {
  none: 0,
  unresolved: 1,
  fuzzy: 2,
  exact: 3,
  alias: 4,
  saved: 5,
};
