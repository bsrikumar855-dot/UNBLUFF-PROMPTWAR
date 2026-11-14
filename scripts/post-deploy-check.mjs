#!/usr/bin/env node
/**
 * Post-deploy smoke test: Vercel frontend + Render backend, wired together correctly.
 *
 *   node scripts/post-deploy-check.mjs <render-api-url> <vercel-frontend-url>
 *
 * Example:
 *   node scripts/post-deploy-check.mjs https://unbluff-api.onrender.com https://unbluff.vercel.app
 *
 * Checks, in order:
 *   1. GET  <render>/api/health           -> 200, { status: "ok", llm_mode: "live" }
 *   2. GET  <vercel>/                     -> 200, html, has the app's root div
 *   3. GET  <vercel>/learning-path        -> 200, html, app shell (SPA deep-link rewrite works)
 *   4. OPTIONS <render>/api/roles         -> CORS preflight from the Vercel origin succeeds and is
 *                                            scoped to exactly that origin (not "*")
 *
 * No npm dependencies: uses the global fetch (Node 18+). Sets a nonzero exit code if any check fails
 * (never a forced process.exit, so pending timers drain cleanly). Render's free plan sleeps after
 * inactivity, so the health check retries through a cold start.
 */

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

/** Render's free plan sleeps after inactivity; the first request wakes it and can take 30-60s+. */
async function fetchWithColdStartRetry(url, opts, { attempts = 3, timeoutMs = 75_000 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...opts, signal: controller.signal });
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) console.log(`  (attempt ${i + 1} failed: ${err.message}; retrying — this is normal on a cold Render instance)`);
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
}

async function checkHealth(api) {
  try {
    const res = await fetchWithColdStartRetry(`${api}/api/health`);
    const body = await res.json().catch(() => null);
    const ok = res.status === 200 && body?.status === "ok" && body?.llm_mode === "live";
    record(
      "1. Render /api/health",
      ok,
      `status=${res.status} body=${JSON.stringify(body)}${body?.llm_mode !== "live" ? ' — expected llm_mode "live" in production' : ""}`
    );
  } catch (err) {
    record("1. Render /api/health", false, `request failed: ${err.message}`);
  }
}

async function checkLandingPage(site) {
  try {
    const res = await fetch(site + "/", { redirect: "follow" });
    const html = await res.text();
    const ok = res.status === 200 && /<div id="root">/.test(html) && /<html/i.test(html);
    record("2. Vercel landing page (/)", ok, `status=${res.status} content-type=${res.headers.get("content-type")}`);
  } catch (err) {
    record("2. Vercel landing page (/)", false, `request failed: ${err.message}`);
  }
}

async function checkDeepLinkRefresh(site) {
  try {
    const res = await fetch(site + "/learning-path", { redirect: "follow" });
    const html = await res.text();
    const ok = res.status === 200 && /<div id="root">/.test(html);
    record("3. Vercel deep-link refresh (/learning-path)", ok, `status=${res.status} served-app-shell=${/<div id="root">/.test(html)}`);
  } catch (err) {
    record("3. Vercel deep-link refresh (/learning-path)", false, `request failed: ${err.message}`);
  }
}

async function checkCorsPreflight(api, site) {
  try {
    const res = await fetch(`${api}/api/roles`, {
      method: "OPTIONS",
      headers: {
        Origin: site,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization,content-type",
      },
    });
    const allowOrigin = res.headers.get("access-control-allow-origin");
    const ok = (res.status === 204 || res.status === 200) && allowOrigin === site;
    record(
      "4. CORS preflight (Vercel origin -> Render API)",
      ok,
      `status=${res.status} access-control-allow-origin=${allowOrigin ?? "(absent)"}` +
        (allowOrigin === "*" ? ' — origin is "*": CORS_ORIGIN on Render is not locked down' : "")
    );
  } catch (err) {
    record("4. CORS preflight (Vercel origin -> Render API)", false, `request failed: ${err.message}`);
  }
}

function parseArgs() {
  const [, , renderUrlArg, vercelUrlArg] = process.argv;
  if (!renderUrlArg || !vercelUrlArg) {
    console.error("Usage: node scripts/post-deploy-check.mjs <render-api-url> <vercel-frontend-url>");
    console.error("Example: node scripts/post-deploy-check.mjs https://unbluff-api.onrender.com https://unbluff.vercel.app");
    return null;
  }
  let renderUrl, vercelUrl;
  try {
    renderUrl = new URL(renderUrlArg);
    vercelUrl = new URL(vercelUrlArg);
  } catch {
    console.error("Both arguments must be full URLs, e.g. https://unbluff-api.onrender.com");
    return null;
  }
  for (const u of [renderUrl, vercelUrl]) {
    if (u.protocol !== "https:") console.warn(`Warning: ${u.origin} is not https. Proceeding, but a real deployment should be https-only.`);
  }
  return { api: renderUrl.origin, site: vercelUrl.origin };
}

async function main() {
  const args = parseArgs();
  if (!args) {
    process.exitCode = 2;
    return;
  }
  const { api, site } = args;
  console.log(`Checking Render API: ${api}`);
  console.log(`Checking Vercel site: ${site}\n`);

  await checkHealth(api);
  await checkLandingPage(site);
  await checkDeepLinkRefresh(site);
  await checkCorsPreflight(api, site);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) {
    console.log("Failed: " + failed.map((f) => f.name).join(", "));
    process.exitCode = 1;
  }
}

await main();
