/**
 * A complete, offline Nori stack for crawling and end-to-end tests.
 *   API: apps/api's real Hono app, in this process, on an in-memory database (a fake ATS driver, the real PDF renderer).
 *   Web: the production Next build (`next start`) proxying /api to that API. Live mode, never mock.
 * Run scripts with `npx tsx scripts/<name>.ts`.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { jobs, openTestDb, seedBoardRegistry, type ApplyDriver, type DriverContext, type DriverResult, type Db } from "@jobgraph/core";
import { createApp } from "../apps/api/src/app.js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const API_PORT = Number(process.env.E2E_API_PORT ?? 4200);
export const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3200);
export const WEB = `http://localhost:${WEB_PORT}`;
const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

export const RESUME_TEXT = `Maya Chen
San Francisco, CA | maya.chen@example.com | 415-555-0142 | linkedin.com/in/mayachen

SUMMARY
Frontend engineer who builds fast, accessible product surfaces in React and TypeScript.

EXPERIENCE
Senior Frontend Engineer at Lumen Analytics (Jan 2022 - Present)
- Rebuilt the dashboard in React and Next.js, cutting p95 page load from 4.2s to 1.1s for 2M monthly users
- Led a design system used by 6 product teams, with 120 components in TypeScript and Storybook
- Introduced end-to-end testing with Playwright, reducing escaped UI bugs by 38 percent

Frontend Engineer at Brightpath (Jun 2019 - Dec 2021)
- Shipped a real-time collaboration editor with WebSockets and React, adopted by 40,000 users
- Migrated a 300-page app from JavaScript to TypeScript with zero downtime

EDUCATION
B.S. Computer Science, University of Washington, 2019

SKILLS
React, TypeScript, Next.js, Node.js, GraphQL, Tailwind CSS, Storybook, Playwright, Jest

PROJECTS
Open-source charts library: a 3kB accessible charting library for React with 2,100 GitHub stars
`;

/** Deterministic stand-in for the ATS form filler: dry-run fills, and "needs-answers" jobs ask two questions first. */
class FakeDriver implements ApplyDriver {
  atsType = "web" as const;
  supports() { return true; }
  async run(ctx: DriverContext): Promise<DriverResult> {
    await mkdir(ctx.artifactsDir, { recursive: true });
    const shot = path.join(ctx.artifactsDir, "filled.png");
    await writeFile(shot, PNG_1PX);
    const receipt = {
      fields: [
        { label: "First Name", value: ctx.profile.firstName, kind: "text" as const },
        { label: "Email", value: ctx.profile.email, kind: "text" as const },
      ],
      files: [ctx.resumePdfPath], screenshotPath: shot, submittedVia: "fake", dryRun: ctx.dryRun, durationMs: 5,
    };
    if (ctx.applyUrl.includes("needs-answers") && !ctx.answers["Will you require visa sponsorship?"]) {
      return {
        outcome: "needs_user", receipt,
        pending: [{ type: "select", label: "Will you require visa sponsorship?", options: ["Yes", "No"], required: true }],
      };
    }
    return ctx.dryRun ? { outcome: "filled", receipt, fields: [] } : { outcome: "submitted", receipt: { ...receipt, confirmationText: "Thanks" } };
  }
}

export type Stack = {
  db: Db;
  /** Every email the API "sent" (verification, password reset), newest last. Nothing leaves the machine. */
  outbox: { to: string; subject: string; text: string }[];
  webUrl: string;
  apiUrl: string;
  stop: () => Promise<void>;
};

async function waitFor(url: string, ms = 90_000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    try { if ((await fetch(url, { redirect: "manual" })).status < 500) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`timed out waiting for ${url}`);
}

/** True when the production build is missing or older than any web source file, so tests never run against stale code. */
function buildIsStale(): boolean {
  const marker = path.join(ROOT, "apps/web/.next/BUILD_ID");
  if (!existsSync(marker)) return true;
  const built = statSync(marker).mtimeMs;
  const newest = (dir: string): number => readdirSync(dir, { withFileTypes: true }).reduce((m, e) => {
    if (e.name === "node_modules" || e.name === ".next") return m;
    const p = path.join(dir, e.name);
    return Math.max(m, e.isDirectory() ? newest(p) : statSync(p).mtimeMs);
  }, 0);
  return Math.max(newest(path.join(ROOT, "apps/web/src")), statSync(path.join(ROOT, "apps/web/next.config.ts")).mtimeMs, statSync(path.join(ROOT, "apps/web/package.json")).mtimeMs) > built;
}

