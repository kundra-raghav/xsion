import fs from 'fs/promises';
import path from 'path';
import type {
  Project,
  DiscoveryRun,
  StateNode,
  TransitionEdge,
  TestCase,
  TestRun,
} from '../types';

// DATA_DIR/DB_FILE are env-overridable so the `xsion check` CLI can run against a PROJECT-LOCAL store (its own
// db.json on the dev's machine) and tests can point at a temp dir — without touching the server's data/db.json.
const DATA_DIR = process.env.XSION_DATA_DIR || path.join(__dirname, '../../data');
const DB_FILE = process.env.XSION_DB_FILE || path.join(DATA_DIR, 'db.json');

interface GraphData {
  nodes: Map<string, StateNode>;
  edges: Map<string, TransitionEdge>;
}

interface StoreState {
  projects: [string, Project][];
  discoveryRuns: [string, DiscoveryRun][];
  graphs: [string, { nodes: [string, StateNode][]; edges: [string, TransitionEdge][] }][];
  testRuns: [string, TestRun][];
  smokeSuites: [string, TestCase[]][];
}

export class DataStore {
  private projects: Map<string, Project> = new Map();
  private discoveryRuns: Map<string, DiscoveryRun> = new Map();
  private graphs: Map<string, GraphData> = new Map();
  private testRuns: Map<string, TestRun> = new Map();
  private smokeSuites: Map<string, TestCase[]> = new Map();
  private projectMaps: Map<string, any> = new Map();   // projectId → ProjectMap (the crawl-map spine)
  private mapHistory: Map<string, any[]> = new Map();   // projectId → ring of PREVIOUS completed maps (newest last)
  private static MAP_HISTORY_KEEP = 5;                   // small ring — mapDiff only needs the immediately-previous
  private projectKnowledge: Map<string, any[]> = new Map();   // projectId → KnowledgeEntry[] (NAVIGATIONAL learning)

  // ── PROJECT LEARNING STORE (navigational only — see projectKnowledge.ts; NEVER holds oracle verdicts) ──
  getProjectKnowledge(projectId: string): any[] { return this.projectKnowledge.get(projectId) || []; }
  setProjectKnowledge(projectId: string, entries: any[]): void { this.projectKnowledge.set(projectId, entries); this.persist(); }

  // ── crawl-map: a URL onboarded as a mapped project ──
  /** Persist the current map. mapDiff() needs the PREVIOUS completed crawl as a baseline — but a crawl saves many
   * incremental `status:'crawling'` snapshots that would clobber it. So we archive the prior DONE map at the moment a
   * NEW crawl begins (the first save whose crawledAt differs from the current map's), BEFORE it gets overwritten.
   * In-progress saves of the SAME crawl (same crawledAt) never re-archive. This is the v2 "what changed" spine — no git. */
  saveProjectMap(projectId: string, map: any): void {
    const prev = this.projectMaps.get(projectId);
    const isNewCrawl = prev && map && prev.crawledAt !== map.crawledAt;
    // archive the prior map only when it was a COMPLETED crawl AND a genuinely new crawl is now starting/replacing it.
    if (isNewCrawl && prev.status !== 'crawling') {
      const ring = this.mapHistory.get(projectId) || [];
      // guard against double-archiving the same baseline (idempotent on crawledAt).
      if (!ring.length || ring[ring.length - 1]?.crawledAt !== prev.crawledAt) {
        ring.push(prev);
        while (ring.length > DataStore.MAP_HISTORY_KEEP) ring.shift();
        this.mapHistory.set(projectId, ring);
      }
    }
    this.projectMaps.set(projectId, map);
    this.persist();
  }
  getProjectMap(projectId: string): any | undefined { return this.projectMaps.get(projectId); }
  /** The immediately-previous COMPLETED map for this project (the mapDiff baseline), or undefined on the first crawl. */
  getPreviousProjectMap(projectId: string): any | undefined { const ring = this.mapHistory.get(projectId); return ring && ring.length ? ring[ring.length - 1] : undefined; }
  /** The full history ring (newest last), for a future "drift over N crawls" view. */
  getProjectMapHistory(projectId: string): any[] { return this.mapHistory.get(projectId) || []; }

