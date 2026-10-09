/**
 * Phase 5 D13: Reciprocal Rank Fusion.
 *
 * RRF fuses ranked lists by POSITION, not by score, which is the whole point: a
 * `$vectorSearch` cosine score and a BM25 relevance score are not on the same scale and
 * cannot be added or averaged without inventing a weighting nobody can justify. Rank is the
 * one thing both lists agree on the meaning of.
 *
 *   score(d) = Σ over lists  1 / (k + rank(d))      rank 1-based
 *
 * `k` damps the top of each list: a large k makes the lists more equal, a small k lets a
 * single list's first place dominate. 60 is the value from the original Cormack et al.
 * paper and the usual default; it lives in config (`DOC_RRF_K`) because it is exactly the
 * sort of number recall@5 gets tuned against.
 */

export interface RankedList<T> {
  /** Items in rank order, best first. */
  items: T[];
}

export interface FusedEntry<T> {
  item: T;
  score: number;
  /** 1-based rank in each contributing list, for debugging why something surfaced. */
  ranks: Record<string, number>;
}

/**
 * Deterministic: equal scores break by the identity of the first list that contained the
 * item, then by key, so the same inputs always produce the same order. A fusion that
 * reorders run to run makes recall@5 unreproducible and impossible to tune.
 */
export function reciprocalRankFusion<T>(
  lists: Record<string, RankedList<T>>,
  keyOf: (item: T) => string,
  k: number
): FusedEntry<T>[] {
  const byKey = new Map<string, FusedEntry<T>>();
  const firstSeen = new Map<string, number>();
  let order = 0;

  for (const [listName, list] of Object.entries(lists)) {
    list.items.forEach((item, i) => {
      const rank = i + 1;
      const key = keyOf(item);
      const existing = byKey.get(key);
      if (existing) {
        existing.score += 1 / (k + rank);
        existing.ranks[listName] = rank;
        return;
      }
      byKey.set(key, { item, score: 1 / (k + rank), ranks: { [listName]: rank } });
      firstSeen.set(key, order++);
    });
  }

  return [...byKey.entries()]
    .sort(([keyA, a], [keyB, b]) => {
      if (b.score !== a.score) return b.score - a.score;
      const oa = firstSeen.get(keyA) ?? 0;
      const ob = firstSeen.get(keyB) ?? 0;
      if (oa !== ob) return oa - ob;
      return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
    })
    .map(([, entry]) => entry);
}
