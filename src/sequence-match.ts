export interface MatchRange {
  candidateStart: number;
  liveStart: number;
  length: number;
}

interface LongestRun {
  length: number;
  unique?: MatchRange;
}

const NO_RUN: LongestRun = { length: 0 };
const MAX_APPEND_KEYS = 8;
const SHORT_TAIL_KEYS = 4;

export function findUniqueLongestRun<Key>(candidates: readonly Key[], live: readonly Key[]): MatchRange | undefined {
  if (candidates.length === 0 || live.length === 0) return undefined;
  // Origins are normally a short live tail. Scan its endpoints instead of sorting the history.
  if (candidates.length <= SHORT_TAIL_KEYS) return extendLongestRun(NO_RUN, candidates, live, 0, live.length).unique;
  if (live.length <= SHORT_TAIL_KEYS) return extendLongestRun(NO_RUN, candidates, live, candidates.length, 0).unique;
  return findLongestRun(candidates, live).unique;
}

export class AppendOnlyRunMatcher<Key> {
  private previous?: { candidates: readonly Key[]; live: readonly Key[]; longest: LongestRun };

  match(candidates: readonly Key[], live: readonly Key[], canExtend: boolean): MatchRange | undefined {
    const previous = this.previous;
    const longest = canExtend && previous
      && candidates.length + live.length - previous.candidates.length - previous.live.length <= MAX_APPEND_KEYS
      && hasPrefix(candidates, previous.candidates) && hasPrefix(live, previous.live)
      ? extendLongestRun(previous.longest, candidates, live, previous.candidates.length, previous.live.length)
      : findLongestRun(candidates, live);
    this.previous = { candidates, live, longest };
    return longest.unique;
  }
}

function sameKey<Key>(a: Key, b: Key): boolean {
  return a === b || Object.is(a, b);
}

function hasPrefix<Key>(values: readonly Key[], prefix: readonly Key[]): boolean {
  return values.length >= prefix.length && prefix.every((key, i) => sameKey(values[i]!, key));
}

function extendLongestRun<Key>(
  previous: LongestRun, candidates: readonly Key[], live: readonly Key[], oldCandidates: number, oldLive: number,
): LongestRun {
  let best = previous;
  function record(length: number, candidateStart: number, liveStart: number): void {
    if (length > best.length) best = { length, unique: { length, candidateStart, liveStart } };
    else if (length === best.length && best.unique) best = { length };
  }
  // A new best run must end in an appended key. Count runs ending in both new tails only once.
  for (let end = oldCandidates + 1; end <= candidates.length; end++) {
    scanRunsEndingAt(candidates, end, live, live.length, (length, start) => record(length, end - length, start));
  }
  for (let end = oldLive + 1; end <= live.length; end++) {
    scanRunsEndingAt(live, end, candidates, oldCandidates, (length, start) => record(length, start, end - length));
  }
  return best;
}

function scanRunsEndingAt<Key>(
  fixed: readonly Key[], end: number, other: readonly Key[], otherEnd: number,
  visit: (length: number, start: number) => void,
): void {
  if (otherEnd === 0) return;
  // KMP on the reversed views gives the longest match at each start in `other`
  // that ends at `end` (exclusive) in `fixed`, even for duplicate-heavy sequences.
  const failure = new Uint32Array(end);
  function advance(length: number, key: Key): number {
    while (length > 0 && (length === end || !sameKey(fixed[end - length - 1]!, key))) length = failure[length - 1]!;
    return sameKey(fixed[end - length - 1]!, key) ? length + 1 : length;
  }
  for (let i = 1; i < end; i++) failure[i] = advance(failure[i - 1]!, fixed[end - i - 1]!);
  let length = 0;
  for (let start = otherEnd - 1; start >= 0; start--) {
    length = advance(length, other[start]!);
    if (length > 0) visit(length, start);
  }
}

