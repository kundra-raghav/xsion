/**
 * liveFrame.ts — stream a "watch it work" frame (screenshot + URL + action) from a test executor to the UI, AND
 * (optionally) PERSIST each frame to disk so a finished run can be REPLAYED frame-by-frame later.
 *
 * The crawl has BrowserStage; the test runs (break-it/bug-repro/mission/…) showed only a text list. This closes that
 * gap: pass `makeFrameHook(runId, emit)` as executeFlow's `onFrame` → the frontend gets `test:frame {screenshot,
 * url, path, label}` (accepted by the useTestRun `test:` filter). When persistence is on, each frame is ALSO written
 * to `data/artifacts/<runId>/frame-NNNN.jpg`, and `hook.frames` collects lightweight POINTERS (url + label + ts) the
 * caller attaches to the run record — never base64 in db.json.
 *
 * TWO SEPARATE cadences (advisor #211-style split):
 *   - LIVE (WS): throttled to XSION_FRAME_INTERVAL_MS (default 500) + a re-entrancy guard, to protect streaming cost.
 *   - PERSIST (disk): EVERY onFrame call is saved (one per step) — full step-coverage so playback isn't jumpy. Only
 *     the WS is throttled; disk gets everything (screenshot is already captured; we just add a writeFile).
 * Behind XSION_LIVE_FRAMES (default on). Frames-per-run capped by XSION_MAX_SAVED_FRAMES (default 300).
 */
import fs from 'fs/promises';
import path from 'path';

type Emit = (runId: string, e: any) => void;
type PageLike = { url: () => string; screenshot: (opts: any) => Promise<Buffer>; evaluate?: (fn: any, arg?: any) => Promise<any> };

const LIVE_FRAMES = (process.env.XSION_LIVE_FRAMES ?? '1') !== '0';
const SAVE_FRAMES = (process.env.XSION_SAVE_FRAMES ?? '1') !== '0';
const MIN_INTERVAL_MS = Number(process.env.XSION_FRAME_INTERVAL_MS || 500);
const MAX_SAVED_FRAMES = Number(process.env.XSION_MAX_SAVED_FRAMES || 300);
const MAX_RECORDED_RUNS = Number(process.env.XSION_MAX_RECORDED_RUNS || 60);   // keep the N newest runs' frame dirs
const API_BASE = process.env.API_BASE_URL || 'http://localhost:4000';
const ARTIFACTS_DIR = path.join(__dirname, '../../data/artifacts');

function safePath(u: string): string { try { return new URL(u).pathname || '/'; } catch { return u; } }

/** EVICTION: keep only the MAX_RECORDED_RUNS newest frame directories on disk (bounds storage). A pruned run's
 * pointers still exist in db.json, but the RunPlayer is tolerant of missing images ("playback expired"), so this
 * never shows a broken image — it degrades to "expired" (the advisor-approved option). Best-effort, never throws. */
async function evictOldRunDirs(keepRunId: string): Promise<void> {
  try {
    const entries = await fs.readdir(ARTIFACTS_DIR, { withFileTypes: true }).catch(() => [] as any[]);
    const dirs: { name: string; mtime: number }[] = [];
    for (const e of entries as any[]) {
      if (!e.isDirectory || !e.isDirectory()) continue;
      // only prune dirs that actually hold playback frames (leave crawl stall-shots / other artifacts alone).
      const files = await fs.readdir(path.join(ARTIFACTS_DIR, e.name)).catch(() => [] as string[]);
      if (!files.some((f) => f.startsWith('frame-'))) continue;
      const st = await fs.stat(path.join(ARTIFACTS_DIR, e.name)).catch(() => null);
      dirs.push({ name: e.name, mtime: st ? st.mtimeMs : 0 });
    }
    if (dirs.length <= MAX_RECORDED_RUNS) return;
    dirs.sort((a, b) => b.mtime - a.mtime);   // newest first
    for (const d of dirs.slice(MAX_RECORDED_RUNS)) {
      if (d.name === keepRunId) continue;
      await fs.rm(path.join(ARTIFACTS_DIR, d.name), { recursive: true, force: true }).catch(() => {});
    }
  } catch { /* eviction is best-effort */ }
}

/** A box in page CSS pixels — where an action happened, for the cursor/highlight overlay. */
export interface ActionBox { x: number; y: number; width: number; height: number; }

/** A persisted frame pointer stored in the run record (NOT the bytes). */
export interface FramePointer {
  n: number; url: string; path: string; label?: string; ts: number;
  caseIndex?: number;   // which attack/case this frame belongs to (for per-case clips)
  caseTitle?: string;
}

