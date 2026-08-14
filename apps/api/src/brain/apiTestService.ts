/**
 * apiTestService.ts — API testing: replay the endpoints recorded during the crawl, assert status + response
 * shape, stream each result live, and RECORD the run for replay/reference. Mechanically checkable (no oracle),
 * the honest-strongest test type. SAFE BY DEFAULT: only GET/read-only endpoints run unless mutating replays are
 * explicitly opted in — replaying a recorded POST could mutate the live app.
 */
import { v4 as uuid } from 'uuid';
import { wsServer } from '../ws';
import { store } from '../store';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export type TestEvent =
  | { type: 'test:phase'; phase: 'start' | 'run' | 'done'; label: string; kind: string }
  | { type: 'test:think'; message: string }
  | { type: 'test:item-start'; index: number; title: string }
  | { type: 'test:item-result'; index: number; status: 'pass' | 'fail' | 'skipped' | 'unverifiable'; detail: string; evidence?: string }
  | { type: 'test:done'; passed: number; failed: number; skipped: number; total: number };

function emit(runId: string, e: TestEvent) { wsServer.broadcastToRun(runId, e as any); }

export interface ApiTestOpts { allowMutating?: boolean; }

/** Kick off an API test run: create a recorded TestRun, return runId, stream results, persist the replay. */
export function startApiTest(projectId: string, baseUrl: string, opts: ApiTestOpts = {}): string {
  const runId = uuid();
  store.createTestRun({ id: runId, projectId, status: 'running', startedAt: new Date().toISOString(), artifacts: [], stepResults: [], summary: `API test · ${baseUrl}` } as any);
  runApiTest(runId, projectId, baseUrl, opts).catch((e) => {
    emit(runId, { type: 'test:think', message: `error: ${String(e.message || e)}` });
    emit(runId, { type: 'test:phase', phase: 'done', label: 'Run failed', kind: 'api' });
    store.updateTestRun(runId, { status: 'failed', finishedAt: new Date().toISOString() });
  });
  return runId;
}

