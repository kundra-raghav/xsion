import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { store } from '../store';
import { CreateProjectRequestSchema, StartDiscoveryRequestSchema } from '../types';
import { startSimulatedDiscovery } from '../runners/discoverySimulator';
import { startPlaywrightDiscovery } from '../runners/playwrightDiscovery';
import { generateSmokeSuite } from '../runners/smokeSuite';
import { startSimulatedTestRun } from '../runners/testRunSimulator';
import { startPlaywrightTestRun } from '../runners/playwrightTestRun';
import { startSoaRun } from '../brain/soaRunService';
import { startCrawlMap } from '../brain/crawlMapService';
import { startApiTest } from '../brain/apiTestService';
import { recordObservation } from '../brain/projectKnowledge';
import { startGenCases, startFeApi } from '../brain/soaTestServices';
import { startSecurityAudit } from '../brain/securityAuditService';
import { startEnvMatrix } from '../brain/envMatrixService';
import { startBreakIt } from '../brain/breakItService';
import { startGoal } from '../brain/goalRunService';
import { startBugRepro } from '../brain/bugReproService';
import { startMission } from '../brain/missionService';
import { testPlan } from '../brain/soaClient';

const ENABLE_PLAYWRIGHT = process.env.ENABLE_PLAYWRIGHT === 'true';

export const projectsRouter = Router();

