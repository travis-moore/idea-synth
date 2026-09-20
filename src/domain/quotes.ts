/**
 * Locating a model-supplied quote in the user's original text.
 *
 * An item may only be labelled `extracted_from_user` if at least one of its quotes really
 * occurs in what the user wrote. Models often normalise whitespace and typographic
 * quotes when copying, so after an exact match fails we compare normalised forms, but
 * always map the match back to offsets in the *real* text.
 */
export interface QuoteSpan {
  start: number;
  end: number;
}

const canonicalChar = (c: string): string =>
  /\s/.test(c) ? ' ' : c === '‘' || c === '’' ? "'" : c === '“' || c === '”' ? '"' : c;

/** Collapse whitespace runs and straighten quotes, remembering where each char came from. */
function normalise(text: string): { value: string; offsets: number[] } {
  let value = '';
  const offsets: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = canonicalChar(text[i]!);
    if (c === ' ' && (value.length === 0 || value.endsWith(' '))) continue;
    value += c;
    offsets.push(i);
  }
  return { value, offsets };
}

export function locateQuote(original: string, quote: string): QuoteSpan | null {
  if (!quote.trim()) return null;
  const exact = original.indexOf(quote);
  if (exact >= 0) return { start: exact, end: exact + quote.length };

  const haystack = normalise(original);
  const needle = normalise(quote).value.trim();
  if (!needle) return null;
  const at = haystack.value.indexOf(needle);
  if (at < 0) return null;
  const start = haystack.offsets[at]!;
  const end = haystack.offsets[at + needle.length - 1]! + 1;
  return { start, end };
}
