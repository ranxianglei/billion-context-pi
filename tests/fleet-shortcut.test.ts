import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDelegate, DEFAULT_FLEET_SHORTCUT, type AdapterConfig } from "../src/config.js";
import { formatShortcutLabel } from "../src/fleet-widget.js";

// #412: the acp_delegate fleet-inspector TUI shortcut was hardcoded to
// "ctrl+alt+f", colliding with pi-subagents' FLEET_OPEN_SHORTCUT. Pi's loader
// only warns on cross-extension conflicts and lets the later-loaded binding win
// silently, so one inspector's key died. The key is now configurable
// (delegate.fleetShortcut) and its default moved off the collision.

test("DEFAULT_FLEET_SHORTCUT is ctrl+alt+d (not the colliding ctrl+alt+f)", () => {
  assert.equal(DEFAULT_FLEET_SHORTCUT, "ctrl+alt+d");
});

test("resolveDelegate: fleetShortcut defaults to ctrl+alt+d when unset", () => {
  assert.equal(resolveDelegate({}).fleetShortcut, "ctrl+alt+d");
});

test("resolveDelegate: boolean delegate shorthand keeps the default shortcut", () => {
  assert.equal(resolveDelegate({ delegate: true }).fleetShortcut, "ctrl+alt+d");
});

test("resolveDelegate: custom fleetShortcut is honored verbatim", () => {
  assert.equal(resolveDelegate({ delegate: { fleetShortcut: "ctrl+shift+f" } }).fleetShortcut, "ctrl+shift+f");
});

test("resolveDelegate: empty-string fleetShortcut disables registration", () => {
  assert.equal(resolveDelegate({ delegate: { fleetShortcut: "" } }).fleetShortcut, "");
});

test("resolveDelegate: non-string fleetShortcut (malformed acp.json) falls back to default", () => {
  const adapter = { delegate: { fleetShortcut: 42 } } as unknown as AdapterConfig;
  assert.equal(resolveDelegate(adapter).fleetShortcut, "ctrl+alt+d");
});

test("formatShortcutLabel: title-cases modifiers and single-character keys", () => {
  assert.equal(formatShortcutLabel("ctrl+alt+d"), "Ctrl+Alt+D");
  assert.equal(formatShortcutLabel("ctrl+shift+f"), "Ctrl+Shift+F");
  assert.equal(formatShortcutLabel("super+k"), "Super+K");
});
