import type { Page, Locator } from 'playwright';

export interface SelectorBundle {
  preferred: {
    kind: 'role' | 'testid' | 'text' | 'css';
    role?: string;
    name?: string;
    value?: string;
  };
  fallbacks: Array<{
    kind: 'role' | 'testid' | 'text' | 'css';
    role?: string;
    name?: string;
    value?: string;
  }>;
}

export interface CandidateAction {
  type: 'click';
  label?: string;
  selectorBundle: SelectorBundle;
  score: number;
  elementHint?: {
    tag?: string;
    role?: string;
  };
}

const DANGEROUS_LABELS = [
  'delete',
  'remove',
  'cancel',
  'pay',
  'logout',
  'unsubscribe',
  'deactivate',
  'destroy',
  'sign out',
  'log out',
];

const GENERIC_LABELS = ['ok', 'yes', 'submit', 'click', 'close', 'x'];

export function isDangerousLabel(label?: string): boolean {
  if (!label) return false;
  const lower = label.toLowerCase();
  return DANGEROUS_LABELS.some((dangerous) => lower.includes(dangerous));
}

export function makeActionKey(fingerprint: string, candidate: CandidateAction): string {
  const sel = candidate.selectorBundle.preferred;
  const key = `${sel.kind}:${sel.role || ''}:${sel.name || ''}:${sel.value || ''}`;
  return `${fingerprint}|${key}`;
}

export async function getCandidateActions(
  page: Page,
  opts?: { maxCandidates?: number }
): Promise<CandidateAction[]> {
  const maxCandidates = opts?.maxCandidates || 12;
  const candidates: CandidateAction[] = [];

  const selectors = ['a[href]', 'button', '[role="button"]'];

  for (const selector of selectors) {
    const elements = await page.locator(selector).all();

    for (const element of elements) {
      try {
        const isVisible = await element.isVisible().catch(() => false);
        if (!isVisible) continue;

        // Check bounding box size
        const box = await element.boundingBox().catch(() => null);
        if (box && (box.width < 18 || box.height < 18)) {
          // Check if inside nav
          const inNav = await element.evaluate((el) => {
            let parent = el.parentElement;
            while (parent) {
              if (parent.tagName === 'NAV') return true;
              parent = parent.parentElement;
            }
            return false;
          });

          if (!inNav) continue;
        }

        // Extract label
        const ariaLabel = await element.getAttribute('aria-label');
        const innerText = await element.textContent();
        const titleAttr = await element.getAttribute('title');
        const label = (ariaLabel || innerText || titleAttr || '').trim();

        if (!label || label.length === 0) continue;

        // Filter dangerous
        if (isDangerousLabel(label)) continue;

        // Build selector bundle
        const selectorBundle = await buildSelectorBundle(element, label);

        // Get element hint
        const elementHint = await element.evaluate((el) => ({
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || undefined,
        }));

        // Score the action
        const score = scoreAction(label, elementHint, box);

        candidates.push({
          type: 'click',
          label: label.slice(0, 50),
          selectorBundle,
          score,
          elementHint,
        });

        if (candidates.length >= maxCandidates * 2) break;
      } catch {
        continue;
      }
    }
  }

  // Sort by score and take top N
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, maxCandidates);
}

async function buildSelectorBundle(element: Locator, label: string): Promise<SelectorBundle> {
  const bundle: SelectorBundle = {
    preferred: { kind: 'css', value: '' },
    fallbacks: [],
  };

  try {
    // Try role + name
    const role = await element.getAttribute('role');
    if (role && label) {
      bundle.preferred = { kind: 'role', role, name: label };

      // Add testid as fallback
      const testid = await element.getAttribute('data-testid');
      if (testid) {
        bundle.fallbacks.push({ kind: 'testid', value: testid });
      }

      // Add text selector as fallback
      bundle.fallbacks.push({ kind: 'text', value: label });

      // Add CSS as last resort
      const css = await element.evaluate((el) => {
        if (el.id) return `#${el.id}`;
        const classes = Array.from(el.classList).join('.');
        if (classes) return `${el.tagName.toLowerCase()}.${classes}`;
        return el.tagName.toLowerCase();
      });
      bundle.fallbacks.push({ kind: 'css', value: css });

      return bundle;
    }

    // Try testid
    const testid = await element.getAttribute('data-testid');
    if (testid) {
      bundle.preferred = { kind: 'testid', value: testid };
      bundle.fallbacks.push({ kind: 'text', value: label });

      const css = await element.evaluate((el) => {
        if (el.id) return `#${el.id}`;
        const classes = Array.from(el.classList).join('.');
        if (classes) return `${el.tagName.toLowerCase()}.${classes}`;
        return el.tagName.toLowerCase();
      });
      bundle.fallbacks.push({ kind: 'css', value: css });

      return bundle;
    }

    // Use text selector as preferred
    bundle.preferred = { kind: 'text', value: label };

    // CSS as fallback
    const css = await element.evaluate((el) => {
      if (el.id) return `#${el.id}`;
      const classes = Array.from(el.classList).join('.');
      if (classes) return `${el.tagName.toLowerCase()}.${classes}`;
      return el.tagName.toLowerCase();
    });
    bundle.fallbacks.push({ kind: 'css', value: css });
  } catch {
    // Fallback to CSS only
    const css = await element.evaluate((el) => {
      if (el.id) return `#${el.id}`;
      const classes = Array.from(el.classList).join('.');
      if (classes) return `${el.tagName.toLowerCase()}.${classes}`;
      return el.tagName.toLowerCase();
    });
    bundle.preferred = { kind: 'css', value: css };
  }

  return bundle;
}

function scoreAction(
  label: string,
  hint: { tag?: string; role?: string },
  box: { width: number; height: number } | null
): number {
  let score = 50;

  // Nav items higher
  if (hint.tag === 'nav' || hint.role === 'navigation') {
    score += 30;
  }

  // Meaningful length (3-30 chars)
  if (label.length >= 3 && label.length <= 30) {
    score += 20;
  }

  // Penalize generic labels
  const lower = label.toLowerCase();
  if (GENERIC_LABELS.some((gen) => lower === gen)) {
    score -= 30;
  }

  // Bonus for larger elements (likely important)
  if (box && box.width > 100 && box.height > 30) {
    score += 10;
  }

  return score;
}
