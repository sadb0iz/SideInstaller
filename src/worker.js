/**
 * SideInstaller website — Cloudflare Worker
 * Serves static assets with correct MIME types for iOS OTA install
 * (.plist, .mobileconfig). IPA packages stay on GitHub raw (see plists).
 */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".plist": "application/xml",
  ".mobileconfig": "application/x-apple-aspen-config",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json",
  ".tsv": "text/tab-separated-values; charset=utf-8",
  ".ipa": "application/octet-stream",
};

function contentType(path) {
  const i = path.lastIndexOf(".");
  if (i === -1) return "application/octet-stream";
  return MIME[path.slice(i).toLowerCase()] || "application/octet-stream";
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    let path = url.pathname;

    // Normalize
    if (path === "/" || path === "") path = "/index.html";

    // Try static asset first
    if (env.ASSETS) {
      // Cloudflare Assets binding
      let assetReq = new Request(new URL(path, url.origin), request);
      let res = await env.ASSETS.fetch(assetReq);

      // SPA-style: /terms → terms.html if exact miss
      if (res.status === 404) {
        if (!path.endsWith("/") && !path.includes(".")) {
          const tryHtml = path + ".html";
          res = await env.ASSETS.fetch(new Request(new URL(tryHtml, url.origin), request));
          if (res.status !== 404) path = tryHtml;
        }
      }

      if (res.status !== 404) {
        // Override Content-Type for iOS-critical extensions
        const ct = contentType(path);
        const headers = new Headers(res.headers);
        headers.set("Content-Type", ct);
        // Allow OTA install from any origin context
        headers.set("Access-Control-Allow-Origin", "*");
        // Cache static assets
        if (path.endsWith(".png") || path.endsWith(".plist") || path.endsWith(".mobileconfig")) {
          headers.set("Cache-Control", "public, max-age=3600");
        } else if (path.endsWith(".html")) {
          headers.set("Cache-Control", "public, max-age=60");
        }
        return new Response(res.body, {
          status: res.status,
          statusText: res.statusText,
          headers,
        });
      }
    }

    return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain" } });
  },
};
