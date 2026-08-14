/**
 * crawlTypes.ts — the onboarding + crawl-map spine's data model + event vocabulary.
 * A URL becomes a PROJECT with a semantic MAP (flows + API inventory). The crawl streams live so the user
 * watches Xsion think and click; it BLOCKS only on credentials. Bounded + resumable (never exhaustive).
 */

// ── A TYPED FIELD REQUIREMENT (item 3): what a form field NEEDS to be filled, read GENERICALLY from what the DOM
// declares — NOT hardcoded to email/password. Credentials become ONE instance of this shape. In Mode 1, SoA
// cross-checks against the code to add server-side requirements the DOM doesn't show (e.g. a max file size).
export interface FieldRequirement {
  selector: string;            // a stable selector to find the field again
  kind: string;                // email | password | file | text | number | date | tel | url | select | checkbox …
  label?: string;              // visible label / placeholder / aria-label
  required: boolean;
  accepts?: string[];          // for file inputs: normalized categories, e.g. ['image','pdf']
  pattern?: string;            // regex the DOM declares
  min?: string; max?: string; maxLength?: number;
  prompt: string;              // human phrasing of the ask ("Upload an image or PDF")
  met: boolean;                // has the user supplied a value? (never store the value in the map — reference only)
  source: 'dom' | 'dom+code';  // 'dom+code' = a code cross-check confirmed/augmented it (Mode 1)
  codeNote?: string;           // what the code added, e.g. "server rejects files > 5MB (upload.ts:22)"
}

// ── MULTI-ROLE (item 4): one URL, N roles, each its own flows. A role is a credential set; the crawl runs ONCE
// PER ROLE and every mapped entity is TAGGED with the roles that actually saw it (verified, not guessed). This is
// how "nothing is left" becomes CHECKABLE — per-role coverage shows which routes a role reached and which routes
// only one role sees. Credentials are NEVER persisted in plaintext (env/request only) — the map holds the label.
export interface RoleDef {
  id: string;
  name: string;          // e.g. 'admin', 'owner', 'customer'
  hasCredentials: boolean;  // whether a credential set was supplied for this role (creds themselves not stored)
  crawledAt?: string;
}

// ── The persisted map that turns a URL into a mapped project ──
export interface MappedPage {
  id: string;
  url: string;
  path: string;           // pathname, the human-readable route
  title?: string;
  screenshotKey?: string;
  fingerprint?: string;
  interactives: number;   // count of buttons/links/inputs found
  requirements?: FieldRequirement[];  // typed field requirements found on this page (item 3)
  roles?: string[];       // role ids that reached this page (item 4). Absent/empty = the default single crawl.
}

export interface ApiEndpoint {
  method: string;
  url: string;            // normalized (ids → :id) so repeat calls collapse
  statuses: number[];     // observed status codes
  count: number;          // times seen
  samplePayload?: string; // request body sample (truncated, redacted)
  sampleResponse?: string;// response body sample (truncated)
  firstSeenOnPath?: string;
  // GraphQL: a single /graphql url is meaningless — the OPERATION identifies the call.
  graphql?: boolean;
  gqlKind?: 'query' | 'mutation' | 'subscription';
  gqlOperation?: string;  // the operation name, derived from the payload
  roles?: string[];       // role ids that fired this endpoint (item 4)
}

/** Parse a GraphQL request body → {kind, operation}. A /graphql endpoint is ONE url, so the operation name
 * (from the payload) is what actually identifies the call. Handles {query, operationName, variables}. */
