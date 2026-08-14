import crypto from 'crypto';
import type { Page } from 'playwright';

export function normalizeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);

    // Remove query string and hash
    url.search = '';
    url.hash = '';

    // Normalize trailing slash
    if (url.pathname.endsWith('/') && url.pathname.length > 1) {
      url.pathname = url.pathname.slice(0, -1);
    }

    // Replace obvious numeric IDs in path segments
    const segments = url.pathname.split('/').map((segment) => {
      // All digits -> :id
      if (/^\d+$/.test(segment)) {
        return ':id';
      }

      // UUID v4 pattern
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(segment)) {
        return ':uuid';
      }

      // Long hex-like segments (tokens)
      if (segment.length > 12 && /^[0-9a-fA-F]{13,}$/.test(segment)) {
        return ':token';
      }

      return segment;
    });

    url.pathname = segments.join('/');

    return url.toString();
  } catch {
    // If URL parsing fails, return as-is
    return rawUrl;
  }
}

export interface PageSignature {
  title?: string;
  h1?: string;
  navLabels: string[];
  ctas: string[];
}

export async function extractPageSignature(page: Page): Promise<PageSignature> {
  const signature: PageSignature = {
    navLabels: [],
    ctas: [],
  };

  try {
    // Get title
    signature.title = (await page.title()).trim();
  } catch {
    signature.title = undefined;
  }

  try {
    // Get first visible H1 or H2
    const h1 = await page.locator('h1').first().textContent({ timeout: 1000 }).catch(() => null);
    const h2 = await page.locator('h2').first().textContent({ timeout: 1000 }).catch(() => null);
    signature.h1 = (h1 || h2 || '').trim().slice(0, 100);
  } catch {
    signature.h1 = undefined;
  }

  try {
    // Get nav labels (up to 5)
    const navElements = await page.locator('nav a, nav button').all();
    const navTexts = new Set<string>();

    for (const el of navElements.slice(0, 10)) {
      try {
        const text = await el.textContent();
        if (text) {
          const trimmed = text.trim().slice(0, 50);
          if (trimmed.length > 0) {
            navTexts.add(trimmed);
          }
        }
      } catch {
        continue;
      }

      if (navTexts.size >= 5) break;
    }

    signature.navLabels = Array.from(navTexts);
  } catch {
    signature.navLabels = [];
  }

  try {
    // Get CTA button labels (up to 3 primary buttons)
    const buttons = await page.locator('button').all();
    const ctaTexts = new Set<string>();

    for (const btn of buttons) {
      try {
        const isVisible = await btn.isVisible().catch(() => false);
        if (!isVisible) continue;

        const text = await btn.textContent();
        if (text && text.trim().length >= 3 && text.trim().length <= 50) {
          ctaTexts.add(text.trim());
        }
      } catch {
        continue;
      }

      if (ctaTexts.size >= 3) break;
    }

    signature.ctas = Array.from(ctaTexts);
  } catch {
    signature.ctas = [];
  }

  return signature;
}

export function computeFingerprint(normalizedUrl: string, sig: PageSignature): string {
  const data = {
    normalizedUrl,
    title: sig.title || '',
    h1: sig.h1 || '',
    navLabels: sig.navLabels,
    ctas: sig.ctas,
  };

  const jsonString = JSON.stringify(data);
  return crypto.createHash('sha256').update(jsonString).digest('hex');
}

export async function getFingerprintForPage(page: Page): Promise<{
  normalizedUrl: string;
  fingerprint: string;
  title?: string;
  h1?: string;
  navLabels: string[];
  ctas: string[];
}> {
  const rawUrl = page.url();
  const normalizedUrl = normalizeUrl(rawUrl);
  const signature = await extractPageSignature(page);
  const fingerprint = computeFingerprint(normalizedUrl, signature);

  return {
    normalizedUrl,
    fingerprint,
    title: signature.title,
    h1: signature.h1,
    navLabels: signature.navLabels,
    ctas: signature.ctas,
  };
}
