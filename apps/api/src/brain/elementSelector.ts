/**
 * elementSelector.ts — L1-a: DURABLE element identity for interaction-graph edges.
 *
 * WHY: today a GraphEdge's element is a ≤40-char text label (crawlMapService safeClickExplore returns strings). Two
 * same-text controls collapse; a relabelled control splits. MEASURED on dent: two distinct "Users" controls (Explore
 * tab-bar vs Progress view) are separable ONLY by fromSig — two same-label controls in the SAME state would merge.
 *
 * A selector has a TIER (how stable its basis is). The tier decides where the selector may be used:
 *   • PAYLOAD: always recorded (so a consumer can re-find the element), regardless of tier.
 *   • DEDUP KEY: included ONLY when the tier is STABLE (id/testid/aria/role+name). A POSITIONAL selector
 *     (nth-of-type) must NOT enter the key — else list re-ordering churns edge keys → mapDiff phantom "drift"
 *     (the xsion-check false-positive the review flagged). Positional-tier edges key on the label as before.
 *
 * Tiers, best → worst:  'id' > 'testid' > 'aria' > 'role-name' > 'positional'
 */
export type SelectorTier = 'id' | 'testid' | 'aria' | 'text' | 'positional';
export interface ElementSelector { selector: string; tier: SelectorTier; label: string }

/**
 * VERIFY-AT-CAPTURE (the smart/dynamic move — ask the app, don't assume). A candidate identity is only trusted when,
 * IN-PAGE and RIGHT NOW, it resolves to EXACTLY the one element it was derived from. This is the pure decision the
 * in-page scan applies per candidate; `elementUniquenessInPage` is the string injected into page.evaluate so the whole
 * scan is one DOM pass (no Playwright round-trips on the hot path). Encoded here so the hermetic can lock the contract.
 *
 * Contract per identity:
 *   • css tier   → document.querySelectorAll(css).length, and the single match IS the target node.
 *   • text tier  → count of elements whose OWN innermost trimmed text === name (the innermost-text-node primitive),
 *                  and the single match IS the target node.
 *   verifiedAtCapture = (matchCount === 1 && theMatchIsTheTarget). ambiguityCount = matchCount (0 = vanished/derive
 *   bug; >1 = genuinely ambiguous in this state — an HONEST signal, stored, never silently dropped).
 * CAVEAT: verified-at-capture proves uniqueness IN THIS STATE AT THIS MOMENT — NOT stability across renders/crawls.
 */
export function verdictFromCounts(matchCount: number, matchIsTarget: boolean): { verifiedAtCapture: boolean; ambiguityCount: number } {
  return { verifiedAtCapture: matchCount === 1 && matchIsTarget, ambiguityCount: matchCount };
}

/**
 * A RESOLVABLE element identity. `tier` decides which fields are populated:
 *   • id | testid | aria | positional → `css` is a REAL CSS selector (querySelector / Playwright `locator(css)`).
 *   • role-name                        → `role`+`name` are a Playwright `getByRole(role, {name})` recipe. There is NO
 *                                        css fallback for this tier — real apps (dent, schooltalk) overwhelmingly have
 *                                        no id/testid/aria on nav/tab/card controls, so role-name is the COMMON case
 *                                        and it MUST resolve. Do NOT synthesize a fake `[__role][__name]` CSS string —
 *                                        that matches nothing (the bug this type replaces).
 * A consumer resolves via: css ? page.locator(css) : page.getByRole(role, { name, exact:true }).
 */
export interface ResolvableIdentity {
  tier: SelectorTier;
  css?: string | null;       // a real CSS selector — for id/testid/aria/positional
  name?: string | null;      // for the text tier: the exact visible text → getByText(name,{exact})
  verifiedAtCapture: boolean;// did this identity resolve to EXACTLY its target element IN-PAGE at capture time?
  ambiguityCount: number;    // in-page match count (1 = unique; >1 = honest ambiguity; 0 = derive bug)
}

/**
 * THE single in-page identity deriver+verifier, as an injectable expression. Both detectGate and safeClickExplore
 * inject this so there is ONE deriver, ONE verifier, no divergence. Given an element + its label, walk the tier
 * ladder (id→testid→aria→text→positional, generated-ids skipped), then VERIFY the chosen recipe resolves to exactly
 * that element in the current DOM. Returns {tier, css, name, verifiedAtCapture, ambiguityCount}. Pure DOM; no
 * Playwright. `innermostTextNode` makes the text tier point at the node whose OWN text is the label (a click bubbles).
 */
