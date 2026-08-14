import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';
import type { RunEvent } from '../types/events';

class WSServer {
  private wss: WebSocketServer | null = null;
  private subscriptions: Map<string, Set<WebSocket>> = new Map();
  // REPLAY BUFFER: the client can only `subscribe` AFTER the POST returns the runId — but the engine emits its first
  // events (phase:start, "reading the ticket", early thoughts) BEFORE that. Those used to be dropped (broadcastToRun
  // no-ops with no subscribers) → a frozen/READY panel until the next event landed ~a minute later. We keep a small
  // per-run history and FLUSH it on subscribe, so a late subscriber sees everything from the start. Bounded + evicted.
  private history: Map<string, any[]> = new Map();
  private static MAX_HISTORY = 200;          // per run — plenty for a phase/think/step stream, never unbounded
  private static MAX_RUNS = 100;             // cap distinct runs buffered (evict oldest)

  initialize(server: Server) {
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', (ws: WebSocket) => {
      console.log('WebSocket client connected');

      ws.on('message', (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(ws, message);
        } catch (error) {
          console.error('Failed to parse WebSocket message:', error);
        }
      });

      ws.on('close', () => {
        console.log('WebSocket client disconnected');
        this.removeClient(ws);
      });

      ws.on('error', (error) => {
        console.error('WebSocket error:', error);
      });
    });

    console.log('WebSocket server initialized on ws://localhost:4000/ws');
  }

  private handleMessage(ws: WebSocket, message: any) {
    if (message.type === 'subscribe' && message.runId) {
      this.subscribe(message.runId, ws);
      const response = { type: 'subscribed', runId: message.runId };
      this.sendToClient(ws, response);
    } else if (message.type === 'unsubscribe' && message.runId) {
      this.unsubscribe(message.runId, ws);
    }
  }

  sendToClient(ws: WebSocket, event: any) {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(event));
      }
    } catch (error) {
      console.error('Failed to send to client:', error);
    }
  }

  /** Append an event to a run's replay buffer, bounded per-run and across runs (evict oldest run). */
  private recordHistory(runId: string, event: any) {
    let buf = this.history.get(runId);
    if (!buf) {
      // evict the oldest run's buffer if we're at the run cap (Map preserves insertion order).
      if (this.history.size >= WSServer.MAX_RUNS) { const oldest = this.history.keys().next().value; if (oldest !== undefined) this.history.delete(oldest); }
      buf = []; this.history.set(runId, buf);
    }
    buf.push(event);
    if (buf.length > WSServer.MAX_HISTORY) buf.shift();
  }

  private subscribe(runId: string, client: WebSocket) {
    let clients = this.subscriptions.get(runId);
    if (!clients) {
      clients = new Set();
      this.subscriptions.set(runId, clients);
    }
    clients.add(client);
    console.log(`Client subscribed to run ${runId}, total clients: ${clients.size}`);
    // REPLAY: flush everything emitted before this client subscribed, in order, so the panel is never frozen/stale.
    const past = this.history.get(runId);
    if (past && past.length) for (const e of past) this.sendToClient(client, e);
  }

  private unsubscribe(runId: string, client: WebSocket) {
    const clients = this.subscriptions.get(runId);
    if (clients) {
      clients.delete(client);
      console.log(`Client unsubscribed from run ${runId}, remaining: ${clients.size}`);

      if (clients.size === 0) {
        this.subscriptions.delete(runId);
        console.log(`No more clients for run ${runId}, removed subscription`);
      }
    }
  }

  private removeClient(client: WebSocket) {
    for (const [runId, clients] of this.subscriptions.entries()) {
      clients.delete(client);
      if (clients.size === 0) {
        this.subscriptions.delete(runId);
      }
    }
  }

  broadcastToRun(runId: string, event: any) {
    const fullEvent = { ...event, runId } as RunEvent;
    // RECORD into the replay buffer FIRST, unconditionally — even with zero current subscribers — so a client that
    // subscribes moments later (after the POST returns its runId) still receives this event on flush.
    this.recordHistory(runId, fullEvent);

    const clients = this.subscriptions.get(runId);
    if (!clients || clients.size === 0) {
      return;
    }

    const message = JSON.stringify(fullEvent);
    const deadClients: WebSocket[] = [];

    clients.forEach((client) => {
      try {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message);
        } else {
          deadClients.push(client);
        }
      } catch (error) {
        console.error('Failed to send to client:', error);
        deadClients.push(client);
      }
    });

    // Clean up dead clients
    deadClients.forEach((client) => {
      clients.delete(client);
    });

    if (clients.size === 0) {
      this.subscriptions.delete(runId);
    }
  }

  hasSubscribers(runId: string): boolean {
    const clients = this.subscriptions.get(runId);
    return clients ? clients.size > 0 : false;
  }
}

export const wsServer = new WSServer();
