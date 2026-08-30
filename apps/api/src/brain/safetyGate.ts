/**
 * safetyGate.ts — CRAWL-e: decide whether a UI element is SAFE for the crawler to click, or GENUINELY DESTRUCTIVE
 * (must be mapped-but-never-clicked, so a crawl of a live/prod app can never fire a real Send/Delete/Pay).
 *
 * Design (measured on real dent labels: the lexicon catches every Send/Delete but over-flags Cancel/Reset/Update-view):
 *   1. A high-recall RISK LEXICON is the danger prefilter (cheap, catches all real danger).
 *   2. CHEAP DEMOTION from DOM structure — a lexicon-flagged element that is really NAVIGATION or a READ (a same-origin
 *      <a href>, or a control inside a method=GET / no-method form) is demoted to 'safe'. This recovers the false
 *      positives with zero LLM/bridge cost. A method=POST / type=submit / formaction control stays 'dangerous'.
 *   3. Genuinely-destructive elements are TAGGED (risk + category + why) and mapped, never clicked.
 *   4. (Mode 1, wired separately) SoA can read the code for flagged labels to demote FPs + enrich — code gives
 *      KNOWLEDGE not permission; genuinely-destructive stays mapped-unclicked.
 *
 * This module is the pure decision layer (no browser). The crawler passes it per-element DOM facts it already has.
 */

// high-recall danger lexicon (word-boundaried). Intentionally broad — demotion (below) removes the false positives.
export const RISK_LEXICON = /\b(delete|remove|destroy|erase|drop|send|publish|post|pay|buy|purchase|checkout|charge|refund|transfer|withdraw|deposit|deactivate|disable|suspend|ban|revoke|log\s*out|sign\s*out|unsubscribe|approve|reject|confirm|submit|save|create|add|update|edit|archive|reset|clear|cancel)\b/i;

// the genuinely-irreversible / real-world-side-effect core — these NEVER auto-demote on label alone (structure can
// still demote a link/GET-form, but the label itself is high-signal-danger, used for category + the never-click default).
const HARD_DANGER = /\b(delete|remove|destroy|erase|drop|send|publish|pay|buy|purchase|checkout|charge|refund|transfer|withdraw|deposit|deactivate|disable|suspend|ban|revoke|log\s*out|sign\s*out|unsubscribe)\b/i;

// the benign-verb tail the lexicon includes for recall but which are usually safe UNLESS on a non-idempotent form
// (save/create/update/submit/confirm are only dangerous when they actually POST — structure decides).
const SOFT_VERB = /\b(approve|reject|confirm|submit|save|create|add|update|edit|archive|reset|clear|cancel)\b/i;

export type RiskCategory = 'destructive' | 'messaging' | 'payment' | 'account-mgmt' | 'auth' | 'permissions' | 'none';

/** category from the label — the published taxonomy anchor {auth, payment, account-mgmt, messaging, permissions}. */
export function riskCategory(label: string): RiskCategory {
  const l = (label || '').toLowerCase();
  if (/\b(pay|buy|purchase|checkout|charge|refund|transfer|withdraw|deposit|invoice|billing)\b/.test(l)) return 'payment';
  if (/\b(send|publish|post|message|notify|notification|email|sms|broadcast|announce)\b/.test(l)) return 'messaging';
  if (/\b(delete|remove|destroy|erase|drop|deactivate|disable|suspend|ban|archive)\b/.test(l)) return 'account-mgmt';
  if (/\b(log\s*out|sign\s*out|unsubscribe|password|login|sign\s*in)\b/.test(l)) return 'auth';
  if (/\b(revoke|grant|permission|role|access|admin|privilege)\b/.test(l)) return 'permissions';
  if (/\b(delete|remove|destroy|erase|drop)\b/.test(l)) return 'destructive';
  return 'none';
}

/** DOM facts the crawler already knows about a candidate element — everything here is a cheap synchronous read. */
export interface ElementFacts {
  label: string;
  tag?: string;                 // 'a' | 'button' | 'input' | ...
  href?: string | null;         // for <a> — a same-origin href is NAVIGATION (safe)
  sameOrigin?: boolean;         // is href same-origin? (a cross-origin link is a different concern, not a mutation)
  inFormMethod?: string | null; // the ancestor <form method> ('get' | 'post' | null/none)
  inputType?: string | null;    // for <input>/<button> — 'submit' | 'button' | ...
  hasFormaction?: boolean;      // a formaction attr overrides the form's action → treat as a submit
}

export interface SafetyVerdict {
  risk: 'safe' | 'dangerous';
  category: RiskCategory;
  why: string;
  clickable: boolean;           // may the CRAWLER auto-click it? (dangerous → false: map-but-never-click)
}

/** THE DECISION. Returns safe/dangerous + whether the crawler may click. Pure, synchronous, no bridge. */
export function classifyElement(f: ElementFacts): SafetyVerdict {
  const label = f.label || '';
  const flagged = RISK_LEXICON.test(label);
  if (!flagged) return { risk: 'safe', category: 'none', why: 'no risk term in label', clickable: true };

  const category = riskCategory(label);

  // ── CHEAP DEMOTION (structure beats label) ──
  // a same-origin <a href> is NAVIGATION, not a mutation — safe to follow even if the label says "Delete" (it's a
  // link to a delete-confirmation PAGE, not the destructive act itself). Cross-origin/absent href → don't demote.
  if ((f.tag || '').toLowerCase() === 'a' && f.href && f.sameOrigin && !f.hasFormaction) {
    return { risk: 'safe', category, why: `same-origin link (navigation, not a mutation): ${category}`, clickable: true };
  }
  // a control inside a method=GET (or method-less) form, with no formaction, is a READ (search/filter) — safe.
  const method = (f.inFormMethod || '').toLowerCase();
  const submits = f.inputType === 'submit' || f.hasFormaction || method === 'post';
  if (!submits && (method === 'get' || method === '' ) && !HARD_DANGER.test(label)) {
    return { risk: 'safe', category, why: `read-only control (GET form / no submit): ${category}`, clickable: true };
  }
  // a SOFT verb (save/create/update/confirm/cancel/reset/clear) that does NOT actually submit → benign UI state, safe.
  if (SOFT_VERB.test(label) && !HARD_DANGER.test(label) && !submits) {
    return { risk: 'safe', category, why: 'soft action with no mutation signal (no POST/submit)', clickable: true };
  }

  // ── otherwise it is GENUINELY DANGEROUS: a hard-danger label, or a soft verb that DOES submit a non-idempotent form.
  const reason = HARD_DANGER.test(label)
    ? `hard-danger term ("${label.match(HARD_DANGER)?.[0]}") — irreversible / real-world side effect`
    : `submits a non-idempotent form (${submits ? 'POST/submit/formaction' : 'mutation'})`;
  return { risk: 'dangerous', category: category === 'none' ? 'destructive' : category, why: reason, clickable: false };
}
