#!/usr/bin/env node
/**
 * cli.ts — `xsion check`: the TRIGGER SURFACE. The whole v2 reframe in one command: a developer runs it before
 * pushing and, in ~90s, gets — in their terminal, where they already are — "here's what your change put at risk,"
 * with a hard-signal finding, and a next action. NO git (crawl-over-crawl diff is the spine); LOCAL all-in-one
 * (boots the in-process engine + Playwright on the dev's own machine; creds never leave the box).
 *
 * FLOW: load-or-create the project → RE-CRAWL the live app → mapDiff vs the LAST crawl → if nothing moved, say so
 * and exit 0 (the beloved-tool "silent when clean" law) → else run BREAK-IT on the changed/added flows only (not
 * everything) → print a colleague-voice report → exit NON-ZERO on a hard `broke` (so a pre-push hook gates on it,
 * and a future git-diff scoping upgrade slots in without reworking this).
 *
 * CONFIG: `.xsion.json` in cwd { projectId?, name, baseUrl, repo?, authorized? }. Credentials come from the ENV
 * ONLY (XSION_EMAIL / XSION_PASSWORD) — never the config file, never logged, never persisted (the store strips
 * them). Run against a PROJECT-LOCAL db by setting XSION_DATA_DIR (defaults to the server's data dir otherwise).
 *
 * Usage:  npx tsx src/cli.ts check [--flows N] [--no-crawl] [--all]
 *   --flows N   cap break-it to the N highest-value changed flows (default 3)
 *   --no-crawl  skip the re-crawl; diff the last two stored crawls (fast, for iterating on the report)
 *   --all       run break-it on ALL mapped flows, not just the changed set (the "full sweep" escape hatch)
 */
import fs from 'fs';
import path from 'path';

// ── tiny ANSI (no dep). Honor NO_COLOR. ──
const useColor = !process.env.NO_COLOR && process.stdout.isTTY;
const c = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = c('2'), bold = c('1'), red = c('31'), green = c('32'), yellow = c('33'), cyan = c('36'), gray = c('90');

function die(msg: string, code = 2): never { console.error(red('✗ ') + msg); process.exit(code); }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface XsionConfig { projectId?: string; name?: string; baseUrl?: string; repo?: string; authorized?: boolean; }

export interface FeatureResult { feature: string; findings: Array<{ verdict?: string }> }
export interface Coverage { code: 0 | 1 | 2; kind: 'broke' | 'nothing-verified' | 'held'; verified: number; unreached: number; noPlan: number; total: number; note: string }
/**
 * The exit + coverage decision, PURE so it's hermetically testable (the live-run bug was here: "safe to push" printed
 * after break-it tested nothing). Three buckets — verified (≥1 held/broke landed), unreached (had a plan, nothing
 * landed = all needs-review), noPlan (no attack plan at all). Contract:
 *   • any hard break / status regression → code 1 ("do not push")
 *   • zero verified (everything unreached/noPlan) → code 2 ("nothing verified", never "safe to push")
 *   • ≥1 verified, none broke → code 0, but the note names any not-covered targets (never hide partial coverage)
 */
export function summarizeCoverage(results: FeatureResult[], hardBroke: boolean, statusRegressions: number): Coverage {
  const isVerified = (r: FeatureResult) => r.findings.some((f) => ['held', 'passed', 'broke'].includes(f.verdict || ''));
  const totalBroke = results.reduce((n, r) => n + r.findings.filter((f) => f.verdict === 'broke').length, 0);
  const verified = results.filter((r) => r.findings.length && isVerified(r)).length;
  const unreached = results.filter((r) => r.findings.length && !isVerified(r)).length;
  const noPlan = results.filter((r) => !r.findings.length).length;
  const notCovered = unreached + noPlan;
  if (hardBroke) return { code: 1, kind: 'broke', verified, unreached, noPlan, total: results.length,
    note: `${totalBroke} hard break${totalBroke === 1 ? '' : 's'}${statusRegressions ? ` + ${statusRegressions} status regression(s)` : ''} — do not push.` };
  if (!verified) return { code: 2, kind: 'nothing-verified', verified, unreached, noPlan, total: results.length,
    note: `Nothing verified — ${notCovered} target(s) could not be exercised (login gate, authorization needed, or no attack plan).` };
  const cov = notCovered ? ` — but ${notCovered} target(s) NOT verified (${unreached} unreached, ${noPlan} no-plan); re-run with creds/authorization to cover them` : ' Safe to push.';
  return { code: 0, kind: 'held', verified, unreached, noPlan, total: results.length, note: `${verified}/${results.length} target(s) verified & held.${cov}` };
}

