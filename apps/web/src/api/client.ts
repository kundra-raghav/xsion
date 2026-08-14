import type {
  Project,
  DiscoveryRun,
  TestCase,
  TestRun,
  RunEvent,
  GraphResponse,
  CreateProjectRequest,
  StartDiscoveryRunRequest,
} from './types';

export interface ApiClient {
  // Project operations
  listProjects(): Promise<Project[]>;
  createProject(request: CreateProjectRequest): Promise<Project>;
  getProject(projectId: string): Promise<Project>;

  // Discovery run operations
  listRuns(): Promise<DiscoveryRun[]>;
  getDiscoveryRuns(): Promise<DiscoveryRun[]>;
  getRun(runId: string): Promise<DiscoveryRun>;
  startDiscoveryRun(projectId: string, request: StartDiscoveryRunRequest): Promise<DiscoveryRun>;

  // Test run operations
  getTestRuns(): Promise<TestRun[]>;
  getTestRun(runId: string): Promise<TestRun>;

  // Real-time updates
  streamRunEvents(runId: string, onEvent: (event: RunEvent) => void, onConnectionChange?: (connected: boolean, retrying: boolean) => void): () => void;

  // Graph operations
  getGraph(runId: string): Promise<GraphResponse>;

  // Test generation and execution
  generateSmokeSuite(projectId: string, runId: string): Promise<TestCase[]>;
  runSmokeSuite(projectId: string, runId: string): Promise<TestRun>;
}

const API_BASE_URL = 'http://localhost:4000';
const WS_BASE_URL = 'ws://localhost:4000';

class HttpApiClient implements ApiClient {
  private async fetch<T>(endpoint: string, options?: RequestInit): Promise<T> {
    const url = `${API_BASE_URL}${endpoint}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout

    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...options?.headers,
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error(error.error || `HTTP ${response.status}: ${response.statusText}`);
      }

      return response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new Error('Request timeout');
        }
        throw error;
      }
      throw new Error('Unknown error occurred');
    }
  }

  // Project operations
  async listProjects(): Promise<Project[]> {
    return this.fetch<Project[]>('/api/projects');
  }

  async createProject(request: CreateProjectRequest): Promise<Project> {
    return this.fetch<Project>('/api/projects', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  async getProject(projectId: string): Promise<Project> {
    return this.fetch<Project>(`/api/projects/${projectId}`);
  }

  // Discovery run operations
  async listRuns(): Promise<DiscoveryRun[]> {
    const data = await this.fetch<{ discoveryRuns: DiscoveryRun[]; testRuns: TestRun[] }>('/api/runs');
    return data.discoveryRuns;
  }

  async getDiscoveryRuns(): Promise<DiscoveryRun[]> {
    const data = await this.fetch<{ discoveryRuns: DiscoveryRun[]; testRuns: TestRun[] }>('/api/runs');
    return data.discoveryRuns;
  }

  async getRun(runId: string): Promise<DiscoveryRun> {
    return this.fetch<DiscoveryRun>(`/api/runs/${runId}`);
  }

  async startDiscoveryRun(
    projectId: string,
    request: StartDiscoveryRunRequest
  ): Promise<DiscoveryRun> {
    return this.fetch<DiscoveryRun>(`/api/projects/${projectId}/discovery-runs`, {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  // Test run operations
  async getTestRuns(): Promise<TestRun[]> {
    const data = await this.fetch<{ discoveryRuns: DiscoveryRun[]; testRuns: TestRun[] }>('/api/runs');
    return data.testRuns;
  }

  async getTestRun(runId: string): Promise<TestRun> {
    return this.fetch<TestRun>(`/api/runs/${runId}`);
  }

  // Real-time updates
  streamRunEvents(runId: string, onEvent: (event: RunEvent) => void, onConnectionChange?: (connected: boolean, retrying: boolean) => void): () => void {
    const wsUrl = `${WS_BASE_URL}/ws`;
    let ws: WebSocket | null = null;
    let reconnectTimeout: number | null = null;
    let isClosed = false;
    let retryCount = 0;
    const MAX_RETRIES = 3;

    const connect = () => {
      if (isClosed || retryCount >= MAX_RETRIES) {
        if (retryCount >= MAX_RETRIES) {
          console.error('Max reconnection attempts reached');
          onConnectionChange?.(false, false);
        }
        return;
      }

      try {
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
          console.log(`WebSocket connected for run ${runId}`);
          retryCount = 0; // Reset retry count on successful connection
          ws?.send(JSON.stringify({ type: 'subscribe', runId }));
          onConnectionChange?.(true, false);
        };

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);

            // Skip subscription confirmation
            if (data.type === 'subscribed') {
              console.log(`Subscribed to run ${runId}`);
              return;
            }

            onEvent(data as RunEvent);
          } catch (error) {
            console.error('Failed to parse WebSocket message:', error);
          }
        };

        ws.onerror = (error) => {
          console.error('WebSocket error:', error);
        };

        ws.onclose = (event) => {
          console.log('WebSocket closed', event.code, event.reason);
          ws = null;

          // Only attempt reconnect if not explicitly closed and haven't exceeded retries
          if (!isClosed && retryCount < MAX_RETRIES) {
            retryCount++;
            const backoffDelay = Math.min(1000 * Math.pow(2, retryCount - 1), 10000); // Exponential backoff: 1s, 2s, 4s, capped at 10s
            console.log(`Connection lost. Retry ${retryCount}/${MAX_RETRIES} in ${backoffDelay}ms`);

            onConnectionChange?.(false, true);

            reconnectTimeout = window.setTimeout(() => {
              console.log(`Attempting reconnection ${retryCount}/${MAX_RETRIES}...`);
              connect();
            }, backoffDelay);
          } else if (retryCount >= MAX_RETRIES) {
            console.error('Max reconnection attempts reached');
            onConnectionChange?.(false, false);
          }
        };
      } catch (error) {
        console.error('Failed to create WebSocket:', error);
        onConnectionChange?.(false, false);
      }
    };

    // Initial connection
    connect();

    // Return cleanup function
    return () => {
      isClosed = true;
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
      }
      if (ws) {
        ws.close();
        ws = null;
      }
    };
  }

  // Graph operations
  async getGraph(runId: string): Promise<GraphResponse> {
    return this.fetch<GraphResponse>(`/api/runs/${runId}/graph`);
  }

  // Test generation and execution
  async generateSmokeSuite(projectId: string, runId: string): Promise<TestCase[]> {
    return this.fetch<TestCase[]>(`/api/projects/${projectId}/runs/${runId}/generate-smoke`, {
      method: 'POST',
    });
  }

  async runSmokeSuite(projectId: string, runId: string): Promise<TestRun> {
    return this.fetch<TestRun>(`/api/projects/${projectId}/runs/${runId}/run-smoke`, {
      method: 'POST',
    });
  }
}

export const api: ApiClient = new HttpApiClient();
