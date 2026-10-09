import { env } from '../env.js';
import { wrapLines, type ParsedDoc, type ParsedUnit } from './parsed.js';

/**
 * Phase 5 C6 / D8: Markdown and plain text.
 *
 * Markdown becomes one unit per heading section, carrying `{heading}`; plain text becomes one
 * unit carrying no base at all, so its chunks are located by `{line}` alone. Both number
 * lines across the WHOLE document rather than per unit — which is what keeps locators unique
 * when a document has two sections with the same heading text (`## Notes` twice is common,
 * and `{heading:'Notes', line:12}` vs `{heading:'Notes', line:88}` still distinguishes them).
 */

function splitLines(text: string): string[] {
  // Normalise newlines and strip a BOM so line 1 is line 1. The BOM goes by code point
  // rather than a literal character in a regex, so this file carries no invisible characters.
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return body.replace(/\r\n?/g, '\n').split('\n');
}

const ATX_HEADING = /^(#{1,6})\s+(.*)$/;

export function parseMarkdown(text: string): ParsedDoc {
  const raw = splitLines(text);

  const units: ParsedUnit[] = [];
  let heading: string | undefined;
  let buffer: string[] = [];
  let bufferStart = 1; // 1-based document line of buffer[0]

  const flush = () => {
    // Drop a section with no content of its own (a heading immediately followed by another):
    // there is nothing to cite, and an empty chunk is forbidden by C6.
    if (buffer.some((l) => l.trim().length > 0)) {
      units.push({
        locatorBase: heading ? { heading } : {},
        lines: wrapLines(buffer, env.docLineWrapChars),
        firstLine: bufferStart
      });
    }
    buffer = [];
  };

  // Inside a fenced code block a `#` is a comment, not a heading. Tracking fences is the
  // difference between "## Install" as a section and a shell comment silently starting one.
  let inFence = false;
  let fence = '';

  for (let i = 0; i < raw.length; i++) {
    const line = raw[i] ?? '';
    const lineNo = i + 1;

    const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? '';
      if (!inFence) {
        inFence = true;
        fence = marker[0] ?? '`';
      } else if (marker.startsWith(fence)) {
        inFence = false;
        fence = '';
      }
    }

    const h = inFence ? null : ATX_HEADING.exec(line);
    if (h) {
      flush();
      const title = (h[2] ?? '').replace(/\s+#+\s*$/, '').trim(); // closed ATX: "## Title ##"
      heading = title || undefined;
      // The heading line belongs to its own section's text: the gold anchors include heading
      // words (g37's anchor is literally "Termination"), so dropping it would lose the match.
      buffer = [line];
      bufferStart = lineNo;
      continue;
    }

    if (buffer.length === 0) bufferStart = lineNo;
    buffer.push(line);
  }
  flush();

  if (units.length === 0) throw new Error('no usable text in the markdown document');
  return { units };
}

export function parsePlainText(text: string): ParsedDoc {
  const lines = splitLines(text);
  if (!lines.some((l) => l.trim().length > 0)) {
    throw new Error('no usable text in the document');
  }
  return {
    units: [{ locatorBase: {}, lines: wrapLines(lines, env.docLineWrapChars), firstLine: 1 }]
  };
}

/** Decoded as UTF-8; a text upload that is not valid UTF-8 is the user's problem to hear
 * about, not something to paper over with a lossy fallback encoding. */
export function decodeText(bytes: Buffer): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}
