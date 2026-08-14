import { Router } from 'express';

export const proxyRouter = Router();

/**
 * Proxy endpoint to bypass X-Frame-Options and CSP headers
 * Fetches external URLs server-side and serves them without restrictive headers
 */
proxyRouter.get('/', async (req, res): Promise<void> => {
  const targetUrl = req.query.url as string;

  if (!targetUrl) {
    res.status(400).json({ error: 'Missing url parameter' });
    return;
  }

  // Validate URL
  try {
    new URL(targetUrl);
  } catch (error) {
    res.status(400).json({ error: 'Invalid URL' });
    return;
  }

  try {
    // Fetch the target URL
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; XsionBot/1.0)',
      },
      redirect: 'follow',
    });

    if (!response.ok) {
      res.status(response.status).json({
        error: `Failed to fetch: ${response.statusText}`
      });
      return;
    }

    const contentType = response.headers.get('content-type') || 'text/html';
    let content = await response.text();

    // Rewrite URLs to proxy through our server for HTML content
    if (contentType.includes('text/html')) {
      // Rewrite absolute URLs in href and src attributes
      content = rewriteUrls(content, targetUrl);
    }

    // Set permissive headers to allow iframe embedding
    res.setHeader('Content-Type', contentType);

    // Remove X-Frame-Options entirely (setting ALLOWALL is non-standard)
    // Not setting it allows framing from anywhere

    // Set permissive CSP to allow framing from our frontend
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self' http://localhost:5173 http://localhost:*");

    // Allow CORS from our frontend
    res.setHeader('Access-Control-Allow-Origin', 'http://localhost:5173');
    res.setHeader('Access-Control-Allow-Credentials', 'true');

    res.send(content);
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).json({
      error: 'Failed to proxy request',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

/**
 * Rewrites URLs in HTML content to proxy through our server
 * Simplified version that only rewrites the base tag for better performance
 */
function rewriteUrls(html: string, baseUrl: string): string {
  const base = new URL(baseUrl);
  const origin = base.origin;

  // Instead of rewriting every URL (which is slow for large pages),
  // inject a base tag that tells the browser to resolve relative URLs
  // This is much faster and works for most cases

  // Remove existing base tags
  html = html.replace(/<base[^>]*>/gi, '');

  // Inject a base tag after <head> to handle relative URLs
  html = html.replace(
    /<head([^>]*)>/i,
    `<head$1>\n  <base href="${origin}/">`
  );

  return html;
}
