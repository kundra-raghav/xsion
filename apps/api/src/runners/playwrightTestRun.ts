import { chromium, Page } from 'playwright';
import { v4 as uuidv4 } from 'uuid';
import { store } from '../store';
import { wsServer } from '../ws';
import type { TestRun, StateNode, TransitionEdge, StepResult } from '../types';
import type { SelectorBundle } from './candidates';
import { resolveAndClick } from './locator';
import { installEvalShim } from '../brain/evalShim';
import { saveJson, saveText } from '../utils/artifacts';
import fs from 'fs/promises';
import path from 'path';

export async function startPlaywrightTestRun(projectId: string, discoveryRunId: string): Promise<TestRun> {
  const project = store.getProject(projectId);
  if (!project) {
    throw new Error(`Project ${projectId} not found`);
  }

  // Get smoke suite
  const smokeSuite = store.getSmokeSuite(discoveryRunId) || [];
  const testCount = smokeSuite.length;

  if (testCount === 0) {
    throw new Error(`No smoke suite found for run ${discoveryRunId}`);
  }

  // Get discovery graph
  const graph = store.getGraph(discoveryRunId);
  if (!graph || graph.nodes.length === 0) {
    throw new Error(`No discovery graph found for run ${discoveryRunId}`);
  }

  // Create test run
  const testRun = store.createTestRun({
    id: uuidv4(),
    projectId,
    suiteId: `suite-${discoveryRunId}`,
    status: 'running',
    startedAt: new Date().toISOString(),
    progressPct: 0,
    artifacts: [],
  });

  console.log(`Starting Playwright test run ${testRun.id} for project ${project.name}`);

  // Start async execution
  executePlaywrightTestRun(testRun, project, smokeSuite, graph, discoveryRunId).catch((error) => {
    console.error(`Test run ${testRun.id} failed:`, error);
    store.updateTestRun(testRun.id, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      errorSummary: `Test runner encountered an error: ${error.message}`,
    });
  });

  return testRun;
}