// ── CRAWL-MAP: onboard a URL — crawl + map the app (pages, flows, API surface), stream live over WS.
// Returns runId immediately; the agentic-browser view subscribes and watches it work. Blocks only on creds.
projectsRouter.post('/:projectId/crawl-map', async (req, res) => {
  const { projectId } = req.params;
  const project = store.getProject(projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const { repo, baseUrl, email, password, roleId } = req.body || {};
  const target = baseUrl || project.baseUrl;
  if (!target) return res.status(400).json({ error: 'baseUrl (or project.baseUrl) required' });
  // MULTI-ROLE (item 4): crawl AS a defined role. Its creds come from the project's role set (or the request);
  // creds are used in-memory only, never persisted. roleId must reference a role on the project.
  let role: { id: string; name: string } | undefined;
  let roleEmail = email, rolePassword = password;
  if (roleId) {
    const r = (project.roles || []).find((x: any) => x.id === roleId);
    if (!r) return res.status(400).json({ error: `roleId "${roleId}" not found on project` });
    role = { id: r.id, name: r.name };
    roleEmail = email || (r as any)._email;    // request creds win; else the role's stored (in-memory) creds
    rolePassword = password || (r as any)._password;
  } else {
    // CREDS-REUSE (BUG 3 fix): a project remembers its default credential set in memory (stripped before persist,
    // like roles) so the user doesn't RE-FILL on every crawl. Request creds are stored; omitted → reuse stored.
    if (email && password) {
      store.updateProject(projectId, { _defaultCreds: { email, password } } as any);
      roleEmail = email; rolePassword = password;
    } else {
      const dc = (project as any)._defaultCreds;
      if (dc) { roleEmail = dc.email; rolePassword = dc.password; }
    }
  }
  try {
    console.log(`[XSION][crawl] POST /crawl-map project=${projectId} url=${target} hasCreds=${!!(roleEmail && rolePassword)} role=${role?.name || '(none)'} repo=${!!repo}`);
    const runId = startCrawlMap(projectId, { baseUrl: target, repo, email: roleEmail, password: rolePassword, role });
    return res.status(201).json({ runId, projectId, baseUrl: target, role: role?.name });
  } catch (e: any) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

// does this project already have stored (in-memory) crawl credentials? The FE reads this to skip re-prompting.
projectsRouter.get('/:projectId/has-credentials', (req, res) => {
  const p = store.getProject(req.params.projectId); if (!p) return res.status(404).json({ error: 'Project not found' });
  return res.json({ hasCredentials: !!(p as any)._defaultCreds });
});

// SET credentials for a project (the cred prompt any engine can trigger — bug-repro/break-it, not just the crawl).
// Stored IN-MEMORY only as _defaultCreds; the store STRIPS every underscored key before persisting to db.json, so
// creds never touch disk. The response NEVER echoes them back. Send {} or {email:'',password:''} to CLEAR.
projectsRouter.put('/:projectId/credentials', (req, res) => {
  const p = store.getProject(req.params.projectId); if (!p) return res.status(404).json({ error: 'Project not found' });
  const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  console.log(`[XSION][creds] PUT /credentials project=${req.params.projectId} email="${email ? email.replace(/(.{2}).*(@.*)/, '$1***$2') : '(empty→CLEAR)'}" hasPassword=${!!password}`);
  if (email && password) store.updateProject(req.params.projectId, { _defaultCreds: { email, password } } as any);
  else store.updateProject(req.params.projectId, { _defaultCreds: undefined } as any);   // clear
  const after = store.getProject(req.params.projectId) as any;
  console.log(`[XSION][creds] after PUT: project.hasCredentials=${!!after?._defaultCreds}`);
  return res.json({ hasCredentials: !!(email && password) });   // never echo the values
});

// ── CONTINUE EXPLORING (BUG 2 fix): after validating flows, resume the crawl from where it left off — the
// persisted frontier + budget-clipped known-unknowns become fresh frontier, and the budget grows. Reuses stored
// creds so no re-fill. This is what "go back and resume from where it confirmed to continue" needs.
projectsRouter.post('/:projectId/continue-crawl', async (req, res) => {
  const p = store.getProject(req.params.projectId); if (!p) return res.status(404).json({ error: 'Project not found' });
  const map = store.getProjectMap(req.params.projectId);
  if (!map) return res.status(404).json({ error: 'No map yet — run the crawl first' });
  const dc = (p as any)._defaultCreds;
  const runId = startCrawlMap(req.params.projectId, {
    baseUrl: req.body?.baseUrl || p.baseUrl, repo: req.body?.repo || map.repo,
    email: dc?.email, password: dc?.password, resume: true,
  });
  return res.status(201).json({ runId, resuming: true });
});

// ── MULTI-ROLE (item 4): manage the project's role set (a credential set per role). Credentials are held in
// memory only and NEVER written to db.json (the persisted role carries just id/name/hasCredentials).
projectsRouter.get('/:projectId/roles', (req, res) => {
  const p = store.getProject(req.params.projectId); if (!p) return res.status(404).json({ error: 'Project not found' });
  const roles = (p.roles || []).map((r: any) => ({ id: r.id, name: r.name, hasCredentials: !!(r._email && r._password) }));
  return res.json({ roles });
});
projectsRouter.post('/:projectId/roles', (req, res) => {
  const p = store.getProject(req.params.projectId); if (!p) return res.status(404).json({ error: 'Project not found' });
  const { name, email, password } = req.body || {};
  if (!name) return res.status(400).json({ error: 'role name required' });
  console.log(`[XSION][creds] POST /roles project=${req.params.projectId} name="${name}" email="${email ? String(email).replace(/(.{2}).*(@.*)/, '$1***$2') : '(none)'}" hasPassword=${!!password}`);
  const role: any = { id: uuidv4(), name: String(name), hasCredentials: !!(email && password) };
  if (email) role._email = String(email);        // in-memory only — store.updateProject strips underscored keys before persist
  if (password) role._password = String(password);
  const patch: any = { roles: [...(p.roles || []), role] };
  // ★ THE FIX (creds saved in Roles & coverage were NEVER USED): the engines (break-it/bug-repro/env-matrix) read
  // project._defaultCreds, NOT role creds — so adding a role with creds did nothing for them. PROMOTE this role's
  // creds to the project default when the project has none yet, so "save creds here" actually signs the engines in.
  if (email && password && !(p as any)._defaultCreds) {
    patch._defaultCreds = { email: String(email), password: String(password) };
    console.log(`[XSION][creds] promoted role "${name}" creds → project _defaultCreds (engines will now use them). project=${req.params.projectId}`);
  } else if (email && password) {
    console.log(`[XSION][creds] project already has _defaultCreds; role "${name}" creds stored on the role only (use PUT /credentials to change the project default).`);
  }
  store.updateProject(req.params.projectId, patch);
  const after = store.getProject(req.params.projectId) as any;
  console.log(`[XSION][creds] after save: project.hasCredentials=${!!after?._defaultCreds} roles=${(after?.roles || []).length}`);
  return res.status(201).json({ role: { id: role.id, name: role.name, hasCredentials: role.hasCredentials }, projectHasCredentials: !!after?._defaultCreds });
});
projectsRouter.delete('/:projectId/roles/:roleId', (req, res) => {
  const p = store.getProject(req.params.projectId); if (!p) return res.status(404).json({ error: 'Project not found' });
  const roles = (p.roles || []).filter((r: any) => r.id !== req.params.roleId);
  store.updateProject(req.params.projectId, { roles } as any);
  return res.json({ ok: true });
});

// DELETE a whole project — cascades to its map, map-history, and test runs (store.deleteProject cleans all).
projectsRouter.delete('/:projectId', (req, res) => {
  const p = store.getProject(req.params.projectId); if (!p) return res.status(404).json({ error: 'Project not found' });
  const ok = store.deleteProject(req.params.projectId);
  return res.json({ ok, deleted: req.params.projectId });
});

// ── PER-ROLE COVERAGE (item 4): the "nothing is left" check — which routes each role reached, and which routes
// only one role sees. Computed from the role-tagged map entities.
projectsRouter.get('/:projectId/coverage', (req, res) => {
  const p = store.getProject(req.params.projectId); if (!p) return res.status(404).json({ error: 'Project not found' });
  const map = store.getProjectMap(req.params.projectId);
  if (!map) return res.status(404).json({ error: 'No map yet' });
  const roles = (map.roles || []) as any[];
  const byRole: Record<string, string[]> = {};
  for (const r of roles) byRole[r.id] = [];
  for (const pg of map.pages || []) for (const rid of (pg.roles || [])) if (byRole[rid]) byRole[rid].push(pg.path);
  // routes only ONE role sees = role-exclusive surface (the thing a single-role crawl would miss)
  const pageRoleCount: Record<string, Set<string>> = {};
  for (const pg of map.pages || []) { pageRoleCount[pg.path] = pageRoleCount[pg.path] || new Set(); for (const rid of (pg.roles || [])) pageRoleCount[pg.path].add(rid); }
  const exclusive: Record<string, string> = {};
  for (const [path, set] of Object.entries(pageRoleCount)) if (set.size === 1) exclusive[path] = [...set][0];
  return res.json({
    roles: roles.map((r) => ({ id: r.id, name: r.name, hasCredentials: r.hasCredentials, crawledAt: r.crawledAt, pagesReached: (byRole[r.id] || []).length })),
    coverageByRole: byRole,
    roleExclusivePages: exclusive,   // path → the single role id that sees it (map role id → name via roles[])
    totalPages: (map.pages || []).length,
  });
});

// read the persisted map for a project
projectsRouter.get('/:projectId/map', (req, res) => {
  const map = store.getProjectMap(req.params.projectId);
  if (!map) return res.status(404).json({ error: 'No map yet — run crawl-map first' });
  return res.json(map);
});

// ── TEST TYPES (each streams live over WS + records a re-runnable TestRun) ──
projectsRouter.post('/:projectId/test/api', (req, res) => {
  const p = store.getProject(req.params.projectId); if (!p) return res.status(404).json({ error: 'Project not found' });
  const runId = startApiTest(req.params.projectId, req.body?.baseUrl || p.baseUrl, { allowMutating: !!req.body?.allowMutating });
  return res.status(201).json({ runId });
});
projectsRouter.post('/:projectId/test/generate', (req, res) => {
  const p = store.getProject(req.params.projectId); if (!p) return res.status(404).json({ error: 'Project not found' });
  if (!req.body?.repo) return res.status(400).json({ error: 'repo required — case generation reads the code' });
  const runId = startGenCases(req.params.projectId, req.body.repo, req.body.flowId);
  return res.status(201).json({ runId });
});
projectsRouter.post('/:projectId/test/fe-api', (req, res) => {
  const p = store.getProject(req.params.projectId); if (!p) return res.status(404).json({ error: 'Project not found' });
  if (!req.body?.repo) return res.status(400).json({ error: 'repo required — FE→API matching reads the code' });
  const runId = startFeApi(req.params.projectId, req.body.repo, req.body.flowId);
  return res.status(201).json({ runId });
});
// ── SECURITY-AUDIT CONSENT: the user attests they own/are authorized to test this target. Gates the exploit
// tiers. Per-project, user-set. No attack fires without this.
projectsRouter.patch('/:projectId/security', (req, res) => {
  const p = store.getProject(req.params.projectId); if (!p) return res.status(404).json({ error: 'Project not found' });
  const { authorized, allowDestructive } = req.body || {};
  const security = {
    authorized: !!authorized,
    authorizedAt: authorized ? new Date().toISOString() : undefined,
    allowDestructive: !!allowDestructive,
  };
  const updated = store.updateProject(req.params.projectId, { security } as any);
  return res.json({ security: updated?.security });
});

// ── SECURITY AUDIT (Mode 1 only): SoA reads the security-relevant code → code-cited probe plan → Xsion runs it
// safely → code-cited, reproducible findings. Tier is CLAMPED to what the project's consent permits.
projectsRouter.post('/:projectId/audit', (req, res) => {
  const p = store.getProject(req.params.projectId); if (!p) return res.status(404).json({ error: 'Project not found' });
  const repo = req.body?.repo;
  if (!repo) return res.status(400).json({ error: 'repo required — the security audit is code-grounded (Mode 1 only)' });
  const tier = ([1, 2, 3].includes(Number(req.body?.tier)) ? Number(req.body.tier) : 1) as 1 | 2 | 3;
  const runId = startSecurityAudit(req.params.projectId, req.body?.baseUrl || p.baseUrl, {
    repo, tier, destructiveAck: !!req.body?.destructiveAck,
  });
  return res.status(201).json({ runId });
});

// ── SOA-STEER (the "SoA decides what to test" surface): SoA reasons over the mapped app + code → prioritized
// test PROPOSALS the operator approves item by item. Returns the proposals directly (the user reviews, then runs
// approved ones via the normal test routes). ~60-90s (a real SoA call).
projectsRouter.post('/:projectId/test-plan', async (req, res) => {
  const p = store.getProject(req.params.projectId); if (!p) return res.status(404).json({ error: 'Project not found' });
  const map = store.getProjectMap(req.params.projectId);
  if (!map) return res.status(404).json({ error: 'No map yet — crawl + map the app first' });
  const repo = req.body?.repo || map.repo || '';
  // give SoA a compact view of the map (names + counts, not full payloads)
  const compact = {
    baseUrl: map.baseUrl, mode: map.mode,
    pages: (map.pages || []).map((pg: any) => ({ path: pg.path, interactives: pg.interactives, requirements: (pg.requirements || []).map((r: any) => r.kind) })).slice(0, 30),
    flows: (map.flows || []).map((f: any) => ({ name: f.name, role: f.role, confidence: f.confidence, steps: f.steps?.length })),
    api: (map.api || []).map((e: any) => (e.graphql ? `${e.gqlKind} ${e.gqlOperation}` : `${e.method} ${e.url}`)).slice(0, 30),
    routeManifest: map.routeManifest,
    roles: (map.roles || []).map((r: any) => r.name),
  };
  try {
    const { proposals, error } = await testPlan(repo, compact);
    return res.json({ proposals, error });
  } catch (e: any) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

// ── BREAK-IT (adversarial QA): SoA plans happy→CRUD→adversarial→API attacks for a feature (each with a
// pre-declared oracle), the engine executes safely (only mutates its own tagged test data) → oracle-matched,
// code-cited findings. Mutating phases need the project's security.authorized attestation.
projectsRouter.post('/:projectId/test/break-it', (req, res) => {
  const p = store.getProject(req.params.projectId); if (!p) return res.status(404).json({ error: 'Project not found' });
  const feature = req.body?.feature;
  if (!feature) return res.status(400).json({ error: 'feature required — name the feature to break (e.g. "Create Event")' });
  const runId = startBreakIt(req.params.projectId, req.body?.baseUrl || p.baseUrl, {
    repo: req.body?.repo || '', feature: String(feature), flowId: req.body?.flowId, destructiveAck: !!req.body?.destructiveAck,
    scope: typeof req.body?.scope === 'string' ? req.body.scope : undefined,   // e.g. "NZ Curriculum" → enter that tenant before attacking
  });
  return res.status(201).json({ runId });
});

// ── GENERAL GOAL AGENT: a plain-English multi-step GOAL → runGoal drives it adaptively (LLM plans / deterministic
// executes / structure verifies), streamed live + recorded. NOT a per-task engine — one general agent for any goal.
projectsRouter.post('/:projectId/test/goal', (req, res) => {
  const p = store.getProject(req.params.projectId); if (!p) return res.status(404).json({ error: 'Project not found' });
  const goal = req.body?.goal;
  if (!goal || String(goal).trim().length < 4) return res.status(400).json({ error: 'goal required — describe what to do (e.g. "create an event and verify it opens")' });
  // creds: caller-supplied (POST body) win; else the project's in-memory _defaultCreds (set via the cred prompt).
  // The route MUST forward body creds — otherwise a fresh server (tsx restart wipes _defaultCreds) has no way to log
  // in and the whole run burns against the login gate (exactly the 484e786b failure: 24 steps, all on the login page).
  const bodyCreds = req.body?.creds && req.body.creds.email && req.body.creds.password ? req.body.creds : undefined;
  const runId = startGoal(req.params.projectId, req.body?.baseUrl || p.baseUrl, {
    goal: String(goal), maxSteps: typeof req.body?.maxSteps === 'number' ? req.body.maxSteps : undefined,
    creds: bodyCreds,
  });
  return res.status(201).json({ runId });
});

// ── MISSION (the prompt-agent): a plain-English mission → SoA routes it to the right engines → runs them in
// order → unified report. "The prompt is the product."
projectsRouter.post('/:projectId/mission', (req, res) => {
  const p = store.getProject(req.params.projectId); if (!p) return res.status(404).json({ error: 'Project not found' });
  const mission = req.body?.mission;
  if (!mission || String(mission).trim().length < 4) return res.status(400).json({ error: 'mission required — tell Xsion what to test in plain English' });
  const runId = startMission(req.params.projectId, req.body?.baseUrl || p.baseUrl, { repo: req.body?.repo || '', mission: String(mission) });
  return res.status(201).json({ runId });
});

// ── BUG REPLICATION: paste a QA bug ticket → SoA parses it into concrete steps + an oracle (expected vs actual)
// → executor runs them → verdict: reproduced / not-reproduced / cant-perform. Mode 1 also cross-checks the code.
projectsRouter.post('/:projectId/test/bug-repro', (req, res) => {
  const p = store.getProject(req.params.projectId); if (!p) return res.status(404).json({ error: 'Project not found' });
  const ticket = req.body?.ticket;
  if (!ticket || String(ticket).trim().length < 10) return res.status(400).json({ error: 'ticket required — paste the QA bug report' });
  const runId = startBugRepro(req.params.projectId, req.body?.baseUrl || p.baseUrl, {
    repo: req.body?.repo || '', ticket: String(ticket),
  });
  return res.status(201).json({ runId });
});

// ── ENVIRONMENT MATRIX (item 5): run a mapped flow under device/network/offline/session-expiry conditions.
projectsRouter.post('/:projectId/test/env-matrix', (req, res) => {
  const p = store.getProject(req.params.projectId); if (!p) return res.status(404).json({ error: 'Project not found' });
  const runId = startEnvMatrix(req.params.projectId, req.body?.baseUrl || p.baseUrl, req.body?.flowId, req.body?.conditions);
  return res.status(201).json({ runId });
});

// read a recorded run (for reference / replay)
projectsRouter.get('/:projectId/runs/:runId/record', (req, res) => {
  const run = store.getTestRun(req.params.runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  return res.json(run);
});

// ── RESOLVE A FINDING (the "approve button" — the entrepreneur-lens fix): a needs-review finding is not a dead
// end. The user answers its ONE question (was this a bug?) and the finding RE-VERDICTS: yes → broke, no → held.
// This is the teach-the-oracle loop made real. Body: { index, answer: 'bug' | 'fine' }. Only 'answer-oracle'
// findings are resolvable this way (authorize/credentials/unreachable resolve by their own actions, not a yes/no).
projectsRouter.post('/:projectId/runs/:runId/findings/:index/resolve', (req, res) => {
  const run = store.getTestRun(req.params.runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  const art = ((run as any).artifacts || [])[0];
  const findings = art?.findings || [];
  const idx = parseInt(req.params.index, 10);
  const finding = findings[idx];
  if (!finding) return res.status(404).json({ error: `finding ${idx} not found` });
  const answer = String(req.body?.answer || '');
  if (answer !== 'bug' && answer !== 'fine') return res.status(400).json({ error: `answer must be 'bug' or 'fine'` });
  if (finding.resolution?.kind !== 'answer-oracle') {
    return res.status(409).json({ error: `finding ${idx} isn't answerable by yes/no — its resolution is '${finding.resolution?.kind}' (resolve it by that action instead)` });
  }
  // re-verdict + record that a HUMAN decided this (so the UI shows it as user-confirmed, and future runs of the
  // same attack can carry the answer forward via project knowledge).
  finding.verdict = answer === 'bug' ? 'broke' : 'held';
  finding.detail = `${answer === 'bug' ? 'CONFIRMED A BUG' : 'CONFIRMED FINE'} by you — "${finding.expectBroke || finding.title}". ${finding.detail}`;
  finding.resolution = { kind: answer === 'bug' ? 'file-ticket' : 'none' };
  (finding as any).humanConfirmed = true;
  store.updateTestRun(req.params.runId, { artifacts: (run as any).artifacts } as any);
  return res.json({ ok: true, verdict: finding.verdict, resolution: finding.resolution });
});

// ── ANSWER A NEEDS-INPUT (bug-repro's "which control is this step?" — closes the teach-the-app loop): the run
// reached the feature but a step's control didn't match; the user picks the RIGHT control from the candidate list.
// We store it as a NAVIGATIONAL fact in projectKnowledge (never an oracle/verdict — the store's whole discipline)
// so the NEXT run resolves that step without asking again. Body: { chosenControl: "<one of the candidates>" }.
projectsRouter.post('/:projectId/runs/:runId/answer-control', (req, res) => {
  const run = store.getTestRun(req.params.runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  const art = ((run as any).artifacts || [])[0];
  const resolution = art?.resolution;
  if (!resolution || resolution.kind !== 'needs-input') {
    return res.status(409).json({ error: `this run has no needs-input to answer (resolution: ${resolution?.kind || 'none'})` });
  }
  const chosen = String(req.body?.chosenControl || '').trim();
  if (!chosen) return res.status(400).json({ error: 'chosenControl required — the control that performs the step' });
  // record the navigational fact: "for step X on this app, the control is <chosen>". Human-confirmed provenance.
  let knowledge = store.getProjectKnowledge(req.params.projectId) || [];
  knowledge = recordObservation(knowledge, {
    kind: 'selector', key: `step:${resolution.forStep}`,
    fact: `for "${resolution.forStep}", click the control "${chosen}"`,
    provenance: 'human-confirmed',
  }, new Date().toISOString());
  store.setProjectKnowledge(req.params.projectId, knowledge);
  // mark the run's resolution answered so the UI reflects it.
  (art.resolution as any).answeredWith = chosen;
  store.updateTestRun(req.params.runId, { artifacts: (run as any).artifacts } as any);
  return res.json({ ok: true, learned: `for "${resolution.forStep}" → "${chosen}" (the next run will use it)` });
});

// LIST recent recorded runs for a project (so the UI can OPEN a past run instead of always re-running). Compact
// summary only — id / kind / feature / status / finishedAt — newest first. `?kind=break-it` filters by engine.
projectsRouter.get('/:projectId/runs', (req, res) => {
  const kindFilter = req.query.kind as string | undefined;
  const runs = (store.listTestRuns() as any[])
    .filter((r) => r.projectId === req.params.projectId)
    .map((r) => {
      const art = (r.artifacts || [])[0] || {};
      // a compact label + a headline outcome per KIND, so a cross-type history reads at a glance
      const findings = art.findings || [];
      const outcome = art.kind === 'break-it'
        ? `${findings.filter((f: any) => f.verdict === 'broke').length} broke · ${findings.filter((f: any) => f.verdict === 'needs-review').length} review`
        : art.kind === 'bug-repro' ? (art.verdict || '')
        : art.kind === 'mission' ? `${(art.steps || []).length} step(s)`
        : r.summary || r.status || '';
      // ACTIONS PENDING (entrepreneur-lens: the history tells the user WHICH runs still need them). Count the
      // non-'none', non-answered resolutions across the run — break-it findings + the bug-repro/mission artifact.
      const isPending = (res: any) => res && res.kind && res.kind !== 'none' && !res.answeredWith && res.kind !== 'file-ticket';
      // actionable rows live under `findings` (break-it/audit) OR `results` (fe-api) — scan both so an fe-api
      // 'answer-oracle' row (or any per-row resolution) counts toward the pending badge, not just findings.
      const rows = [...findings, ...(art.results || [])];
      let actionsPending = rows.filter((f: any) => isPending(f.resolution)).length;
      if (isPending(art.resolution)) actionsPending += 1;
      if (art.kind === 'mission') actionsPending += (art.actions || []).filter((a: any) => a.kind !== 'file-ticket').reduce((n: number, a: any) => n + (a.count || 0), 0);
      return { id: r.id, kind: art.kind || 'run', label: art.feature || art.summary || art.kind || 'run', outcome, actionsPending, status: r.status, finishedAt: r.finishedAt, startedAt: r.startedAt, frameCount: (art.frames || []).length };
    })
    .filter((r) => !kindFilter || r.kind === kindFilter)
    .sort((a, b) => String(b.finishedAt || b.startedAt || '').localeCompare(String(a.finishedAt || a.startedAt || '')))
    .slice(0, 40);
  return res.json({ runs });
});

// map-validation: record a user's correction on one flow (persists + bumps confidence to high).
projectsRouter.patch('/:projectId/map/flow/:flowId', (req, res) => {
  const { note, name, confidence } = req.body || {};
  const flow = store.correctFlow(req.params.projectId, req.params.flowId, { note, name, confidence });
  if (!flow) return res.status(404).json({ error: 'Map or flow not found' });
  return res.json(flow);
});

// ── SoA AI run: plan flows from code → execute on the live URL → verify vs code. Returns runId immediately;
// the UI subscribes over WebSocket and renders plan/execute/verify events live.
projectsRouter.post('/:projectId/soa-run', async (req, res) => {
  const { projectId } = req.params;
  const project = store.getProject(projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const { repo, baseUrl, flowIndex, flowFile } = req.body || {};
  const target = baseUrl || project.baseUrl;
  if (!repo || !target) return res.status(400).json({ error: 'repo and baseUrl (or project.baseUrl) required' });
  try {
    const runId = startSoaRun(projectId, { repo, baseUrl: target, flowIndex, flowFile });
    return res.status(201).json({ runId, projectId, baseUrl: target });
  } catch (e: any) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

// List all projects
projectsRouter.get('/', (_req, res) => {
  const projects = store.listProjects();
  return res.json(projects);
});

// Create new project
projectsRouter.post('/', (req, res) => {
  try {
    const body = CreateProjectRequestSchema.parse(req.body);

    const project = store.createProject({
      id: uuidv4(),
      name: body.name,
      baseUrl: body.baseUrl,
      createdAt: new Date().toISOString(),
    });

    return res.status(201).json(project);
  } catch (error) {
    return res.status(400).json({ error: 'Invalid request body' });
  }
});

// Get project by ID
projectsRouter.get('/:projectId', (req, res) => {
  const project = store.getProject(req.params.projectId);
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }
  return res.json(project);
});

// Start discovery run for a project
projectsRouter.post('/:projectId/discovery-runs', (req, res) => {
  try {
    const { projectId } = req.params;
    const body = StartDiscoveryRequestSchema.parse(req.body);

    const project = store.getProject(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const run = store.createDiscoveryRun({
      id: uuidv4(),
      projectId,
      status: 'queued',
      startedAt: new Date().toISOString(),
      progressPct: 0,
      mode: body.mode,
      nodesCount: 0,
      edgesCount: 0,
    });

    // Start discovery runner (Playwright or simulator)
    const discoveryRunner = ENABLE_PLAYWRIGHT ? startPlaywrightDiscovery : startSimulatedDiscovery;

    console.log(
      `Starting discovery with ${ENABLE_PLAYWRIGHT ? 'Playwright' : 'simulator'} for run ${run.id}`
    );

    discoveryRunner(run).catch((error) => {
      console.error(`Discovery runner failed for run ${run.id}:`, error);
      store.updateDiscoveryRun(run.id, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
      });
    });

    return res.status(201).json(run);
  } catch (error) {
    return res.status(400).json({ error: 'Invalid request body' });
  }
});

// Generate smoke suite for a discovery run
projectsRouter.post('/:projectId/runs/:runId/generate-smoke', (req, res) => {
  const { projectId, runId } = req.params;

  const project = store.getProject(projectId);
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }

  const run = store.getDiscoveryRun(runId);
  if (!run) {
    return res.status(404).json({ error: 'Discovery run not found' });
  }

  const testCases = generateSmokeSuite(projectId, runId);
  return res.json(testCases);
});

// Run smoke suite for a discovery run
projectsRouter.post('/:projectId/runs/:runId/run-smoke', async (req, res) => {
  const { projectId, runId } = req.params;

  const project = store.getProject(projectId);
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }

  const discoveryRun = store.getDiscoveryRun(runId);
  if (!discoveryRun) {
    return res.status(404).json({ error: 'Discovery run not found' });
  }

  try {
    // Use Playwright test runner if enabled, otherwise use simulator
    const testRunner = ENABLE_PLAYWRIGHT ? startPlaywrightTestRun : startSimulatedTestRun;

    console.log(
      `Starting test run with ${ENABLE_PLAYWRIGHT ? 'Playwright' : 'simulator'} for discovery ${runId}`
    );

    const testRun = await testRunner(projectId, runId);
    return res.status(201).json(testRun);
  } catch (error) {
    console.error('Failed to start test run:', error);
    return res.status(500).json({ error: 'Failed to start test run' });
  }
});
