/**
 * pageInventory.ts — capture the CLICKABLE INVENTORY of the current page (clickables + inputs + overlays + a text
 * snapshot + a screenshot data-URL), the input to SoA's `explorePage` (the on-stall visual-reasoning brain).
 *
 * Extracted from crawlMapService so BOTH the crawl (when the mechanical crawl stalls) AND the intent-runner (when a
 * bug-repro/flow step can't find its control) can hand SoA the same view and ask "what's actually here, what do I
 * click to get past this?" — reusing #199/#200's on-stall reasoning instead of re-inventing it. intentRunner stays
 * free of ws/store/emit; this module is a pure page-capture (a single page.evaluate + an optional screenshot).
 *
 * NOTE: the page.evaluate is HELPER-FREE inside (the tsx/esbuild __name rule — see evalShim.ts): no named closures.
 */
type PageLike = { url: () => string; evaluate: (fn: any) => Promise<any>; screenshot?: (opts: any) => Promise<Buffer> };

export interface PageInventory {
  url: string; title: string; text: string; viewport?: string;
  clickables: Array<{ label: string; tag: string; at: string; size: string; prominent: boolean; color?: string }>;
  inputs: Array<{ kind: string; label: string; at: string }>;
  overlays: Array<{ label: string; zIndex: number; coversPct: number; role?: string }>;
  screenshot?: string;   // data-URL, for multimodal reasoning (a visual-only gate the layout-as-text can't capture)
}

/** Capture the page's clickable inventory (labels + layout regions + prominence + overlays + inputs). Pure capture. */
export async function pageClickableInventory(page: PageLike): Promise<PageInventory> {
  try {
    const data = await page.evaluate(() => {
      const doc: any = (globalThis as any).document; const win: any = (globalThis as any);
      const vw = win.innerWidth || 1280, vh = win.innerHeight || 800;
      const visible = (el: any, r: any) => r.width > 0 && r.height > 0 && win.getComputedStyle(el).visibility !== 'hidden' && win.getComputedStyle(el).display !== 'none' && r.bottom > 0 && r.top < vh;
      const region = (r: any) => {
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const h = cy < vh * 0.25 ? 'top' : cy > vh * 0.75 ? 'bottom' : 'mid';
        const v = cx < vw * 0.33 ? 'left' : cx > vw * 0.66 ? 'right' : 'center';
        return `${h}-${v}`;
      };
      const roleSel = 'button, a, [role="button"], [role="menuitem"], [role="tab"], [role="option"], [role="link"], [onclick]';
      const set = new Set<any>(Array.prototype.slice.call(doc.querySelectorAll(roleSel)));
      const allEls: any[] = Array.prototype.slice.call(doc.querySelectorAll('li, div, span, article, [class*="item" i], [class*="card" i], [class*="tile" i], [class*="portal" i], [class*="option" i], [class*="menu" i], [class*="row" i], [class*="nav" i]'));
      for (const el of allEls) {
        try {
          const t = (el.textContent || '').trim();
          if (!t || t.length < 2 || t.length > 45) continue;
          if (el.children && el.children.length > 2) continue;
          if (el.querySelector && el.querySelector('button, a, [role="button"]')) continue;
          set.add(el);
        } catch {}
      }
      const seen = new Set<string>(); const clickables: any[] = [];
      set.forEach((el: any) => {
        const label = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 45);
        if (!label || seen.has(label)) return;
        const r = el.getBoundingClientRect();
        if (!visible(el, r)) return;
        seen.add(label);
        const cs = win.getComputedStyle(el);
        clickables.push({ label, tag: el.tagName.toLowerCase(), at: region(r), size: `${Math.round(r.width)}x${Math.round(r.height)}`, prominent: (r.width * r.height) > (vw * vh * 0.02), color: cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' ? cs.backgroundColor : undefined });
      });
      const inputs: any[] = [];
      Array.prototype.slice.call(doc.querySelectorAll('input, textarea, select')).forEach((el: any) => {
        const r = el.getBoundingClientRect(); if (!visible(el, r)) return;
        const t = (el.type || el.tagName).toLowerCase(); if (['hidden', 'submit', 'button'].includes(t)) return;
        const lab = el.getAttribute('aria-label') || el.placeholder || el.name || el.id || '';
        inputs.push({ kind: t, label: String(lab).slice(0, 40), at: region(r) });
      });
      const overlays: any[] = [];
      Array.prototype.slice.call(doc.querySelectorAll('*')).slice(0, 4000).forEach((el: any) => {
        try {
          const cs = win.getComputedStyle(el); const pos = cs.position;
          if (pos !== 'fixed' && pos !== 'absolute') return;
          const z = parseInt(cs.zIndex || '0', 10); if (!(z >= 100)) return;
          const r = el.getBoundingClientRect(); const cover = (r.width * r.height) / (vw * vh);
          if (cover < 0.25) return;
          const label = (el.getAttribute('aria-label') || el.className || el.getAttribute('role') || 'overlay').toString().slice(0, 40);
          overlays.push({ label, zIndex: z, coversPct: Math.round(cover * 100), role: el.getAttribute('role') || undefined });
        } catch {}
      });
      return { url: win.location.href, title: doc.title || '', text: (doc.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 800), viewport: `${vw}x${vh}`, clickables: clickables.slice(0, 50), inputs: inputs.slice(0, 15), overlays: overlays.slice(0, 5) };
    });
    return data;
  } catch { return { url: page.url(), title: '', text: '', clickables: [], inputs: [], overlays: [] }; }
}
