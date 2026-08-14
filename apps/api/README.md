# Xsion API Backend

Node.js backend for Xsion web application testing platform.

## Features

- **RESTful API**: Express-based API for managing projects, discovery runs, and test runs
- **WebSocket Support**: Real-time updates for discovery run progress
- **Type Safety**: Full TypeScript with Zod validation
- **Mock Runners**: Simulated discovery and test execution (ready for Playwright integration)

## Getting Started

### Install Dependencies

```bash
npm install
```

### Development

Start the dev server with hot reload:

```bash
npm run dev
```

Server will run on `http://localhost:4000`

### Build

Compile TypeScript to JavaScript:

```bash
npm run build
```

### Production

Run the compiled server:

```bash
npm start
```

## API Endpoints

### Projects

- `GET /api/projects` - List all projects
- `GET /api/projects/:id` - Get project by ID
- `POST /api/projects` - Create new project
- `DELETE /api/projects/:id` - Delete project

### Discovery Runs

- `GET /api/runs/discovery` - List all discovery runs
- `GET /api/runs/discovery/:id` - Get discovery run by ID
- `POST /api/runs/discovery/:projectId` - Start new discovery run

### Test Runs

- `GET /api/runs/test` - List all test runs
- `GET /api/runs/test/:id` - Get test run by ID

### Graph

- `GET /api/graph/:runId` - Get graph (nodes and edges) for a run

### Tests

- `POST /api/tests/generate/:projectId/:runId` - Generate smoke test suite
- `POST /api/tests/run/:projectId/:runId` - Run smoke test suite

### WebSocket

Connect to `ws://localhost:4000/ws` for real-time updates.

**Message Format:**

Subscribe to run updates:
```json
{ "type": "subscribe", "runId": "run-123" }
```

Unsubscribe:
```json
{ "type": "unsubscribe", "runId": "run-123" }
```

**Events received:**
- Progress updates: `{ "type": "progress", "progressPct": 50 }`
- Status changes: `{ "type": "status", "status": "finished" }`
- Graph updates: `{ "type": "graph:add", "nodes": [...], "edges": [...] }`

## Project Structure

```
apps/api/
├── src/
│   ├── index.ts          # Entry point
│   ├── server.ts         # Express app setup
│   ├── routes/           # API route handlers
│   │   ├── index.ts
│   │   ├── projects.ts
│   │   ├── runs.ts
│   │   ├── graph.ts
│   │   └── tests.ts
│   ├── ws/               # WebSocket manager
│   │   └── index.ts
│   ├── store/            # In-memory data store
│   │   └── index.ts
│   ├── types/            # TypeScript types and Zod schemas
│   │   └── index.ts
│   ├── runners/          # Discovery and test runners
│   │   ├── discovery.ts
│   │   └── test.ts
│   └── utils/            # Utility functions
│       └── delay.ts
├── data/                 # Data persistence (gitignored)
│   └── artifacts/
├── package.json
├── tsconfig.json
└── README.md
```

## Development Notes

- The current implementation uses in-memory storage. Data is lost on restart.
- Discovery and test runners are mocked. Replace with actual Playwright/Puppeteer implementation.
- WebSocket broadcasts work only for active connections. Consider adding a pub/sub system for production.
