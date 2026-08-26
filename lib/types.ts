export type CatalogueEntry = { name: string; detail: string };

export type CatalogueProduct = {
  store: string;
  handle: string;
  title: string;
  url: string;
  grams: number | null;
  skus: string[];
  blurb: string;
  /** 'ingredients' = botanical list, 'components' = constituent teas of a gift set */
  kind: 'ingredients' | 'components' | null;
  entries: CatalogueEntry[];
};

export type Catalogue = {
  generatedAt: string;
  stores: string[];
  productCount: number;
  products: CatalogueProduct[];
};

export type AliasEntry = {
  match: string;
  product: string | null;
  description: string;
  notes?: string[];
  unresolved?: string;
};

export type Supplier = { name: string; addressLines: string[] };

export type Aliases = {
  supplier: Supplier;
  entries: AliasEntry[];
  /** component name (as printed in a gift set) -> '<store>/<handle>' */
  componentAliases?: Record<string, string>;
};

/** One row of the uploaded spreadsheet, in file order. */
export type SheetLine = { line: number; description: string };

/** How confident we are that a job line was matched to the right product. */
export type Confidence = 'saved' | 'alias' | 'exact' | 'fuzzy' | 'unresolved' | 'none';

/** An ingredient list confirmed by hand and remembered for next time. */
export type SavedAlias = {
  /** goods description from the job, as typed on the entry */
  match: string;
  description: string;
  ingredients: string;
  components: string[];
  notes: string[];
  savedAt: string;
};

/** A group of identical job lines, resolved against the catalogue. */
export type ResolvedItem = {
  /** spreadsheet row numbers this product appears on */
  lines: number[];
  /** "Line 7" / "Lines 3-6" / "Lines 1-2, 9" */
  linesLabel: string;
  /** goods description exactly as it appears on the job */
  entryDescription: string;
  /** retail description printed on the declaration */
  description: string;
  /** rendered ingredient statement */
  ingredients: string;
  /** constituent teas, for gift sets and samplers */
  components: string[];
  /** allergen / origin lines printed under the ingredients */
  notes: string[];
  sourceUrl: string | null;
  confidence: Confidence;
  /** true when this came from the local overlay, so it can be forgotten */
  saved: boolean;
  /** why we matched it this way, shown in the review table */
  matchNote: string;
  /** alternative catalogue products, offered in the review UI */
  suggestions: { key: string; title: string; store: string }[];
};

export type AnalyseResult = {
  supplier: Supplier;
  totalLines: number;
  columnUsed: string;
  items: ResolvedItem[];
  catalogueGeneratedAt: string;
};

/** Payload the browser posts back to /api/generate after review. */
export type GenerateRequest = {
  consignmentLink: string;
  supplier: Supplier;
  totalLines: number;
  items: Pick<
    ResolvedItem,
    'linesLabel' | 'entryDescription' | 'description' | 'ingredients' | 'components' | 'notes'
  >[];
};
