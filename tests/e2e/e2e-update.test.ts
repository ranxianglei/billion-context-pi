// Real-upgrade e2e against a hermetic local npm registry (verdaccio,
// loopback-only) — exercises the actual `npm install` → verifyInstall →
// syncLockEntry chain of src/update.ts (issue #584).
//
// Run with:  npm run build && \
//            ACP_TEST_REGISTRY=1 NPM_ALLOW_DANGEROUS=1 \
//            node --import tsx --test tests/e2e/e2e-update.test.ts
// (plain `npm test` skips this file: it shells out to npm and verdaccio.
// NPM_ALLOW_DANGEROUS=1 is only needed where an npm-guard shim intercepts
// `npm publish` — the publish target is this test's own loopback registry.)
//
// Scenarios:
//   control  — the pre-fix oscillation: `npm install <pkg>@new --no-save`
//              flips node_modules but leaves the root lock stale, and pi's
//              start-time bare `npm install --prefix` reverts the tree (#584)
//   A        — OLD version → THIS version via autoInstallLatest: the root
//              lock entry is synced (version+resolved+integrity) and a
//              pi-style reconcile no longer reverts the tree
//   B        — THIS version → NEWER version: the fixed updater still detects
//              and installs a newer release and the root stays consistent
//
// The pi host (`@earendil-works/pi-coding-agent`, a peerDependency) is made
// resolvable via a `work/node_modules/@earendil-works` symlink to the repo's
// own node_modules — outside every npm-managed tree, so no install step can
// prune it, while verifyInstall's smoke-import of dist/index.js still
// resolves it (node walks all ancestor node_modules dirs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync, rmSync, symlinkSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { startRegistry } from "./registry-fixture.js";

// Tests drive src directly (no bundled CLI): one directory deeper than tests/.
const UPDATE_MODULE = "../../src/update.js";

const execFileAsync = promisify(execFile);

const run = process.env.ACP_TEST_REGISTRY === "1";
const skipReason = !run
    ? "set ACP_TEST_REGISTRY=1 (hermetic local-registry e2e; loopback only, needs npm run build first)"
    : undefined;

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const PKG = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as {
    version: string;
    files?: string[];
};
const PACKAGE_NAME = "billion-context-pi";

const patch = (v: string, delta: number): string => {
    const parts = v.split(".").map((p) => Number.parseInt(p, 10));
    parts[2] = (parts[2] ?? 0) + delta;
    return parts.join(".");
};
const OLD_VERSION = patch(PKG.version, -1);
const CUR_VERSION = PKG.version;
const NEW_VERSION = patch(PKG.version, +1);

type LockEntry = { version?: string; resolved?: string; integrity?: string };

function rootLockEntry(fixtureRoot: string): LockEntry | undefined {
    const lock = JSON.parse(readFileSync(join(fixtureRoot, "package-lock.json"), "utf8")) as {
        packages?: Record<string, LockEntry>;
    };
    return lock.packages?.[`node_modules/${PACKAGE_NAME}`];
}

function hiddenLockEntry(fixtureRoot: string): LockEntry | undefined {
    const lock = JSON.parse(readFileSync(join(fixtureRoot, "node_modules", ".package-lock.json"), "utf8")) as {
        packages?: Record<string, LockEntry>;
    };
    return lock.packages?.[`node_modules/${PACKAGE_NAME}`];
}

const treeVersion = (fixtureRoot: string): string | undefined =>
    (JSON.parse(readFileSync(join(fixtureRoot, "node_modules", PACKAGE_NAME, "package.json"), "utf8")) as { version?: string })
        .version;

// Stage a pack-able copy of THIS repo at an arbitrary version, then `npm pack`
// it — real tarball, real integrity, exactly what a release publish produces.
async function makeFixtureTarball(tgzDir: string, version: string, env: { HOME: string }): Promise<string> {
    const stage = join(tgzDir, `stage-${version}`);
    mkdirSync(stage, { recursive: true });
    writeFileSync(
        join(stage, "package.json"),
        JSON.stringify({ ...PKG, version }, null, "\t") + "\n",
    );
    for (const entry of PKG.files ?? ["dist"]) {
        const src = join(REPO, entry);
        if (existsSync(src)) cpSync(src, join(stage, entry), { recursive: true });
    }
    const { stdout } = await execFileAsync(
        "npm",
        ["pack", stage, "--json", "--silent", "--pack-destination", tgzDir],
        { cwd: tgzDir, timeout: 120_000, env: { ...process.env, HOME: env.HOME } },
    );
    const files = JSON.parse(stdout) as { filename: string }[];
    assert.ok(files.length === 1 && files[0].filename.endsWith(".tgz"), `npm pack produced no tarball for ${version}: ${stdout}`);
    return join(tgzDir, files[0].filename);
}

