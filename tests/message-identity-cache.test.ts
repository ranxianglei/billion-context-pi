import assert from "node:assert/strict";
import { test } from "node:test";
import { MessageIdentityCache } from "../src/message-identity-cache.js";
import { messageIdentity } from "../src/messages.js";

test("memoizes unchanged messages and verified clones, but not nested edits", () => {
  const cache = new MessageIdentityCache();
  const message = {
    role: "assistant",
    timestamp: 1,
    content: [
      { type: "text", text: "First result.\n[m00010]" },
      { type: "toolCall", id: "call-1", arguments: { opts: [{ path: "a", limit: 1 }] } },
    ],
  };
  const first = cache.read(message);
  assert.equal(first.identity, messageIdentity(message));
  message.timestamp++;
  assert.equal(cache.read(message), first);
  const clone = structuredClone(message);
  assert.equal(cache.read(clone, first), first);
  clone.content[1]!.arguments!.opts[0]!.limit = 2;
  const edited = cache.read(clone, first);
  assert.notEqual(edited.identity, first.identity);
  assert.equal(edited.identity, messageIdentity(clone));
  message.content[0]!.text = "Second result.\n\x3cacp tokens=\"2\" type=\"text\"\x3em00010\x3c/acp\x3e";
  const newText = cache.read(message);
  assert.notEqual(newText.identity, first.identity);
  assert.equal(newText.identity, messageIdentity(message));
});

test("does not reuse identities across accessors, proxy changes or shape edits", () => {
  const cache = new MessageIdentityCache();
  const block = { type: "text", text: "original" };
  const message = { role: "user", content: [block] };
  const first = cache.read(message);
  let shown = "first";
  Object.defineProperty(block, "text", { get: () => shown });
  assert.equal(cache.read(message, first).identity, messageIdentity(message));
  shown = "second";
  assert.equal(cache.read(message, first).identity, messageIdentity(message));

  const tracked = { role: "user", content: "first" };
  const proxy = new Proxy(tracked, {});
  const proxyMemo = cache.read(proxy);
  tracked.content = "second";
  assert.notEqual(cache.read(proxy, proxyMemo).identity, proxyMemo.identity);
  assert.equal(cache.read(proxy).identity, messageIdentity(tracked));

  const plain = { role: "user", content: "text", extra: { present: true } };
  const previous = cache.read(plain);
  Object.defineProperty(plain.extra, "present", { enumerable: false });
  assert.equal(cache.read(plain, previous).identity, messageIdentity(plain));
  assert.notEqual(cache.read(plain).identity, previous.identity);
});
