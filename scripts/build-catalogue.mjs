#!/usr/bin/env node
/**
 * Rebuilds data/catalogue.json from the Vahdam storefronts.
 *
 * Every product page carries a "What's Inside" section. For a single tea that
 * section lists botanical ingredients (name + growing region); for a gift set it
 * lists the component teas (name + pack size). We scrape both shapes and record
 * which one we got, so the document builder can render them differently.
 *
 * Pages without that section (vahdam.in's wellness range uses a newer template)
 * fall back to the product description, but only when it states a single
 * botanical outright -- "made with 100% pure Lemon Balm leaves". Blends stay empty.
 *
 * Pure scraping + string parsing. Nothing here calls a model.
 *
 * The run is INCREMENTAL and resumable: it merges into whatever is already in
 * catalogue.json and skips products it has already captured. Shopify throttles
 * hard (HTTP 429), so a single pass rarely gets everything -- just run it again
 * and it will pick up the stragglers.
 *
 *   npm run catalogue           # top up anything missing
 *   npm run catalogue -- --force  # re-scrape every product from scratch
 */

import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'data', 'catalogue.json');

const STORES = ['www.vahdam.com', 'vahdam.in', 'www.vahdam.co.uk', 'www.vahdam.global'];

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 mandec-catalogue';
const CONCURRENCY = 2;
const RETRIES = 6;
const MIN_GAP_MS = 220; // floor between request starts, across all workers

const FORCE = process.argv.includes('--force');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Single global throttle so concurrent workers can't burst past the rate limit.
let nextSlot = 0;
async function throttle() {
  const now = Date.now();
  const slot = Math.max(now, nextSlot);
  nextSlot = slot + MIN_GAP_MS;
  if (slot > now) await sleep(slot - now);
}

async function get(url, { json = false } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    await throttle();
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** attempt;
        // Push every other worker's next slot out too -- the limit is per-site.
        nextSlot = Math.max(nextSlot, Date.now() + waitMs);
        await sleep(waitMs);
        lastErr = new Error('HTTP 429');
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return json ? await res.json() : await res.text();
    } catch (err) {
      lastErr = err;
      if (attempt === RETRIES - 1) break;
      await sleep(600 * 2 ** attempt);
    }
  }
  throw lastErr ?? new Error('request failed');
}

