import type { Locator } from '@lumina/contract';
import type { ParsedUnit } from './parsed.js';

/**
 * Phase 5 C6 / D8: turn parsed units into chunks whose locators are unique within the
 * document.
 *
 * Uniqueness is structural here, not checked-and-hoped-for:
 *
 *   - a chunk never spans two units, so `page`/`heading` is always truthful;
 *   - a chunk never splits a line, so every chunk starts at a distinct line index;
 *   - overlap may never reach back to the previous chunk's own first line, which is the one
 *     case that could otherwise repeat a start line inside a unit.
 *
 * It matters because `bench.mjs:200-202` identifies a chunk by
 * `docId:page:heading:line` and `bench.mjs:416-417` uses that key to build the grounding
 * haystack — two chunks sharing a key means one overwrites the other and a correct citation
 * gets scored ungrounded against `min_citation_grounding: 0.95`.
 */

export interface ChunkDraft {
  text: string;
  locator: Locator;
  ord: number;
}

export interface ChunkOptions {
  targetChars: number;
  overlapChars: number;
}

export function chunkUnits(units: ParsedUnit[], opts: ChunkOptions): ChunkDraft[] {
  const drafts: ChunkDraft[] = [];
  let ord = 0;

  for (const unit of units) {
    for (const span of chunkOneUnit(unit, opts)) {
      const locator = {
        ...unit.locatorBase,
        line: unit.firstLine + span.startIndex
      } as Locator;
      drafts.push({ text: span.text, locator, ord: ord++ });
    }
  }

  return drafts;
}

interface Span {
  text: string;
  /** Offset of this span's first line within the unit's `lines`. */
  startIndex: number;
}

function chunkOneUnit(unit: ParsedUnit, opts: ChunkOptions): Span[] {
  const { lines } = unit;
  const spans: Span[] = [];

  let i = 0;
  let previousStart = -1;

  while (i < lines.length) {
    // Skip leading blank lines so a chunk never starts on whitespace — its `line` would
    // point at nothing a reader could find.
    while (i < lines.length && (lines[i] ?? '').trim().length === 0) i++;
    if (i >= lines.length) break;

    const startIndex = i;
    let length = 0;
    let end = i; // exclusive

    while (end < lines.length) {
      const line = lines[end] ?? '';
      const added = length === 0 ? line.length : line.length + 1; // +1 for the joining \n
      // Always take at least one line, so a line longer than the target becomes its own
      // chunk rather than an empty one (this is the "never split a line" rule).
      if (length > 0 && length + added > opts.targetChars) break;
      length += added;
      end++;
    }

    const text = lines.slice(startIndex, end).join('\n').trim();
    if (text.length > 0) {
      spans.push({ text, startIndex });
      previousStart = startIndex;
    }

    if (end >= lines.length) break;

    // Step back over trailing lines worth up to `overlapChars`, so a sentence split across a
    // boundary is still retrievable from one chunk — but never back to (or past) this
    // chunk's own first line, which would repeat a start line and break uniqueness.
    let back = end;
    let carried = 0;
    while (back - 1 > previousStart && carried + (lines[back - 1] ?? '').length <= opts.overlapChars) {
      back--;
      carried += (lines[back] ?? '').length + 1;
    }
    i = Math.max(back, previousStart + 1);
  }

  return spans;
}

/** D8's invariant, asserted rather than assumed (C7 calls this before inserting anything). */
export function locatorKey(docId: string, locator: Locator): string {
  return `${docId}:${locator.page ?? ''}:${locator.heading ?? ''}:${locator.line ?? ''}`;
}

export function assertUniqueLocators(docId: string, drafts: ChunkDraft[]): void {
  const seen = new Map<string, number>();
  for (const d of drafts) {
    const key = locatorKey(docId, d.locator);
    const first = seen.get(key);
    if (first !== undefined) {
      throw new Error(
        `locator collision: chunks ord ${first} and ${d.ord} share "${key}" — ` +
          'two chunks of one document must not share a locator (D8)'
      );
    }
    seen.set(key, d.ord);
  }
}
