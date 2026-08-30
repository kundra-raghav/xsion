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
      // ── SHADOW-DOM DEEP-QUERY (generality FINDING 1): light-DOM querySelectorAll can't see OPEN shadow roots, so a
      // login form / affordance inside a web component is invisible. This returns a deduped Array SUPERSET of a plain
      // QSA, recursing into open shadow roots (closed roots are inaccessible by design). Iterative, namespace-filtered
      // (skips svg/math subtrees), node-budgeted (degrades, never throws). Call sites use it with a light-DOM fallback.
      if (!g.__xsionQueryAllDeep) {
        g.__xsionQueryAllDeep = function (sel: string, root: any) {
          const d: any = (globalThis as any).document;
          const start: any = root || d;
          const out: any[] = [];
          const seen: any = (typeof Set !== 'undefined') ? new Set() : null;
          const push = function (el: any) { if (!el) return; if (seen) { if (seen.has(el)) return; seen.add(el); } out.push(el); };
          const roots: any[] = [start];
          let nodeBudget = 20000;
          const XHTML = 'http://www.w3.org/1999/xhtml';
          while (roots.length) {
            const r = roots.shift();
            if (!r) continue;
            try { if (r.querySelectorAll) { const m = r.querySelectorAll(sel); for (let i = 0; i < m.length; i++) push(m[i]); } } catch (e) { /* bad selector for scope */ }
            try {
              const doc: any = r.ownerDocument || (r.nodeType === 9 ? r : d);
              if (!doc || !doc.createTreeWalker) continue;
              const walker = doc.createTreeWalker(r, 0x1 /* SHOW_ELEMENT */, {
                acceptNode: function (n: any) { const ns = n && n.namespaceURI; if (ns && ns !== XHTML) return 2 /* REJECT */; return 1 /* ACCEPT */; },
              } as any);
              let cur: any = walker.nextNode();
              while (cur) { if (--nodeBudget <= 0) return out; const sr = cur.shadowRoot; if (sr) roots.push(sr); cur = walker.nextNode(); }
            } catch (e) { /* TreeWalker unavailable / detached */ }
          }
          return out;
        };
      }
    });
  } catch { /* addInitScript can only fail on a closed context; the evaluate fallbacks still degrade safely */ }
}