  /** Record a user's correction on one flow of the map (map-validation UX). Persists the correction + bumps
   * the flow's confidence to 'high' (the user vouched for it) so it's real, not decorative. */
  correctFlow(projectId: string, flowId: string, correction: { note?: string; name?: string; confidence?: string }): any | undefined {
    const map = this.projectMaps.get(projectId);
    if (!map) return undefined;
    const flow = (map.flows || []).find((f: any) => f.id === flowId);
    if (!flow) return undefined;
    if (correction.name) flow.name = correction.name;
    flow.userCorrected = true;
    flow.userNote = correction.note || flow.userNote;
    flow.confidence = correction.confidence || 'high';   // user vouched → high
    this.projectMaps.set(projectId, map);
    this.persist();
    return flow;
  }

  constructor() {
    this.ensureDataDir();
    this.load();
  }

  private async ensureDataDir() {
    try {
      await fs.mkdir(DATA_DIR, { recursive: true });
      await fs.mkdir(path.join(DATA_DIR, 'artifacts'), { recursive: true });
    } catch (error) {
      console.error('Failed to create data directory:', error);
    }
  }

  private async load() {
    try {
      const data = await fs.readFile(DB_FILE, 'utf-8');
      const state: StoreState = JSON.parse(data);

      this.projects = new Map(state.projects || []);
      this.discoveryRuns = new Map(state.discoveryRuns || []);
      this.testRuns = new Map(state.testRuns || []);
      this.smokeSuites = new Map(state.smokeSuites || []);
      this.projectMaps = new Map((state as any).projectMaps || []);
      this.mapHistory = new Map((state as any).mapHistory || []);
      this.projectKnowledge = new Map((state as any).projectKnowledge || []);

      // Restore graphs with nested Maps
      this.graphs = new Map(
        (state.graphs || []).map(([runId, graphData]) => [
          runId,
          {
            nodes: new Map(graphData.nodes || []),
            edges: new Map(graphData.edges || []),
          },
        ])
      );

      console.log('📂 Data loaded from db.json');
    } catch (error) {
      // File doesn't exist or is invalid - start fresh
      console.log('📂 No existing data found, starting fresh');
    }
  }

  // persist serialization: many store mutations call persist() WITHOUT awaiting, so multiple async persists could
  // run concurrently and interleave their writes → a corrupted db.json (this really happened: a schooltalk crawl
  // wrote `"url":"https://qa-auth.sc` then abruptly `"count":1` = two serializations racing). We serialize: if a
  // persist is in flight, mark dirty and let the running one re-run once when it finishes, so no write is lost.
  private _persisting = false;
  private _persistDirty = false;
  private _persistPromise: Promise<void> | null = null;   // the in-flight persist chain, for flush()
  private async persist() {
    if (this._persisting) { this._persistDirty = true; return; }
    this._persisting = true;
    const run = (async () => {
      try {
        do { this._persistDirty = false; await this._persistOnce(); } while (this._persistDirty);
      } finally {
        this._persisting = false;
        this._persistPromise = null;
      }
    })();
    this._persistPromise = run;
    return run;
  }
  /** Await any in-flight/pending write to settle. Callers that `process.exit()` (e.g. the `xsion check` CLI) MUST
   * `await store.flush()` first — persist() is fire-and-forget, so exiting immediately drops the pending write and
   * loses the just-recorded run (this really happened: a break-it artifact vanished because exit raced the async
   * save). Idempotent; resolves immediately when nothing is pending. */
  async flush(): Promise<void> {
    // loop in case a mutation lands between our check and the await (dirty re-run schedules another cycle).
    while (this._persistPromise) { await this._persistPromise; }
  }
  private async _persistOnce() {
    try {
      // SECURITY: role credentials live in memory only (underscored keys like _email/_password). Strip them from
      // every project before writing to db.json — the persisted role carries just id/name/hasCredentials.
      const scrubbedProjects = Array.from(this.projects.entries()).map(([id, p]) => {
        const proj: any = {};
        // strip ANY top-level underscored key (e.g. _defaultCreds) — those hold in-memory secrets, never persisted.
        for (const k of Object.keys(p)) if (!k.startsWith('_')) proj[k] = (p as any)[k];
        if (Array.isArray(proj.roles)) {
          proj.roles = proj.roles.map((r: any) => {
            const clean: any = {};
            for (const k of Object.keys(r)) if (!k.startsWith('_')) clean[k] = r[k];
            clean.hasCredentials = !!(r._email && r._password) || !!r.hasCredentials;
            return clean;
          });
        }
        return [id, proj] as [string, Project];
      });
      const state: StoreState = {
        projects: scrubbedProjects,
        discoveryRuns: Array.from(this.discoveryRuns.entries()),
        graphs: Array.from(this.graphs.entries()).map(([runId, graphData]) => [
          runId,
          {
            nodes: Array.from(graphData.nodes.entries()),
            edges: Array.from(graphData.edges.entries()),
          },
        ]),
        testRuns: Array.from(this.testRuns.entries()),
        smokeSuites: Array.from(this.smokeSuites.entries()),
      };
      // crawl-map spine: persist project maps so a URL onboarded as a project survives a restart.
      (state as any).projectMaps = Array.from(this.projectMaps.entries());
      (state as any).mapHistory = Array.from(this.mapHistory.entries());
      (state as any).projectKnowledge = Array.from(this.projectKnowledge.entries());

      // ATOMIC write: serialize to a temp file, then rename OVER db.json. rename() is atomic on POSIX, so a reader
      // (or a crash) never sees a half-written file — it sees either the old db or the new one, never a torn mix.
      const body = JSON.stringify(state, null, 2);
      const tmp = `${DB_FILE}.tmp.${process.pid}`;
      await fs.writeFile(tmp, body, 'utf-8');
      await fs.rename(tmp, DB_FILE);
    } catch (error) {
      console.error('Failed to persist data:', error);
    }
  }

