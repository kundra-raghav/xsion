/* runtimeGuards.ts — engine resilience against the dent break-it wedge.
 *
 * EVIDENCE (3/3 real break-it runs on dent, none in isolation): the run froze right after "gate.blocked=false",
 * BEFORE executeFlow logged anything, with a spawned headless_shell at 0.0% CPU held for minutes. That points at
 * `chromium.launch()`/CDP-handshake stalling under a loaded long-lived server — a launch-under-load failure, upstream
 * of the login cap and the per-step cap (both live INSIDE executeFlow, so both were unreachable).
 *
 * Two guards, layered:
 *  1. withDeadline(ms, work) — an OUTER cap wrapping the WHOLE executeFlow call (launch → login → steps). It's the
 *     backstop for anything the inner caps can't reach (the launch itself). Promise.race can't close a handle it never
 *     got — but executeFlow's own teardown still closes the browser when its work eventually settles/throws, and for a
 *     truly-wedged launch there's no handle anyway (only the reaper reclaims it).
 *  2. reapStaleBrowsers() — called BEFORE each launch: kill headless_shell processes older than a threshold. Directly
 *     attacks the accumulation we measured (a launch-start browser idle at 0% CPU for 7 min). Crude but it's the only
 *     thing that reclaims a wedged, handle-less process; a Promise cannot.
 */
import { execSync } from 'child_process';

/** Reject `work` if it doesn't settle within `ms`. Distinguishable error so callers key their honest "harness, not
 *  app" finding on it. Timer cleared on settle (no phantom late-fire). Does NOT cancel the loser — pair with teardown
 *  that runs regardless, and with reapStaleBrowsers for the handle-less launch case. */
export async function withDeadline<T>(ms: number, label: string, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`XSION_DEADLINE: ${label} exceeded ${ms}ms`)), ms); });
  try { return await Promise.race([work, cap]); } finally { clearTimeout(timer); }
}

/** Kill headless_shell processes older than `maxAgeSec` (default 300s). A healthy engine run's browser lives seconds
 *  to low minutes and closes itself; anything older is orphaned (a wedged launch, a crashed run) and only leaks
 *  resources. Best-effort + fully guarded — never throws into the caller. macOS/Linux `ps`-based; a no-op on failure. */
export function reapStaleBrowsers(maxAgeSec = 300): number {
  try {
    // macOS `ps` has `etime` ([[DD-]HH:]MM:SS elapsed), NOT `etimes` (Linux seconds). Parse etime → seconds so this
    // works on the dev box. Match the playwright chromium shell only.
    const out = execSync(`ps -axo pid=,etime=,comm= | grep -i headless_shell || true`, { encoding: 'utf8' });
    let killed = 0;
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+([\d:-]+)\s/);
      if (!m) continue;
      const pid = Number(m[1]);
      const age = parseEtime(m[2]);
      if (age > maxAgeSec) { try { process.kill(pid, 'SIGKILL'); killed++; } catch {} }
    }
    if (killed) console.log(`[XSION][reaper] killed ${killed} stale headless_shell (>${maxAgeSec}s old) before launch`);
    return killed;
  } catch { return 0; }
}

/** parse ps `etime` — "MM:SS" | "HH:MM:SS" | "DD-HH:MM:SS" → seconds. */
function parseEtime(s: string): number {
  let days = 0, rest = s;
  if (s.includes('-')) { const [d, r] = s.split('-'); days = Number(d) || 0; rest = r; }
  const parts = rest.split(':').map(Number);   // [SS] | [MM,SS] | [HH,MM,SS]
  let sec = 0;
  if (parts.length === 3) sec = parts[0] * 3600 + parts[1] * 60 + parts[2];
  else if (parts.length === 2) sec = parts[0] * 60 + parts[1];
  else sec = parts[0] || 0;
  return days * 86400 + sec;
}