export interface FrameHook {
  (page: PageLike, label?: string, box?: ActionBox | null): Promise<void>;
  /** the persisted frame pointers, in order — attach to the run record's artifact for playback. */
  frames: FramePointer[];
  /** the caller sets these before each case so every subsequent frame is tagged with it. */
  caseIndex?: number;
  caseTitle?: string;
}

/** Build an onFrame hook bound to a runId + the caller's emit. Streams live (throttled) + persists to disk (every
 * frame). Returns a no-op hook (with empty `frames`) when live frames are disabled. */
export function makeFrameHook(runId: string, emit: Emit): FrameHook {
  const frames: FramePointer[] = [];
  if (!LIVE_FRAMES) { const noop = (async () => {}) as unknown as FrameHook; noop.frames = frames; return noop; }

  let liveCapturing = false;   // guards the LIVE (WS) path only
  let lastLiveAt = 0;
  let n = 0;
  let dirReady: Promise<void> | null = null;

  const hook = (async (page: PageLike, label?: string, box?: ActionBox | null) => {
    const now = Date.now();
    let buf: Buffer | null = null;
    const url = page.url();

    // Draw a CURSOR + highlight ring at the action box BEFORE the screenshot, so playback SHOWS where Xsion clicked/
    // typed (not just a caption). Removed in finally so it never persists into the next frame or the app's own DOM.
    // NOTE: no named helpers inside the evaluate (the tsx __name rule — kept helper-free so it survives any build).
    let overlayDrawn = false;
    if (box && (page as any).evaluate) {
      try {
        await (page as any).evaluate((b: ActionBox) => {
          const d: any = (globalThis as any).document;
          const wrap = d.createElement('div'); wrap.id = '__xsion_cursor__';
          wrap.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;left:0;top:0;';
          const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
          // highlight ring on the target element
          const ring = d.createElement('div');
          ring.style.cssText = `position:fixed;left:${b.x - 4}px;top:${b.y - 4}px;width:${b.width + 8}px;height:${b.height + 8}px;border:2px solid #b6ff3a;border-radius:6px;box-shadow:0 0 0 3px rgba(182,255,58,.25),0 0 14px rgba(182,255,58,.5);pointer-events:none;`;
          // the cursor arrow at the action point
          const cur = d.createElement('div');
          cur.style.cssText = `position:fixed;left:${cx}px;top:${cy}px;width:22px;height:22px;pointer-events:none;transform:translate(-2px,-2px);`;
          cur.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M4 2l6 16 2.5-6.5L19 9z" fill="#b6ff3a" stroke="#0b0e14" stroke-width="1.4"/></svg>';
          wrap.appendChild(ring); wrap.appendChild(cur); d.body.appendChild(wrap);
        }, box);
        overlayDrawn = true;
      } catch { /* couldn't draw — screenshot the bare frame */ }
    }

    try {
      // PERSIST (disk): every call, until the cap. Screenshot once; reuse the buffer for the WS below.
      if (SAVE_FRAMES && frames.length < MAX_SAVED_FRAMES) {
        try {
          if (!dirReady) dirReady = fs.mkdir(path.join(ARTIFACTS_DIR, runId), { recursive: true }).then(() => evictOldRunDirs(runId));
          await dirReady;
          buf = await page.screenshot({ type: 'jpeg', quality: 55, timeout: 5000 });
          const idx = ++n;
          const filename = `frame-${String(idx).padStart(4, '0')}.jpg`;
          await fs.writeFile(path.join(ARTIFACTS_DIR, runId, filename), buf);
          frames.push({ n: idx, url: `${API_BASE}/artifacts/${runId}/${filename}`, path: safePath(url), label, ts: now, caseIndex: hook.caseIndex, caseTitle: hook.caseTitle });
        } catch { /* capture/write failed → skip this frame */ }
      }

      // LIVE (WS): throttled + guarded. Reuse the persisted buffer if we have one.
      if (!(liveCapturing || now - lastLiveAt < MIN_INTERVAL_MS)) {
        liveCapturing = true; lastLiveAt = now;
        try {
          emit(runId, { type: 'test:navigate', url, path: safePath(url), label });
          if (!buf) buf = await page.screenshot({ type: 'jpeg', quality: 55, timeout: 5000 });
          emit(runId, { type: 'test:frame', screenshot: `data:image/jpeg;base64,${buf.toString('base64')}`, url, path: safePath(url), label });
        } catch { /* navigation mid-flight → skip */ }
        finally { liveCapturing = false; }
      }
    } finally {
      // ALWAYS remove the overlay so it never bleeds into the next frame or the live app DOM.
      if (overlayDrawn && (page as any).evaluate) {
        await (page as any).evaluate(() => { const e = (globalThis as any).document.getElementById('__xsion_cursor__'); if (e) e.remove(); }).catch(() => {});
      }
    }
  }) as FrameHook;
  hook.frames = frames;
  return hook;
}
