/**
 * One definition of what a note path means (tracker 1.1).
 *
 * WHY THIS IS ARCHITECTURE AND NOT HOUSEKEEPING. Every later phase of the
 * freshness build is a SET OPERATION: notes on disk minus notes with a current
 * vector, plugin sources intersected with the inventory, pending minus
 * supplemental. Set operations on keys that disagree do not throw. They return a
 * plausible wrong answer. `daily/2026/a.md` and `daily\2026\a.md` are the same
 * note to a member and two different notes to a `Set`, and the symptom is a note
 * that is simultaneously "covered" and "missing" depending on which producer you
 * ask.
 *
 * Four producers have to agree: Smart Connections' `.smart-env` records, our
 * on-disk walker, the supplemental embedding cache, and the paths that come back
 * on a search result. This module is the only place any of them is allowed to
 * decide.
 *
 * WHAT IS DELIBERATELY NOT DONE HERE. Case is preserved, not folded. The vault
 * is the authority on how a note is spelled, because that spelling is what opens
 * the file, and folding it here would mean handing callers a path that does not
 * exist on a case-sensitive filesystem. Case DISAGREEMENT between producers is
 * handled once, in the inventory, by re-keying everything to the casing the disk
 * reports. See `caseFold` and `VaultInventory.resolve`.
 *
 * Unicode is normalized to NFC because macOS hands out NFD filenames and Windows
 * and Linux hand out NFC, and the same note would otherwise hold two identities.
 * That normalization is for COMPARISON only: the inventory keeps the raw
 * readdir-supplied path alongside it and uses that for file I/O, since the
 * filesystem wants its own spelling back.
 */

/**
 * Vault-relative, forward-slashed, no leading `./` or `/`, no `.` or `..`
 * segments, NFC-normalized. Case preserved.
 *
 * Returns '' for input that normalizes away to nothing, which callers must treat
 * as "not a usable path" rather than as the vault root.
 */
export function canonicalPath(input: string): string {
  if (!input) return '';
  // Windows drive-absolute or UNC paths cannot be vault-relative keys. Callers
  // that hold an absolute path must go through `relativeToVault` first; getting
  // one here means a producer skipped that step, and silently accepting it would
  // put an unmatched key into a set.
  let s = String(input).replace(/\\/g, '/');

  const segments: string[] = [];
  for (const part of s.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      // A `..` that escapes the vault root is dropped rather than allowed to
      // climb out. Nothing above the vault is addressable as a note.
      segments.pop();
      continue;
    }
    segments.push(part);
  }

  return segments.join('/').normalize('NFC');
}

/**
 * Turn an absolute path into a vault-relative canonical one, or null when it
 * does not live under the vault.
 *
 * Null rather than a best guess: a path outside the vault is not a note with an
 * awkward name, it is a bug in whoever produced it, and inventing a key for it
 * would put a phantom into the corpus.
 */
export function relativeToVault(vaultPath: string, absolute: string): string | null {
  const root = canonicalPath(vaultPath);
  const full = canonicalPath(absolute);
  if (full === root) return '';
  if (!full.startsWith(root + '/')) return null;
  return full.slice(root.length + 1);
}

/**
 * The comparison key used when two producers disagree about capitalization.
 *
 * Only the inventory is allowed to use this, and only to find the disk's own
 * spelling of a path. It is never a corpus key: `README.md` and `readme.md` are
 * one file on Windows and two on Linux, and the set that decides what is
 * searchable has to hold the spelling that actually opens.
 */
export function caseFold(canonical: string): string {
  return canonical.toLowerCase();
}

/** True for the paths this server treats as notes. */
export function isMarkdownPath(canonical: string): boolean {
  return /\.md$/i.test(canonical);
}
