import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { entrySourceOf, forkHostDeclaration, isDeclaredForkHost, isUnsupportedHost } from "../src/host.js";
import { PI_DESKTOP_WARNING_MESSAGE, UNSUPPORTED_HOST_MESSAGE } from "../src/omp.js";

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
  test("\"pi-desktop\" → true (#635)", () => withForkEnv("pi-desktop", () => assert.equal(isDeclaredForkHost(), true)));
  test("\"0\"/\"yes\"/\"\"/unknown name → false (strict)", () => {
    withForkEnv("0", () => assert.equal(isDeclaredForkHost(), false));
    withForkEnv("yes", () => assert.equal(isDeclaredForkHost(), false));
    withForkEnv("", () => assert.equal(isDeclaredForkHost(), false));
    withForkEnv("prime", () => assert.equal(isDeclaredForkHost(), false));
  });
});

describe("forkHostDeclaration", () => {
  test("unset → not declared, no host class", () =>
    withForkEnv(undefined, () => assert.deepEqual(forkHostDeclaration(), { declared: false, hostClass: null })));
  test("\"1\"/\"true\"/\"TRUE\" → declared generic fork", () => {
    withForkEnv("1", () => assert.deepEqual(forkHostDeclaration(), { declared: true, hostClass: "generic" }));
    withForkEnv("true", () => assert.deepEqual(forkHostDeclaration(), { declared: true, hostClass: "generic" }));
    withForkEnv("TRUE", () => assert.deepEqual(forkHostDeclaration(), { declared: true, hostClass: "generic" }));
  });
  test("\"pi-desktop\" (any case, trimmed) → declared pi-desktop (#635)", () => {
    withForkEnv("pi-desktop", () => assert.deepEqual(forkHostDeclaration(), { declared: true, hostClass: "pi-desktop" }));
    withForkEnv("Pi-Desktop", () => assert.deepEqual(forkHostDeclaration(), { declared: true, hostClass: "pi-desktop" }));
    withForkEnv("  PI-DESKTOP  ", () => assert.deepEqual(forkHostDeclaration(), { declared: true, hostClass: "pi-desktop" }));
  });
  test("unrecognized values are NOT declarations (stays refused)", () => {
    for (const v of ["0", "yes", "", "prime", "pidesktop", "pi desktop"]) {
      withForkEnv(v, () => assert.deepEqual(forkHostDeclaration(), { declared: false, hostClass: null }, `value ${JSON.stringify(v)}`));
    }
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
  test("fork-shaped host accepted via pi-desktop declaration (#635)", () => {
    withForkEnv("pi-desktop", () => assert.equal(isUnsupportedHost(forkShaped), false));
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
  test("names PI-Desktop and its dedicated opt-in value (#635)", () => {
    assert.ok(UNSUPPORTED_HOST_MESSAGE.includes("PI-Desktop"));
    assert.ok(UNSUPPORTED_HOST_MESSAGE.includes("PI_ACP_FORK_HOST=pi-desktop"));
  });
});

describe("PI_DESKTOP_WARNING_MESSAGE", () => {
  test("names the host, the opt-in value, the issue, and the proxy remedy", () => {
    assert.ok(PI_DESKTOP_WARNING_MESSAGE.includes("PI-Desktop"));
    assert.ok(PI_DESKTOP_WARNING_MESSAGE.includes("pi-desktop"));
    assert.ok(PI_DESKTOP_WARNING_MESSAGE.includes("#635"));
    assert.ok(PI_DESKTOP_WARNING_MESSAGE.includes("billion-context"));
  });
});