export function parseGraphql(body?: string): { graphql: boolean; gqlKind?: 'query' | 'mutation' | 'subscription'; gqlOperation?: string } {
  if (!body) return { graphql: false };
  try {
    const j = JSON.parse(body);
    const doc = Array.isArray(j) ? j[0] : j;           // batched queries → first
    const q: string = doc?.query || '';
    if (!q) return { graphql: false };
    // kind = leading keyword; operation = explicit operationName, else the first field selected
    const kindMatch = q.match(/\b(query|mutation|subscription)\b/i);
    const kind = (kindMatch?.[1]?.toLowerCase() as any) || 'query';
    let op = doc.operationName as string | undefined;
    if (!op) {
      const named = q.match(/\b(?:query|mutation|subscription)\s+([A-Za-z_][\w]*)/i);
      op = named?.[1];
    }
    if (!op) {
      // fall back to the first selected field inside the outer braces
      const field = q.replace(/\b(query|mutation|subscription)\b[^{]*\{/i, '{').match(/\{\s*([A-Za-z_][\w]*)/);
      op = field?.[1];
    }
    return { graphql: true, gqlKind: kind, gqlOperation: op || 'anonymous' };
  } catch { return { graphql: false }; }
}

export type FlowConfidence = 'high' | 'medium' | 'low';
export interface MappedFlow {
  id: string;
  name: string;
  role: string;                 // SoA's guessed role LABEL (from synthesis) — a hint, not verified capture
  steps: { intent: string; expectedOutcome?: string }[];
  confidence: FlowConfidence;   // per-flow — user corrects only low/medium ones
  reasoning?: string;           // why SoA thinks this is a flow (one line — the evidence)
  description?: string;         // 2-4 sentences: what the flow/feature DOES + why it matters (a QA-lead description)
  breaksIf?: string;            // the single sharpest way this flow breaks in practice (what to test)
  businessValue?: 'critical' | 'important' | 'minor';
  userCorrected?: boolean;
  userNote?: string;
  roles?: string[];             // role ids whose crawl surfaced this flow (item 4 — verified, unlike `role`)
}

export interface ProjectMap {
  baseUrl: string;
  mode: 'code' | 'blackbox';
  repo?: string;
  pages: MappedPage[];
  flows: MappedFlow[];
  api: ApiEndpoint[];
  crawledAt: string;
  bounded: { maxPages: number; maxActionsPerPage: number; reachedLimit: boolean };
  status?: 'crawling' | 'done';
  // COMPLETENESS (item 2): the crawl is bounded, so honesty means recording what it DIDN'T reach.
  // frontier = the still-unvisited queue (persisted so a resume CONTINUES from it, not from scratch).
  // knownUnknowns = routes seen-but-not-visited (budget clipped) + links dropped by the per-page cap.
  // "nothing is left" is only checkable if the map carries this set.
  frontier?: Array<{ url: string; clicks?: Array<string | { fill: string; value: string }> } | string>;   // Nav entries (url + action-path)
  knownUnknowns?: string[];
  // the DECLARED route manifest (Mode 1, from SoA reading the router). Kept in the map — not just used to seed
  // the crawl — because item 3 (typed field requirements) + item 4 (multi-role) both need requiresAuth/role:
  // a requiresAuth route IS a route with a credential requirement.
  routeManifest?: { path: string; requiresAuth: boolean; role: string }[];
  // MULTI-ROLE (item 4): the roles crawled into this map. Every page/flow/api carries the role ids that saw it.
  roles?: RoleDef[];
}

// ── The live crawl event stream (the agentic-browser view subscribes) ──
export type CrawlEvent =
  | { type: 'crawl:phase'; phase: 'launch' | 'crawl' | 'network' | 'synthesize' | 'await-creds' | 'done'; label: string }
  | { type: 'crawl:think'; message: string }                       // the thinking stream
  | { type: 'crawl:navigate'; url: string; path: string }          // moved to a page
  | { type: 'crawl:screenshot'; dataUrl: string; path: string }    // a frame of the page (the "browser view")
  | { type: 'crawl:cursor'; x: number; y: number; label?: string } // synthetic cursor position (real-time clicks)
  | { type: 'crawl:action'; kind: string; label: string; path: string } // clicked/typed something
  | { type: 'crawl:page-found'; page: MappedPage }
  | { type: 'crawl:api'; endpoint: ApiEndpoint }                   // recorded an API call
  | { type: 'crawl:need-creds'; forUrl: string; message: string }  // BLOCKING: overlay prompts the user
  | { type: 'crawl:flow'; flow: MappedFlow }                       // a flow SoA identified (with confidence)
  | { type: 'crawl:done'; map: ProjectMap };