test(
    "hermetic registry e2e: old→this and this→newer upgrades stick (issue #584)",
    { skip: skipReason, timeout: 300_000 },
    async (t) => {
        assert.ok(
            existsSync(join(REPO, "dist", "index.js")),
            "dist/index.js missing — run `npm run build` first (the tarball must carry the real entry verifyInstall smoke-imports)",
        );

        const work = join(REPO, "tmp", `e2e-update-${process.pid}`);
        rmSync(work, { recursive: true, force: true });
        mkdirSync(work, { recursive: true });
        const fixtureRoot = join(work, "fixture");

        // Peer host for verifyInstall's smoke-import: one directory ABOVE the
        // npm-managed fixture root, so no npm step can ever prune it.
        mkdirSync(join(work, "node_modules"), { recursive: true });
        const hostLink = join(work, "node_modules", "@earendil-works");
        symlinkSync(join(REPO, "node_modules", "@earendil-works"), hostLink, "dir");

        // Redirect the in-process auto-update chain at the local registry:
        // src/update.ts spawns npm without an env override (inherits ours),
        // and `npm view`/`npm install` both honor npm_config_registry.
        const savedEnv: Record<string, string | undefined> = {};
        const reg = await startRegistry(join(work, "registry"));
        t.after(async () => {
            for (const [k, v] of Object.entries(savedEnv)) {
                if (v === undefined) delete process.env[k];
                else process.env[k] = v;
            }
            await reg.stop();
        });
            // npm_config_legacy_peer_deps mirrors pi's own reconcile
            // invocation (--legacy-peer-deps): the host provides the peer at
            // runtime, the updater must not try to fetch it from a registry.
        for (const [k, v] of Object.entries({
            npm_config_registry: reg.url,
            npm_config_cache: join(work, "npm-cache"),
            npm_config_legacy_peer_deps: "true",
            HOME: reg.homeDir,
        })) {
            savedEnv[k] = process.env[k];
            process.env[k] = v;
        }
        mkdirSync(join(work, "npm-cache"), { recursive: true });

        const tgzDir = join(work, "tarballs");
        mkdirSync(tgzDir, { recursive: true });

        // A failing subtest does not abort the parent flow — track it so the
        // work dir is kept for post-mortem exactly when something broke.
        let failed = false;
        const step = async (name: string, fn: () => Promise<void>): Promise<void> => {
            await t.test(name, async () => {
                try {
                    await fn();
                } catch (e) {
                    failed = true;
                    throw e;
                }
            });
        };

        await step("pack + publish the OLD version", async () => {
            // Only OLD is on the registry while seeding: a fresh `npm install`
            // of `^OLD` must resolve to OLD (publishing THIS first would make
            // the seed lock pin the newer version — pi seeds with the newest
            // release that exists at install time, and so do we).
            await reg.publish(await makeFixtureTarball(tgzDir, OLD_VERSION, { HOME: reg.homeDir }));
        });

        await step("seed a pi-shaped managed root at the OLD version", async () => {
            // What pi writes when the user installs an extension: a manifest
            // declaring the spec, then a plain reconcile install.
            mkdirSync(fixtureRoot, { recursive: true });
            writeFileSync(
                join(fixtureRoot, "package.json"),
                JSON.stringify({ name: "host", private: true, dependencies: { [PACKAGE_NAME]: `^${OLD_VERSION}` } }, null, "\t") + "\n",
            );
            await reg.npm(["install", "--prefix", fixtureRoot, "--legacy-peer-deps"]);
            assert.equal(treeVersion(fixtureRoot), OLD_VERSION);
            assert.equal(rootLockEntry(fixtureRoot)?.version, OLD_VERSION);
        });

        await step("publish THIS version (latest tag flips)", async () => {
            await reg.publish(await makeFixtureTarball(tgzDir, CUR_VERSION, { HOME: reg.homeDir }));
            const doc = (await (await fetch(`${reg.url}/${PACKAGE_NAME}`)).json()) as {
                "dist-tags"?: Record<string, string>;
            };
            assert.equal(doc["dist-tags"]?.latest, CUR_VERSION);
        });

        await step("control: pre-fix --no-save upgrade is reverted by pi's reconcile (#584)", async () => {
            // The OLD updater's exact behavior: install new, save nothing.
            await reg.npm(["install", "--prefix", fixtureRoot, `${PACKAGE_NAME}@${CUR_VERSION}`, "--no-save", "--legacy-peer-deps"]);
            assert.equal(treeVersion(fixtureRoot), CUR_VERSION, "tree flipped by --no-save install");
            assert.equal(rootLockEntry(fixtureRoot)?.version, OLD_VERSION, "root lock stayed stale (the bug's precondition)");
            assert.equal(hiddenLockEntry(fixtureRoot)?.version, CUR_VERSION, "hidden lock tracked the real tree");
            // pi's start-time reconcile:
            await reg.npm(["install", "--prefix", fixtureRoot, "--legacy-peer-deps"]);
            assert.equal(treeVersion(fixtureRoot), OLD_VERSION, "reconcile reverted the tree — oscillation reproduced");
        });

        await step("A: autoInstallLatest upgrades OLD → THIS and the lock follows", async () => {
            const { autoInstallLatest } = await import(UPDATE_MODULE);
            const extDir = join(fixtureRoot, "node_modules", PACKAGE_NAME);
            const outcome = await autoInstallLatest(CUR_VERSION, extDir);
            assert.equal(outcome, "ok");
            assert.equal(treeVersion(fixtureRoot), CUR_VERSION);
            const entry = rootLockEntry(fixtureRoot);
            assert.equal(entry?.version, CUR_VERSION, "root lock entry synced to installed version");
            assert.ok(entry?.resolved?.startsWith(reg.url), `lock resolved must point at the local registry, got ${entry?.resolved}`);
            assert.match(entry?.integrity ?? "", /^sha512-/, "lock integrity must be a real sha512");
            assert.equal(
                entry?.integrity,
                hiddenLockEntry(fixtureRoot)?.integrity,
                "lock entry mirrors the hidden lock npm itself wrote",
            );
            // The fix's payoff: pi's reconcile must now keep THIS version.
            await reg.npm(["install", "--prefix", fixtureRoot, "--legacy-peer-deps"]);
            assert.equal(treeVersion(fixtureRoot), CUR_VERSION, "reconcile no longer reverts (oscillation fixed)");
            // syncLockEntry's atomic write leaves no debris.
            const leftovers = readdirSync(fixtureRoot).filter((f) => f.startsWith("package-lock.json."));
            assert.deepEqual(leftovers, [], "no stray tmp lock files");
        });

        await step("B: autoInstallLatest upgrades THIS → NEWER and stays consistent", async () => {
            const newTgz = await makeFixtureTarball(tgzDir, NEW_VERSION, { HOME: reg.homeDir });
            await reg.publish(newTgz); // latest dist-tag flips to NEWER
            const { autoInstallLatest } = await import(UPDATE_MODULE);
            const extDir = join(fixtureRoot, "node_modules", PACKAGE_NAME);
            const outcome = await autoInstallLatest(NEW_VERSION, extDir);
            assert.equal(outcome, "ok");
            assert.equal(treeVersion(fixtureRoot), NEW_VERSION);
            assert.equal(rootLockEntry(fixtureRoot)?.version, NEW_VERSION, "root lock entry synced again");
            await reg.npm(["install", "--prefix", fixtureRoot, "--legacy-peer-deps"]);
            assert.equal(treeVersion(fixtureRoot), NEW_VERSION, "reconcile keeps the newer version too");
        });

        // Success → clean up; failure → leave tmp/ for post-mortem.
        if (!failed) rmSync(work, { recursive: true, force: true });
    },
);
