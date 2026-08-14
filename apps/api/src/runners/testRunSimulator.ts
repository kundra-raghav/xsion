import { v4 as uuidv4 } from 'uuid';
import { store } from '../store';
import { wsServer } from '../ws';
import type { TestRun } from '../types';
import { delay } from '../utils/delay';
import { saveJson, saveText } from '../utils/artifacts';
import { createPlaceholderScreenshot } from '../utils/screenshots';

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash);
}

function shouldFail(runId: string): boolean {
  // Deterministic failure: 1 in 5 runs fail based on runId hash
  const hash = hashString(runId);
  return hash % 5 === 0;
}

export async function startSimulatedTestRun(projectId: string, runId: string): Promise<TestRun> {
  const project = store.getProject(projectId);
  if (!project) {
    throw new Error(`Project ${projectId} not found`);
  }

  // Get smoke suite
  const smokeSuite = store.getSmokeSuite(runId) || [];
  const testCount = smokeSuite.length;

  // Create test run
  const testRun = store.createTestRun({
    id: uuidv4(),
    projectId,
    suiteId: `suite-${runId}`,
    status: 'running',
    startedAt: new Date().toISOString(),
    progressPct: 0,
    artifacts: [],
  });

  console.log(`Starting simulated test run ${testRun.id} for project ${project.name}`);

  // Start async execution
  executeTestRun(testRun, project, smokeSuite, runId).catch((error) => {
    console.error(`Test run ${testRun.id} failed:`, error);
    store.updateTestRun(testRun.id, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      errorSummary: 'Test runner encountered an error',
    });
  });

  return testRun;
}

async function executeTestRun(
  testRun: TestRun,
  project: any,
  smokeSuite: any[],
  discoveryRunId: string
): Promise<void> {
  const testRunId = testRun.id;
  const willFail = shouldFail(testRunId);
  const testCount = smokeSuite.length || 3;

  wsServer.broadcastToRun(testRunId, {
    type: 'log',
    message: `Starting smoke test suite with ${testCount} test cases`,
    level: 'info',
  });

  wsServer.broadcastToRun(testRunId, {
    type: 'status',
    status: 'running',
  });

  const steps: any[] = [];
  const screenshotArtifacts: any[] = [];
  let failedStepIndex: number | undefined;

  // Simulate test execution
  for (let i = 0; i < testCount; i++) {
    const testCase = smokeSuite[i];
    const stepNumber = i + 1;
    const totalSteps = testCount;

    wsServer.broadcastToRun(testRunId, {
      type: 'log',
      message: `Running test case ${stepNumber}/${totalSteps}: ${testCase?.name || `Test ${stepNumber}`}`,
      level: 'info',
    });

    await delay(1000 + Math.random() * 1500); // 1-2.5 seconds per test

    // Generate screenshot for this step
    try {
      const screenshot = await createPlaceholderScreenshot(
        testRunId,
        i,
        testCase?.name || `Test ${stepNumber}`,
        project.baseUrl
      );
      screenshotArtifacts.push(screenshot);
    } catch (error) {
      console.error(`Failed to save screenshot for step ${i}:`, error);
    }

    const step = {
      index: i,
      testCase: testCase?.name || `Test ${stepNumber}`,
      action: testCase?.edgePath?.[0] || 'navigate',
      duration: Math.floor(500 + Math.random() * 2000),
      status: 'passed',
    };

    // Check if this test should fail
    if (willFail && i === Math.floor(testCount / 2)) {
      step.status = 'failed';
      failedStepIndex = i;

      wsServer.broadcastToRun(testRunId, {
        type: 'log',
        message: `Test case ${stepNumber} failed: Element not found`,
        level: 'error',
      });

      steps.push(step);
      break;
    } else {
      steps.push(step);

      wsServer.broadcastToRun(testRunId, {
        type: 'log',
        message: `Test case ${stepNumber} passed`,
        level: 'info',
      });
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
    status: willFail ? 'failed' : 'passed',
  };
  const traceArtifact = await saveJson(testRunId, 'trace.json', traceData);
  artifacts.push(traceArtifact);

  // 2. Log file
  const logLines = [
    `Smoke Test Run: ${testRunId}`,
    `Project: ${project.name}`,
    `Started: ${testRun.startedAt}`,
    `Test Cases: ${testCount}`,
    '',
    'Execution:',
    ...steps.map(
      (s) =>
        `  ${s.index + 1}. ${s.testCase} - ${s.status.toUpperCase()} (${s.duration}ms)`
    ),
    '',
    willFail ? 'RESULT: FAILED' : 'RESULT: PASSED',
    willFail ? `Failed at step ${(failedStepIndex || 0) + 1}: Element not found: button[data-action="submit"]` : 'All tests passed successfully',
  ];
  const logContent = logLines.join('\n');
  const logArtifact = await saveText(testRunId, 'test-run.log', logContent);
  artifacts.push(logArtifact);

  // 3. HAR file (network trace)
  const harData = {
    log: {
      version: '1.2',
      creator: { name: 'Xsion Test Runner', version: '0.1.0' },
      entries: steps.map((s, idx) => ({
        startedDateTime: new Date(Date.now() - (steps.length - idx) * 1000).toISOString(),
        time: s.duration,
        request: {
          method: 'GET',
          url: `${project.baseUrl}/page-${idx}`,
          httpVersion: 'HTTP/1.1',
        },
        response: {
          status: 200,
          statusText: 'OK',
          httpVersion: 'HTTP/1.1',
        },
      })),
    },
  };
  const harArtifact = await saveJson(testRunId, 'network.har', harData);
  artifacts.push(harArtifact);

  // 4. Screenshots
  artifacts.push(...screenshotArtifacts);

  // Update test run with results
  store.updateTestRun(testRunId, {
    status: willFail ? 'failed' : 'passed',
    finishedAt: new Date().toISOString(),
    progressPct: 100,
    summary: willFail
      ? `${failedStepIndex! + 1}/${testCount} tests passed before failure`
      : `All ${testCount} smoke tests passed successfully`,
    errorSummary: willFail ? 'Element not found: button[data-action="submit"]' : undefined,
    failedStepIndex: failedStepIndex,
    artifacts,
  });

  // Emit final events
  wsServer.broadcastToRun(testRunId, {
    type: 'progress',
    progressPct: 100,
  });

  wsServer.broadcastToRun(testRunId, {
    type: 'status',
    status: willFail ? 'failed' : 'passed',
  });

  wsServer.broadcastToRun(testRunId, {
    type: 'log',
    message: willFail
      ? `Test suite failed at step ${(failedStepIndex || 0) + 1}`
      : 'All smoke tests completed successfully',
    level: willFail ? 'error' : 'info',
  });

  wsServer.broadcastToRun(testRunId, {
    type: 'done',
  });

  console.log(`Test run ${testRunId} completed: ${willFail ? 'FAILED' : 'PASSED'}`);
}
