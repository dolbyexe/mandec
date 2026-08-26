'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import type { AnalyseResult, Confidence, ResolvedItem, Supplier } from '@/lib/types';

const CONFIDENCE_LABEL: Record<Confidence, string> = {
  alias: 'mapped',
  exact: 'exact match',
  fuzzy: 'check this',
  unresolved: 'not on file',
  none: 'no match',
};

/** Items in these states must be filled in by hand before the document is worth issuing. */
const NEEDS_REVIEW: Confidence[] = ['fuzzy', 'unresolved', 'none'];

export default function Page() {
  const [consignmentLink, setConsignmentLink] = useState('');
  const [analysis, setAnalysis] = useState<AnalyseResult | null>(null);
  const [items, setItems] = useState<ResolvedItem[]>([]);
  const [supplier, setSupplier] = useState<Supplier | null>(null);
  const [busy, setBusy] = useState<'idle' | 'analysing' | 'generating'>('idle');
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const upload = useCallback(async (file: File) => {
    setBusy('analysing');
    setError('');
    setFileName(file.name);

    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/analyse', { method: 'POST', body: form });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? 'Could not read that spreadsheet.');
        setAnalysis(null);
        setItems([]);
        return;
      }

      const result = data as AnalyseResult;
      setAnalysis(result);
      setItems(result.items);
      setSupplier(result.supplier);
    } catch {
      setError('Upload failed. Check your connection and try again.');
    } finally {
      setBusy('idle');
    }
  }, []);

  const patch = (index: number, changes: Partial<ResolvedItem>) =>
    setItems((current) => current.map((it, i) => (i === index ? { ...it, ...changes } : it)));

  const blocking = useMemo(
    () => items.filter((it) => !it.description.trim() || !it.ingredients.trim()),
    [items],
  );
  const review = useMemo(
    () => items.filter((it) => NEEDS_REVIEW.includes(it.confidence)),
    [items],
  );

  const generate = async () => {
    if (!supplier) return;
    setBusy('generating');
    setError('');

    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          consignmentLink,
          supplier,
          totalLines: analysis?.totalLines ?? items.length,
          items: items.map((it) => ({
            linesLabel: it.linesLabel,
            entryDescription: it.entryDescription,
            description: it.description,
            ingredients: it.ingredients,
            components: it.components,
            notes: it.notes,
          })),
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? 'Could not build the document.');
        return;
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download =
        res.headers
          .get('Content-Disposition')
          ?.match(/filename="([^"]+)"/)?.[1] ?? 'Manufacturers_Declaration.docx';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError('Generation failed. Try again.');
    } finally {
      setBusy('idle');
    }
  };

  return (
    <div className="wrap">
      <header className="masthead">
        <h1>Manufacturer&rsquo;s Declaration Generator</h1>
        <p className="sub">
          Upload a job report, confirm the ingredient breakdowns, download a Word document ready for
          the supplier to sign.
        </p>
      </header>

      {error && <div className="alert bad">{error}</div>}

      <section className="panel">
        <h2>1 &middot; Consignment</h2>
        <div className="field">
          <label htmlFor="consignment">Consignment link</label>
          <input
            id="consignment"
            type="text"
            value={consignmentLink}
            placeholder="e.g. 39155425164"
            onChange={(e) => setConsignmentLink(e.target.value)}
          />
        </div>

        <label htmlFor="sheet">Job report spreadsheet (.csv, .xlsx, .xls)</label>
        <div
          className={`drop${dragging ? ' over' : ''}`}
          onClick={() => fileInput.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const file = e.dataTransfer.files?.[0];
            if (file) void upload(file);
          }}
        >
          <input
            id="sheet"
            ref={fileInput}
            type="file"
            accept=".csv,.xlsx,.xls,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
            }}
          />
          {busy === 'analysing'
            ? 'Reading spreadsheet…'
            : fileName
              ? `${fileName} — click or drop to replace`
              : 'Click to choose a file, or drop one here'}
        </div>
      </section>

      {analysis && (
        <>
          <section className="panel">
            <h2>2 &middot; Letterhead</h2>
            <div className="row">
              <div className="field">
                <label htmlFor="supplier-name">Company name</label>
                <input
                  id="supplier-name"
                  type="text"
                  value={supplier?.name ?? ''}
                  onChange={(e) =>
                    setSupplier((s) => (s ? { ...s, name: e.target.value } : s))
                  }
                />
              </div>
              <div className="field">
                <label htmlFor="supplier-address">Address (one line per row)</label>
                <textarea
                  id="supplier-address"
                  value={supplier?.addressLines.join('\n') ?? ''}
                  onChange={(e) =>
                    setSupplier((s) =>
                      s ? { ...s, addressLines: e.target.value.split('\n') } : s,
                    )
                  }
                />
              </div>
            </div>
          </section>

          <section className="panel">
            <h2>
              3 &middot; Review &mdash; {analysis.totalLines} job lines, {items.length} products
            </h2>

            {review.length > 0 ? (
              <div className="alert warn">
                {review.length} of {items.length} products need checking before you issue this
                declaration. They are outlined below.
              </div>
            ) : (
              <div className="alert ok">
                Every product matched a catalogue entry. Still worth a read before you send it.
              </div>
            )}

            <p className="sub" style={{ marginBottom: 16 }}>
              Read from the <code>{analysis.columnUsed}</code> column. Anything you edit here goes
              straight into the document.
            </p>

            {items.map((item, i) => {
              const blocked = !item.description.trim() || !item.ingredients.trim();
              const flagged = NEEDS_REVIEW.includes(item.confidence);
              return (
                <div
                  key={item.entryDescription + i}
                  className={`item${blocked ? ' blocked' : flagged ? ' needs-review' : ''}`}
                >
                  <div className="item-head">
                    <span className="entry-desc">{item.entryDescription}</span>
                    <span className="lines">
                      {item.linesLabel}{' '}
                      <span className={`badge ${item.confidence}`}>
                        {CONFIDENCE_LABEL[item.confidence]}
                      </span>
                    </span>
                  </div>

                  <p className="match-note">
                    {item.matchNote}{' '}
                    {item.sourceUrl && (
                      <a
                        className="source-link"
                        href={item.sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        view source
                      </a>
                    )}
                  </p>

                  <div className="field">
                    <label>Item description</label>
                    <input
                      type="text"
                      value={item.description}
                      placeholder="Retail description as it appears on the pack"
                      onChange={(e) => patch(i, { description: e.target.value })}
                    />
                  </div>

                  {item.components.length > 0 && (
                    <div className="field">
                      <label>Comprising ({item.components.length} teas)</label>
                      <textarea
                        value={item.components.join('; ')}
                        onChange={(e) =>
                          patch(i, {
                            components: e.target.value
                              .split(';')
                              .map((s) => s.trim())
                              .filter(Boolean),
                          })
                        }
                      />
                    </div>
                  )}

                  <div className="field">
                    <label>
                      {item.components.length ? 'Consolidated ingredients' : 'Ingredients'}
                    </label>
                    <textarea
                      value={item.ingredients}
                      placeholder="Full ingredient list — required"
                      onChange={(e) => patch(i, { ingredients: e.target.value })}
                    />
                  </div>

                  <div className="field" style={{ marginBottom: 0 }}>
                    <label>Notes printed under the ingredients (one per line, optional)</label>
                    <textarea
                      value={item.notes.join('\n')}
                      placeholder="e.g. ALLERGEN: contains Almonds (tree nut)."
                      onChange={(e) =>
                        patch(i, {
                          notes: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean),
                        })
                      }
                    />
                  </div>
                </div>
              );
            })}
          </section>

          <section className="panel">
            <h2>4 &middot; Generate</h2>
            {blocking.length > 0 && (
              <div className="alert bad">
                {blocking.length} product{blocking.length === 1 ? '' : 's'} still missing a
                description or ingredient list.
              </div>
            )}
            <div className="actions">
              <button
                onClick={generate}
                disabled={
                  busy !== 'idle' || !consignmentLink.trim() || blocking.length > 0 || !supplier
                }
              >
                {busy === 'generating' ? 'Building…' : 'Download Word document'}
              </button>
              <button
                className="secondary"
                onClick={() => {
                  setAnalysis(null);
                  setItems([]);
                  setFileName('');
                  setError('');
                  if (fileInput.current) fileInput.current.value = '';
                }}
              >
                Start over
              </button>
              {!consignmentLink.trim() && (
                <span className="sub">Enter a consignment link to enable the download.</span>
              )}
            </div>
            <p className="meta">
              Ingredient data scraped from the Vahdam storefronts on{' '}
              {new Date(analysis.catalogueGeneratedAt).toLocaleDateString('en-AU', {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              })}
              . Re-run <code>npm run catalogue</code> to refresh it.
            </p>
          </section>
        </>
      )}
    </div>
  );
}
