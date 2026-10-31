"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Search, SlidersHorizontal } from "lucide-react";
import type { ApplicationStatus, JobWithMatch } from "@/lib/types";
import { STATUS_LABEL } from "@/lib/format";
import { ApplyButton } from "./ApplyButton";
import { cx } from "./cx";
import { Icon } from "./Icon";
import { MatchBadge } from "./MatchBadge";
import { Monogram } from "./Monogram";
import { STATUS_MARK } from "./StatusPill";
import { TimeAgo } from "./TimeAgo";
import { EmptyState } from "./ui";
import {
  DEFAULT_FILTERS, SENIORITY_ORDER, VIEW_PARAMS, activeFilterCount, filtersToParams, placeName, postedIso,
  seniorityKey, seniorityLabel, skillChips, sourceLabel, workMode, type BoardFilters, type JobsView,
} from "./jobMeta";

export type BoardApp = { id: string; status: ApplicationStatus };

const chip = (on: boolean) =>
  cx("inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-medium transition-colors", on ? "border-ink bg-ink text-on-ink" : "border-line bg-surface text-ink-2 hover:border-control");

function CheckRow({ checked, onChange, label, count }: { checked: boolean; onChange: (v: boolean) => void; label: string; count?: number }) {
  return (
    <label className="flex min-h-8 cursor-pointer items-center gap-2.5 text-body-sm text-ink">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4" />
      <span className="flex-1">{label}</span>
      {count !== undefined && <span className="text-[12px] text-muted tnum">{count}</span>}
    </label>
  );
}

