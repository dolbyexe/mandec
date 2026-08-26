# Manufacturer's Declaration Generator

Upload an xClear job report, confirm the ingredient breakdowns, download a Word
document ready for the supplier to sign.

Built for the Vahdam tea consignments, but the letterhead is editable and the
product catalogue is data, not code.

## No model in the request path

Everything at request time is deterministic:

| Step | How |
| --- | --- |
| Read the spreadsheet | SheetJS (`xlsx`), header detection by name with a heuristic fallback |
| Group job lines | Exact match on a normalised description key |
| Find the product | Curated alias map first, then exact title match, then Sørensen–Dice token overlap |
| Roll up a gift set | Union of each component tea's ingredient list |
| Build the document | `docx`, assembled paragraph by paragraph |

The same spreadsheet always produces the same document. Fuzzy matching only ever
produces a *suggestion* that the review screen flags for a human to confirm — it
never silently decides what goes on a signed declaration.

## Running it

```bash
npm install
npm run dev          # http://localhost:3000
```

Deploy to Vercel as a standard Next.js app — no environment variables, no
database, no external calls at request time.

## The data

### `data/catalogue.json` — scraped facts

Every product on `vahdam.com`, `vahdam.in`, `vahdam.co.uk` and `vahdam.global`,
with the "What's Inside" panel off each product page. That panel comes in two
shapes and the scraper records which one it got:

- `kind: "ingredients"` — a botanical list (*Ginger, Licorice, Fennel…*)
- `kind: "components"` — the constituent teas of a gift set (*Cardamom Masala Chai Tea, 20 g…*)

Refresh it with:

```bash
npm run catalogue            # top up anything missing
npm run catalogue -- --force # re-scrape everything
```

The run is incremental and resumable. Shopify throttles bursts with HTTP 429, so
a single pass rarely gets every product — it merges into what is already there
and saves after each store, so just run it again to pick up stragglers.

### `data/aliases.json` — human decisions

Hand-maintained, and deliberately separate from the scraped facts.

- **`entries`** maps a goods description as it appears on a job (`HP GINGER TEA
  100TB 200G AUS`) to a catalogue product. Set `product: null` with an
  `unresolved` message for goods that have no published product — the app then
  refuses to invent an ingredient list and flags the item for manual entry.
- **`componentAliases`** maps gift-set contents that use Vahdam's older naming
  onto their catalogue equivalent (*Saffron Chai Spiced Black Tea* →
  *Saffron Premium Masala Chai Tea*). Token overlap cannot bridge a rename, so
  the decision is recorded rather than guessed.

**When a new job line will not match, add a row here.** That is the intended
maintenance path.

## Matching notes

Two adjustments earned their place, both found by testing against a real job:

- **Token stemming.** Vahdam write the same tea as "Double Spice" in one place
  and "Double Spiced" in another. Without stemming those score as unrelated
  words, and the sampler picked up vanilla and cappuccino flavours that were
  never in it.
- **Home-store preference.** Size and count tokens (`100 Count`, `3.53 oz`)
  dilute a product's score, which let a bare gift-set component land on a
  mirror-site listing whose panel reads `CTC` where the home store reads
  `Black Tea`. Candidates from the parent product's own store get a small bonus.

## Confidence levels

Shown per item on the review screen:

| Level | Meaning |
| --- | --- |
| `mapped` | Resolved through the curated alias map |
| `exact match` | Job description matched a catalogue title exactly |
| `check this` | Fuzzy suggestion — **confirm before issuing** |
| `not on file` | Known product with no published ingredients — enter by hand |
| `no match` | Nothing close enough to suggest — enter by hand |

Generation is blocked until every item has a description and an ingredient list.

## Output

A `.docx` following the Ingredients List Declaration template:

- Letterhead (company name **and** address), title and consignment link in the
  page **header**, so they repeat on every page as the template requires
- One block per product: job line numbers, the goods description from the job,
  the retail description, ingredients, and any allergen or origin notes
- Gift sets additionally list what they comprise, above the consolidated list
- Signature block, and `Page X of Y` in the footer
