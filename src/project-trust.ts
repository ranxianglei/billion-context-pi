/** Pi project trust (#624): `ctx.isProjectTrusted()` is the SOLE trust signal
 *  for project-scoped acp.json keys and project prompt packs. Fail closed: a
 *  missing method, a throw, or any non-true result means untrusted — an
 *  untrusted project must never influence ACP policy or prompts. */
export function readProjectTrusted(source?: unknown): boolean {
  if (!source || typeof source !== "object") return false;
  const fn = (source as { isProjectTrusted?: unknown }).isProjectTrusted;
  if (typeof fn !== "function") return false;
  try {
    return (fn as () => unknown).call(source) === true;
  } catch {
    return false;
  }
}
