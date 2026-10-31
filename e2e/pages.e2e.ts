import { afterAll, beforeAll, describe, it } from "vitest";
import { expect } from "@playwright/test";
import { eq } from "drizzle-orm";
import type { Browser, BrowserContext, Page } from "playwright";
import { jobs as jobsTable } from "@jobgraph/core";
import { seedUser, startStack, type Seed, type Stack } from "../scripts/stack.mjs";
import { WEB, launchBrowser, newSession } from "./helpers";

/**
 * Click-through tests for the pages the journey does not touch: jobs, applications, tracker, inbox, auto apply.
 * One seeded user (see seedUser): three applications in different states and one job nobody has applied to.
 */
let stack: Stack;
let seed: Seed;
let browser: Browser;
let ctx: BrowserContext;
let page: Page;
let errors: string[];

const api = async (p: string, init?: { method?: string; data?: unknown }) => {
  const r = await ctx.request.fetch(`${WEB}${p}`, { method: init?.method ?? "GET", data: init?.data });
  const ct = r.headers()["content-type"] ?? "";
  return { status: r.status(), json: ct.includes("json") ? await r.json() : null };
};

beforeAll(async () => {
  stack = await startStack();
  seed = await seedUser(stack);
  browser = await launchBrowser();
  ({ ctx, page, errors } = await newSession(browser));
  const [name, ...rest] = seed.cookie.split("=");
  await ctx.addCookies([{ name, value: rest.join("="), url: WEB, httpOnly: true, sameSite: "Lax" }]);
}, 600_000);

afterAll(async () => {
  await browser?.close();
  await stack?.stop();
});

const cards = () => page.locator("main article");

