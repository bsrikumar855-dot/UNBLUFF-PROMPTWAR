/**
 * The problem-statement scenario through the REAL UI: Python, SQL, HTML -> Full Stack; a failed (simulated) JavaScript
 * assessment; passing it; switching goal to Data Analyst; reload. Asserts every step and fails on any console error,
 * failed request or HTTP error. Uses the system Edge or Chrome through playwright-core (not a project dependency):
 *
 *   npm i --no-save playwright-core            # once, in frontend/
 *   node scripts/learning-path-demo.mjs [--base http://localhost:5173] [--channel msedge|chrome] [--shots <dir>]
 *
 * Needs a local stack in demo mode: backend with LLM_MODE=mock (or live) and AUTH_MODE=mock, frontend with
 * VITE_AUTH_MODE=mock. With --shots, writes WebP screenshots (encoded by the browser) to <dir>.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const BASE = arg("base", "http://localhost:5173").replace(/\/+$/, "");
const CHANNEL = arg("channel", "msedge");
const SHOTS = arg("shots", null);

let chromium;
try {
  ({ chromium } = await import("playwright-core"));
} catch {
  console.error("playwright-core is not installed. Run: npm i --no-save playwright-core");
  process.exit(2);
}

const failures = [];
const problems = [];
const check = (step, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${step}: ${detail}`);
  if (!ok) failures.push(step);
};
const flat = (s) => s.replace(/\s+/g, " ").trim();

const browser = await chromium.launch({ channel: CHANNEL, headless: true });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
page.on("console", (m) => m.type() === "error" && problems.push(`console: ${m.text().slice(0, 200)}`));
page.on("pageerror", (e) => problems.push(`pageerror: ${String(e).slice(0, 200)}`));
page.on("requestfailed", (r) => problems.push(`requestfailed: ${r.url()}`));
page.on("response", (r) => r.status() >= 400 && problems.push(`http ${r.status()}: ${r.url()}`));

/** Screenshot of one section, re-encoded as WebP by the browser so no image tool is needed. */
async function shot(name, selector) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const el = await page.$(selector);
  const png = await (el ?? page).screenshot({ type: "png" });
  const webp = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const scale = Math.min(1, 1000 / img.width);
    const c = document.createElement("canvas");
    c.width = Math.round(img.width * scale);
    c.height = Math.round(img.height * scale);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/webp", 0.72).split(",")[1];
  }, png.toString("base64"));
  const file = join(SHOTS, `${name}.webp`);
  writeFileSync(file, Buffer.from(webp, "base64"));
  console.log(`  saved ${file} (${Math.round(Buffer.from(webp, "base64").length / 1024)} KB)`);
}
const roadmap = () => page.$$eval("#roadmap ol[aria-label] > li", (lis) => lis.map((l) => ({ title: l.querySelector("h3").innerText, text: l.innerText, links: l.querySelectorAll("a").length })));
const setScore = (v) => page.$eval("#sim-score", (el, val) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, String(val)); el.dispatchEvent(new Event("input", { bubbles: true })); }, v);
const pct = async () => Number((await page.innerText("#progress [aria-label$='percent complete']")).match(/(\d+)%/)?.[1] ?? -1);

