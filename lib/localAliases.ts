import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { normKey } from './normalise';
import type { SavedAlias } from './types';

/**
 * Ingredient lists confirmed by hand in the review screen, kept in a local
 * overlay file rather than in the committed catalogue.
 *
 * Deliberately gitignored. The repository is public, so job-line descriptions
 * (which identify a client's SKUs) must not end up in a committed file; and
 * keeping local corrections out of `aliases.json` means a `git pull` never
 * fights with what someone typed here.
 *
 * Read fresh on every request. The file is a few kB and changes while the
 * server is running, so caching would only buy staleness.
 */

const FILE = path.join(process.cwd(), 'data', 'aliases.local.json');

export class ReadOnlyStoreError extends Error {}

export async function readSaved(): Promise<SavedAlias[]> {
  try {
    const parsed = JSON.parse(await readFile(FILE, 'utf8'));
    return Array.isArray(parsed?.entries) ? parsed.entries : [];
  } catch (err) {
    // Missing file is the normal state before anything has been saved.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    // A corrupt overlay must not take the whole app down -- fall back to the
    // committed catalogue and let the user re-save.
    console.error('aliases.local.json is unreadable, ignoring it', err);
    return [];
  }
}

async function write(entries: SavedAlias[]): Promise<void> {
  const payload = {
    _comment:
      'Ingredient lists confirmed by hand in the app. Gitignored on purpose. ' +
      'Delete an entry here (or use Forget in the review screen) to fall back to the catalogue.',
    entries: entries.sort((a, b) => a.match.localeCompare(b.match)),
  };

  try {
    await writeFile(FILE, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EROFS' || code === 'EACCES' || code === 'EPERM') {
      throw new ReadOnlyStoreError(
        'Saving needs a writable filesystem, so it only works when you run the app locally. ' +
          'On a hosted deployment the ingredients still apply to this document, they just cannot be remembered.',
      );
    }
    throw err;
  }
}

/** Store a confirmed entry, replacing any earlier one for the same job line. */
export async function saveAlias(entry: Omit<SavedAlias, 'savedAt'>): Promise<SavedAlias> {
  const key = normKey(entry.match);
  const existing = await readSaved();
  const saved: SavedAlias = { ...entry, savedAt: new Date().toISOString() };

  await write([...existing.filter((e) => normKey(e.match) !== key), saved]);
  return saved;
}

/** Drop a saved entry so the item falls back to the catalogue. */
export async function forgetAlias(match: string): Promise<boolean> {
  const key = normKey(match);
  const existing = await readSaved();
  const remaining = existing.filter((e) => normKey(e.match) !== key);

  if (remaining.length === existing.length) return false;
  await write(remaining);
  return true;
}