/** One job as a row: who, what, where, how well it matches and why, and the one action that fits its state. */
export function BoardCard({ item, app, href }: { item: JobWithMatch; app?: BoardApp | null; href: string }) {
  const { job, match } = item;
  const mode = workMode(job);
  const place = placeName(job.location);
  const more = (item.locations ?? 1) - 1;
  const moreNames = item.locationNames?.join(", ") ?? "";
  const sen = seniorityKey(job);
  const chips = skillChips(match, 4);
  const status = app?.status ?? item.applicationStatus ?? null;
  const waiting = status ? STATUS_MARK[status] === "accent" : false;

  return (
    <article className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:gap-4">
      <Monogram name={job.companyName} size={40} className="hidden sm:inline-flex" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Link href={href} scroll={false} className="min-w-0 text-body-sm font-semibold text-ink underline-offset-4 hover:underline sm:text-[15px]">{job.title}</Link>
          <MatchBadge score={match?.score} />
        </div>
        <p className="mt-0.5 truncate text-meta text-muted">
          {job.companyName} · {place ?? (mode === "Remote" ? "Anywhere" : "Location not listed")}
          {more > 0 && (
            <>
              {" "}<span title={moreNames} className="font-medium text-ink-2">+{more} {more === 1 ? "location" : "locations"}<span className="sr-only">: {moreNames}</span></span>
            </>
          )}
          {" "}· {mode}{sen ? ` · ${seniorityLabel(sen)}` : ""} · {sourceLabel(job.atsType)} · <TimeAgo iso={postedIso(job)} />
        </p>
        {chips.length > 0 && (
          <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Skills the posting asks for">
            {chips.map((c) => (
              <li
                key={c.name}
                title={c.matched ? "In your career graph" : `Not in your graph${c.required ? " (required)" : ""}`}
                className={cx("rounded-full px-2 py-[1px] text-[12px]", c.matched ? "bg-sunken text-ink" : "border border-dashed border-control text-muted")}
              >
                {c.name}<span className="sr-only">{c.matched ? ", in your graph" : ", missing"}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2 sm:justify-end">
        <Link href={href} scroll={false} className="inline-flex h-8 items-center rounded-control px-2.5 text-[13px] font-medium text-ink-2 hover:bg-sunken">Details</Link>
        {status ? (
          <Link
            href={app ? `/applications/${app.id}` : href}
            className={cx("inline-flex h-8 items-center gap-1.5 rounded-control px-3 text-[12px] font-semibold", waiting ? "bg-attn-tint text-attn-fg ring-1 ring-inset ring-attn" : "bg-sunken text-ink-2")}
          >
            <span className="sr-only">Applied: </span>{STATUS_LABEL[status] ?? status} <Icon icon={ArrowRight} size={13} />
          </Link>
        ) : (
          <ApplyButton jobId={job.id} />
        )}
      </div>
    </article>
  );
}

/** Job list: a compact filter bar (more filters behind a disclosure), then ranked rows. */
export function JobBoard({ items, apps, initial, view, viewQuery = "" }: {
  items: JobWithMatch[]; apps: Record<string, BoardApp>; initial: BoardFilters;
  /** Which server view these items came from (best match, newest, new today); the list keeps the server's order. */
  view: JobsView;
  /** The view's own URL params (view, clearance, older), kept on every link so opening a job does not reset the view. */
  viewQuery?: string;
}) {
  const [f, setF] = useState<BoardFilters>(initial);
  const [more, setMore] = useState(initial.seniority.length + initial.sources.length > 0);
  const set = <K extends keyof BoardFilters>(k: K, v: BoardFilters[K]) => setF((prev) => ({ ...prev, [k]: v }));
  const toggleIn = (k: "seniority" | "sources", v: string, on: boolean) =>
    setF((prev) => ({ ...prev, [k]: on ? [...prev[k], v] : prev[k].filter((x) => x !== v) }));

  const params = filtersToParams(f).toString();
  useEffect(() => {
    const cur = new URLSearchParams(window.location.search);
    const next = new URLSearchParams(params);
    for (const k of ["job", ...VIEW_PARAMS]) {
      const v = cur.get(k);
      if (v) next.set(k, v);
    }
    const qs = next.toString();
    if (qs !== cur.toString()) window.history.replaceState(window.history.state, "", `/jobs${qs ? `?${qs}` : ""}`);
  }, [params]);

  const facets = useMemo(() => {
    const sen = new Map<string, number>();
    const src = new Map<string, number>();
    for (const { job } of items) {
      const s = seniorityKey(job);
      if (s) sen.set(s, (sen.get(s) ?? 0) + 1);
      src.set(job.atsType, (src.get(job.atsType) ?? 0) + 1);
    }
    const order = (k: string) => (SENIORITY_ORDER.indexOf(k) + 1 || 99);
    return {
      seniority: [...sen].sort((a, b) => order(a[0]) - order(b[0])),
      sources: [...src].sort((a, b) => b[1] - a[1]),
      remote: items.filter(({ job }) => workMode(job) === "Remote").length,
      applied: items.filter(({ job, applicationStatus }) => apps[job.id] || applicationStatus).length,
    };
  }, [items, apps]);

  const shown = useMemo(() => {
    const q = f.q.trim().toLowerCase();
    const out = items.filter(({ job, match, applicationStatus }) => {
      if (q) {
        const hay = [job.title, job.companyName, job.location ?? "", ...(job.requirements?.skills.map((s) => s.name) ?? [])].join(" ").toLowerCase();
        if (!q.split(/\s+/).every((w) => hay.includes(w))) return false;
      }
      if (f.min && Math.round((match?.score ?? 0) * 100) < f.min) return false;
      if (f.remote && workMode(job) !== "Remote") return false;
      if (f.seniority.length && !f.seniority.includes(seniorityKey(job) ?? "")) return false;
      if (f.sources.length && !f.sources.includes(job.atsType)) return false;
      if (f.hideApplied && (apps[job.id] || applicationStatus)) return false;
      return true;
    });
    return out; // the server already ordered them for the chosen view
  }, [items, apps, f]);

  const PAGE = 20;
  const [page, setPage] = useState({ key: params, n: PAGE });
  const limit = page.key === params ? page.n : PAGE;
  const visible = shown.slice(0, limit);

  const active = activeFilterCount(f);
  const extra = f.seniority.length + f.sources.length;
  const hrefFor = (id: string) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of new URLSearchParams(viewQuery)) p.set(k, v);
    p.set("job", id);
    return `/jobs?${p}`;
  };
  /** Same filters and switches, on the Newest view (which is not trimmed to the user's lanes). */
  const newestHref = (() => {
    const p = new URLSearchParams(params);
    for (const [k, v] of new URLSearchParams(viewQuery)) p.set(k, v);
    p.set("view", "new");
    return `/jobs?${p}`;
  })();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3" aria-label="Filters">
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative min-w-0 flex-1 basis-60">
            <span className="sr-only">Search jobs</span>
            <Icon icon={Search} size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input
              type="search"
              value={f.q}
              onChange={(e) => set("q", e.target.value)}
              placeholder="Title, skill, company, city"
              className="h-10 w-full rounded-control border border-control bg-surface pl-9 pr-3 text-body-sm text-ink placeholder:text-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25"
            />
          </label>
          <label className="flex items-center gap-2 text-meta text-ink-2">
            <span className="sr-only sm:not-sr-only">Minimum match</span>
            <select value={f.min} onChange={(e) => set("min", Number(e.target.value))} aria-label="Minimum match" className="h-10 rounded-control border border-control bg-surface pl-3 text-body-sm text-ink">
              {[0, 50, 60, 70, 80, 90].map((n) => <option key={n} value={n}>{n === 0 ? "Any match" : `${n}% or more`}</option>)}
            </select>
          </label>
        </div>
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0">
          <button type="button" role="switch" aria-checked={f.remote} onClick={() => set("remote", !f.remote)} className={chip(f.remote)}>Remote only <span className="font-normal tnum">{facets.remote}</span></button>
          <button type="button" role="switch" aria-checked={f.hideApplied} onClick={() => set("hideApplied", !f.hideApplied)} className={chip(f.hideApplied)}>Hide applied <span className="font-normal tnum">{facets.applied}</span></button>
          <button type="button" aria-expanded={more} aria-controls="more-filters" onClick={() => setMore((m) => !m)} className={chip(extra > 0)}>
            <Icon icon={SlidersHorizontal} size={14} /> More filters{extra > 0 && <span className="tnum">{extra}</span>}
          </button>
          {active > 0 && (
            <button type="button" onClick={() => setF(DEFAULT_FILTERS)} className="inline-flex h-9 shrink-0 items-center px-2 text-[13px] font-medium text-accent underline-offset-4 hover:underline">Clear filters</button>
          )}
        </div>
        {/* An ordinary panel under the row, not a dropdown: the chip row scrolls sideways on phones and would clip one. */}
        {more && (
          <div id="more-filters" className="grid gap-4 rounded-card border border-line bg-surface p-4 sm:grid-cols-2">
            {facets.seniority.length > 0 && (
              <fieldset>
                <legend className="mb-1 text-meta font-semibold text-ink">Level</legend>
                {facets.seniority.map(([k, c]) => <CheckRow key={k} label={seniorityLabel(k)} count={c} checked={f.seniority.includes(k)} onChange={(on) => toggleIn("seniority", k, on)} />)}
              </fieldset>
            )}
            <fieldset>
              <legend className="mb-1 text-meta font-semibold text-ink">Source</legend>
              {facets.sources.map(([k, c]) => <CheckRow key={k} label={sourceLabel(k)} count={c} checked={f.sources.includes(k)} onChange={(on) => toggleIn("sources", k, on)} />)}
            </fieldset>
          </div>
        )}
      </div>

      <p className="text-meta text-muted tnum">
        <span className="font-semibold text-ink">{shown.length}</span> of {items.length} roles, {view === "best" ? "best match first" : "newest first"}.
        <span className="ml-2 hidden sm:inline">Solid chips are in your graph; dashed ones are missing.</span>
      </p>

      {shown.length === 0 ? (
        <EmptyState title={items.length === 0 ? (view === "today" ? "Nothing new in the last 24 hours" : "No jobs yet") : "No roles match these filters"}>
          {items.length === 0
            ? view === "today" ? "Check Newest for the latest postings, or come back later today." : "Poll a company's board or paste a posting link above to start."
            : "Loosen a filter, or add more roles above."}
          {items.length > 0 && view === "best" && f.q.trim() && (
            <>
              {" "}Best match only lists roles that fit your lanes.{" "}
              <Link href={newestHref} className="font-medium text-ink underline">Search every open role in Newest</Link>.
            </>
          )}
        </EmptyState>
      ) : (
        <>
          <ul className="divide-y divide-line rounded-card border border-line bg-surface">
            {visible.map((item) => (
              <li key={item.job.id} className="min-w-0 hover:bg-sunken/40">
                <BoardCard item={item} app={apps[item.job.id]} href={hrefFor(item.job.id)} />
              </li>
            ))}
          </ul>
          {shown.length > limit && (
            <div className="flex items-center justify-between gap-4">
              <span className="text-meta text-muted tnum">Showing {visible.length} of {shown.length}</span>
              <button type="button" onClick={() => setPage({ key: params, n: limit + PAGE })} className="inline-flex h-10 items-center rounded-control border border-control px-4 text-[13px] font-semibold text-ink hover:bg-sunken">
                Show {Math.min(PAGE, shown.length - limit)} more
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