async function runApiTest(runId: string, projectId: string, baseUrl: string, opts: ApiTestOpts) {
  const map = store.getProjectMap(projectId);
  const endpoints: any[] = map?.api || [];
  emit(runId, { type: 'test:phase', phase: 'start', label: 'Preparing endpoint replay', kind: 'api' });
  emit(runId, { type: 'test:think', message: `${endpoints.length} endpoints recorded during the crawl. Replaying the safe (read-only) ones and checking status + response shape.` });

  const results: any[] = [];
  const replayItems: any[] = [];
  let passed = 0, failed = 0, skipped = 0;

  emit(runId, { type: 'test:phase', phase: 'run', label: 'Replaying endpoints', kind: 'api' });
  for (let i = 0; i < endpoints.length; i++) {
    const ep = endpoints[i];
    // GraphQL is ALWAYS POST, so method-only safety skips every GraphQL app entirely. A GraphQL *query* is a
    // READ (safe to replay); only a mutation/subscription can change data. Key safety on what it DOES.
    const isGqlQuery = ep.graphql && ep.gqlKind === 'query';
    const isReadOnly = SAFE_METHODS.has(ep.method) || isGqlQuery;
    const title = ep.graphql ? `${ep.gqlKind || 'gql'} ${ep.gqlOperation || short(ep.url)}` : `${ep.method} ${short(ep.url)}`;
    emit(runId, { type: 'test:item-start', index: i, title });

    // SAFE-BY-DEFAULT: skip only genuinely mutating calls unless opted in. GraphQL queries are read-only → replayed.
    if (!isReadOnly && !opts.allowMutating) {
      skipped++;
      const reason = ep.graphql ? `GraphQL ${ep.gqlKind} could change live data` : `${ep.method} is mutating`;
      const detail = `skipped — ${reason}; not replayed by default (enable "include mutating" to run it)`;
      emit(runId, { type: 'test:item-result', index: i, status: 'skipped', detail });
      results.push({ index: i, title, status: 'skipped', detail });
      replayItems.push({ method: ep.method, url: ep.url, replayed: false, reason: 'mutating' });
      continue;
    }

    // replay the endpoint and check status + JSON-shape. GraphQL queries re-POST their recorded payload.
    try {
      const url = ep.url.startsWith('http') ? ep.url.replace('/:id', '/1') : `${baseUrl}${ep.url}`;
      const t0 = Date.now();
      const fetchOpts: any = { method: ep.method, signal: AbortSignal.timeout(12000) };
      if (ep.graphql && ep.samplePayload) {
        fetchOpts.method = 'POST';
        fetchOpts.headers = { 'content-type': 'application/json' };
        fetchOpts.body = ep.samplePayload;   // the recorded query payload (the operation SoA identified)
      }
      const resp = await fetch(url, fetchOpts);
      const ms = Date.now() - t0;
      const bodyText = await resp.text().catch(() => '');
      const isJson = /application\/json/.test(resp.headers.get('content-type') || '') || /^\s*[[{]/.test(bodyText);
      const expected = ep.statuses?.[0];
      const statusOk = resp.status < 400;
      const matchesRecorded = expected ? resp.status === expected : statusOk;

      // GraphQL puts errors in the BODY at HTTP 200 — so a 200 with {"errors":[…]} is a failure, not a pass.
      let gqlErrors: string | null = null;
      if (ep.graphql) { try { const j = JSON.parse(bodyText); if (Array.isArray(j?.errors) && j.errors.length) gqlErrors = String(j.errors[0]?.message || 'GraphQL error'); } catch {} }

      let status: 'pass' | 'fail' | 'unverifiable';
      let detail: string;
      if (resp.status >= 500) { status = 'fail'; detail = `HTTP ${resp.status} — server error`; failed++; }
      else if (gqlErrors) { status = 'fail'; detail = `HTTP ${resp.status} but GraphQL returned errors: ${gqlErrors.slice(0, 80)}`; failed++; }
      else if (expected && !matchesRecorded) { status = 'fail'; detail = `status drift: recorded ${expected}, got ${resp.status}`; failed++; }
      else if (statusOk) { status = 'pass'; detail = `${ep.graphql ? ep.gqlOperation + ' · ' : ''}HTTP ${resp.status} · ${ms}ms · ${isJson ? 'JSON body' : 'non-JSON'}`; passed++; }
      else if (resp.status === 401 || resp.status === 403) { status = 'unverifiable'; detail = `HTTP ${resp.status} — needs auth (sign-in context) to judge`; }
      else { status = 'unverifiable'; detail = `HTTP ${resp.status} — needs auth or context to judge`; }

      const evidence = bodyText.slice(0, 120);
      emit(runId, { type: 'test:item-result', index: i, status, detail, evidence });
      results.push({ index: i, title, status, detail });
      replayItems.push({ method: ep.method, url: ep.url, replayed: true, status: resp.status, ms });
    } catch (e: any) {
      failed++;
      const detail = `request failed: ${String(e.message || e).slice(0, 80)}`;
      emit(runId, { type: 'test:item-result', index: i, status: 'fail', detail });
      results.push({ index: i, title, status: 'fail', detail });
      replayItems.push({ method: ep.method, url: ep.url, replayed: true, error: true });
    }
    await new Promise((r) => setTimeout(r, 250)); // let the UI breathe between items
  }

  emit(runId, { type: 'test:phase', phase: 'done', label: 'API test complete', kind: 'api' });
  emit(runId, { type: 'test:done', passed, failed, skipped, total: endpoints.length });
  // RECORD for replay/reference: the endpoint list + what actually ran (a re-runnable record, not just a log).
  store.updateTestRun(runId, {
    status: failed ? 'failed' : 'passed', finishedAt: new Date().toISOString(),
    summary: `API test · ${passed} pass · ${failed} fail · ${skipped} skipped`,
    stepResults: results as any,
    ...( { replay: { kind: 'api', baseUrl, endpoints: replayItems, allowMutating: !!opts.allowMutating } } as any),
  });
}

function short(u: string) { return u.replace(/^https?:\/\//, '').slice(0, 48); }