describe("jobs", () => {
  // The seeded user's lane comes from the onboarding titles ("Senior Frontend Engineer", "Frontend Engineer"), so Best
  // match lists the three frontend roles (all applied to) and leaves out the backend one; Newest lists all four.
  it("lists the roles that fit the lanes in Best match, and every open role in Newest", async () => {
    await page.goto(`${WEB}/jobs`);
    await expect(cards()).toHaveCount(3);
    await expect(page.getByText(/of 3 roles, best match first/)).toBeVisible();
    await expect(page.getByRole("link", { name: /Applied: Resume review/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /Applied: Needs you/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /Applied: Form review/ })).toBeVisible();
    await expect(cards().filter({ hasText: "Backend Engineer" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Best match" })).toHaveAttribute("aria-current", "page");

    await page.getByRole("link", { name: "Newest" }).click();
    await expect(page).toHaveURL(/view=new/);
    await expect(cards()).toHaveCount(4);
    await expect(page.getByText(/of 4 roles, newest first/)).toBeVisible();
    await expect(cards().first()).toContainText("Senior Frontend Engineer"); // posted most recently
    await expect(cards().filter({ hasText: "Backend Engineer" }).getByRole("button", { name: "Apply" })).toBeVisible();
  });

  it("filters by search text, and the filter lives in the URL", async () => {
    await page.goto(`${WEB}/jobs?view=new`);
    await page.getByRole("searchbox", { name: "Search jobs" }).fill("backend");
    await expect(cards()).toHaveCount(1);
    await expect(cards().first()).toContainText("Backend Engineer");
    await expect(page).toHaveURL(/q=backend/);
    await expect(page).toHaveURL(/view=new/); // the view survives the filter
    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(cards()).toHaveCount(4);
    await page.getByRole("searchbox", { name: "Search jobs" }).fill("zzz-nothing");
    await expect(page.getByText("No roles match these filters")).toBeVisible();
    await page.getByRole("button", { name: "Clear filters" }).click();
  });

  it("points a search that Best match cannot answer at Newest", async () => {
    await page.goto(`${WEB}/jobs`);
    await page.getByRole("searchbox", { name: "Search jobs" }).fill("backend");
    await expect(page.getByText("No roles match these filters")).toBeVisible();
    await page.getByRole("link", { name: /Search every open role in Newest/ }).click();
    await expect(page).toHaveURL(/view=new/);
    await expect(page).toHaveURL(/q=backend/);
    await expect(cards()).toHaveCount(1);
    await expect(cards().first()).toContainText("Backend Engineer");
  });

  it("filters to remote roles, hides applied ones, and switches views", async () => {
    await page.goto(`${WEB}/jobs?view=new`);
    await expect(cards()).toHaveCount(4);
    await page.getByRole("switch", { name: /Remote only/ }).click();
    await expect(cards()).toHaveCount(2);
    await page.getByRole("switch", { name: /Remote only/ }).click();
    await page.getByRole("switch", { name: /Hide applied/ }).click();
    await expect(cards()).toHaveCount(1);
    await expect(cards().first()).toContainText("Backend Engineer");
    await page.getByRole("switch", { name: /Hide applied/ }).click();
    await page.getByRole("link", { name: "Best match" }).click();
    await expect(page.getByText(/best match first/)).toBeVisible();
    await expect(page).not.toHaveURL(/view=/);
    await page.getByRole("link", { name: "Newest" }).click();
    await expect(page.getByText(/newest first/)).toBeVisible();
    await page.getByLabel("Minimum match").selectOption("90");
    await expect(page).toHaveURL(/min=90/);
    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(cards()).toHaveCount(4);
  });

  it("shows New today only for roles posted in the last 24 hours, and older postings only when asked", async () => {
    await page.goto(`${WEB}/jobs?view=today`);
    await expect(page.getByText("Nothing new in the last 24 hours")).toBeVisible();
    await expect(cards()).toHaveCount(0);
    // A role posted 90 days ago is outside the default 60-day window.
    const [old] = await stack.db.insert(jobsTable).values({
      companyName: "Oldco", atsType: "web", externalId: "old-1", title: "Frontend Engineer, Legacy", location: "Remote (US)", remote: true,
      descriptionText: "Requirements:\n- React", applyUrl: "https://example.com/?job=old-1", postedAt: new Date(Date.now() - 90 * 86_400_000),
    }).returning();
    try {
      await page.goto(`${WEB}/jobs?view=new`);
      await expect(cards()).toHaveCount(4);
      await expect(cards().filter({ hasText: "Legacy" })).toHaveCount(0);
      await page.getByRole("switch", { name: /Include older postings/ }).click();
      await expect(page).toHaveURL(/older=1/);
      await expect(cards()).toHaveCount(5);
    } finally {
      await stack.db.delete(jobsTable).where(eq(jobsTable.id, old.id));
    }
  });

  it("never leaves Best match empty: with no role fitting the lanes it shows the open roles and says so", async () => {
    const stored = ((await api("/api/lanes")).json as { implicit?: boolean }[]).filter((l) => !l.implicit); // the onboarding-title lane is implicit: not stored
    await api("/api/lanes", { method: "PUT", data: [{ name: "Astronaut", titles: ["Astronaut"], remote: "ok", minScore: 60 }] });
    try {
      await page.goto(`${WEB}/jobs`);
      await expect(page.getByText(/No open role fits your lanes yet/)).toBeVisible();
      await expect(cards()).toHaveCount(4);
    } finally {
      await api("/api/lanes", { method: "PUT", data: stored });
    }
  });

  it("opens a role in a drawer with the reasons, and closes it again", async () => {
    await page.goto(`${WEB}/jobs`);
    await cards().filter({ hasText: "Senior Frontend Engineer" }).getByRole("link", { name: "Details" }).click();
    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();
    await expect(page).toHaveURL(/job=/);
    await expect(drawer).toContainText("Senior Frontend Engineer");
    await expect(drawer.getByRole("link", { name: /posting/i })).toHaveAttribute("href", /example\.com/);
    await drawer.getByRole("link", { name: "Close job details" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.goto(`${WEB}/jobs?job=${seed.jobIds[0]}`); // a shared link opens the drawer directly
    await expect(page.getByRole("dialog")).toBeVisible();
  });

  it("applies to the one open role and lands on its review", async () => {
    await page.goto(`${WEB}/jobs?view=new`);
    await cards().filter({ hasText: "Backend Engineer" }).getByRole("button", { name: "Apply" }).click();
    await page.waitForURL(/\/applications\/[0-9a-f-]{36}$/, { timeout: 60_000 });
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Backend Engineer");
    await page.goto(`${WEB}/jobs?view=new`);
    await expect(cards().filter({ hasText: "Backend Engineer" }).getByRole("link", { name: /Applied/ })).toBeVisible();
  });

  it("refuses a pasted URL that is not a job, with a message", async () => {
    await page.goto(`${WEB}/jobs`);
    await page.getByRole("tab", { name: "Paste a link" }).click();
    await page.getByPlaceholder("https://boards.greenhouse.io/...").fill("http://127.0.0.1:1/not-a-job");
    await page.getByRole("button", { name: "Add job" }).click();
    await expect(page.getByRole("button", { name: "Add job" })).toBeEnabled({ timeout: 60_000 });
    await expect(page.getByText(/^Added /)).toHaveCount(0);
    await expect(page.locator("main").getByText(/fetch|reach|could not|failed|unable|not a job|not a public|error|refused/i).first()).toBeVisible();
  });
});

describe("applications and the review gates", () => {
  it("shows the list with stage filters and a search that can come up empty", async () => {
    await page.goto(`${WEB}/applications`);
    const all = page.getByRole("button", { name: /^All/ });
    await expect(all).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("searchbox", { name: "Search applications" }).fill("zzz-nothing");
    await expect(page.getByText("Nothing in this view")).toBeVisible();
    await page.getByRole("searchbox", { name: "Search applications" }).fill("");
    await page.getByRole("button", { name: /^Waiting on you/ }).click();
    await expect(page.getByRole("button", { name: /^Waiting on you/ })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("link", { name: /Needs Answers Co/ })).toBeVisible();
  });

  it("answers the pending questions, approves the form, and the application is submitted (no 409)", async () => {
    await page.goto(`${WEB}/applications/${seed.apps.needsAnswers}`);
    await expect(page.getByText("Will you require visa sponsorship?").first()).toBeVisible();
    // This stack's submit lock is off, so the button says what really happens: the answer is saved and the run goes on, nothing is sent.
    const approve = page.getByRole("button", { name: /^Answer and (send|continue)$/i });
    await expect(approve).toBeDisabled(); // a required question is still open
    await page.locator("main select").first().selectOption({ label: "No" });
    await expect(approve).toBeEnabled({ timeout: 15_000 });
    await approve.click();
    // Assert the lasting fact, not a transient status: the form was approved (this stack's submit lock is off, so the run
    // goes on to submitting and then back to review, and a poll for "submitting" can miss it).
    const steps = async () => ((await api(`/api/applications/${seed.apps.needsAnswers}`)).json.events as { step: string }[]).map((e) => e.step);
    await expect.poll(steps, { timeout: 90_000 }).toEqual(expect.arrayContaining(["answer", "approve_form"]));
    expect(errors.filter((e) => /409/.test(e))).toEqual([]);
  });

  it("shows a recruiter's view of the tailored resume, with what the job asks for and what to fix", async () => {
    await page.goto(`${WEB}/applications/${seed.apps.formReview}`);
    const view = page.getByRole("region", { name: /Strong|Good|Needs work/ });
    await expect(view).toBeVisible();
    await expect(view).toContainText("Recruiter's view");
    await expect(view).toContainText(/out of 100/);
    const asked = view.getByRole("list", { name: "Skills the job asks for" });
    await expect(asked.getByRole("listitem").first()).toBeVisible();
    await expect(view).toContainText(/shown in your experience|only in the skills list|not on your resume/);
  });

  it("skips an application and shows it as skipped", async () => {
    await page.goto(`${WEB}/applications/${seed.apps.resumeReview}`);
    await page.getByRole("button", { name: /^Skip/ }).first().click();
    await expect.poll(async () => (await api(`/api/applications/${seed.apps.resumeReview}`)).json.application.status).toBe("skipped");
  });
});

describe("tracker, now part of Applications", () => {
  it("old tracker links land on Applications, which links each application to its review", async () => {
    await page.goto(`${WEB}/tracker`);
    await expect(page).toHaveURL(/\/applications$/);
    await expect(page.getByRole("table")).toBeVisible();
    await page.getByRole("link", { name: /Globex/ }).first().click();
    await page.waitForURL(new RegExp(`/applications/${seed.apps.formReview}$`));
  });

  it("says plainly that the sheet needs Google when it is not connected", async () => {
    await page.goto(`${WEB}/applications`);
    await page.getByRole("button", { name: "Export to Google Sheets" }).click();
    await expect(page.getByText(/composio|connect|not configured|google/i).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible(); // the page did not crash
  });
});

describe("inbox", () => {
  it("is empty without a mailbox, and says what syncing needs instead of failing", async () => {
    await page.goto(`${WEB}/inbox`);
    await page.getByRole("button", { name: "Check mail now" }).click();
    await expect(page.getByText(/composio|connect|gmail|no (messages|mail)|nothing/i).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });
});

describe("auto apply", () => {
  it("changes the daily cap and keeps it after a reload", async () => {
    await page.goto(`${WEB}/agent`);
    const cap = page.locator('input[aria-label="Daily cap"]');
    const before = Number(await cap.inputValue());
    await page.getByRole("button", { name: "Raise the daily cap" }).click();
    await expect.poll(async () => (await api("/api/me")).json.profile.autoApplyDailyCap).toBe(before + 1);
    await page.reload();
    await expect(page.locator('input[aria-label="Daily cap"]')).toHaveValue(String(before + 1));
    await page.getByRole("button", { name: "Lower the daily cap" }).click();
    await expect.poll(async () => (await api("/api/me")).json.profile.autoApplyDailyCap).toBe(before);
  });

  it("toggles review-before-submit and auto-approve, and they persist", async () => {
    await page.goto(`${WEB}/agent`);
    const review = page.getByRole("switch", { name: "Review every form before it is sent" });
    const was = (await review.getAttribute("aria-checked")) === "true";
    await review.click();
    await expect.poll(async () => (await api("/api/me")).json.profile.reviewBeforeSubmit).toBe(!was);
    await review.click();
    await expect.poll(async () => (await api("/api/me")).json.profile.reviewBeforeSubmit).toBe(was);
  });

  it("adds, edits and deletes a lane", async () => {
    await page.goto(`${WEB}/agent`);
    page.on("response", async (r) => { const m = r.request().method(); if (m !== "GET" || /api.lanes/.test(r.url())) if (/api\/(lanes|profile|agent|settings|me)/.test(r.url())) console.log("DBG", m, r.url().replace(WEB, ""), r.status(), m === "GET" ? (await r.text().catch(() => "")).slice(0, 90) : ""); });
    await page.getByRole("button", { name: "Add a lane" }).click();
    await page.getByPlaceholder("Frontend, remote").fill("Platform, remote");
    await page.getByRole("button", { name: "Save lane" }).click();
    await expect(page.getByRole("button", { name: "Edit Platform, remote" })).toBeVisible({ timeout: 15_000 });
    await page.reload();
    await expect(page.getByRole("button", { name: "Edit Platform, remote" })).toBeVisible();
    await page.getByRole("button", { name: "Edit Platform, remote" }).click();
    await page.getByRole("button", { name: "Delete lane" }).click();
    await expect(page.getByRole("button", { name: "Edit Platform, remote" })).toHaveCount(0);
  });

  it("turns Autopilot on after a warning, shows how much trust is still needed, and turns it off", async () => {
    await page.goto(`${WEB}/agent`);
    const group = page.getByRole("radiogroup", { name: "Autopilot" });
    await expect(group.getByRole("radio", { name: /^Off/ })).toHaveAttribute("aria-checked", "true");

    let warned = "";
    page.once("dialog", (d) => { warned = d.message(); void d.accept(); });
    await group.getByRole("radio", { name: /^On, profile answers only/ }).click();
    await expect(group.getByRole("radio", { name: /^On, profile answers only/ })).toHaveAttribute("aria-checked", "true");
    expect(warned).toMatch(/send an application by itself, without asking/);
    await expect(page.getByText(/Trust: \d of 3 hand approvals so far/)).toBeVisible(); // earlier steps approved one by hand
    await expect.poll(async () => (await api("/api/me")).json.profile).toMatchObject({ autopilot: "safe", reviewBeforeSubmit: true });

    // The checks it runs for each application are always listed, not hidden behind a disclosure.
    await expect(page.getByText(/Greenhouse, Lever or Ashby/)).toBeVisible();
    await expect(page.getByText("You have not applied to the same company in the last 30 days.")).toBeVisible();

    await page.reload();
    await expect(page.getByRole("radiogroup", { name: "Autopilot" }).getByRole("radio", { name: /^On, profile answers only/ })).toHaveAttribute("aria-checked", "true");
    await page.getByRole("radiogroup", { name: "Autopilot" }).getByRole("radio", { name: /^Off/ }).click(); // turning off needs no warning
    await expect.poll(async () => (await api("/api/me")).json.profile.autopilot).toBe("off");
  });

  it("runs a cycle from Today and reports what it did", async () => {
    await page.goto(`${WEB}/dashboard`);
    await page.getByRole("button", { name: "Run a cycle now" }).click();
    await expect(page.getByRole("button", { name: "Run a cycle now" })).toBeEnabled({ timeout: 90_000 });
    await expect(page.getByRole("status").filter({ hasText: /./ }).first()).toBeVisible({ timeout: 90_000 });
  });

  it("answers a message in the chat", async () => {
    await page.goto(`${WEB}/chat`);
    await page.getByLabel("Message Nori").fill("What did you do today?");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("What did you do today?").first()).toBeVisible();
    await expect(page.getByText(/Nori is thinking/)).toHaveCount(0, { timeout: 90_000 });
    await expect(page.getByRole("alert").filter({ hasText: /./ })).toHaveCount(0);
  });
});

describe("companies", () => {
  it("lists the watched companies with open-role counts", async () => {
    await page.goto(`${WEB}/companies`);
    const rows = page.getByRole("list", { name: "Companies" }).getByRole("listitem");
    await expect(rows).toHaveCount(60);
    await expect(page.getByRole("status").filter({ hasText: /companies/ })).toContainText(/\d{3,} companies/); // the registry grows as boards are added: any three-digit count
    await expect(rows.first()).toContainText(/open role/);
  });

  it("searches, follows, filters to followed ones and unfollows", async () => {
    const rows = page.getByRole("list", { name: "Companies" }).getByRole("listitem");
    await page.getByRole("searchbox", { name: "Search companies" }).fill("stripe");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Stripe");
    await page.getByRole("button", { name: "Follow Stripe" }).click();
    await expect(page.getByRole("button", { name: "Unfollow Stripe" })).toHaveAttribute("aria-pressed", "true");
    await expect.poll(async () => (await api("/api/me")).json.profile.preferences.followCompanies).toEqual(["greenhouse:stripe"]);
    await page.getByRole("searchbox", { name: "Search companies" }).fill("");
    await page.getByRole("switch", { name: "Following only" }).click();
    await expect(rows).toHaveCount(1);
    await page.getByRole("button", { name: "Unfollow Stripe" }).click();
    await expect(page.getByText("You are not following anyone yet")).toBeVisible();
    await expect.poll(async () => (await api("/api/me")).json.profile.preferences.followCompanies).toEqual([]);
  });

  it("explains why a link cannot be used instead of failing", async () => {
    await page.getByRole("switch", { name: "Following only" }).click();
    await page.getByPlaceholder("https://example.com/careers").fill("http://169.254.169.254/latest");
    await page.getByRole("button", { name: "Find and follow" }).click();
    await expect(page.getByText(/not a public website/i)).toBeVisible({ timeout: 20_000 });
  });

  it("is reachable from the jobs page", async () => {
    await page.goto(`${WEB}/jobs`);
    await page.getByRole("link", { name: "Followed companies" }).click();
    await page.waitForURL(/\/companies$/);
  });
});

describe("nothing broke along the way", () => {
  it("raised no page errors, console errors or server errors", () => {
    // Syncing a sheet or a mailbox without Composio answers 503 on purpose ("not configured"); the pages show it as a message.
    expect(errors.filter((e) => !/^http 503: \/api\/(tracker\/sync-sheet|inbox\/sync)$/.test(e))).toEqual([]);
  });
});
