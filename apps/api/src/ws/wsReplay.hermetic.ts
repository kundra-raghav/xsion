/**
 * wsReplay.hermetic.ts — proves the WS replay buffer fixes the frozen-panel lag. No real sockets.
 * Run: cd apps/api && npx tsx src/ws/wsReplay.hermetic.ts
 *
 * The bug: the browser can only `subscribe` AFTER the POST returns the runId, but the engine emits its first events
 * (phase:start, "reading the ticket") BEFORE that → those were dropped → the panel sat on READY for ~a minute until
 * the next event landed. The buffer records every broadcast and flushes it on subscribe, so a late subscriber sees
 * the whole stream from the start.
 */
import { wsServer } from './wsServer';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d?: string) => { if (c) pass++; else { fail++; console.error(`  ✗ ${n}${d ? ' — ' + d : ''}`); } };

// a fake WebSocket that records what it's sent (mirrors the `ws` lib's shape the server uses).
function fakeSocket() {
  const OPEN = 1;
  return { readyState: OPEN, sent: [] as any[], send(m: string) { this.sent.push(JSON.parse(m)); } } as any;
}
// the server's `subscribe`/`sendToClient`/`broadcastToRun` are what we exercise. subscribe is private → drive it via
// the public message handler shape: the server calls subscribe on a {type:'subscribe',runId} message. We reach it
// through a minimal shim that mimics one connection.
function connectAndSubscribe(runId: string) {
  const sock = fakeSocket();
  // emulate the onmessage → handleMessage('subscribe') path by calling the same public entrypoint the ws uses:
  (wsServer as any).handleMessage(sock, { type: 'subscribe', runId });
  return sock;
}

const RUN = 'run-replay-1';

// 1. Emit BEFORE anyone subscribes (the race window) — these must NOT be lost.
wsServer.broadcastToRun(RUN, { type: 'test:phase', phase: 'start', label: 'Reading the bug ticket', kind: 'bugrepro' });
wsServer.broadcastToRun(RUN, { type: 'test:think', message: 'Reading the ticket…' });

// 2. NOW a client subscribes (as the UI does, after the POST returns the runId).
const late = connectAndSubscribe(RUN);
// it should have received BOTH pre-subscribe events on flush, in order (+ the 'subscribed' ack).
const events = late.sent.filter((e: any) => e.type && e.type !== 'subscribed');
ok('late subscriber receives the pre-subscribe phase event', events.some((e: any) => e.type === 'test:phase' && e.phase === 'start'), JSON.stringify(events));
ok('late subscriber receives the pre-subscribe think event', events.some((e: any) => e.type === 'test:think'));
ok('events replayed IN ORDER', events[0]?.type === 'test:phase' && events[1]?.type === 'test:think');
ok('every replayed event carries the runId', events.every((e: any) => e.runId === RUN));

// 3. A subsequent live broadcast reaches the now-subscribed client immediately.
const before = late.sent.length;
wsServer.broadcastToRun(RUN, { type: 'test:done', passed: 0, failed: 1, skipped: 0, total: 1 });
ok('live event after subscribe is delivered', late.sent.length === before + 1 && late.sent[late.sent.length - 1].type === 'test:done');

// 4. A SECOND late subscriber (e.g. a refresh) also gets the full history.
const second = connectAndSubscribe(RUN);
const secEvents = second.sent.filter((e: any) => e.type && e.type !== 'subscribed');
ok('a second late subscriber also replays the full stream', secEvents.length >= 3 && secEvents.some((e: any) => e.type === 'test:done'));

// 5. An unrelated run's buffer is independent (no cross-run leakage).
wsServer.broadcastToRun('run-other', { type: 'test:think', message: 'other run' });
const other = connectAndSubscribe('run-other');
const otherEvents = other.sent.filter((e: any) => e.type && e.type !== 'subscribed');
ok('runs are isolated — no cross-run replay', otherEvents.length === 1 && otherEvents[0].message === 'other run');

console.log(`\nwsReplay hermetic: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
