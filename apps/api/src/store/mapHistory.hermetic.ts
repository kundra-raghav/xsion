/**
 * mapHistory.hermetic.ts — proves the map-history archiving survives the crawl's SAVE SEQUENCE (#216/1a).
 * Run: cd apps/api && npx tsx src/store/mapHistory.hermetic.ts
 *
 * The trap this guards: a crawl calls saveProjectMap MANY times with status:'crawling' (each a fresh crawledAt),
 * then ONCE with status:'done'. If we archived at the 'done' save, the previous run's baseline was already clobbered
 * by this run's first 'crawling' save. So archiving must happen at the FIRST save of a NEW crawl, and ONLY when the
 * map being replaced was itself a completed crawl. These assertions replay that exact sequence.
 *
 * Isolated: uses a temp DB_FILE via XSION_DB env so it never touches the real db.json.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xsion-maphist-'));
process.env.XSION_DB_FILE = path.join(tmp, 'db.json');   // store.ts reads this if present; harmless otherwise

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) pass++; else { fail++; console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

async function main() {
  const { DataStore } = await import('./store');
  const s = new (DataStore as any)();
  const P = 'proj-1';

  // ── run 1: two crawling snapshots then done ──
  s.saveProjectMap(P, { crawledAt: 't1a', status: 'crawling', pages: [{ path: '/a' }] });
  s.saveProjectMap(P, { crawledAt: 't1b', status: 'crawling', pages: [{ path: '/a' }, { path: '/b' }] });
  s.saveProjectMap(P, { crawledAt: 't1c', status: 'done', pages: [{ path: '/a' }, { path: '/b' }] });
  ok('after run 1, no previous baseline yet', s.getPreviousProjectMap(P) === undefined);
  ok('current map is run 1 done', s.getProjectMap(P)?.crawledAt === 't1c');

  // ── run 2 STARTS: first crawling save must archive run 1's DONE map ──
  s.saveProjectMap(P, { crawledAt: 't2a', status: 'crawling', pages: [{ path: '/a' }] });
  ok('run 1 done map archived at run 2 start', s.getPreviousProjectMap(P)?.crawledAt === 't1c');
  // subsequent crawling saves of run 2 must NOT re-archive (prev is now a crawling snapshot)
  s.saveProjectMap(P, { crawledAt: 't2b', status: 'crawling', pages: [{ path: '/a' }, { path: '/c' }] });
  ok('mid-run crawling save does NOT re-archive', s.getProjectMapHistory(P).length === 1);
  ok('baseline still run 1 done', s.getPreviousProjectMap(P)?.crawledAt === 't1c');

  s.saveProjectMap(P, { crawledAt: 't2c', status: 'done', pages: [{ path: '/a' }, { path: '/c' }] });
  ok('run 2 done does not archive a crawling snapshot', s.getPreviousProjectMap(P)?.crawledAt === 't1c');
  ok('current is now run 2 done', s.getProjectMap(P)?.crawledAt === 't2c');

  // ── run 3 STARTS: baseline advances to run 2's done ──
  s.saveProjectMap(P, { crawledAt: 't3a', status: 'crawling', pages: [] });
  ok('baseline advances to run 2 done at run 3 start', s.getPreviousProjectMap(P)?.crawledAt === 't2c');
  ok('history ring holds both prior done maps', s.getProjectMapHistory(P).map((m: any) => m.crawledAt).join(',') === 't1c,t2c');

  // ── ring bound: push many completed crawls, keep only the newest N ──
  for (let i = 4; i < 15; i++) {
    s.saveProjectMap(P, { crawledAt: `t${i}a`, status: 'crawling', pages: [] });
    s.saveProjectMap(P, { crawledAt: `t${i}c`, status: 'done', pages: [] });
  }
  ok('ring bounded to 5', s.getProjectMapHistory(P).length === 5, `got ${s.getProjectMapHistory(P).length}`);
  ok('newest baseline is the most recent prior done', /^(t13c)$/.test(s.getPreviousProjectMap(P)?.crawledAt), s.getPreviousProjectMap(P)?.crawledAt);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nmapHistory hermetic: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main();
