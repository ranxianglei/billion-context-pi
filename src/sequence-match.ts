export interface MatchRange {
  candidateStart: number;
  liveStart: number;
  length: number;
}

export function findUniqueLongestRun<Key>(candidates: readonly Key[], live: readonly Key[]): MatchRange | undefined {
  if (candidates.length === 0 || live.length === 0) return undefined;

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
  if (bestLength === 0) return undefined;

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
      if (pairCount > 1) return undefined;
    }
    start = end + 1;
  }

  return pairCount === 1
    ? { candidateStart: uniqueCandidateStart, liveStart: uniqueLiveStart, length: bestLength }
    : undefined;
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