/** Run `worker` over `items`, at most CONCURRENCY in flight. */
async function pool(items, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        results[i] = await worker(items[i], i);
      } catch (err) {
        results[i] = { error: String(err?.message ?? err) };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

const decode = (s) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;|&#8217;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Pull the "What's Inside" panel out of a product page.
 * Returns { kind: 'ingredients' | 'components', entries: [{ name, detail }] }
 */
function parseWhatsInside(html) {
  const start = html.search(/<p class="subheading">\s*WHAT.{0,3}S INSIDE/i);
  if (start === -1) return null;

  const tail = html.slice(start);
  const end = tail.indexOf('</section>');
  const section = end === -1 ? tail.slice(0, 40000) : tail.slice(0, end);

  // The heading right after the subheading tells us which shape this is:
  // "Ingredients" for a single tea, "What's Inside" for a gift set / sampler.
  const headingMatch = section.match(/<h2[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i);
  const heading = headingMatch ? decode(headingMatch[1].replace(/<[^>]+>/g, '')) : '';
  const kind = /ingredient/i.test(heading) ? 'ingredients' : 'components';

  const entries = [];
  const blockRe =
    /<p class="what-head">([\s\S]*?)<\/p>(?:\s*<p class="what-subhead">([\s\S]*?)<\/p>)?/g;
  let m;
  while ((m = blockRe.exec(section))) {
    const name = decode(m[1].replace(/<[^>]+>/g, ''));
    const detail = m[2] ? decode(m[2].replace(/<[^>]+>/g, '')) : '';
    if (name && !name.startsWith('#shopify-section')) entries.push({ name, detail });
  }

  return entries.length ? { kind, entries } : null;
}

/**
 * Fallback for pages with no "What's Inside" panel. Trusts only an explicit
 * single-ingredient claim in the description:
 *   "...is a single-ingredient tea made with 100% pure Lemon Balm leaves..."
 *   "...is a 100% single-ingredient herbal infusion made from pure chamomile flowers..."
 * There is no growing region to record, so `detail` is left empty.
 */
function parseSingleIngredient(bodyHtml) {
  const text = decode((bodyHtml ?? '').replace(/<[^>]+>/g, ' '));
  const m = text.match(
    /single[- ]ingredient[^.]*?\bmade (?:with|from) (?:100%\s*)?pure\s+([A-Za-z][A-Za-z ]*?)\s+(?:leaves|leaf|flowers|flower|petals|roots?|seeds?|buds?|bark)\b/i,
  );
  if (!m) return null;
  const name = m[1].trim().replace(/\b[a-z]/g, (c) => c.toUpperCase());
  return { kind: 'ingredients', entries: [{ name, detail: '' }] };
}

async function listProducts(store) {
  let products = [];
  for (let page = 1; page <= 10; page++) {
    const data = await get(`https://${store}/products.json?limit=250&page=${page}`, { json: true });
    if (!data?.products?.length) break;
    products = products.concat(data.products);
    if (data.products.length < 250) break;
  }
  return products;
}

async function scrapeStore(store, have) {
  process.stdout.write(`\n${store.padEnd(20)} `);

  let listing;
  try {
    listing = await listProducts(store);
  } catch (err) {
    process.stdout.write(`listing failed (${err.message})`);
    return [];
  }
  process.stdout.write(`${String(listing.length).padStart(3)} listed`);

  const todo = FORCE
    ? listing
    : listing.filter((p) => !have.get(`${store}/${p.handle}`)?.entries?.length);
  process.stdout.write(`, ${String(todo.length).padStart(3)} to fetch`);

  if (!todo.length) return [];

  const rows = await pool(todo, async (p) => {
    const url = `https://${store}/products/${p.handle}`;
    const html = await get(url);
    const inside = parseWhatsInside(html) ?? parseSingleIngredient(p.body_html);
    const grams = p.variants?.map((v) => v.grams).find((g) => g > 0) ?? null;

    return {
      store,
      handle: p.handle,
      title: p.title,
      url,
      grams,
      skus: (p.variants ?? []).map((v) => v.sku).filter(Boolean),
      blurb: decode((p.body_html ?? '').replace(/<[^>]+>/g, ' ')).slice(0, 400),
      kind: inside?.kind ?? null,
      entries: inside?.entries ?? [],
    };
  });

  const ok = rows.filter((r) => !r.error);
  const failed = rows.filter((r) => r.error);
  const withData = ok.filter((r) => r.entries.length);
  process.stdout.write(` -> ${withData.length} with panel`);
  if (failed.length) {
    const reasons = [...new Set(failed.map((r) => r.error))].slice(0, 2).join('; ');
    process.stdout.write(`, ${failed.length} failed (${reasons})`);
  }
  return ok;
}

async function loadExisting() {
  if (FORCE) return new Map();
  try {
    const json = JSON.parse(await readFile(OUT, 'utf8'));
    return new Map((json.products ?? []).map((p) => [`${p.store}/${p.handle}`, p]));
  } catch {
    return new Map();
  }
}

async function main() {
  const have = await loadExisting();
  if (have.size) console.log(`Resuming from ${have.size} products already in catalogue.json`);

  for (const store of STORES) {
    const rows = await scrapeStore(store, have);
    for (const row of rows) have.set(`${row.store}/${row.handle}`, row);
    // Persist after every store so a throttled run never loses earlier work.
    await save(have);
  }

  const products = [...have.values()];
  const withPanel = products.filter((p) => p.entries?.length).length;
  console.log(
    `\n\n${products.length} products in catalogue, ${withPanel} with a What's Inside panel` +
      `${withPanel < products.length ? '  (re-run to top up the rest)' : ''}`,
  );
}

async function save(have) {
  const products = [...have.values()].sort((a, b) => a.title.localeCompare(b.title));
  await writeFile(
    OUT,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        stores: STORES,
        productCount: products.length,
        products,
      },
      null,
      1,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
