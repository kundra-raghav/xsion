import fs from 'fs/promises';
import path from 'path';
import type { RunArtifact, RunArtifactKind } from '../types';

const ARTIFACTS_DIR = path.join(__dirname, '../../data/artifacts');

async function ensureRunDir(runId: string): Promise<string> {
  const runDir = path.join(ARTIFACTS_DIR, runId);
  await fs.mkdir(runDir, { recursive: true });
  return runDir;
}

function createArtifact(runId: string, filename: string, kind: RunArtifactKind): RunArtifact {
  const baseUrl = process.env.API_BASE_URL || 'http://localhost:4000';
  return {
    key: `artifacts/${runId}/${filename}`,
    kind,
    url: `${baseUrl}/artifacts/${runId}/${filename}`,
  };
}

export async function saveText(runId: string, filename: string, content: string): Promise<RunArtifact> {
  const runDir = await ensureRunDir(runId);
  const filePath = path.join(runDir, filename);
  await fs.writeFile(filePath, content, 'utf-8');
  return createArtifact(runId, filename, 'log');
}

export async function saveJson(runId: string, filename: string, data: any): Promise<RunArtifact> {
  const runDir = await ensureRunDir(runId);
  const filePath = path.join(runDir, filename);
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  return createArtifact(runId, filename, 'trace');
}

export async function saveFakeScreenshot(runId: string, stepIndex: number): Promise<RunArtifact> {
  const runDir = await ensureRunDir(runId);
  const filename = `screenshot-${stepIndex}.png`;
  const filePath = path.join(runDir, filename);

  // Write a simple placeholder text file with .png extension for MVP
  const placeholder = `[Screenshot Placeholder - Step ${stepIndex}]\nRun ID: ${runId}\nTimestamp: ${new Date().toISOString()}`;
  await fs.writeFile(filePath, placeholder, 'utf-8');

  return createArtifact(runId, filename, 'screenshot');
}
