import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createAcpExtension } from "../src/index.js";
import { loadUserConfig, parseAcpJson } from "../src/user-config.js";

// issue #467 (from billion-context#894): hand-edited acp.json on Windows
// commonly uses unquoted keys / trailing commas / a BOM head — strict
// JSON.parse silently treated all of them as "not disabled", the exact
// opposite of the user's intent. The factory-time read must repair the
// common shapes and disable ACP as written.
function withAcpJson(content: string, fn: (api: any) => void): void {
  const home = mkdtempSync(path.join(os.tmpdir(), "bili-acp-enabled-"));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  if (prevUserProfile !== undefined) process.env.USERPROFILE = home;
  const cwd = path.join(home, "project");
  mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  writeFileSync(path.join(cwd, ".pi", "acp.json"), content);
  const prevCwd = process.cwd();
  process.chdir(cwd);
  try {
    const handlers = new Map<string, ((e: any, ctx: any) => any)[]>();
    const api = {
      on(event: string, handler: (e: any, ctx: any) => any) { handlers.set(event, handler); },
      tools: [] as any[],
      commands: new Map<string, any>(),
      registerTool(tool: any) { this.tools.push(tool); },
      registerCommand(name: string, options: any) { this.commands.set(name, options); },
    };
    createAcpExtension({})(api as any);
    fn(api);
  } finally {
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
}

test("#467 unquoted keys in acp.json still disable ACP", () => {
  withAcpJson("{ enabled : false }", (api) => {
    assert.equal(api.tools.length, 0, "no tools registered when disabled");
  });
});

test("#467 trailing comma + BOM head still disable ACP", () => {
  withAcpJson("\uFEFF{\n  \"enabled\": false,\n}\n", (api) => {
    assert.equal(api.tools.length, 0, "no tools registered when disabled");
  });
});

test("#467 enabled:\"false\" (string) stays ENABLED but is a documented non-boolean", () => {
  withAcpJson("{ \"enabled\": \"false\" }", (api) => {
    assert.ok(api.tools.length > 0, "non-literal boolean does not disable");
  });
});

test("#467 garbage json stays ENABLED (loud warn covers it)", () => {
  withAcpJson("{ enabled false !!!", (api) => {
    assert.ok(api.tools.length > 0, "unparseable file does not disable");
  });
});

test("#467 valid enabled:true registers tools", () => {
  withAcpJson("{ \"enabled\": true }", (api) => {
    assert.ok(api.tools.length > 0, "explicit enable keeps ACP on");
  });
});

test("#467 loadUserConfig salvages repaired config (unquoted key still applies)", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "bili-acp-loadcfg-"));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  const cwd = path.join(home, "project");
  mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  writeFileSync(path.join(cwd, ".pi", "acp.json"), "{\n  enabled : false,\n  modelContextLimit: 123456,\n}\n");
  const prevCwd = process.cwd();
  process.chdir(cwd);
  try {
    const cfg = await loadUserConfig(cwd);
    assert.equal(cfg.modelContextLimit, 123456, "repaired unquoted-key file still merges known keys");
  } finally {
    process.chdir(prevCwd);
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("#467 parseAcpJson reports diagnosed failure reason", () => {
  const r = parseAcpJson("/fake/acp.json", "{ enabled false !!!");
  assert.equal(r.status, "failed");
  assert.match(r.reason ?? "", /failed to parse/);
});

test("#467 parseAcpJson repairs BOM + trailing comma silently marked repaired", () => {
  const r = parseAcpJson("/fake/acp.json", "\uFEFF{\"enabled\": false,}\n");
  assert.equal(r.status, "repaired");
  assert.equal(r.value?.enabled, false);
});
