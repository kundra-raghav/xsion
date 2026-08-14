import type { Page, Locator } from 'playwright';
import type { ClickContext } from '../types';

export interface SelectorPart {
  kind: 'role' | 'testid' | 'text' | 'css';
  role?: string;
  name?: string;
  value?: string;
}

export interface SelectorBundle {
  preferred: SelectorPart;
  fallbacks: SelectorPart[];
}

export interface AttemptLog {
  kind: string;
  selector: string;
  matched: number;
  chosenIndex?: number;
  error?: string;
}

/**
 * Get the scope root for the locator based on click context
 */
export function getScopeRoot(page: Page, clickContext?: ClickContext): Page | Locator {
  if (clickContext?.scopeSelector) {
    return page.locator(clickContext.scopeSelector);
  }
  return page;
}

/**
 * Build a locator from a selector part within a scope
 */
export function buildLocator(root: Page | Locator, selectorPart: SelectorPart): Locator {
  if (selectorPart.kind === 'role' && selectorPart.role) {
    return root.getByRole(selectorPart.role as any, { name: selectorPart.name });
  } else if (selectorPart.kind === 'testid' && selectorPart.value) {
    return root.getByTestId(selectorPart.value);
  } else if (selectorPart.kind === 'text' && selectorPart.value) {
    return root.getByText(selectorPart.value, { exact: true });
  } else if (selectorPart.kind === 'css' && selectorPart.value) {
    return root.locator(selectorPart.value);
  }
  throw new Error(`Invalid selector part: ${JSON.stringify(selectorPart)}`);
}

/**
 * Choose the best match from a locator with multiple matches
 */
export async function chooseBestMatch(
  locator: Locator
): Promise<{ locator: Locator; matched: number; chosenIndex: number }> {
  const matched = await locator.count();

  if (matched === 0) {
    return { locator, matched: 0, chosenIndex: -1 };
  }

  if (matched === 1) {
    return { locator: locator.nth(0), matched: 1, chosenIndex: 0 };
  }

  // If multiple matches, prefer first visible
  for (let i = 0; i < Math.min(matched, 5); i++) {
    try {
      const isVisible = await locator.nth(i).isVisible({ timeout: 100 });
      if (isVisible) {
        return { locator: locator.nth(i), matched, chosenIndex: i };
      }
    } catch {
      // Continue to next
    }
  }

  // Default to first element
  return { locator: locator.nth(0), matched, chosenIndex: 0 };
}

/**
 * Resolve and click using selector bundle with click context scoping
 */
export async function resolveAndClick(
  page: Page,
  selectorBundle: SelectorBundle,
  clickContext?: ClickContext,
  opts?: { timeoutMs?: number; preClickUrl?: string }
): Promise<{ attempts: AttemptLog[]; note?: string }> {
  const timeoutMs = opts?.timeoutMs || 8000;
  const attempts: AttemptLog[] = [];
  const selectors = [selectorBundle.preferred, ...selectorBundle.fallbacks];

  for (const selectorPart of selectors) {
    const selectorString = JSON.stringify(selectorPart);
    const attempt: AttemptLog = {
      kind: selectorPart.kind,
      selector: selectorString,
      matched: 0,
    };

    try {
      // Get scoped root
      const root = getScopeRoot(page, clickContext);

      // Build locator
      let locator = buildLocator(root, selectorPart);

      // Special handling for text selector: try exact first, fall back to non-exact
      if (selectorPart.kind === 'text' && selectorPart.value) {
        const exactCount = await locator.count();
        if (exactCount === 0) {
          // Fallback to non-exact
          locator = (root as any).getByText(selectorPart.value, { exact: false });
        }
      }

      // Wait for at least one element to be visible
      try {
        await locator.first().waitFor({ state: 'visible', timeout: timeoutMs });
      } catch {
        // Continue if wait fails
      }

      // Choose best match
      const { locator: chosenLocator, matched, chosenIndex } = await chooseBestMatch(locator);
      attempt.matched = matched;
      attempt.chosenIndex = chosenIndex;

      if (matched === 0) {
        attempt.error = 'No matches found';
        attempts.push(attempt);
        continue;
      }

      // Try to click
      await chosenLocator.click({ timeout: timeoutMs });
      attempts.push(attempt);

      // Wait for state change after click
      let note: string | undefined;
      const postClickUrl = page.url();
      const urlChanged = opts?.preClickUrl && postClickUrl !== opts.preClickUrl;

      if (urlChanged) {
        note = 'url_changed';
      } else {
        // Wait for potential state change or stabilization
        try {
          await page.waitForLoadState('domcontentloaded', { timeout: 1000 });
          note = 'domcontentloaded';
        } catch {
          // Just wait for stabilization
          await page.waitForTimeout(250);
          note = 'timeout_stabilized';
        }
      }

      return { attempts, note };
    } catch (error: any) {
      attempt.error = error.message || 'Click failed';
      attempts.push(attempt);
      continue;
    }
  }

  throw new Error('All selector attempts failed');
}