function buildWeb() {
  const r = spawnSync(process.execPath, [path.join(ROOT, "node_modules/next/dist/bin/next"), "build"], {
    cwd: path.join(ROOT, "apps/web"), stdio: "inherit",
    env: { ...process.env, NEXT_PUBLIC_USE_MOCK: "0", API_URL: `http://localhost:${API_PORT}`, NEXT_TELEMETRY_DISABLED: "1" },
  });
  if (r.status !== 0) throw new Error("web build failed");
}

export async function startStack(opts: { build?: boolean; realModel?: boolean; realMail?: boolean } = {}): Promise<Stack> {
  // Deterministic runs: never talk to a local model or a hosted one; the heuristic paths are what the tests cover.
  process.env.OLLAMA_BASE_URL = "http://127.0.0.1:1/v1";
  // (realModel keeps the model settings from .env, for scripts/live-flow.mts, which runs the pipeline against a real provider.)
  if (!opts.realModel) { delete process.env.ANTHROPIC_API_KEY; delete process.env.HOSTED_LLM_API_KEY; delete process.env.OPENAI_COMPAT_API_KEY; }
  const db = await openTestDb();
  await seedBoardRegistry(db); // the curated companies, as the worker does on start
  const artifactsRoot = await mkdtemp(path.join(os.tmpdir(), "nori-e2e-"));
  const outbox: Stack["outbox"] = [];
  const app = createApp(db, {
    // realMail sends through SMTP_URL / RESEND_API_KEY from .env; otherwise nothing leaves the machine.
    ...(opts.realMail ? {} : { mailer: async (m: { to: string; subject: string; text: string }) => { outbox.push({ to: m.to, subject: m.subject, text: m.text }); } }),
    // The fake driver only simulates sending (it never leaves the machine), so the send lock is "open" for it; with the lock closed the runner records the approval without driving at all.
    runnerDeps: { pickDriver: () => new FakeDriver(), artifactsRoot, allowRealSubmit: true },
    mcp: true, defaultUserEmail: null, rateLimit: false, webUrl: WEB,
  });
  const server = serve({ fetch: app.fetch, port: API_PORT });
  await waitFor(`http://localhost:${API_PORT}/api/health`);

  if (opts.build || buildIsStale()) buildWeb();
  const web: ChildProcess = spawn(process.execPath, [path.join(ROOT, "node_modules/next/dist/bin/next"), "start", "-p", String(WEB_PORT)], {
    cwd: path.join(ROOT, "apps/web"), stdio: "ignore",
    env: { ...process.env, NEXT_PUBLIC_USE_MOCK: "0", API_URL: `http://localhost:${API_PORT}`, NEXT_TELEMETRY_DISABLED: "1" },
  });
  await waitFor(`${WEB}/login`);
  return {
    db, outbox, webUrl: WEB, apiUrl: `http://localhost:${API_PORT}`,
    stop: async () => { web.kill(); await new Promise<void>((r) => server.close(() => r())); },
  };
}

// ---------- a tiny cookie-aware client for seeding through the real HTTP API ----------

