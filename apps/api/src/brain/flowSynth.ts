/**
 * flowSynth.ts — SoA turns the OBSERVED crawl surface (pages + API inventory) into named user flows, each with
 * a per-flow CONFIDENCE score (high/medium/low) so the user corrects only the uncertain ones (not a modal per
 * flow). In code-mode SoA also reads the repo; in blackbox-mode it reasons from the observed surface alone.
 */
import { spawn } from 'child_process';
import * as path from 'path';
import { v4 as uuid } from 'uuid';
import type { MappedFlow, MappedPage, ApiEndpoint } from './crawlTypes';

const SOA_DIR = process.env.SOA_DIR || path.resolve(process.env.HOME || '', 'Desktop/Dev/Son_Of_Antonov/soa_gemini');
const PYTHON = process.env.SOA_PYTHON || 'python3';
const BRIDGE = path.join(SOA_DIR, 'xsion_bridge.py');

export interface SynthInput { baseUrl: string; repo?: string; pages: MappedPage[]; api: ApiEndpoint[]; }

export async function synthesizeFlows(input: SynthInput): Promise<MappedFlow[]> {
  const observation = {
    baseUrl: input.baseUrl,
    pages: input.pages.map((p) => ({ path: p.path, title: p.title, interactives: p.interactives })),
    api: input.api.slice(0, 40).map((a) => ({ method: a.method, url: a.url, statuses: a.statuses })),
  };
  const raw = await callBridge(['map', input.repo || '-', JSON.stringify(observation)]).catch(() => null);
  const flows = (raw?.flows || []) as any[];
  if (!Array.isArray(flows) || !flows.length) return [];
  return flows.slice(0, 12).map((f) => ({
    id: uuid(),
    name: String(f.name || 'flow'),
    role: String(f.role || 'user'),
    steps: Array.isArray(f.steps) ? f.steps.map((s: any) => ({ intent: String(s.intent || s), expectedOutcome: s.expectedOutcome })) : [],
    confidence: (['high', 'medium', 'low'].includes(f.confidence) ? f.confidence : 'medium') as any,
    reasoning: f.reasoning ? String(f.reasoning) : undefined,
    description: f.description ? String(f.description) : undefined,
    breaksIf: f.breaksIf ? String(f.breaksIf) : undefined,
    businessValue: (['critical', 'important', 'minor'].includes(f.businessValue) ? f.businessValue : undefined) as any,
  })).filter((f) => f.name && f.steps.length);
}

function callBridge(args: string[], timeoutMs = 180000): Promise<any> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, SOA_BACKEND: process.env.SOA_BACKEND || 'perplexity', SOA_PERPLEXITY: '1', SOA_V3_PROMOTE_ON_ANY_READ: '1', SOA_MAX_COST_USD: process.env.SOA_MAX_COST_USD || '0.60' };
    const proc = spawn(PYTHON, [BRIDGE, ...args], { cwd: SOA_DIR, env });
    let out = ''; let err = '';
    const t = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('map bridge timeout')); }, timeoutMs);
    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('error', (e) => { clearTimeout(t); reject(e); });
    proc.on('close', () => {
      clearTimeout(t);
      const line = out.trim().split('\n').filter((l) => l.trim().startsWith('{')).pop();
      if (!line) return reject(new Error(`map bridge no JSON. stderr: ${err.slice(-300)}`));
      try { resolve(JSON.parse(line)); } catch (e: any) { reject(e); }
    });
  });
}
