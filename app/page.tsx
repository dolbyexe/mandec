'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AnalyseResult, Confidence, ResolvedItem, Supplier } from '@/lib/types';

const CONFIDENCE_LABEL: Record<Confidence, string> = {
  saved: 'saved by you',
  alias: 'mapped',
  exact: 'exact match',
  fuzzy: 'check this',
  unresolved: 'not on file',
  none: 'no match',
};

/** Items in these states must be filled in by hand before the document is worth issuing. */
const NEEDS_REVIEW: Confidence[] = ['fuzzy', 'unresolved', 'none'];

/** An item cannot go on a declaration without both of these. */
const isBlocked = (item: ResolvedItem) =>
  !item.description.trim() || !item.ingredients.trim();

/** "1 saved by you, 11 mapped" -- what a collapsed group is hiding. */
const describeBucket = (bucket: { item: ResolvedItem }[]) => {
  const counts = new Map<Confidence, number>();
  for (const { item } of bucket) counts.set(item.confidence, (counts.get(item.confidence) ?? 0) + 1);
  return [...counts.entries()].map(([c, n]) => `${n} ${CONFIDENCE_LABEL[c]}`).join(', ');
};

export default function Page() {
  const [consignmentLink, setConsignmentLink] = useState('');
  const [analysis, setAnalysis] = useState<AnalyseResult | null>(null);
  const [items, setItems] = useState<ResolvedItem[]>([]);
  const [supplier, setSupplier] = useState<Supplier | null>(null);
  const [busy, setBusy] = useState<'idle' | 'analysing' | 'generating'>('idle');
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState('');
  const [saving, setSaving] = useState<number | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [savedFlash, setSavedFlash] = useState<Record<number, string>>({});
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

  const flash = (index: number, message: string) => {
    setSavedFlash((f) => ({ ...f, [index]: message }));
    setTimeout(() => setSavedFlash((f) => ({ ...f, [index]: '' })), 4000);
  };

  /** Remember this ingredient list so the same job line resolves next time. */
  const remember = async (index: number) => {
    const item = items[index];
    setSaving(index);
    setError('');
    try {
      const res = await fetch('/api/save-alias', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          match: item.entryDescription,
          description: item.description,
          ingredients: item.ingredients,
          components: item.components,
          notes: item.notes,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Could not save that entry.');
        return;
      }
      patch(index, { saved: true, confidence: 'saved' });
      flash(index, 'Saved. This job line will resolve automatically next time.');
    } catch {
      setError('Could not reach the server to save that entry.');
    } finally {
      setSaving(null);
    }
  };

  /** Drop the saved entry so this job line falls back to the catalogue. */
  const forget = async (index: number) => {
    const item = items[index];
    setSaving(index);
    setError('');
    try {
      const res = await fetch(
        `/api/save-alias?match=${encodeURIComponent(item.entryDescription)}`,
        { method: 'DELETE' },
      );
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Could not remove that entry.');
        return;
      }
      patch(index, { saved: false });
      flash(index, 'Forgotten. Re-upload the job to see the catalogue match.');
    } catch {
      setError('Could not reach the server.');
    } finally {
      setSaving(null);
    }
  };

  const blocking = useMemo(
    () => items.filter(isBlocked),
    [items],
  );
  const review = useMemo(
    () => items.filter((it) => NEEDS_REVIEW.includes(it.confidence)),
    [items],
  );

  /**
   * Split into what needs a human and what does not.
   *
   * Bucketing is on confidence alone, never on whether the item is currently
   * blocked -- confidence only changes on an explicit save, so an item cannot
   * jump between groups while someone is mid-edit in it.
   */
  const grouped = useMemo(() => {
    const attention: { item: ResolvedItem; index: number }[] = [];
    const resolved: { item: ResolvedItem; index: number }[] = [];
    items.forEach((item, index) =>
      (NEEDS_REVIEW.includes(item.confidence) ? attention : resolved).push({ item, index }),
    );
    return { attention, resolved };
  }, [items]);

  // A blocked item must never hide inside a collapsed group, or the download
  // stays disabled with nothing on screen explaining why.
  const resolvedHasBlocked = grouped.resolved.some(({ item }) => isBlocked(item));
  useEffect(() => {
    if (resolvedHasBlocked) setShowResolved(true);
  }, [resolvedHasBlocked]);

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

  /** One reviewable product. Kept as a function so both groups can render it. */
  const renderItem = (item: ResolvedItem, i: number) => {
              const blocked = isBlocked(item);
              const flagged = NEEDS_REVIEW.includes(item.confidence);
              return (
                <div
                  key={item.entryDescription + i}
                  className={`item${
                    blocked
                      ? ' blocked'
                      : item.saved
                        ? ' saved-entry'
                        : flagged
                          ? ' needs-review'
                          : ''
                  }`}
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

                  <div className="field">
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

                  <div className="actions">
                    <button
                      className="secondary"
                      disabled={saving === i || blocked}
                      onClick={() => void remember(i)}
                      title={
                        blocked
                          ? 'Fill in the description and ingredients first'
                          : 'Remember this for the next job with the same line'
                      }
                    >
                      {saving === i ? 'Saving…' : item.saved ? 'Update saved entry' : 'Save for next time'}
                    </button>

                    {item.saved && (
                      <button
                        className="secondary"
                        disabled={saving === i}
                        onClick={() => void forget(i)}
                        title="Drop the saved entry and fall back to the catalogue"
                      >
                        Forget
                      </button>
                    )}

                    {savedFlash[i] && <span className="flash">{savedFlash[i]}</span>}
                  </div>
                </div>
              );
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

            <details className="group" open>
              <summary>
                <span className="group-title">Needs your attention</span>
                <span className="group-count warn">{grouped.attention.length}</span>
                <span className="group-breakdown">{describeBucket(grouped.attention)}</span>
              </summary>
              <div className="group-body">
                {grouped.attention.length === 0 ? (
                  <p className="sub">
                    Nothing here. Every product resolved from the catalogue or a saved entry.
                  </p>
                ) : (
                  grouped.attention.map(({ item, index }) => renderItem(item, index))
                )}
              </div>
            </details>

            <details
              className="group"
              open={showResolved}
              onToggle={(e) => setShowResolved(e.currentTarget.open)}
            >
              <summary>
                <span className="group-title">Resolved automatically</span>
                <span className="group-count ok">{grouped.resolved.length}</span>
                <span className="group-breakdown">{describeBucket(grouped.resolved)}</span>
              </summary>
              <div className="group-body">
                {grouped.resolved.length === 0 ? (
                  <p className="sub">Nothing resolved automatically.</p>
                ) : (
                  grouped.resolved.map(({ item, index }) => renderItem(item, index))
                )}
              </div>
            </details>
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
