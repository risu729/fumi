/**
 * Move a UTF-16 cut index back by one when it falls between the two halves of a
 * surrogate pair. Slicing at the result never yields a lone surrogate, which
 * strict UTF-8 and JSON consumers reject.
 */
export function pairBoundary(value: string, index: number): number {
  if (index <= 0 || index >= value.length) return index;
  const before = value.charCodeAt(index - 1);
  const after = value.charCodeAt(index);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
    ? index - 1
    : index;
}

/** The first `limit` UTF-16 code units, one fewer when the cut would split a surrogate pair. */
export function truncateCodeUnits(value: string, limit: number): string {
  return value.slice(0, pairBoundary(value, limit));
}