function loadConfig(): XsionConfig {
  const p = path.join(process.cwd(), '.xsion.json');
  if (!fs.existsSync(p)) die(`No .xsion.json in ${process.cwd()}. Create one:\n` + gray(JSON.stringify({ name: 'my-app', baseUrl: 'http://localhost:3000', repo: '.', authorized: true }, null, 2)));
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (e: any) { die(`.xsion.json is not valid JSON: ${e.message}`); }
}

function parseArgs(argv: string[]) {
  const a = { cmd: argv[0] || 'check', flows: 3, crawl: true, all: false };
  for (let i = 1; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--flows') a.flows = Math.max(1, parseInt(argv[++i] || '3', 10) || 3);
    else if (v === '--no-crawl') a.crawl = false;
    else if (v === '--all') a.all = true;
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.cmd !== 'check') die(`Unknown command "${args.cmd}". Only \`xsion check\` is supported.`);

  // Point the store at a project-local db unless the caller already set one (keeps the dev's data on their box).
  if (!process.env.XSION_DATA_DIR && !process.env.XSION_DB_FILE) {
    process.env.XSION_DATA_DIR = path.join(process.cwd(), '.xsion');
  }

  const cfg = loadConfig();
  if (!cfg.baseUrl) die('.xsion.json needs a "baseUrl" (the live app to test).');

  // Lazy import AFTER env is set, so the store reads the right db path.
  const { store } = await import('./store');
  const { startCrawlMap } = await import('./brain/crawlMapService');
  const { startBreakIt } = await import('./brain/breakItService');
  const { mapDiff, summarizeDiff } = await import('./brain/mapDiff');

  // ALWAYS flush the store before exiting — persist() is fire-and-forget, so a bare process.exit() drops the
  // just-recorded run (a break-it artifact vanished this way in the live dent run). Route every exit through here.
  const finish = async (code: number): Promise<never> => { await store.flush().catch(() => {}); process.exit(code); };

  // ── resolve the project (create on first run) ──
  let projectId = cfg.projectId;
  if (projectId && !store.getProject(projectId)) projectId = undefined;
  if (!projectId) {
    const { v4: uuid } = await import('uuid');
    projectId = uuid();
    store.createProject({ id: projectId, name: cfg.name || cfg.baseUrl!, baseUrl: cfg.baseUrl!, createdAt: new Date().toISOString(),
      security: cfg.authorized ? { authorized: true, authorizedAt: new Date().toISOString() } : undefined } as any);
    // write the id back so subsequent runs reuse the same project (and its crawl history)
    try { fs.writeFileSync(path.join(process.cwd(), '.xsion.json'), JSON.stringify({ ...cfg, projectId }, null, 2) + '\n'); } catch { /* non-fatal */ }
    console.log(dim(`· created project ${projectId.slice(0, 8)} for ${cfg.baseUrl}`));
  } else if (cfg.authorized && !(store.getProject(projectId) as any)?.security?.authorized) {
    store.updateProject(projectId, { security: { authorized: true, authorizedAt: new Date().toISOString() } } as any);
  }

  console.log('\n' + bold(cyan('xsion check')) + '  ' + dim(cfg.baseUrl!) + '\n');

  // ── STEP 1: re-crawl (unless --no-crawl) ──
  if (args.crawl) {
    process.stdout.write(gray('· crawling the live app…'));
    const email = process.env.XSION_EMAIL, password = process.env.XSION_PASSWORD;   // ENV ONLY — never from config/logs
    startCrawlMap(projectId, { baseUrl: cfg.baseUrl!, repo: cfg.repo, email, password });
    // poll the stored map until this crawl completes (status flips crawling→done). Bounded wait.
    const deadline = Date.now() + 5 * 60_000;
    let lastPages = -1;
    for (;;) {
      await sleep(1200);
      const m = store.getProjectMap(projectId);
      const pages = m?.pages?.length ?? 0;
      if (pages !== lastPages) { process.stdout.write(gray(` ${pages} pages`)); lastPages = pages; }
      if (m?.status === 'done') break;
      if (Date.now() > deadline) { process.stdout.write(yellow(' (crawl timed out — diffing what was mapped)')); break; }
    }
    process.stdout.write('\n');
  }

  // ── STEP 2: diff vs the last crawl ──
  const cur = store.getProjectMap(projectId);
  if (!cur) die('No crawl map for this project. Run without --no-crawl first.');
  const prev = (store as any).getPreviousProjectMap?.(projectId);
  const diff = mapDiff(prev, cur);

  console.log(bold('\nWhat changed since the last crawl'));
  if (!prev) {
    console.log(dim('  (first crawl — no baseline yet; everything is new. Re-run after a change to see the diff.)'));
  }
  console.log('  ' + summarizeDiff(diff).split('\n').join('\n  ') + '\n');

  // status regressions are ALREADY hard signals — surface them at the top, they gate the exit even before break-it.
  let hardBroke = diff.statusRegressions.length > 0;

  if (diff.clean) {
    console.log(green('✓ No drift. Nothing to re-test.') + '\n');
    return finish(0);
  }

  // ── STEP 3: run break-it on the CHANGED flows only (the "what to re-test" set) ──
  const map = cur;
  const allFlowNames: string[] = (map.flows || []).map((f: any) => f.name).filter(Boolean);
  let targets = args.all ? allFlowNames : diff.retestFlows;
  // if the diff moved pages but named no flows (e.g. a new page with no synthesized flow), fall back to the flows
  // whose steps touch a changed path — else fall back to all flows so a real change is never silently un-tested.
  // a status regression touches an ENDPOINT, not a page — target the flows whose steps reference that endpoint's path.
  if (!targets.length && diff.statusRegressions.length) {
    const hitPaths = diff.statusRegressions.map((r) => r.url.toLowerCase());
    targets = allFlowNames.filter((name) => {
      const f = (map.flows || []).find((x: any) => x.name === name);
      return (f?.steps || []).some((s: any) => hitPaths.some((hp) => String(s.intent || '').toLowerCase().includes(hp)));
    });
  }
  if (!targets.length && (diff.retestPaths.length || diff.addedPages.length)) {
    const changedPaths = new Set([...diff.retestPaths, ...diff.addedPages].map((p) => String(p).toLowerCase()));
    targets = allFlowNames.filter((name) => {
      const f = (map.flows || []).find((x: any) => x.name === name);
      return (f?.steps || []).some((s: any) => [...changedPaths].some((cp) => String(s.intent || '').toLowerCase().includes(cp)));
    });
    if (!targets.length) targets = allFlowNames;   // last resort — a change with no flow mapping still gets tested
  }
  // PAGE-DERIVED FALLBACK: a crawl that TIMED OUT never synthesized flows (flows are built only at crawl 'done'),
  // so `map.flows` is empty even though real pages were mapped. Derive break-it features from the meaningful added/
  // changed PAGE PATHS (skip '/' and '/login' — not features) so a rich-but-incomplete crawl still gets attacked.
  // break-it selects by feature NAME, so a route like '/blood-analysis' → feature "blood analysis" works directly.
  if (!targets.length) {
    const pagePaths = (args.all ? (map.pages || []).map((p: any) => p.path) : [...diff.retestPaths, ...diff.addedPages]);
    targets = Array.from(new Set(pagePaths
      .map((p: any) => String(p || '').trim())
      .filter((p: string) => p && p !== '/' && !/^\/?login\b/i.test(p.replace(/^\//, '')))
      .map((p: string) => p.replace(/^\//, '').replace(/[/_-]+/g, ' ').trim())
      .filter(Boolean)));
    if (targets.length) console.log(dim(`· no synthesized flows (crawl incomplete) — deriving ${targets.length} feature target(s) from mapped pages`));
  }
  targets = targets.slice(0, args.flows);

  if (!targets.length) {
    console.log(yellow('· Changes detected, but no page or flow to exercise them (thin map). Consider `xsion check --all`.') + '\n');
    return finish(hardBroke ? 1 : 0);
  }

  console.log(bold(`Re-testing ${targets.length} affected flow${targets.length > 1 ? 's' : ''}: `) + targets.map((t) => cyan(t)).join(', ') + '\n');

  const results: { feature: string; findings: any[] }[] = [];
  for (const feature of targets) {
    process.stdout.write(gray(`· break-it › ${feature}…`));
    const runId = startBreakIt(projectId, cfg.baseUrl!, { repo: cfg.repo || '', feature });
    const deadline = Date.now() + 4 * 60_000;
    for (;;) {
      await sleep(1200);
      const run = store.getTestRun(runId);
      if (run && run.status !== 'running') break;
      if (Date.now() > deadline) break;
    }
    const run = store.getTestRun(runId);
    const art = (run?.artifacts || []).find((a: any) => a.kind === 'break-it') as any;
    const findings = art?.findings || [];
    results.push({ feature, findings });
    const broke = findings.filter((f: any) => f.verdict === 'broke').length;
    const held = findings.filter((f: any) => f.verdict === 'held' || f.verdict === 'passed').length;
    // "held" ONLY if at least one attack actually landed on the feature. Zero-held + zero-broke = we never verified
    // it (e.g. never got past login) — say "unverified", NEVER "held". A false "held" is worse than a real bug.
    process.stdout.write((broke ? red(` ${broke} broke`) : held ? green(' held') : yellow(' unverified')) + '\n');
  }

  // ── STEP 4: the report — colleague voice: evidence → verdict → next action ──
  console.log('\n' + bold('─── Report ───\n'));
  for (const { feature, findings } of results) {
    const broke = findings.filter((f: any) => f.verdict === 'broke');
    const review = findings.filter((f: any) => f.verdict === 'needs-review');
    const held = findings.filter((f: any) => f.verdict === 'held' || f.verdict === 'passed');
    console.log(bold(feature));
    if (!findings.length) { console.log(dim('  (no attack plan produced — feature may be too thin, or code unreadable)\n')); continue; }
    for (const f of broke) {
      hardBroke = true;
      console.log('  ' + red('✗ BROKE  ') + f.title);
      console.log('    ' + dim(f.detail));
      if (f.reproduce) console.log('    ' + gray(`repro: ${f.reproduce.intent}${f.reproduce.value ? ` = ${f.reproduce.value}` : ''} → ${f.reproduce.observed}`));
      if (f.codeRef) console.log('    ' + cyan(String(f.codeRef).replace(/^.*\/(apps|src)\//, '$1/')));
      console.log('    ' + yellow('→ next: ') + 'file a ticket with the repro above; add a failing spec to lock the regression.');
    }
    for (const f of review) console.log('  ' + yellow('? review  ') + f.title + dim(` — ${f.detail}`));
    if (held.length) console.log('  ' + green(`✓ ${held.length} held`));
    // per-feature honesty: nothing actually verified → say so, don't let the reader infer "tested & fine".
    if (findings.length && !held.length && !broke.length) console.log('  ' + yellow('⚠ nothing verified — no attack reached the feature (login gate, harness limit, or auth-required steps)'));
    console.log('');
  }

  const cov = summarizeCoverage(results, hardBroke, diff.statusRegressions.length);
  if (cov.kind === 'broke') { console.log(red(bold('✗ ' + cov.note)) + '\n'); return finish(cov.code); }
  if (cov.kind === 'nothing-verified') {
    console.log(yellow(bold('⚠ ' + cov.note)));
    console.log(yellow('  → next: provide working credentials (XSION_EMAIL / XSION_PASSWORD) and authorize the target so break-it can reach the features.') + '\n');
    return finish(cov.code);
  }
  // held: ≥1 verified. cov.note carries any partial-coverage caveat so a lone held never implies whole-change safety.
  const [headline, caveat] = cov.note.split(' — but ');
  console.log(green(bold('✓ ' + headline)) + (caveat ? yellow(' — but ' + caveat) : '') + '\n');
  return finish(cov.code);
}

// Only run when invoked as the CLI entrypoint — NOT when imported (e.g. the hermetic test importing summarizeCoverage).
if (require.main === module) {
  main().catch((e) => die(`unexpected: ${e?.stack || e}`, 3));
}
