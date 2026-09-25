#!/usr/bin/env node
//
// Cross-platform E2E regression runner for billion-context-pi.
// Node port of scripts/e2e/run-e2e.sh (runs on Linux, macOS, and Windows).
//
// For each scenario in scenarios/*.json:
//   1. Writes an isolated Pi HOME (models.json = fake provider, acp.json = scenario config)
//   2. Starts the fake LLM server (OpenAI-compatible SSE) seeded with the scenario
//   3. Drives real `pi -p` headless turns (continuing one session)
//   4. Locates the persisted ACP state file (<session>.jsonl.acp.json)
//   5. Runs verify.mjs to assert on block counts, nudge baselines, observations
//
// The fake LLM responds per a file-based turn counter, so each scenario turn maps
// to one real (non-auxiliary) LLM request. Turns marked "auto": true are tool-call
// follow-ups consumed within the previous `pi -p` invocation (no new user message).
//
// Cross-platform note: isolation relies on os.homedir(), which Node resolves from
// $HOME on POSIX and %USERPROFILE% on Windows. We set BOTH to the temp home so the
// same isolation works everywhere.
//
// Usage: node scripts/e2e/run-e2e.mjs [scenario-filter]
//   scenario-filter = substring matched against scenario filenames (e.g. "01" or "nudge")
//
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");

const PI_BIN = process.env.PI_BIN || "";
const EXTENSION =
  process.env.BCP_E2E_EXTENSION || path.join(ROOT, "scripts", "e2e", "e2e-extension.js");
const FAKE_PORT = Number(process.env.FAKE_LLM_PORT || 8400);
const WORK_ROOT = process.env.BCP_E2E_WORK_ROOT || path.join(os.tmpdir(), "bcp-e2e");
const SCENARIO_FILTER = process.argv[2] || "";

const C = {
  RED: "\x1b[31m",
  GREEN: "\x1b[32m",
  YELLOW: "\x1b[33m",
  CYAN: "\x1b[36m",
  DIM: "\x1b[2m",
  RESET: "\x1b[0m",
};

const log = (...a) => process.stderr.write(`${C.CYAN}[e2e]${C.RESET} ${a.join(" ")}\n`);
const warn = (...a) => process.stderr.write(`${C.YELLOW}[e2e]${C.RESET} ${a.join(" ")}\n`);
const failMsg = (...a) => process.stderr.write(`${C.RED}[e2e]${C.RESET} ${a.join(" ")}\n`);

const NODE = process.execPath;
const sleepSync = (ms) => spawnSync(NODE, ["-e", `setTimeout(()=>process.exit(0),${ms})`]);

let currentFake = null;
function cleanup() {
  if (currentFake && currentFake.exitCode === null) {
    try {
      currentFake.kill();
    } catch {
      // already gone
    }
  }
}
process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(143);
});

function resolvePiBin() {
  if (PI_BIN) return { exe: PI_BIN, args: [] };
  const cliJs = path.join(
    ROOT,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "cli.js",
  );
  if (!fs.existsSync(cliJs)) {
    throw new Error(`pi CLI not found at ${cliJs} (run "npm ci", or set PI_BIN)`);
  }
  return { exe: NODE, args: [cliJs] };
}

function runNpm(args) {
  const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
  const r = spawnSync(npmBin, args, {
    cwd: ROOT,
    stdio: "pipe",
    shell: process.platform === "win32",
  });
  if (r.status !== 0) {
    if (r.stdout) process.stderr.write(r.stdout.toString());
    if (r.stderr) process.stderr.write(r.stderr.toString());
    if (r.error) failMsg(String(r.error));
    throw new Error(`npm ${args.join(" ")} failed (exit ${r.status})`);
  }
}

// Probe must be synchronous from the runner's perspective; use a child to bridge.
const probeSrc = `
const http = require("http");
const req = http.get("http://127.0.0.1:" + process.argv[1] + "/v1/models", (res) => {
  res.resume();
  process.exit(res.statusCode === 200 ? 0 : 1);
});
req.on("error", () => process.exit(1));
req.setTimeout(1000, () => { req.destroy(); process.exit(1); });
`;
function probeFakeSync(port) {
  const r = spawnSync(NODE, ["-e", probeSrc, String(port)], { stdio: "ignore" });
  return r.status === 0;
}

