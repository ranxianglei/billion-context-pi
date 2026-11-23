import { isProxy } from "node:util/types";
import { messageIdentity } from "./messages.js";

const UNSUPPORTED = Symbol("unsupported identity input");
type Snapshot = string | number | boolean | null | undefined | ObjectSnapshot;
interface ObjectSnapshot {
  readonly prototype: object | null;
  readonly keys: readonly string[];
  readonly values: readonly Snapshot[];
}

export interface CachedIdentity {
  readonly identity: string;
  readonly snapshot: Snapshot | typeof UNSUPPORTED;
}

export class MessageIdentityCache {
  private readonly byMessage = new WeakMap<object, CachedIdentity>();

  read(message: object, previous?: CachedIdentity): CachedIdentity {
    const cached = this.byMessage.get(message);
    if (cached && matches(message, cached.snapshot, true)) return cached;
    if (previous && previous !== cached && matches(message, previous.snapshot, true)) {
      this.byMessage.set(message, previous);
      return previous;
    }
    const snapshot = capture(message, true);
    const result: CachedIdentity = { identity: messageIdentity(message), snapshot };
    if (snapshot !== UNSUPPORTED) this.byMessage.set(message, result);
    else if (cached) this.byMessage.delete(message);
    return result;
  }
}

// Save property values, not references to mutable content blocks or tool arguments.
// Accessors, proxies and other non-JSON shapes always use messageIdentity directly.
function capture(value: unknown, root = false): Snapshot | typeof UNSUPPORTED {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value !== "object" || isProxy(value)) return UNSUPPORTED;
  const prototype: object | null = Object.getPrototypeOf(value);
  const array = Array.isArray(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return UNSUPPORTED;
  const keys = Object.getOwnPropertyNames(value);
  if (array && keys.length !== value.length + 1) return UNSUPPORTED;
  const values: Snapshot[] = [];
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    if ((array && key === "length") || (root && !array && key === "timestamp")) {
      values.push(undefined);
      continue;
    }
    if (array && key !== String(i)) return UNSUPPORTED;
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property?.enumerable || !("value" in property)) return UNSUPPORTED;
    const child = capture(property.value);
    if (child === UNSUPPORTED) return UNSUPPORTED;
    values.push(child);
  }
  return { prototype, keys, values };
}

function matches(value: unknown, snapshot: CachedIdentity["snapshot"], root = false): boolean {
  if (snapshot === UNSUPPORTED) return false;
  if (snapshot === null || typeof snapshot !== "object") return Object.is(value, snapshot);
  if (value === null || typeof value !== "object" || isProxy(value) || Object.getPrototypeOf(value) !== snapshot.prototype) return false;
  const array = snapshot.prototype === Array.prototype;
  if (array !== Array.isArray(value)) return false;
  const keys = Object.getOwnPropertyNames(value);
  if (keys.length !== snapshot.keys.length) return false;
  if (array && (value as unknown[]).length + 1 !== keys.length) return false;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    if (key !== snapshot.keys[i]) return false;
    if ((array && key === "length") || (root && !array && key === "timestamp")) continue;
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property?.enumerable || !("value" in property) || !matches(property.value, snapshot.values[i])) return false;
  }
  return true;
}