async function executePlaywrightTestRun(
  testRun: TestRun,
  project: any,
  smokeSuite: any[],
  graph: { nodes: StateNode[]; edges: TransitionEdge[] },
  discoveryRunId: string
): Promise<void> {
  const testRunId = testRun.id;
  const testCount = smokeSuite.length;

  let browser;
  let page: Page;

  try {
    // Launch browser
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (compatible; XsionBot/1.0)',
    });
    await installEvalShim(context);   // tsx/esbuild __name bug — see brain/evalShim.ts
    page = await context.newPage();

    // Create artifacts directory
    const artifactsDir = path.join(process.cwd(), 'data/artifacts', testRunId);
    await fs.mkdir(artifactsDir, { recursive: true });

    wsServer.broadcastToRun(testRunId, {
      type: 'log',
      message: `Starting Playwright smoke test suite with ${testCount} test cases`,
      level: 'info',
    });

    wsServer.broadcastToRun(testRunId, {
      type: 'status',
      status: 'running',
    });

    const steps: any[] = [];
    const stepResults: StepResult[] = [];
    const screenshotArtifacts: any[] = [];
    let failedStepIndex: number | undefined;

    // Build edge lookup map
    const edgeMap = new Map<string, TransitionEdge>();
    graph.edges.forEach((edge) => {
      edgeMap.set(edge.id, edge);
    });

    // Node lookup for labels
    const nodeMap = new Map<string, StateNode>();
    graph.nodes.forEach((node) => {
      nodeMap.set(node.id, node);
    });

    // Execute each test case
    for (let i = 0; i < testCount; i++) {
      const testCase = smokeSuite[i];
      const stepNumber = i + 1;
      const totalSteps = testCount;
      const startTime = Date.now();

      wsServer.broadcastToRun(testRunId, {
        type: 'log',
        message: `Running test case ${stepNumber}/${totalSteps}: ${testCase?.name || `Test ${stepNumber}`}`,
        level: 'info',
      });

      try {
        // Navigate to base URL for each test case
        await page.goto(project.baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(500);

        // Take initial screenshot
        const initialScreenshotPath = path.join(artifactsDir, `screenshot-${i}-initial.png`);
        await page.screenshot({ path: initialScreenshotPath, fullPage: false });

        const baseUrl = process.env.API_BASE_URL || 'http://localhost:4000';
        const initialScreenshot = {
          key: `artifacts/${testRunId}/screenshot-${i}-initial.png`,
          kind: 'screenshot',
          url: `${baseUrl}/artifacts/${testRunId}/screenshot-${i}-initial.png`,
        };
        screenshotArtifacts.push(initialScreenshot);

        // Execute the edge path
        const edgePath = testCase.edgePath || [];
        for (let edgeIndex = 0; edgeIndex < edgePath.length; edgeIndex++) {
          const edgeId = edgePath[edgeIndex];
          const edge = edgeMap.get(edgeId);

          if (!edge) {
            throw new Error(`Edge ${edgeId} not found in graph`);
          }

          const fromNode = nodeMap.get(edge.fromStateId);
          const toNode = nodeMap.get(edge.toStateId);

          // Emit test:step event
          wsServer.broadcastToRun(testRunId, {
            type: 'test:step',
            runId: testRunId,
            testRunId,
            stepIndex: edgeIndex,
            edgeId: edge.id,
            fromLabel: fromNode?.label,
            toLabel: toNode?.label,
            ts: new Date().toISOString(),
          });

          // Capture pre-click URL
          const preClickUrl = page.url();

          // Use resolveAndClick with click context
          const { attempts, note } = await resolveAndClick(page, edge.selectorBundle, edge.clickContext, {
            timeoutMs: 8000,
            preClickUrl,
          });

          // Take screenshot after each step (unique per test case)
          const stepScreenshotPath = path.join(artifactsDir, `screenshot-test${i}-step${edgeIndex}.png`);
          await page.screenshot({ path: stepScreenshotPath, fullPage: false });

          const stepScreenshot = {
            key: `artifacts/${testRunId}/screenshot-test${i}-step${edgeIndex}.png`,
            kind: 'screenshot',
            url: `${baseUrl}/artifacts/${testRunId}/screenshot-test${i}-step${edgeIndex}.png`,
          };
          screenshotArtifacts.push(stepScreenshot);

          // Record step result
          const stepResult: StepResult = {
            stepIndex: edgeIndex,
            edgeId: edge.id,
            status: 'pass',
            attempts,
            note,
            screenshotKey: stepScreenshot.key,
          };
          stepResults.push(stepResult);
        }

        const duration = Date.now() - startTime;
        const step = {
          index: i,
          testCase: testCase?.name || `Test ${stepNumber}`,
          action: testCase?.edgePath?.[0] || 'navigate',
          duration,
          status: 'passed',
        };

        steps.push(step);

        wsServer.broadcastToRun(testRunId, {
          type: 'log',
          message: `Test case ${stepNumber} passed (${duration}ms)`,
          level: 'info',
        });
      } catch (error: any) {
        // Test case failed
        const duration = Date.now() - startTime;
        failedStepIndex = i;

        const step = {
          index: i,
          testCase: testCase?.name || `Test ${stepNumber}`,
          action: testCase?.edgePath?.[0] || 'navigate',
          duration,
          status: 'failed',
          error: error.message,
        };

        steps.push(step);

        // Take failure screenshot
        const baseUrl = process.env.API_BASE_URL || 'http://localhost:4000';
        let failureScreenshotKey: string | undefined;
        try {
          const failureScreenshotPath = path.join(artifactsDir, `screenshot-${i}-failure.png`);
          await page.screenshot({ path: failureScreenshotPath, fullPage: false });

          const failureScreenshot = {
            key: `artifacts/${testRunId}/screenshot-${i}-failure.png`,
            kind: 'screenshot',
            url: `${baseUrl}/artifacts/${testRunId}/screenshot-${i}-failure.png`,
          };
          screenshotArtifacts.push(failureScreenshot);
          failureScreenshotKey = failureScreenshot.key;
        } catch {
          // Ignore screenshot errors
        }

        // Emit test:fail event
        wsServer.broadcastToRun(testRunId, {
          type: 'test:fail',
          runId: testRunId,
          testRunId,
          stepIndex: i,
          error: error.message,
          screenshotKey: failureScreenshotKey,
          ts: new Date().toISOString(),
        });

        wsServer.broadcastToRun(testRunId, {
          type: 'log',
          message: `Test case ${stepNumber} failed: ${error.message}`,
          level: 'error',
        });

        break; // Stop on first failure
      }

      // Update progress
      const progressPct = Math.round(((i + 1) / totalSteps) * 100);

      // Persist progress to store
      store.updateTestRun(testRunId, {
        progressPct,
      });

      // Broadcast progress event
      wsServer.broadcastToRun(testRunId, {
        type: 'progress',
        progressPct,
      });
    }

    // Generate artifacts
    const artifacts = [];

    // 1. Trace file
    const traceData = {
      testRunId,
      projectId: project.id,
      discoveryRunId,
      timestamp: new Date().toISOString(),
      testCount,
      steps,
      status: failedStepIndex !== undefined ? 'failed' : 'passed',
    };
    const traceArtifact = await saveJson(testRunId, 'trace.json', traceData);
    artifacts.push(traceArtifact);

    // 2. Log file
    const logLines = [
      `Playwright Smoke Test Run: ${testRunId}`,
      `Project: ${project.name}`,
      `Started: ${testRun.startedAt}`,
      `Test Cases: ${testCount}`,
      '',
      'Execution:',
      ...steps.map(
        (s) =>
          `  ${s.index + 1}. ${s.testCase} - ${s.status.toUpperCase()} (${s.duration}ms)${
            s.error ? ` - ${s.error}` : ''
          }`
      ),
      '',
      failedStepIndex !== undefined ? 'RESULT: FAILED' : 'RESULT: PASSED',
      failedStepIndex !== undefined
        ? `Failed at step ${failedStepIndex + 1}: ${steps[failedStepIndex].error || 'Unknown error'}`
        : 'All tests passed successfully',
    ];
    const logContent = logLines.join('\n');
    const logArtifact = await saveText(testRunId, 'test-run.log', logContent);
    artifacts.push(logArtifact);

    // 3. Screenshots (dedupe by key)
    const uniqueScreenshots = Array.from(
      new Map(screenshotArtifacts.map((a) => [a.key, a])).values()
    );
    artifacts.push(...uniqueScreenshots);

    // Update test run with results
    const finalStatus = failedStepIndex !== undefined ? 'failed' : 'passed';
    store.updateTestRun(testRunId, {
      status: finalStatus,
      finishedAt: new Date().toISOString(),
      progressPct: 100,
      summary:
        failedStepIndex !== undefined
          ? `${failedStepIndex}/${testCount} tests passed before failure`
          : `All ${testCount} smoke tests passed successfully`,
      errorSummary:
        failedStepIndex !== undefined ? steps[failedStepIndex].error || 'Test failed' : undefined,
      failedStepIndex: failedStepIndex,
      stepResults,
      artifacts,
    });

    // Emit final events
    wsServer.broadcastToRun(testRunId, {
      type: 'progress',
      progressPct: 100,
    });

    wsServer.broadcastToRun(testRunId, {
      type: 'status',
      status: finalStatus,
    });

    wsServer.broadcastToRun(testRunId, {
      type: 'test:done',
      runId: testRunId,
      testRunId,
      status: finalStatus === 'failed' ? 'fail' : 'pass',
      ts: new Date().toISOString(),
    });

    wsServer.broadcastToRun(testRunId, {
      type: 'log',
      message:
        finalStatus === 'failed'
          ? `Test suite failed at step ${(failedStepIndex || 0) + 1}`
          : 'All smoke tests completed successfully',
      level: finalStatus === 'failed' ? 'error' : 'info',
    });

    wsServer.broadcastToRun(testRunId, {
      type: 'done',
    });

    console.log(`Playwright test run ${testRunId} completed: ${finalStatus.toUpperCase()}`);
  } catch (error: any) {
    console.error(`Playwright test run ${testRunId} failed:`, error);

    store.updateTestRun(testRunId, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      errorSummary: `Test execution failed: ${error.message}`,
    });

    wsServer.broadcastToRun(testRunId, {
      type: 'status',
      status: 'failed',
    });

    wsServer.broadcastToRun(testRunId, {
      type: 'log',
      message: `Test execution failed: ${error.message}`,
      level: 'error',
    });

    wsServer.broadcastToRun(testRunId, {
      type: 'done',
    });

    throw error;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}
