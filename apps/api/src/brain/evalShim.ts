/**
 * evalShim.ts — the systemic fix for the tsx/esbuild `__name` bug.
 *
 * tsx runs with esbuild `keepNames: true`, which wraps EVERY named function/arrow (`const f = () => …`,
 * `function f(){}`) with a `__name(f, "f")` helper call. When such code is serialized into a `page.evaluate`
 * browser context, `__name` does not exist there → the evaluate throws "ReferenceError: __name is not defined",
 * the caller's try/catch swallows it, and the evaluate silently returns its catch-value. This has silently
 * degraded pageClickableInventory / extractFieldRequirements / resolveIdentifierField / fillByLabel in production.
 *
 * Rather than hand-inline every helper across ~4 complex evaluate bodies (error-prone, and any NEW named helper
 * re-introduces the bug), we define `__name` in the page context ONCE via addInitScript, before any page script or
 * evaluate runs. The `|| ` guard makes it a no-op under a real esbuild build (where __name is already defined), so
 * this is a harmless compatibility shim, not a behaviour change.
 *
 * Call installEvalShim(context) right after every browser.newContext().
 */
export async function installEvalShim(context: { addInitScript: (fn: any) => Promise<void> }): Promise<void> {
  try {
    await context.addInitScript(() => {
      const g: any = globalThis as any;
      if (!g.__name) g.__name = (fn: any) => fn;
    });
  } catch { /* addInitScript can only fail on a closed context; the evaluate fallbacks still degrade safely */ }
}
