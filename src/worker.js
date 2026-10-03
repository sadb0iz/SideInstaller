/**
 * SideInstaller website — Cloudflare Worker
 *
 * - Serves static assets with correct MIME types for iOS OTA
 * - Dynamic /api/certs endpoint:
 *     Reads public/certificates/index.json (list of folder names)
 *     Fetches each folder's .mobileprovision, parses ExpirationDate etc.
 *     Returns JSON array used by index.html to render cert-cards
 *
 * How to add a new certificate (no local machine needed):
 *   1. Create folder: public/certificates/My Cert Name/
 *   2. Put  .mobileprovision  and  .p12  inside
 *   3. Add "My Cert Name" to public/certificates/index.json
 *   4. Deploy → /api/certs automatically picks it up
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
  ".mobileprovision": "application/octet-stream",
  ".p12": "application/x-pkcs12",
};

function contentType(path) {
  const i = path.lastIndexOf(".");
  if (i === -1) return "application/octet-stream";
  return MIME[path.slice(i).toLowerCase()] || "application/octet-stream";
}

/** Extract the clear-text XML plist from a .mobileprovision (CMS signed) */
function extractPlistXml(buffer) {
  const bytes = new Uint8Array(buffer);
  // Look for "<?xml"
  const startTag = [0x3c, 0x3f, 0x78, 0x6d, 0x6c]; // <?xml
  let start = -1;
  for (let i = 0; i < bytes.length - 5; i++) {
    if (
      bytes[i] === startTag[0] &&
      bytes[i + 1] === startTag[1] &&
      bytes[i + 2] === startTag[2] &&
      bytes[i + 3] === startTag[3] &&
      bytes[i + 4] === startTag[4]
    ) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;

  // Look for "</plist>"
  const endStr = "</plist>";
  const endBytes = new TextEncoder().encode(endStr);
  let end = -1;
  for (let i = start; i < bytes.length - endBytes.length; i++) {
    let match = true;
    for (let j = 0; j < endBytes.length; j++) {
      if (bytes[i + j] !== endBytes[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      end = i + endBytes.length;
      break;
    }
  }
  if (end < 0) return null;

  return new TextDecoder("utf-8").decode(bytes.subarray(start, end));
}

/** Very small XML → object parser for the keys we need from mobileprovision */
function parseProvisionXml(xml) {
  const get = (tag) => {
    const re = new RegExp(`<key>${tag}</key>\\s*<string>([^<]*)</string>`, "i");
    const m = xml.match(re);
    return m ? m[1] : null;
  };
  const getDate = (tag) => {
    const re = new RegExp(`<key>${tag}</key>\\s*<date>([^<]*)</date>`, "i");
    const m = xml.match(re);
    return m ? m[1] : null;
  };

  return {
    Name: get("Name"),
    AppIDName: get("AppIDName"),
    TeamName: get("TeamName"),
    UUID: get("UUID"),
    ExpirationDate: getDate("ExpirationDate"),
    CreationDate: getDate("CreationDate"),
  };
}

async function fetchAsset(env, path) {
  if (!env.ASSETS) return null;
  const res = await env.ASSETS.fetch(new Request(new URL(path, "https://assets.local")));
  if (res.status === 404) return null;
  return res;
}

/** Build the list of certs from certificates/index.json + each folder's provision */
async function buildCerts(env) {
  const indexRes = await fetchAsset(env, "/certificates/index.json");
  if (!indexRes) {
    return { error: "certificates/index.json not found", certs: [] };
  }

  let folders;
  try {
    folders = await indexRes.json();
  } catch {
    return { error: "invalid certificates/index.json", certs: [] };
  }
  if (!Array.isArray(folders)) {
    return { error: "certificates/index.json must be an array of folder names", certs: [] };
  }

  const now = Date.now();
  const certs = [];

  for (const folder of folders) {
    if (typeof folder !== "string" || !folder.trim()) continue;
    const name = folder.trim();

    // Try common provision filenames
    const candidates = [
      `/certificates/${name}/${name}.mobileprovision`,
      `/certificates/${name}/${name.replace(/ /g, "-")}.mobileprovision`,
      `/certificates/${name}/profile.mobileprovision`,
    ];

    let provisionBuf = null;
    for (const p of candidates) {
      const r = await fetchAsset(env, p);
      if (r) {
        provisionBuf = await r.arrayBuffer();
        break;
      }
    }

    if (!provisionBuf) {
      const safeName = name.replace(/ /g, "-");
      certs.push({
        name: safeName,
        displayName: name,
        days: -999999,
        rank: 1,
        status: "unknown",
        expires: null,
        teamName: name,
        appIdName: "",
        uuid: "",
        plist: `/output/sideinstaller-${safeName}.plist`,
        hasP12: false,
        hasProvision: false,
        folder: name,
        note: "mobileprovision not found",
      });
      continue;
    }

    const xml = extractPlistXml(provisionBuf);
    if (!xml) {
      const safeName = name.replace(/ /g, "-");
      certs.push({
        name: safeName,
        displayName: name,
        days: -999999,
        rank: 1,
        status: "unknown",
        expires: null,
        teamName: name,
        appIdName: "",
        uuid: "",
        plist: `/output/sideinstaller-${safeName}.plist`,
        hasP12: true,
        hasProvision: true,
        folder: name,
        note: "could not parse mobileprovision",
      });
      continue;
    }

    const info = parseProvisionXml(xml);
    const safeName = name.replace(/ /g, "-");

    let days = -999999;
    let expStr = null;
    let status = "unknown";
    let rank = 1;

    if (info.ExpirationDate) {
      const expMs = Date.parse(info.ExpirationDate);
      if (!isNaN(expMs)) {
        days = Math.floor((expMs - now) / 86400000);
        expStr = new Date(expMs).toISOString().slice(0, 10);
        if (days > 0) {
          status = "valid";
          rank = 0;
        } else {
          status = "expired";
          rank = 2;
        }
      }
    }

    // Check if a .p12 exists (best-effort)
    let hasP12 = false;
    const p12Candidates = [
      `/certificates/${name}/${name}.p12`,
      `/certificates/${name}/${name.replace(/ /g, "-")}.p12`,
    ];
    for (const p of p12Candidates) {
      const r = await fetchAsset(env, p);
      if (r) {
        hasP12 = true;
        break;
      }
    }

    certs.push({
      name: safeName,
      displayName: name,
      days,
      rank,
      status,
      expires: expStr,
      teamName: info.TeamName || name,
      appIdName: info.AppIDName || "",
      uuid: info.UUID || "",
      plist: `/output/sideinstaller-${safeName}.plist`,
      hasP12,
      hasProvision: true,
      folder: name,
    });
  }

  // Sort: valid first, then by days descending
  certs.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return (b.days || 0) - (a.days || 0);
  });

  return { certs };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    let path = url.pathname;

    // ---------- Dynamic API ----------
    if (path === "/api/certs" || path === "/api/certs/") {
      const result = await buildCerts(env);
      return new Response(JSON.stringify(result.certs, null, 2), {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=60",
        },
      });
    }

    // ---------- Static assets ----------
    if (path === "/" || path === "") path = "/index.html";

    if (env.ASSETS) {
      let assetReq = new Request(new URL(path, url.origin), request);
      let res = await env.ASSETS.fetch(assetReq);

      // SPA-style: /terms → terms.html
      if (res.status === 404) {
        if (!path.endsWith("/") && !path.includes(".")) {
          const tryHtml = path + ".html";
          res = await env.ASSETS.fetch(new Request(new URL(tryHtml, url.origin), request));
          if (res.status !== 404) path = tryHtml;
        }
      }

      if (res.status !== 404) {
        const ct = contentType(path);
        const headers = new Headers(res.headers);
        headers.set("Content-Type", ct);
        headers.set("Access-Control-Allow-Origin", "*");

        if (
          path.endsWith(".png") ||
          path.endsWith(".plist") ||
          path.endsWith(".mobileconfig") ||
          path.endsWith(".mobileprovision") ||
          path.endsWith(".p12")
        ) {
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

    return new Response("Not Found", {
      status: 404,
      headers: { "Content-Type": "text/plain" },
    });
  },
};