  // Projects
  createProject(project: Project): Project {
    this.projects.set(project.id, project);
    this.persist();
    return project;
  }

  getProject(id: string): Project | undefined {
    return this.projects.get(id);
  }

  updateProject(id: string, updates: Partial<Project>): Project | undefined {
    const p = this.projects.get(id);
    if (!p) return undefined;
    const next = { ...p, ...updates } as Project;
    this.projects.set(id, next);
    this.persist();
    return next;
  }

  listProjects(): Project[] {
    return Array.from(this.projects.values());
  }

  deleteProject(id: string): boolean {
    const deleted = this.projects.delete(id);
    if (deleted) {
      this.persist();
    }
    return deleted;
  }

  // Discovery Runs
  createDiscoveryRun(run: DiscoveryRun): DiscoveryRun {
    this.discoveryRuns.set(run.id, run);
    this.persist();
    return run;
  }

  getDiscoveryRun(id: string): DiscoveryRun | undefined {
    return this.discoveryRuns.get(id);
  }

  listDiscoveryRuns(): DiscoveryRun[] {
    return Array.from(this.discoveryRuns.values());
  }

  updateDiscoveryRun(id: string, updates: Partial<DiscoveryRun>): DiscoveryRun | undefined {
    const run = this.discoveryRuns.get(id);
    if (!run) return undefined;

    const updated = { ...run, ...updates };
    this.discoveryRuns.set(id, updated);
    this.persist();
    return updated;
  }

  // Graph operations
  getGraph(runId: string): { nodes: StateNode[]; edges: TransitionEdge[] } {
    const graph = this.graphs.get(runId);
    if (!graph) {
      return { nodes: [], edges: [] };
    }

    return {
      nodes: Array.from(graph.nodes.values()),
      edges: Array.from(graph.edges.values()),
    };
  }

  addNodes(runId: string, nodes: StateNode[]): void {
    let graph = this.graphs.get(runId);
    if (!graph) {
      graph = { nodes: new Map(), edges: new Map() };
      this.graphs.set(runId, graph);
    }

    nodes.forEach((node) => {
      graph.nodes.set(node.id, node);
    });

    this.persist();
  }

  addEdges(runId: string, edges: TransitionEdge[]): void {
    let graph = this.graphs.get(runId);
    if (!graph) {
      graph = { nodes: new Map(), edges: new Map() };
      this.graphs.set(runId, graph);
    }

    edges.forEach((edge) => {
      graph.edges.set(edge.id, edge);
    });

    this.persist();
  }

  // Smoke Suites
  saveSmokeSuite(runId: string, suite: TestCase[]): void {
    this.smokeSuites.set(runId, suite);
    this.persist();
  }

  getSmokeSuite(runId: string): TestCase[] | undefined {
    return this.smokeSuites.get(runId);
  }

  // Test Runs
  createTestRun(run: TestRun): TestRun {
    this.testRuns.set(run.id, run);
    this.persist();
    return run;
  }

  getTestRun(id: string): TestRun | undefined {
    return this.testRuns.get(id);
  }

  listTestRuns(): TestRun[] {
    return Array.from(this.testRuns.values());
  }

  updateTestRun(id: string, updates: Partial<TestRun>): TestRun | undefined {
    const run = this.testRuns.get(id);
    if (!run) return undefined;

    const updated = { ...run, ...updates };
    this.testRuns.set(id, updated);
    this.persist();
    return updated;
  }
}

export const store = new DataStore();
