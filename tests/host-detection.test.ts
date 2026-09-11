import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { entrySourceOf, isDeclaredForkHost, isUnsupportedHost } from "../src/host.js";
import { UNSUPPORTED_HOST_MESSAGE } from "../src/omp.js";

type SM = ExtensionContext["sessionManager"];

// Prime-shaped / OMP-shaped host: getBranch only, no buildContextEntries (#364).
const piShaped = { buildContextEntries: () => [], getBranch: () => [] } as unknown as SM;
const forkShaped = { getBranch: () => [] } as unknown as SM;
const bare = {} as unknown as SM;

function withForkEnv(value: string | undefined, fn: () => void): void {
  const prev = process.env.PI_ACP_FORK_HOST;
  if (value === undefined) delete process.env.PI_ACP_FORK_HOST;
  else process.env.PI_ACP_FORK_HOST = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.PI_ACP_FORK_HOST;
    else process.env.PI_ACP_FORK_HOST = prev;
  }
}

describe("entrySourceOf", () => {
  test("pi host → buildContextEntries (takes precedence when both exist)", () => {
    assert.equal(entrySourceOf(piShaped), "buildContextEntries");
  });
  test("Prime/OMP-shaped host → getBranch", () => {
    assert.equal(entrySourceOf(forkShaped), "getBranch");
  });
  test("no known API → null", () => {
    assert.equal(entrySourceOf(bare), null);
  });
  test("null sessionManager → null", () => {
    assert.equal(entrySourceOf(null as unknown as SM), null);
  });
});

describe("isDeclaredForkHost", () => {
  test("unset → false", () => withForkEnv(undefined, () => assert.equal(isDeclaredForkHost(), false)));
  test("\"1\" → true", () => withForkEnv("1", () => assert.equal(isDeclaredForkHost(), true)));
  test("\"true\"/\"TRUE\" → true", () => {
    withForkEnv("true", () => assert.equal(isDeclaredForkHost(), true));
    withForkEnv("TRUE", () => assert.equal(isDeclaredForkHost(), true));
  });
  test("\"0\"/\"yes\"/\"\" → false (strict)", () => {
    withForkEnv("0", () => assert.equal(isDeclaredForkHost(), false));
    withForkEnv("yes", () => assert.equal(isDeclaredForkHost(), false));
    withForkEnv("", () => assert.equal(isDeclaredForkHost(), false));
  });
});

describe("isUnsupportedHost", () => {
  test("pi host never unsupported, declared or not", () => {
    withForkEnv(undefined, () => assert.equal(isUnsupportedHost(piShaped), false));
    withForkEnv("1", () => assert.equal(isUnsupportedHost(piShaped), false));
  });
  test("fork-shaped host refused by default (OMP protection intact)", () => {
    withForkEnv(undefined, () => assert.equal(isUnsupportedHost(forkShaped), true));
  });
  test("fork-shaped host accepted once declared", () => {
    withForkEnv("1", () => assert.equal(isUnsupportedHost(forkShaped), false));
  });
  test("bare sessionManager refused regardless of declaration", () => {
    withForkEnv(undefined, () => assert.equal(isUnsupportedHost(bare), true));
    withForkEnv("1", () => assert.equal(isUnsupportedHost(bare), false));
  });
});

describe("UNSUPPORTED_HOST_MESSAGE", () => {
  test("points at both remedies: fork opt-in and OMP proxy", () => {
    assert.ok(UNSUPPORTED_HOST_MESSAGE.includes("PI_ACP_FORK_HOST"));
    assert.ok(UNSUPPORTED_HOST_MESSAGE.includes("buildContextEntries"));
    assert.ok(UNSUPPORTED_HOST_MESSAGE.includes("bili omp"));
    assert.ok(UNSUPPORTED_HOST_MESSAGE.includes("billion-context"));
  });
});