try {
  // a. sample student -> Full Stack
  await page.goto(`${BASE}/learning-path`, { waitUntil: "networkidle" });
  await page.keyboard.press("Escape"); // skips the intro screen if it is showing
  const restart = page.getByRole("button", { name: "Start a new profile" });
  if (await restart.count()) await restart.click(); // a previous run left a path: start a fresh one
  await page.getByRole("button", { name: /Load sample student/ }).click();
  await page.getByRole("button", { name: "Build my learning path" }).click();
  // the new path has arrived when the form closes and the profile names the new target
  await page.waitForFunction(() => !document.querySelector("#skill-draft") && /Target: Full Stack Developer/.test(document.querySelector("#profile")?.textContent ?? ""), { timeout: 60000 });
  await page.waitForLoadState("networkidle");
  const analysis = await page.innerText("#analysis");
  const steps = await roadmap();
  const missing = ["JavaScript", "React", "Node.js"].filter((t) => !analysis.includes(t));
  check("a. sample student", missing.length === 0 && steps.length > 0 && steps.every((s) => s.links > 0), `gaps include JavaScript, React, Node.js (missing: ${missing.join(", ") || "none"}); ${steps.length} roadmap steps, all with resources; match ${flat(await page.innerText("#match")).match(/\d+%/)?.[0]}`);
  await shot("1-skill-gaps", "#analysis");

  // b. simulated 40% on JavaScript
  await page.selectOption("#assess-skill", "javascript");
  await setScore(40);
  await page.getByRole("button", { name: "Apply simulated score" }).click();
  await page.waitForSelector("#changed", { timeout: 60000 });
  await page.waitForLoadState("networkidle");
  const b = await roadmap();
  const remedial = b.find((s) => /^Revisit:/.test(s.title));
  const blocked = b.filter((s) => /Paused until review is done/.test(s.text)).map((s) => s.title);
  const handoffs = await page.$$eval('[data-testid="handoff"]', (els) => els.map((e) => e.textContent));
  const chain = handoffs.some((h) => h.includes("Progress Evaluator → Curriculum Planner")) && handoffs.some((h) => h.includes("Curriculum Planner → Mentor"));
  const labelled = /simulation/i.test(await page.innerText("#changed")) && /includes simulated results/.test(await page.innerText("#roadmap"));
  check("b. fail JavaScript (40%, simulation)", !!remedial && blocked.includes("React") && blocked.includes("Node.js") && chain && labelled, `remedial "${remedial?.title}"; paused: ${blocked.join(", ")}; Evaluator -> Planner -> Mentor: ${chain}; labelled Simulation: ${labelled}`);
  await shot("2-remedial-after-fail", "#roadmap");
  await shot("2b-agent-activity", "#agents");
  const before = await pct();

  // c. simulated 90% on JavaScript (passes the remedial)
  await page.selectOption("#assess-skill", "javascript");
  await setScore(90);
  await page.getByRole("button", { name: "Apply simulated score" }).click();
  await page.waitForFunction(() => !document.querySelector("#roadmap")?.innerText.includes("Paused until review is done"), { timeout: 60000 });
  const after = await pct();
  check("c. pass the remedial (90%)", after > before, `no step paused; progress ${before}% -> ${after}%`);

  // d. switch goal to Data Analyst
  await page.selectOption("#new-goal", "data_analyst");
  await page.getByRole("button", { name: "Switch goal" }).click();
  await page.waitForFunction(() => /Switched goal to Data Analyst/.test(document.querySelector("#changed")?.innerText ?? ""), { timeout: 60000 });
  const diff = flat(await page.innerText("#changed"));
  const heads = await page.$$eval("#changed h3", (h) => h.map((x) => x.innerText));
  check("d. goal -> Data Analyst", ["Kept", "Added", "Removed", "Reordered"].every((h) => heads.some((x) => x.includes(h))) && /Python already declared/.test(diff) && /React is not required/.test(diff), diff.match(/Switched goal[^.]*\./)?.[0] ?? "no summary");
  await shot("3-goal-change-diff", "#changed");
  const roadmapD = (await roadmap()).map((s) => s.title);

  // e. reload
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("#match", { timeout: 60000 });
  const roadmapE = (await roadmap()).map((s) => s.title);
  check("e. reload keeps the state", JSON.stringify(roadmapD) === JSON.stringify(roadmapE) && /Data Analyst/.test(await page.innerText("#profile")), `roadmap after reload: ${roadmapE.join(", ")}`);
} catch (err) {
  check("script", false, String(err).slice(0, 300));
}

await browser.close();
const unique = [...new Set(problems)];
check("no console errors, failed requests or HTTP errors", unique.length === 0, unique.length ? unique.join(" | ") : "none");
process.exit(failures.length ? 1 : 0);
