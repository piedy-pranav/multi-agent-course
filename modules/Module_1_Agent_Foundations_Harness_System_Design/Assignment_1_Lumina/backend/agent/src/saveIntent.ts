/**
 * Phase 4 D8a: the explicit-save backstop's detector and extractor. Pure/testable — no
 * network, no model call, no state — so the ask route can run it deterministically after
 * the gather loop to decide whether a normal model-elected `save_memory` was ever going to
 * happen, and if not, force one. Tuned for false negatives (plan D8a): missing an explicit
 * save request is worse than one unnecessary save, so a query has to look unambiguously
 * like an instruction to remember something, not a question about remembering.
 */

const QUESTION_STARTER = /^(what|how|do|does|did|who|when|where|why|is|are|can|could|should|would|will)\b/i;

const SAVE_TRIGGERS = [
  /^remember\s+(that|this|to)?\b/i,
  /^please\s+remember\b/i,
  /^from\s+now\s+on\b/i,
  /^note\s+that\b/i,
  /^save\s+this\b/i,
  /^keep\s+in\s+mind\b/i,
  /^for\s+(all\s+)?future\s+(answers|threads|conversations)\b/i
];

/** True only for an unambiguous instruction to remember something — never a question. */
export function isExplicitSaveRequest(query: string): boolean {
  const q = query.trim();
  if (!q || q.endsWith('?')) return false;
  if (QUESTION_STARTER.test(q)) return false;
  return SAVE_TRIGGERS.some((re) => re.test(q));
}

const STRIP_PREFIXES = [
  /^remember\s+(that|this|to)?\s*(preference)?\s*(for\s+(all\s+)?future\s+(answers|threads|conversations))?\s*:?\s*/i,
  /^please\s+remember\s+(that|this|to)?\s*:?\s*/i,
  /^from\s+now\s+on[,]?\s*/i,
  /^note\s+that\s*/i,
  /^save\s+this\s*:?\s*/i,
  /^keep\s+in\s+mind\s+(that)?\s*:?\s*/i,
  /^for\s+(all\s+)?future\s+(answers|threads|conversations)[,:]?\s*/i
];

/**
 * Deterministically strips the "remember ..." wrapper off an explicit save request, so the
 * backstop stores the actual fact/preference rather than the whole instruction sentence.
 * Falls back to the trimmed original query when no known wrapper matches, so the backstop
 * never stores an empty string.
 */
export function extractMemoryText(query: string): string {
  const original = query.trim();
  for (const re of STRIP_PREFIXES) {
    const stripped = original.replace(re, '').trim();
    if (stripped && stripped !== original) return stripped;
  }
  return original;
}
