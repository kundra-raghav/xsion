/**
 * codeDerived.hermetic.ts — locks FACET 4's provenance LADDER (the order that must not invert): code is a PRIOR below
 * one observation; agreement upgrades; divergence demotes and exits as an observation, never a verdict.
 * Run: cd apps/api && npx tsx src/brain/comprehension/codeDerived.hermetic.ts
 */
import { parseCode, reconcile } from './codeDerived';
import { confidence } from './substrate';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d?: string) => { if (c) pass++; else { fail++; console.error(`  ✗ ${n}${d ? ' — ' + d : ''}`); } };

const SRC = `
  const ORDER_STATUS = ['draft','approved','shipped'];
  function guard(user){ if (user.role === 'admin') return true; if (hasRole('editor')) return true; return false; }
  const TAX = 0.2;                       // not an enum
  const ONE = ['solo'];                  // 1-elem, not a state machine
`;

// 1. PARSE: state enum + role guards extracted; non-enums ignored.
{
  const cm = parseCode(SRC, { file: 'app.html' });
  ok('parses the ORDER_STATUS enum', cm.stateEnums.length === 1 && cm.stateEnums[0].values.observed.join(',') === 'draft,approved,shipped');
  ok('entity inferred from the symbol', cm.stateEnums[0].entity === 'order');
  ok('parses BOTH role guards (admin, editor)', cm.roleGuards.map((g) => g.role).sort().join(',') === 'admin,editor');
  ok('ignores a non-enum const + a 1-element list', cm.stateEnums.length === 1);
  ok('a source enum is OPEN-WORLD (never complete)', (cm.stateEnums[0].values as any).complete === false);
}

// 2. THE LADDER — code alone is a PRIOR: code-unwitnessed capped ≤0.4 (below one observation).
{
  const cm = parseCode(SRC, { file: 'app.html' });
  ok('code-unwitnessed enum capped ≤0.4 (a prior, not a rank above observation)', confidence(cm.stateEnums[0].claim) <= 0.4 + 1e-9);
}

// 3. AGREEMENT: an observation whose values are a SUBSET of the code enum → code-and-observed (rises ABOVE 0.4).
{
  const cm = parseCode(SRC, { file: 'app.html' });
  const r = reconcile(cm.stateEnums, { order: ['draft', 'approved'] });
  ok('agreeing observation → code-and-observed', r.enums[0].claim.provenance === 'code-and-observed', 'got ' + r.enums[0].claim.provenance);
  ok('… confidence now exceeds the code-unwitnessed ceiling (0.4)', confidence(r.enums[0].claim) > 0.4);
  ok('… no divergence recorded on agreement', r.divergences.length === 0);
}

// 4. DIVERGENCE: the app produces a state NOT in the code enum → OBSERVED WINS, code claim DEMOTED, exits as an
//    OBSERVATION (never a verdict), and the union is OPEN-WORLD (runtime exceeds code).
{
  const cm = parseCode(SRC, { file: 'app.html' });
  const r = reconcile(cm.stateEnums, { order: ['draft', 'archived'] });   // 'archived' not in code
  ok('divergence recorded (code says X / app did Y)', r.divergences.length === 1 && r.divergences[0].runtimeValue === 'archived');
  ok('… it is an OBSERVATION note, never a verdict/bug word', !/bug|broke|fail|invalid|wrong|defect/i.test(r.divergences[0].note));
  ok('… the code claim is DEMOTED (records the miss), not ranked above the observation', r.enums[0].claim.misses >= 1);
  ok('… the open-world union carries BOTH code and runtime values', ['draft', 'approved', 'shipped', 'archived'].every((v) => r.enums[0].values.observed.includes(v)));
  ok('… and the union stays open-world (never closed by code)', (r.enums[0].values as any).complete === false);
}

// 5. BLACKBOX: no source → parsed:false, none mode, the model SHAPE still stands (empty, honest whyEmpty).
{
  const cm = parseCode(undefined);
  ok('no source → parsed:false, parseMode none', cm.parsed === false && cm.parseMode === 'none');
  ok('… and reconcile over zero code enums is a clean empty (crawl-only model holds)', reconcile(cm.stateEnums, { order: ['x'] }).enums.length === 0);
}

// 6. DEDUP: re-parsing the SAME file yields the SAME evidenceId (one hit ever, not N) — confidence can't inflate by re-parse.
{
  const a = parseCode(SRC, { file: 'app.html' }).stateEnums[0];
  const b = parseCode(SRC, { file: 'app.html' }).stateEnums[0];
  ok('same file+symbol+content → identical evidenceId (dedup-stable)', a.values.evidenceIds[0] === b.values.evidenceIds[0]);
}

console.log(`\ncodeDerived hermetic: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