export class Client {
  cookie = "";
  constructor(public base: string) {}
  async call(method: string, url: string, body?: unknown, form?: FormData) {
    const headers: Record<string, string> = { cookie: this.cookie };
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${this.base}${url}`, { method, headers, body: form ?? (body === undefined ? undefined : JSON.stringify(body)) });
    const sc = res.headers.getSetCookie?.() ?? [];
    if (sc.length) this.cookie = sc.map((c) => c.split(";")[0]).join("; ");
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, json };
  }
}

export type Seed = {
  email: string; password: string; cookie: string;
  jobIds: string[];
  docId: string;
  apps: { resumeReview: string; needsAnswers: string; formReview: string };
};

/** A fully onboarded user with a graph, scored jobs and applications in three different states. */
export async function seedUser(stack: Stack, email = "maya.chen@example.com", password = "demo-pass-2026"): Promise<Seed> {
  const c = new Client(stack.apiUrl);
  const ok = async (p: Promise<{ status: number; json: any }>, what: string) => {
    const r = await p;
    if (r.status >= 400) throw new Error(`${what} failed (${r.status}): ${JSON.stringify(r.json)}`);
    return r.json;
  };
  await ok(c.call("POST", "/api/auth/signup", { email, password, name: "Maya Chen" }), "signup");
  await ok(c.call("POST", "/api/profile/resume", { text: RESUME_TEXT }), "resume");
  await ok(c.call("PUT", "/api/onboarding", { step: "resume" }), "onboarding resume");
  await ok(c.call("PUT", "/api/onboarding", { step: "contact", data: { fullName: "Maya Chen", city: "San Francisco", state: "CA", country: "US", phone: "415-555-0142" } }), "contact");
  await ok(c.call("PUT", "/api/onboarding", { step: "authorization", data: { workAuth: { authorizedUS: true, needsSponsorship: false, status: "citizen" }, willingToRelocate: false } }), "authorization");
  await ok(c.call("PUT", "/api/onboarding", { step: "screening", data: { salaryExpectation: { amount: 180000, currency: "USD", period: "year" }, noticePeriodWeeks: 2, over18: true } }), "screening");
  await ok(c.call("PUT", "/api/onboarding", { step: "preferences", data: { titles: ["Senior Frontend Engineer", "Frontend Engineer"], locations: ["San Francisco"], remote: "ok", autoApplyDailyCap: 5 } }), "preferences");
  await ok(c.call("PUT", "/api/onboarding", { step: "integrations" }), "integrations");

  const docs = await ok(c.call("GET", "/api/resume-docs"), "resume docs");
  const docId = docs[0].id as string;

  // Posted in the last two weeks (relative to now, so the Jobs page's 60-day window never ages the fixtures out).
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
  const rows = await stack.db.insert(jobs).values([
    { companyName: "Acme", atsType: "web", externalId: "acme-1", title: "Senior Frontend Engineer", location: "San Francisco, CA", remote: true,
      descriptionText: "Requirements:\n- React and TypeScript\n- Node.js\n- Testing with Playwright\nNice to have:\n- GraphQL", applyUrl: "https://example.com/?job=acme-1", postedAt: daysAgo(2) },
    { companyName: "Needs Answers Co", atsType: "web", externalId: "na-1", title: "Staff Frontend Engineer", location: "Remote (US)", remote: true,
      descriptionText: "Requirements:\n- React and TypeScript\n- Design systems\n- Storybook", applyUrl: "https://example.com/?job=needs-answers-2", postedAt: daysAgo(5) },
    { companyName: "Globex", atsType: "greenhouse", externalId: "gx-1", title: "Frontend Engineer, Growth", location: "New York, NY", remote: false,
      descriptionText: "Requirements:\n- React\n- TypeScript\n- Next.js\n- A/B testing", applyUrl: "https://example.com/?job=globex-3", postedAt: daysAgo(9) },
    { companyName: "Initech", atsType: "lever", externalId: "in-1", title: "Backend Engineer", location: "Austin, TX", remote: false,
      descriptionText: "Requirements:\n- Go\n- Kubernetes\n- PostgreSQL", applyUrl: "https://example.com/?job=initech-4", postedAt: daysAgo(13) },
  ]).returning();
  const [acme, needs, globex] = rows;
  await ok(c.call("GET", "/api/jobs?limit=50&wait=1&lanes=0"), "score jobs");

  const mk = async (jobId: string) => (await ok(c.call("POST", "/api/applications?wait=1", { jobId }), "create application")).id as string;
  const resumeReview = await mk(acme.id);
  const needsAnswers = await mk(needs.id);
  const formReview = await mk(globex.id);
  await ok(c.call("POST", `/api/applications/${needsAnswers}/approve-resume?wait=1`), "approve resume (needs answers)");
  await ok(c.call("POST", `/api/applications/${formReview}/approve-resume?wait=1`), "approve resume (form review)");
  return { email, password, cookie: c.cookie, jobIds: rows.map((r) => r.id), docId, apps: { resumeReview, needsAnswers, formReview } };
}
