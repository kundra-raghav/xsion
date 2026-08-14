import { chromium, Page, Locator } from 'playwright';
import { v4 as uuidv4 } from 'uuid';
import { store } from '../store';
import { wsServer } from '../ws';
import type { DiscoveryRun, StateNode, TransitionEdge, ClickContext } from '../types';
import { getFingerprintForPage } from '../utils/fingerprint';
import { getCandidateActions, makeActionKey, type CandidateAction, type SelectorBundle } from './candidates';
import { createPlaceholderScreenshot } from '../utils/screenshots';
import { installEvalShim } from '../brain/evalShim';

const MAX_DURATION_MS = 8 * 60 * 1000; // 8 minutes
const MAX_ACTIONS = 120;
const MAX_STATES = 30;
const STOP_AFTER_NO_NEW_STATE_STEPS = 10;

async function captureClickContext(page: Page, bundle: SelectorBundle): Promise<ClickContext> {
  const selectors = [bundle.preferred, ...bundle.fallbacks];

  for (const sel of selectors) {
    try {
      let locator: Locator | null = null;

      if (sel.kind === 'role' && sel.role && sel.name) {
        locator = page.getByRole(sel.role as any, { name: sel.name }).first();
      } else if (sel.kind === 'testid' && sel.value) {
        locator = page.getByTestId(sel.value).first();
      } else if (sel.kind === 'text' && sel.value) {
        locator = page.getByText(sel.value, { exact: false }).first();
      } else if (sel.kind === 'css' && sel.value) {
        locator = page.locator(sel.value).first();
      }

      if (!locator) continue;

      const count = await locator.count();
      if (count === 0) continue;

      // Extract context info from element
      const contextInfo = await locator.evaluate((el) => {
        const inNav = !!el.closest('nav');
        const inDialog = !!el.closest('[role="dialog"]');
        const inMain = !!el.closest('main');

        const elementText = (el.textContent || '').trim().slice(0, 60);
        const ariaLabel = el.getAttribute('aria-label') || undefined;
        const role = el.getAttribute('role') || el.tagName.toLowerCase();
        const testId = el.getAttribute('data-testid') || undefined;
        const href = el.tagName.toLowerCase() === 'a' ? (el as any).href : undefined;

        return {
          inNav,
          inDialog,
          inMain,
          elementText,
          ariaLabel,
          role,
          testId,
          href,
        };
      });

      let scope: ClickContext['scope'] = 'page';
      let scopeSelector: string | undefined;

      if (contextInfo.inDialog) {
        scope = 'dialog';
        scopeSelector = '[role="dialog"]';
      } else if (contextInfo.inNav) {
        scope = 'nav';
        scopeSelector = 'nav';
      } else if (contextInfo.inMain) {
        scope = 'main';
        scopeSelector = 'main';
      } else {
        scope = 'page';
      }

      return {
        scope,
        scopeSelector,
        elementText: contextInfo.elementText,
        ariaLabel: contextInfo.ariaLabel,
        role: contextInfo.role,
        testId: contextInfo.testId,
        href: contextInfo.href,
      };
    } catch {
      continue;
    }
  }

  // Fallback
  return {
    scope: 'unknown',
  };
}

async function clickWithSelectorBundle(page: Page, bundle: SelectorBundle): Promise<void> {
  const selectors = [bundle.preferred, ...bundle.fallbacks];

  for (const sel of selectors) {
    try {
      if (sel.kind === 'role' && sel.role && sel.name) {
        await page.getByRole(sel.role as any, { name: sel.name }).first().click({ timeout: 5000 });
        return;
      } else if (sel.kind === 'testid' && sel.value) {
        await page.getByTestId(sel.value).first().click({ timeout: 5000 });
        return;
      } else if (sel.kind === 'text' && sel.value) {
        await page.getByText(sel.value, { exact: false }).first().click({ timeout: 5000 });
        return;
      } else if (sel.kind === 'css' && sel.value) {
        await page.locator(sel.value).first().click({ timeout: 5000 });
        return;
      }
    } catch {
      continue;
    }
  }

  throw new Error('All selector attempts failed');
}

