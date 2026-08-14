import { store } from '../store';
import type { Project } from '../types';
import { delay } from '../utils/delay';
import { saveJson, saveText } from '../utils/artifacts';

/**
 * Mock test runner that simulates running smoke tests
 * In production, this would use Playwright/Puppeteer to execute test cases
 */
export async function startTestRunner(testRunId: string, project: Project): Promise<void> {
  console.log(`Starting test runner for test run ${testRunId}, project: ${project.name}`);

  try {
    // Simulate test execution
    await delay(3000);

    const success = Math.random() > 0.3;

    // Generate artifacts
    const traceData = {
      testRunId,
      projectId: project.id,
      timestamp: new Date().toISOString(),
      steps: [
        { action: 'navigate', url: project.baseUrl, duration: 234 },
        { action: 'click', selector: 'button#login', duration: 123 },
        { action: 'fill', selector: 'input[name="email"]', value: 'test@example.com', duration: 45 },
      ],
    };

    const logContent = `Test Run: ${testRunId}
Project: ${project.name}
Started: ${new Date().toISOString()}
Status: ${success ? 'PASSED' : 'FAILED'}

Steps:
1. Navigate to ${project.baseUrl}
2. Click login button
3. Fill email field

${success ? 'All tests passed successfully' : 'Test failed at step 2: Element not found'}
`;

    const traceArtifact = await saveJson(testRunId, 'trace.json', traceData);
    const logArtifact = await saveText(testRunId, 'log.txt', logContent);

    store.updateTestRun(testRunId, {
      status: success ? 'passed' : 'failed',
      finishedAt: new Date().toISOString(),
      summary: success
        ? 'All smoke tests passed successfully'
        : 'Some tests failed - see error details',
      errorSummary: success ? undefined : 'Element not found: button[data-action="submit"]',
      failedStepIndex: success ? undefined : Math.floor(Math.random() * 3),
      artifacts: [traceArtifact, logArtifact],
    });

    console.log(`Test runner completed for test run ${testRunId}, status: ${success ? 'passed' : 'failed'}`);
  } catch (error) {
    console.error(`Test runner failed for test run ${testRunId}:`, error);
    store.updateTestRun(testRunId, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      errorSummary: 'Test runner encountered an error',
    });
  }
}
