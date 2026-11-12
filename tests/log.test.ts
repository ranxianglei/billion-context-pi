import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, mkdir, writeFile, stat } from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";

async function freshLog(): Promise<string> {
  const dir = await mkdir(path.join(tmpdir(), `acp-log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`), { recursive: true });
  return path.join(dir, "acp.log");
}

async function loadLogger(file: string) {
  process.env.ACP_LOG_FILE = file;
  process.env.ACP_DEBUG = "";
  const mod = await import(`../src/log.js?t=${Date.now()}-${Math.random()}`);
  return mod;
}

test("error/warn/info are written when debug is OFF (always-on)", async () => {
  const file = await freshLog();
  const log = await loadLogger(file);
  log.setDebugEnabled(false);
  log.logError("scope-a", { event: "boom", detail: "x" });
  log.logWarn("scope-b", { event: "careful" });
  log.logInfo("scope-c", { event: "started", sid: "s1" });
  log.closeLogStream();
  const content = await readFile(file, "utf8");
  assert.match(content, /\[error\] \[scope-a\] event=boom detail=x/);
  assert.match(content, /\[warn\] \[scope-b\] event=careful/);
  assert.match(content, /\[info\] \[scope-c\] event=started sid=s1/);
  await rm(path.dirname(file), { recursive: true, force: true });
});

test("debug.event is NOT written when debug is OFF", async () => {
  const file = await freshLog();
  const log = await loadLogger(file);
  log.setDebugEnabled(false);
  log.debug.event("verbose", { k: "v" });
  log.closeLogStream();
  const content = await readFile(file, "utf8").catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return "";
    throw e;
  });
  assert.equal(content, "", "no debug output when debug is off");
  await rm(path.dirname(file), { recursive: true, force: true });
});

test("debug.event IS written when debug is ON", async () => {
  const file = await freshLog();
  const log = await loadLogger(file);
  log.setDebugEnabled(true);
  log.debug.event("verbose", { k: "v" });
  log.closeLogStream();
  const content = await readFile(file, "utf8");
  assert.match(content, /\[debug\] \[verbose\] k=v/);
  await rm(path.dirname(file), { recursive: true, force: true });
});

test("logThrow records message and stack as error", async () => {
  const file = await freshLog();
  const log = await loadLogger(file);
  log.setDebugEnabled(false);
  const err = new Error("kaboom");
  log.logThrow("transform", err, { sid: "s9", phase: "ctx" });
  log.closeLogStream();
  const content = await readFile(file, "utf8");
  assert.match(content, /\[error\] \[transform\] sid=s9 phase=ctx error=kaboom stack=/);
  assert.match(content, /kaboom/);
  await rm(path.dirname(file), { recursive: true, force: true });
});

test("multi-line field values stay on one physical line (issue #326)", async () => {
  const file = await freshLog();
  const log = await loadLogger(file);
  log.setDebugEnabled(true);
  log.debug.event("nudge", { event: "nudge-injected", text: "⚠️ Context limit reached\nTier 1 ranges:\n  m00001–m00050: 12K tokens" });
  log.logThrow("ctx", new Error("boom"), { sid: "s9" });
  log.closeLogStream();
  const content = await readFile(file, "utf8");
  const lines = content.split("\n").filter((l) => l.length > 0);
  for (const l of lines) {
    assert.match(l, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[/, `every entry is one tagged physical line: ${l}`);
  }
  assert.ok(lines.some((l) => l.includes("text=⚠️ Context limit reached\\nTier 1 ranges:\\n  m00001–m00050: 12K tokens")), "escaped newlines keep the nudge body self-contained for grep");
  assert.ok(lines.some((l) => /\[error\] \[ctx\]/.test(l) && l.includes("stack=Error: boom\\n")), "stack trace stays on the same physical line");
  await rm(path.dirname(file), { recursive: true, force: true });
});

test("log lines carry ISO timestamp, level and scope", async () => {
  const file = await freshLog();
  const log = await loadLogger(file);
  log.setDebugEnabled(false);
  log.logInfo("session", { event: "start" });
  log.closeLogStream();
  const content = await readFile(file, "utf8");
  const line = content.trim();
  const prefix = line.split(" [")[0];
  assert.ok(!Number.isNaN(Date.parse(prefix)), `timestamp parses as date: ${prefix}`);
  await rm(path.dirname(file), { recursive: true, force: true });
});

test("rotation renames oversized file to .old", async () => {
  const dir = path.join(tmpdir(), `acp-log-rot-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "acp.log");
  await writeFile(file, "x".repeat(11 * 1024 * 1024));
  const log = await loadLogger(file);
  log.setDebugEnabled(false);
  log.logInfo("rotate", { event: "post-size" });
  log.closeLogStream();
  const oldStat = await stat(file + ".old").catch(() => null);
  assert.ok(oldStat, "rotated .old file should exist");
  await rm(dir, { recursive: true, force: true });
});
