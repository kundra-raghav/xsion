import fs from 'fs/promises';
import path from 'path';
import type { RunArtifact } from '../types';

const ARTIFACTS_DIR = path.join(__dirname, '../../data/artifacts');

async function ensureRunDir(runId: string): Promise<string> {
  const runDir = path.join(ARTIFACTS_DIR, runId);
  await fs.mkdir(runDir, { recursive: true });
  return runDir;
}

/**
 * Creates a visible placeholder screenshot as an SVG image
 */
export async function createPlaceholderScreenshot(
  runId: string,
  stepIndex: number,
  pageTitle: string,
  pageUrl: string
): Promise<RunArtifact> {
  const runDir = await ensureRunDir(runId);
  const filename = `screenshot-${stepIndex}.svg`;
  const filePath = path.join(runDir, filename);

  // Create an SVG placeholder that looks like a browser window
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="1280" height="720" xmlns="http://www.w3.org/2000/svg">
  <!-- Background -->
  <rect width="1280" height="720" fill="#f8f9fa"/>

  <!-- Browser chrome -->
  <rect width="1280" height="50" fill="#e9ecef"/>
  <circle cx="20" cy="25" r="6" fill="#ff5f57"/>
  <circle cx="40" cy="25" r="6" fill="#febc2e"/>
  <circle cx="60" cy="25" r="6" fill="#28c840"/>

  <!-- URL bar -->
  <rect x="80" y="15" width="1120" height="20" rx="10" fill="#ffffff" stroke="#dee2e6" stroke-width="1"/>
  <text x="100" y="29" font-family="Arial, sans-serif" font-size="12" fill="#6c757d">${escapeXml(pageUrl)}</text>

  <!-- Page content -->
  <text x="640" y="200" font-family="Arial, sans-serif" font-size="32" fill="#212529" text-anchor="middle" font-weight="bold">
    ${escapeXml(pageTitle)}
  </text>

  <text x="640" y="240" font-family="Arial, sans-serif" font-size="16" fill="#6c757d" text-anchor="middle">
    Simulated Screenshot
  </text>

  <text x="640" y="270" font-family="Arial, sans-serif" font-size="14" fill="#adb5bd" text-anchor="middle">
    Step ${stepIndex + 1}
  </text>

  <!-- Mock content blocks -->
  <rect x="100" y="320" width="400" height="20" rx="4" fill="#dee2e6"/>
  <rect x="100" y="360" width="300" height="20" rx="4" fill="#dee2e6"/>
  <rect x="100" y="400" width="350" height="20" rx="4" fill="#dee2e6"/>

  <rect x="780" y="320" width="400" height="20" rx="4" fill="#dee2e6"/>
  <rect x="780" y="360" width="320" height="20" rx="4" fill="#dee2e6"/>
  <rect x="780" y="400" width="380" height="20" rx="4" fill="#dee2e6"/>

  <!-- Footer note -->
  <text x="640" y="680" font-family="Arial, sans-serif" font-size="11" fill="#adb5bd" text-anchor="middle">
    Enable ENABLE_PLAYWRIGHT=true for real screenshots
  </text>
</svg>`;

  await fs.writeFile(filePath, svg, 'utf-8');

  const baseUrl = process.env.API_BASE_URL || 'http://localhost:4000';
  return {
    key: `artifacts/${runId}/${filename}`,
    kind: 'screenshot',
    url: `${baseUrl}/artifacts/${runId}/${filename}`,
  };
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