function waitForFake(port) {
  for (let i = 0; i < 50; i++) {
    if (probeFakeSync(port)) return true;
    sleepSync(200);
  }
  return false;
}

function writePiConfig(home) {
  fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
  const models = {
    providers: {
      fake: {
        baseUrl: `http://127.0.0.1:${FAKE_PORT}`,
        api: "openai-completions",
        apiKey: "fake",
        models: [
          {
            id: "fake-model",
            name: "Fake E2E Model",
            input: ["text"],
            contextWindow: 100000,
            maxTokens: 8192,
            compat: { supportsStrictTools: false },
          },
        ],
      },
    },
  };
  fs.writeFileSync(path.join(home, ".pi", "agent", "models.json"), JSON.stringify(models, null, 2));
  fs.writeFileSync(path.join(home, ".pi", "agent", "acp.json"), JSON.stringify({ autoUpdate: false, debug: false }, null, 2));
}

function applyScenarioAcpConfig(scenarioPath, home) {
  const acpPath = path.join(home, ".pi", "agent", "acp.json");
  const base = JSON.parse(fs.readFileSync(acpPath, "utf8"));
  const scenario = JSON.parse(fs.readFileSync(scenarioPath, "utf8"));
  const merged = Object.assign({}, base, scenario.acpConfig || {});
  fs.writeFileSync(acpPath, JSON.stringify(merged, null, 2));
}

function userTurns(scenarioPath) {
  const s = JSON.parse(fs.readFileSync(scenarioPath, "utf8"));
  const turns = s.turns || [];
  const out = [];
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (t.auto) continue;
    out.push(t.userText || `Turn ${i + 1}. Continue the task.`);
  }
  return out;
}