function findLongestRun<Key>(candidates: readonly Key[], live: readonly Key[]): LongestRun {
  if (candidates.length === 0 || live.length === 0) return NO_RUN;

  const ids = new Map<Key, number>();
  const intern = (key: Key): number => {
    const existing = ids.get(key);
    if (existing !== undefined) return existing;
    const id = ids.size + 1;
    ids.set(key, id);
    return id;
  };
  const candidateIds = candidates.map(intern);
  const liveIds = live.map(intern);
  const separator = ids.size + 1;
  const sequence = [...candidateIds, separator, ...liveIds];
  const suffixArray = buildSuffixArray(sequence);
  const lcp = buildLcp(sequence, suffixArray);
  const candidateLength = candidates.length;
  const liveOffset = candidateLength + 1;
  const sourceOf = (suffix: number): 0 | 1 | undefined => {
    if (suffix < candidateLength) return 0;
    if (suffix >= liveOffset) return 1;
    return undefined;
  };

  let bestLength = 0;
  for (let index = 1; index < suffixArray.length; index++) {
    const leftSource = sourceOf(suffixArray[index - 1]!);
    const rightSource = sourceOf(suffixArray[index]!);
    if (leftSource === undefined || rightSource === undefined || leftSource === rightSource) continue;
    bestLength = Math.max(bestLength, lcp[index]!);
  }
  if (bestLength === 0) return NO_RUN;

  let pairCount = 0;
  let uniqueCandidateStart = -1;
  let uniqueLiveStart = -1;
  for (let start = 0; start < suffixArray.length;) {
    let end = start;
    while (end + 1 < suffixArray.length && lcp[end + 1]! >= bestLength) end++;
    if (end > start) {
      const candidateStarts: number[] = [];
      const liveStarts: number[] = [];
      for (let index = start; index <= end; index++) {
        const suffix = suffixArray[index]!;
        const source = sourceOf(suffix);
        if (source === 0) candidateStarts.push(suffix);
        else if (source === 1) liveStarts.push(suffix - liveOffset);
      }
      const groupPairs = candidateStarts.length * liveStarts.length;
      pairCount += groupPairs;
      if (groupPairs === 1) {
        uniqueCandidateStart = candidateStarts[0]!;
        uniqueLiveStart = liveStarts[0]!;
      }
      if (pairCount > 1) return { length: bestLength };
    }
    start = end + 1;
  }

  return {
    length: bestLength,
    unique: pairCount === 1 ? { candidateStart: uniqueCandidateStart, liveStart: uniqueLiveStart, length: bestLength } : undefined,
  };
}

// #459 fallback for hosts whose views contain duplicate content: the
// unique-longest-run matcher above gives up entirely when its best run is
// ambiguous, which strands every live message as unmatched and churns their
// ids. Under append-only growth the live view's matched head always aligns
// with the TAIL of the persisted branch (persisted only grows at the end), so
// anchor there: longest k such that live[0..k) === candidates[len-k..len).
// Deterministic by construction — one answer for a given pair of views.
export function findPositionalPrefixRun<Key>(candidates: readonly Key[], live: readonly Key[]): MatchRange | undefined {
  if (candidates.length === 0 || live.length === 0) return undefined;
  const max = Math.min(candidates.length, live.length);
  for (let length = max; length > 0; length--) {
    const candidateStart = candidates.length - length;
    let ok = true;
    for (let i = 0; i < length; i++) {
      if (candidates[candidateStart + i] !== live[i]) { ok = false; break; }
    }
    if (ok) return { candidateStart, liveStart: 0, length };
  }
  return undefined;
}

function buildSuffixArray(sequence: readonly number[]): number[] {
  const suffixArray = sequence.map((_, index) => index);
  let ranks = [...sequence];
  for (let width = 1; width < sequence.length; width *= 2) {
    suffixArray.sort((left, right) => ranks[left]! - ranks[right]! || (ranks[left + width] ?? -1) - (ranks[right + width] ?? -1));
    const nextRanks = Array<number>(sequence.length);
    nextRanks[suffixArray[0]!] = 0;
    for (let index = 1; index < suffixArray.length; index++) {
      const previous = suffixArray[index - 1]!;
      const current = suffixArray[index]!;
      const differs = ranks[previous] !== ranks[current] || (ranks[previous + width] ?? -1) !== (ranks[current + width] ?? -1);
      nextRanks[current] = nextRanks[previous]! + (differs ? 1 : 0);
    }
    ranks = nextRanks;
    if (ranks[suffixArray.at(-1)!] === sequence.length - 1) break;
  }
  return suffixArray;
}

function buildLcp(sequence: readonly number[], suffixArray: readonly number[]): number[] {
  const positions = Array<number>(sequence.length);
  for (let index = 0; index < suffixArray.length; index++) positions[suffixArray[index]!] = index;
  const lcp = Array<number>(sequence.length).fill(0);
  let length = 0;
  for (let start = 0; start < sequence.length; start++) {
    const position = positions[start]!;
    if (position === 0) continue;
    const previous = suffixArray[position - 1]!;
    while (start + length < sequence.length && previous + length < sequence.length && sequence[start + length] === sequence[previous + length]) length++;
    lcp[position] = length;
    if (length > 0) length--;
  }
  return lcp;
}
