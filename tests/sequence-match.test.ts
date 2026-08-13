import { test } from "node:test";
import assert from "node:assert/strict";
import { findUniqueLongestRun } from "../src/sequence-match.js";

test("finds an exact unique full run", () => {
  assert.deepEqual(findUniqueLongestRun(["A", "B", "C"], ["A", "B", "C"]), {
    candidateStart: 0,
    liveStart: 0,
    length: 3,
  });
});

test("finds a unique run between unrelated prefix and tail", () => {
  assert.deepEqual(findUniqueLongestRun(["A", "B", "C", "D"], ["X", "A", "B", "C", "Y"]), {
    candidateStart: 0,
    liveStart: 1,
    length: 3,
  });
});

test("rejects non-contiguous and tied maximal runs", () => {
  assert.equal(findUniqueLongestRun(["A", "X", "B"], ["A", "B"]), undefined);
  assert.equal(findUniqueLongestRun(["A", "B", "X", "C", "D"], ["A", "B", "Y", "C", "D"]), undefined);
});

test("distinguishes repeated tokens from repeated maximal alignments", () => {
  assert.deepEqual(findUniqueLongestRun(["A", "A", "A"], ["A", "A", "A"]), {
    candidateStart: 0,
    liveStart: 0,
    length: 3,
  });
  assert.equal(findUniqueLongestRun(["A", "A", "A"], ["A", "A"]), undefined);
  assert.deepEqual(findUniqueLongestRun(["A", "B", "C", "A", "C", "B"], ["A", "B", "C"]), {
    candidateStart: 0,
    liveStart: 0,
    length: 3,
  });
});

test("handles periodic unique and ambiguous runs", () => {
  assert.deepEqual(findUniqueLongestRun(["A", "B", "C", "A", "B", "C"], ["B", "C", "A", "B", "C"]), {
    candidateStart: 1,
    liveStart: 0,
    length: 5,
  });
  assert.equal(findUniqueLongestRun(["A", "B", "C", "A", "B", "C"], ["A", "B", "C"]), undefined);
});

test("matches the brute-force contract for small sequences", () => {
  const alphabet = ["A", "B", "C"];
  for (let candidateLength = 0; candidateLength <= 4; candidateLength++) {
    for (const candidates of sequences(alphabet, candidateLength)) {
      for (let liveLength = 0; liveLength <= 4; liveLength++) {
        for (const live of sequences(alphabet, liveLength)) {
          assert.deepEqual(findUniqueLongestRun(candidates, live), bruteForceMatch(candidates, live), `${candidates.join("")} / ${live.join("")}`);
        }
      }
    }
  }
});

function sequences<T>(alphabet: readonly T[], length: number): T[][] {
  if (length === 0) return [[]];
  return sequences(alphabet, length - 1).flatMap((prefix) => alphabet.map((value) => [...prefix, value]));
}

function bruteForceMatch<T>(candidates: readonly T[], live: readonly T[]) {
  let bestLength = 0;
  let candidateStart = -1;
  let liveStart = -1;
  let count = 0;
  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
    for (let liveIndex = 0; liveIndex < live.length; liveIndex++) {
      let length = 0;
      while (candidateIndex + length < candidates.length && liveIndex + length < live.length && candidates[candidateIndex + length] === live[liveIndex + length]) length++;
      if (length > bestLength) {
        bestLength = length;
        candidateStart = candidateIndex;
        liveStart = liveIndex;
        count = 1;
      } else if (length === bestLength && length > 0) {
        count++;
      }
    }
  }
  return bestLength > 0 && count === 1 ? { candidateStart, liveStart, length: bestLength } : undefined;
}