export async function startPlaywrightDiscovery(run: DiscoveryRun): Promise<void> {
  console.log(`Starting Playwright discovery for run ${run.id}, project: ${run.projectId}`);

  const project = store.getProject(run.projectId);
  if (!project) {
    console.error(`Project ${run.projectId} not found`);
    return;
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (compatible; XsionBot/1.0)',
  });
  await installEvalShim(context);   // tsx/esbuild __name bug — see brain/evalShim.ts
  const page = await context.newPage();

  const startTime = Date.now();
  let actionCount = 0;
  let stepIndex = 0;
  let noNewStateCounter = 0;

  const seenStatesByFingerprint = new Map<string, string>(); // fingerprint -> stateId
  const visitedActionKeys = new Set<string>();

  try {
    // Navigate to base URL
    wsServer.broadcastToRun(run.id, {
      type: 'log',
      message: `Navigating to ${project.baseUrl}...`,
      level: 'info',
      ts: new Date().toISOString(),
    });

    try {
      await page.goto(project.baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(1000);
    } catch (navError: any) {
      let errorMessage = 'Failed to load website';

      if (navError.message?.includes('ERR_NAME_NOT_RESOLVED')) {
        errorMessage = `Domain does not exist or cannot be resolved: ${project.baseUrl}. Please check the URL.`;
      } else if (navError.message?.includes('ERR_CONNECTION_REFUSED')) {
        errorMessage = `Connection refused by ${project.baseUrl}. The server may be down.`;
      } else if (navError.message?.includes('ERR_CONNECTION_TIMED_OUT')) {
        errorMessage = `Connection timed out for ${project.baseUrl}. The server may be slow or unreachable.`;
      } else if (navError.message?.includes('ERR_CERT')) {
        errorMessage = `SSL certificate error for ${project.baseUrl}. The site may have an invalid certificate.`;
      } else if (navError.message?.includes('Timeout')) {
        errorMessage = `Page load timeout for ${project.baseUrl}. The site is taking too long to respond.`;
      } else {
        errorMessage = `Navigation failed: ${navError.message || 'Unknown error'}`;
      }

      wsServer.broadcastToRun(run.id, {
        type: 'log',
        message: errorMessage,
        level: 'error',
        ts: new Date().toISOString(),
      });

      throw new Error(errorMessage);
    }

    // Get root state fingerprint
    const rootFp = await getFingerprintForPage(page);
    const rootNode: StateNode = {
      id: uuidv4(),
      projectId: run.projectId,
      runId: run.id,
      url: page.url(),
      title: rootFp.title || '',
      fingerprint: rootFp.fingerprint,
      label: rootFp.title || 'Home',
      tags: ['entry-point'],
      screenshotKey: `artifacts/${run.id}/state-0.png`,
      // Debug info
      normalizedUrl: rootFp.normalizedUrl,
      h1: rootFp.h1,
      navLabels: rootFp.navLabels,
      ctas: rootFp.ctas,
    };

    // Save root screenshot
    const artifactsDir = `${process.cwd()}/data/artifacts/${run.id}`;
    await require('fs').promises.mkdir(artifactsDir, { recursive: true });
    const screenshotPath = `${artifactsDir}/state-0.png`;
    await page.screenshot({ path: screenshotPath, fullPage: false });

    seenStatesByFingerprint.set(rootFp.fingerprint, rootNode.id);
    store.addNodes(run.id, [rootNode]);

    wsServer.broadcastToRun(run.id, {
      type: 'graph:add',
      nodes: [rootNode],
    });

    wsServer.broadcastToRun(run.id, {
      type: 'log',
      message: 'Discovered root state',
      level: 'info',
      ts: new Date().toISOString(),
    });

    // Main discovery loop
    while (true) {
      // Check termination conditions
      if (Date.now() - startTime > MAX_DURATION_MS) {
        wsServer.broadcastToRun(run.id, {
          type: 'log',
          message: 'Reached time limit (8 minutes)',
          level: 'info',
          ts: new Date().toISOString(),
        });
        break;
      }

      if (actionCount >= MAX_ACTIONS) {
        wsServer.broadcastToRun(run.id, {
          type: 'log',
          message: `Reached action limit (${MAX_ACTIONS})`,
          level: 'info',
          ts: new Date().toISOString(),
        });
        break;
      }

      if (seenStatesByFingerprint.size >= MAX_STATES) {
        wsServer.broadcastToRun(run.id, {
          type: 'log',
          message: `Reached state limit (${MAX_STATES})`,
          level: 'info',
          ts: new Date().toISOString(),
        });
        break;
      }

      if (noNewStateCounter >= STOP_AFTER_NO_NEW_STATE_STEPS) {
        wsServer.broadcastToRun(run.id, {
          type: 'log',
          message: `No new states found in last ${STOP_AFTER_NO_NEW_STATE_STEPS} steps, stopping`,
          level: 'info',
          ts: new Date().toISOString(),
        });
        break;
      }

      // Get current state
      const currentFp = await getFingerprintForPage(page);
      const currentStateId = seenStatesByFingerprint.get(currentFp.fingerprint);

      // Get candidates
      const candidates = await getCandidateActions(page, { maxCandidates: 12 });

      // Emit step:start
      wsServer.broadcastToRun(run.id, {
        type: 'step:start',
        stepIndex,
        state: {
          url: page.url(),
          fingerprint: currentFp.fingerprint,
          title: currentFp.title,
        },
        candidatesCount: candidates.length,
        ts: new Date().toISOString(),
      });

      if (candidates.length === 0) {
        wsServer.broadcastToRun(run.id, {
          type: 'log',
          message: 'No more candidates available',
          level: 'info',
          ts: new Date().toISOString(),
        });
        break;
      }

      // Find first unvisited candidate
      let selectedCandidate: CandidateAction | null = null;
      for (const cand of candidates) {
        const actionKey = makeActionKey(currentFp.fingerprint, cand);
        if (!visitedActionKeys.has(actionKey)) {
          selectedCandidate = cand;
          visitedActionKeys.add(actionKey);
          break;
        }
      }

      if (!selectedCandidate) {
        wsServer.broadcastToRun(run.id, {
          type: 'log',
          message: 'All candidates already visited from this state',
          level: 'info',
          ts: new Date().toISOString(),
        });
        noNewStateCounter++;
        stepIndex++;
        continue;
      }

      actionCount++;

      // Emit step:action
      wsServer.broadcastToRun(run.id, {
        type: 'step:action',
        stepIndex,
        action: {
          type: 'click',
          label: selectedCandidate.label,
          selectorBundle: selectedCandidate.selectorBundle,
        },
        ts: new Date().toISOString(),
      });

      try {
        // Capture pre-click context
        const preClickUrl = page.url();
        const clickContext = await captureClickContext(page, selectedCandidate.selectorBundle);

        // Execute click
        await clickWithSelectorBundle(page, selectedCandidate.selectorBundle);

        // Wait for navigation/loading
        await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(250);

        // Capture post-click URL
        const postClickUrl = page.url();

        // Get new state fingerprint
        const newFp = await getFingerprintForPage(page);
        const createdNewState = !seenStatesByFingerprint.has(newFp.fingerprint);

        // Detect unstable edge: same fingerprint as before (no state change)
        const isUnstable = currentFp.fingerprint === newFp.fingerprint;
        const edgeTags: string[] = isUnstable ? ['unstable'] : [];

        if (createdNewState) {
          // New state discovered
          const stateIndex = seenStatesByFingerprint.size;
          const newNode: StateNode = {
            id: uuidv4(),
            projectId: run.projectId,
            runId: run.id,
            url: page.url(),
            title: newFp.title || '',
            fingerprint: newFp.fingerprint,
            label: newFp.title || `State ${stateIndex}`,
            tags: [],
            screenshotKey: `artifacts/${run.id}/state-${stateIndex}.png`,
            // Debug info
            normalizedUrl: newFp.normalizedUrl,
            h1: newFp.h1,
            navLabels: newFp.navLabels,
            ctas: newFp.ctas,
          };

          // Save screenshot
          const newScreenshotPath = `${artifactsDir}/state-${stateIndex}.png`;
          await page.screenshot({ path: newScreenshotPath, fullPage: false });

          seenStatesByFingerprint.set(newFp.fingerprint, newNode.id);
          store.addNodes(run.id, [newNode]);

          // Create edge
          const edge: TransitionEdge = {
            id: uuidv4(),
            projectId: run.projectId,
            runId: run.id,
            fromStateId: currentStateId!,
            toStateId: newNode.id,
            action: {
              type: 'click',
              label: selectedCandidate.label,
            },
            confidence: 0.9,
            selectorBundle: selectedCandidate.selectorBundle,
            clickContext,
            preClickUrl,
            postClickUrl,
            fromFingerprint: currentFp.fingerprint,
            toFingerprint: newFp.fingerprint,
            observedFromFingerprint: currentFp.fingerprint,
            observedToFingerprint: newFp.fingerprint,
            tags: edgeTags,
            createdAt: new Date().toISOString(),
          };

          store.addEdges(run.id, [edge]);

          wsServer.broadcastToRun(run.id, {
            type: 'graph:add',
            nodes: [newNode],
            edges: [edge],
          });

          noNewStateCounter = 0;
        } else {
          // Existing state
          const toStateId = seenStatesByFingerprint.get(newFp.fingerprint)!;

          // Create edge to existing state
          const edge: TransitionEdge = {
            id: uuidv4(),
            projectId: run.projectId,
            runId: run.id,
            fromStateId: currentStateId!,
            toStateId: toStateId,
            action: {
              type: 'click',
              label: selectedCandidate.label,
            },
            confidence: 0.9,
            selectorBundle: selectedCandidate.selectorBundle,
            clickContext,
            preClickUrl,
            postClickUrl,
            fromFingerprint: currentFp.fingerprint,
            toFingerprint: newFp.fingerprint,
            observedFromFingerprint: currentFp.fingerprint,
            observedToFingerprint: newFp.fingerprint,
            tags: edgeTags,
            createdAt: new Date().toISOString(),
          };

          store.addEdges(run.id, [edge]);

          wsServer.broadcastToRun(run.id, {
            type: 'graph:add',
            edges: [edge],
          });

          noNewStateCounter++;
        }

        // Emit step:result
        wsServer.broadcastToRun(run.id, {
          type: 'step:result',
          stepIndex,
          fromFingerprint: currentFp.fingerprint,
          toFingerprint: newFp.fingerprint,
          url: page.url(),
          createdNewState,
          ts: new Date().toISOString(),
        });

        // Update progress
        const progress = Math.min(95, Math.floor((actionCount / MAX_ACTIONS) * 100));
        store.updateDiscoveryRun(run.id, {
          progressPct: progress,
          nodesCount: seenStatesByFingerprint.size,
          edgesCount: actionCount,
        });

        wsServer.broadcastToRun(run.id, {
          type: 'progress',
          progressPct: progress,
        });
      } catch (error: any) {
        // Action failed
        const errorMessage = error.message || 'Unknown error';

        // Take screenshot
        let screenshotKey: string | undefined;
        try {
          const errorScreenshotPath = `${artifactsDir}/error-${stepIndex}.png`;
          await page.screenshot({ path: errorScreenshotPath, fullPage: false });
          screenshotKey = `artifacts/${run.id}/error-${stepIndex}.png`;
        } catch {
          screenshotKey = undefined;
        }

        wsServer.broadcastToRun(run.id, {
          type: 'step:error',
          stepIndex,
          message: errorMessage,
          screenshotArtifactKey: screenshotKey,
          ts: new Date().toISOString(),
        });

        noNewStateCounter++;
      }

      stepIndex++;
    }

    // Finalize run
    store.updateDiscoveryRun(run.id, {
      status: 'finished',
      finishedAt: new Date().toISOString(),
      progressPct: 100,
    });

    wsServer.broadcastToRun(run.id, {
      type: 'status',
      status: 'finished',
    });

    wsServer.broadcastToRun(run.id, {
      type: 'done',
      ts: new Date().toISOString(),
    });

    console.log(`Playwright discovery completed for run ${run.id}`);
  } catch (error: any) {
    console.error(`Playwright discovery failed for run ${run.id}:`, error);

    store.updateDiscoveryRun(run.id, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
    });

    wsServer.broadcastToRun(run.id, {
      type: 'status',
      status: 'failed',
    });

    wsServer.broadcastToRun(run.id, {
      type: 'log',
      message: `Discovery failed: ${error.message || 'Unknown error'}`,
      level: 'error',
      ts: new Date().toISOString(),
    });

    wsServer.broadcastToRun(run.id, {
      type: 'done',
      ts: new Date().toISOString(),
    });
  } finally {
    await browser.close();
  }
}