function newestStateFile(sessionDir) {
  const entries = fs
    .readdirSync(sessionDir)
    .filter((f) => f.endsWith(".acp.json"))
    .map((f) => {
      const full = path.join(sessionDir, f);
      return { full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return entries[0]?.full || null;
}

function runPiTurn(piBin, home, sessionDir, userMsg, contFlag, piLogFd) {
  const args = [
    ...piBin.args,
    "-p",
    "--mode",
    "json",
    "--provider",
    "fake",
    "--model",
    "fake/fake-model",
    "--api-key",
    "fake",
    "-ne",
    "-e",
    EXTENSION,
    "--session-dir",
    sessionDir,
  ];
  if (contFlag) args.push("-c");
  args.push(userMsg);

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PI_OFFLINE: "1",
  };

  return new Promise((resolve, reject) => {
    const child = spawn(piBin.exe, args, {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    child.stdout.pipe(piLogFd);
    child.stderr.pipe(piLogFd);
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      resolve(code === 0 ? 0 : code ?? 1);
    });
  });
}

async function runScenario(scenarioPath, piBin) {
  const name = path.basename(scenarioPath, ".json");
  process.stderr.write("\n");
  log(`${C.YELLOW}\u25b6 scenario: ${name}${C.RESET}`);

  const home = path.join(WORK_ROOT, `home-${name}`);
  const sessionDir = path.join(WORK_ROOT, `sessions-${name}`);
  const turnCounter = path.join(WORK_ROOT, `turn-${name}`);
  const observations = path.join(WORK_ROOT, `obs-${name}.json`);
  const piLogPath = path.join(WORK_ROOT, `pi-${name}.log`);
  const fakeLogPath = path.join(WORK_ROOT, `fake-${name}.log`);

  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(sessionDir, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(piLogPath, "");
  fs.writeFileSync(turnCounter, "");
  fs.writeFileSync(observations, '{"requests":[]}');

  writePiConfig(home);
  applyScenarioAcpConfig(scenarioPath, home);

  const fakeLog = fs.createWriteStream(fakeLogPath, { flags: "w" });
  currentFake = spawn(
    NODE,
    [path.join(ROOT, "scripts", "e2e", "fake-llm-server.cjs")],
    {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        SCENARIO: scenarioPath,
        TURN_COUNTER: turnCounter,
        OBSERVATIONS: observations,
        PORT: String(FAKE_PORT),
      },
      shell: false,
    },
  );
  currentFake.stdout.pipe(fakeLog);
  currentFake.stderr.pipe(fakeLog);
  log(`fake LLM pid=${currentFake.pid} (log: ${fakeLogPath})`);

  if (!waitForFake(FAKE_PORT)) {
    failMsg(`fake LLM did not become healthy; log:`);
    try {
      process.stderr.write(fs.readFileSync(fakeLogPath, "utf8"));
    } catch {
      // ignore
    }
    cleanup();
    return false;
  }

  const piLogFd = fs.createWriteStream(piLogPath, { flags: "a" });
  let turnNo = 0;
  let contFlag = false;
  let failed = false;
  for (const userMsg of userTurns(scenarioPath)) {
    if (!userMsg) continue;
    turnNo += 1;
    log(`  turn ${turnNo}: ${C.DIM}pi -p${C.RESET} ${contFlag ? "-c" : "(new session)"}`);
    const code = await runPiTurn(piBin, home, sessionDir, userMsg, contFlag, piLogFd);
    if (code !== 0) {
      failMsg(`pi -p failed on turn ${turnNo} (see ${piLogPath})`);
      failed = true;
      break;
    }
    contFlag = true;
  }
  await new Promise((r) => piLogFd.end(r));

  cleanup();

  if (failed) return false;

  const stateFile = newestStateFile(sessionDir);
  if (!stateFile) {
    failMsg(`no .acp.json state file in ${sessionDir}`);
    try {
      for (const e of fs.readdirSync(sessionDir)) {
        process.stderr.write(`  ${e}\n`);
      }
    } catch {
      // ignore
    }
    return false;
  }
  log(`  state file: ${stateFile.replace(WORK_ROOT, "$WORK")}`);

  const verifyR = spawnSync(
    NODE,
    [path.join(ROOT, "scripts", "e2e", "verify.mjs"), stateFile, scenarioPath, sessionDir],
    {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...process.env, OBSERVATIONS: observations },
      shell: false,
    },
  );
  return verifyR.status === 0;
}

async function main() {
  process.chdir(ROOT);

  log("building billion-context-pi...");
  runNpm(["run", "build"]);
  const distJs = path.join(ROOT, "dist", "index.js");
  if (!fs.existsSync(distJs)) {
    failMsg(`dist/index.js missing after build`);
    process.exit(1);
  }

  const piBin = resolvePiBin();
  const versionR = spawnSync(piBin.exe, [...piBin.args, "--version"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    env: process.env,
  });
  const piVersion = (versionR.stdout?.toString() || "unknown").split("\n")[0].trim();
  log(`pi binary: ${piVersion}`);

  fs.mkdirSync(WORK_ROOT, { recursive: true });

  const scenarioDir = path.join(ROOT, "scripts", "e2e", "scenarios");
  let scenarios = fs
    .readdirSync(scenarioDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => path.join(scenarioDir, f));

  if (SCENARIO_FILTER) {
    scenarios = scenarios.filter((s) => path.basename(s).includes(SCENARIO_FILTER));
  }
  if (scenarios.length === 0) {
    failMsg("no scenarios found in scripts/e2e/scenarios/");
    process.exit(1);
  }

  let total = 0;
  let passed = 0;
  const failedNames = [];
  for (const scenario of scenarios) {
    total += 1;
    const ok = await runScenario(scenario, piBin);
    if (ok) {
      passed += 1;
      process.stderr.write(`${C.GREEN}[e2e] \u2713 ${path.basename(scenario, ".json")}${C.RESET}\n`);
    } else {
      failedNames.push(path.basename(scenario, ".json"));
      process.stderr.write(`${C.RED}[e2e] \u2717 ${path.basename(scenario, ".json")}${C.RESET}\n`);
    }
  }

  const failed = total - passed;
  process.stderr.write("\n");
  log(`results: ${C.GREEN}${passed} passed${C.RESET}, ${C.RED}${failed} failed${C.RESET}, ${total} total`);
  if (failedNames.length > 0) {
    failMsg(`failed scenarios: ${failedNames.join(" ")}`);
    process.exit(1);
  }
  log(`${C.GREEN}all scenarios passed${C.RESET}`);
}

main().catch((e) => {
  failMsg(String(e?.stack || e));
  cleanup();
  process.exit(1);
});
