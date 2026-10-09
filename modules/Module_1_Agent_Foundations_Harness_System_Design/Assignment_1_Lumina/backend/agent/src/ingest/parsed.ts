/**
 * Phase 5 C6: the one shape every parser produces, so the chunker (and D8's locator
 * uniqueness rule) is written once rather than per format.
 *
 * A `ParsedUnit` is a region the chunker may never chunk ACROSS — a PDF page, a Markdown
 * section, or the whole of a plain-text file. That boundary is what makes a locator honest: a
 * chunk spanning two pages cannot truthfully claim a page, and one spanning two headings
 * cannot truthfully claim a heading.
 */
export interface ParsedUnit {
  /**
   * The non-line half of every locator this unit's chunks will carry. `{page}` for PDF,
   * `{heading}` for Markdown, `{}` for plain text.
   */
  locatorBase: { page?: number; heading?: string };
  /** Wrapped lines (see `wrapLines`), in reading order, blank lines included. */
  lines: string[];
  /**
   * 1-based line number of `lines[0]` in this unit's numbering space. PDF numbers lines
   * within each page (so page 2 starts again at 1, and `page` disambiguates); text and
   * Markdown number lines across the whole document (so two sections sharing a heading
   * string still produce distinct locators).
   */
  firstLine: number;
}

export interface ParsedDoc {
  units: ParsedUnit[];
  /** Only PDFs have a meaningful page count. Left undefined elsewhere — `DocumentDoc.pages`
   * is `.positive()`, so "no pages" must be absent, never 0. */
  pages?: number;
}

/**
 * D8 keeps locators unique by never splitting a source line across chunks — which means one
 * pathological line (a 20 000-character paragraph on a single line) would otherwise become a
 * single enormous chunk, blowing past the chunk-size ceiling D16 depends on.
 *
 * So lines longer than `wrapAt` are wrapped at word boundaries first, and `line` numbers
 * index this wrapped view. For any document whose lines are shorter than `wrapAt` — which is
 * every file in the gold corpus, where the longest line is 94 characters — the wrapped view
 * and the source are identical line for line, so `line` is exactly the source line number.
 * Past that width `line` remains a real, deterministic, reproducible position in a documented
 * view of the file; it is not a guess, which is what "never fabricate a locator" forbids.
 */
export function wrapLines(lines: string[], wrapAt: number): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (line.length <= wrapAt) {
      out.push(line);
      continue;
    }
    let rest = line;
    while (rest.length > wrapAt) {
      // Prefer the last space inside the window; fall back to a hard cut for text with no
      // spaces at all (minified JSON, a long URL, CJK without spaces).
      const window = rest.slice(0, wrapAt);
      const cut = window.lastIndexOf(' ');
      const at = cut > wrapAt * 0.5 ? cut : wrapAt;
      out.push(rest.slice(0, at).trimEnd());
      rest = rest.slice(at).trimStart();
    }
    if (rest) out.push(rest);
  }
  return out;
}