export const DERIVE_AND_VERIFY = `
function(el0, label, doc, win) {
  var esc = (win.CSS && win.CSS.escape) ? win.CSS.escape : function(s){ return String(s).replace(/[^a-zA-Z0-9_-]/g,'\\\\$&'); };
  function innermost(root, lab){ var n=root; for(var d=0; d<6; d++){ var kids=n.children?Array.prototype.slice.call(n.children):[]; var hit=null; for(var i=0;i<kids.length;i++){ if(((kids[i].textContent||'').trim().replace(/\\s+/g,' '))===lab){hit=kids[i];break;} } if(!hit)break; n=hit; } return n; }
  var el = label ? innermost(el0, label) : el0;
  var tier, css=null, name=null;
  var id = el.getAttribute('id');
  if (id && !/^(:r|radix-|mui-|headlessui-)/i.test(id) && !/[0-9a-f]{8,}/i.test(id)) { tier='id'; css='#'+esc(id); }
  else { var tid = el.getAttribute('data-testid')||el.getAttribute('data-test')||el.getAttribute('data-cy');
    if (tid) { tier='testid'; css='[data-testid="'+String(tid).replace(/"/g,'\\\\"')+'"]'; }
    else { var al = el.getAttribute('aria-label');
      if (al) { tier='aria'; css=(el.tagName||'').toLowerCase()+'[aria-label="'+String(al).replace(/"/g,'\\\\"')+'"]'; }
      else if (label) { tier='text'; name=label; }
      else { tier='positional'; var path=[],node=el; while(node&&node.nodeType===1&&path.length<6){ var t=(node.tagName||'').toLowerCase(); var p=node.parentNode; if(p){ var sib=Array.prototype.filter.call(p.children,function(c){return c.tagName===node.tagName;}); if(sib.length>1) t+=':nth-of-type('+(sib.indexOf(node)+1)+')'; } path.unshift(t); node=p; } css=path.join(' > '); }
    }
  }
  // VERIFY in-page: does the recipe resolve to exactly this element right now?
  var matchCount=0, matchIsTarget=false;
  try {
    if (css) { var ms=doc.querySelectorAll(css); matchCount=ms.length; for(var j=0;j<ms.length;j++){ if(ms[j]===el){matchIsTarget=true;break;} } }
    else { // text tier: elements whose OWN innermost text === name
      var all=doc.querySelectorAll('*'); for(var k=0;k<all.length;k++){ var e=all[k]; var kids2=e.children; var ownText=(e.textContent||'').trim().replace(/\\s+/g,' '); if(ownText===name){ var isLeafForText=true; if(kids2){ for(var q=0;q<kids2.length;q++){ if(((kids2[q].textContent||'').trim().replace(/\\s+/g,' '))===name){isLeafForText=false;break;} } } if(isLeafForText){ matchCount++; if(e===el)matchIsTarget=true; } } }
    }
  } catch(e2){}
  return { tier: tier, css: css, name: name, verifiedAtCapture: (matchCount===1 && matchIsTarget), ambiguityCount: matchCount };
}`;

/** A tier is STABLE (safe for the dedup key) when it derives from an author-assigned, position-independent basis. */
export function isStableTier(t: SelectorTier): boolean { return t === 'id' || t === 'testid' || t === 'aria' || t === 'text'; }

/**
 * The IN-PAGE derivation, as a STRING to inject (page.evaluate(new Function(...))) — keeps it out of the tsx
 * named-helper `__name` footgun and lets us unit-test the pure ranking separately (rankSelector below mirrors it).
 * Returns {selector, tier, label} for one element. CSS.escape used where available for id/testid values.
 */
/** implicit-ARIA-role for the common interactive tags — so a role-name recipe uses a REAL role getByRole accepts
 *  ('li' is NOT a role; 'listitem' is). Unlisted tags fall back to a tag+hasText recipe (tier stays role-name, css set). */
export const TAG_ROLE: Record<string, string> = { a: 'link', button: 'button', li: 'listitem', td: 'cell', th: 'columnheader', option: 'option', summary: 'button', input: 'textbox' };

/** The historical BASE key: fromSig | kind:label | toSig. Used by the CROSS-CRAWL merge (so an identity upgrade
 *  doesn't fork an edge's history) and as the prefix of the full key. */
export function edgeBaseKey(e: { fromSig?: string; toSig: string; action: { kind: string; label: string } }): string {
  return `${e.fromSig || 'ROOT'}|${e.action.kind}:${e.action.label}|${e.toSig}`;
}

/** canonical string of a resolvable identity, for the dedup key. */
export function identityKey(id: { tier: SelectorTier; css?: string | null; name?: string | null }): string {
  return id.css ? `css:${id.css}` : `text:${id.name || ''}`;
}

/**
 * THE canonical WITHIN-CRAWL edge dedup key — the single source of truth for edge emission. It splits on a STABLE-tier
 * selector so two same-label controls in the SAME state become two edges (the whole point of L1-a). A positional-tier
 * selector is NEVER in the key (it would churn across list re-orderings → mapDiff phantom drift), so those edges key
 * exactly as the historical base. The CROSS-CRAWL merge uses edgeBaseKey (above), NOT this — an identity upgrade must
 * not fork an existing edge's history.
 */
export function edgeKey(e: { fromSig?: string; toSig: string; action: { kind: string; label: string; elementId?: { tier: SelectorTier; css?: string | null; name?: string | null } } }): string {
  const base = edgeBaseKey(e);
  const id = e.action.elementId;
  // include the identity in the WITHIN-crawl key when its tier is STABLE (id/testid/aria/role-name). NB: on real apps
  // the text tier has name≡label, so this rarely SPLITS two same-label controls — that (Cap-3 disambiguation) needs
  // positional-in-key, a separate deliberate step with its own cost (a mid-crawl list re-render can split an edge).
  // L1-a's job is RESOLVABILITY (the identity is in the payload, resolvable), not disambiguation.
  if (id && isStableTier(id.tier)) return `${base}|id:${identityKey(id)}`;
  return base;
}

/**
 * PURE mirror of the in-page tier ranking, for hermetic tests. Given the element's already-extracted attributes,
 * returns the same {tier} decision the in-page code would. (Selector-string construction is trusted to the in-page
 * version; this locks the ranking/skip logic that actually matters.)
 */
export function rankSelectorTier(attrs: {
  id?: string | null; testid?: string | null; ariaLabel?: string | null; role?: string | null; label?: string | null;
}): SelectorTier {
  const id = attrs.id;
  if (id && !/^(:r|radix-|mui-|headlessui-)/i.test(id) && !/[0-9a-f]{8,}/i.test(id)) return 'id';
  if (attrs.testid) return 'testid';
  if (attrs.ariaLabel) return 'aria';
  if (attrs.label) return 'text';
  return 'positional';
}
