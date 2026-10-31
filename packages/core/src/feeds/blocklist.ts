import { and, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { companies, jobs } from "../db/schema.js";

/**
 * Sources Nori refuses to poll, seed or ingest from a feed because they are not employers: they repost other
 * companies' openings (often scraped, often stale or already filled) under their own name. One reposting service
 * can outweigh a whole real board (Jobgether alone was ~10% of open rows), and every one of its postings sends
 * the candidate through a second funnel instead of the employer's own form.
 *
 * Matching is exact on the normalised name or board token (lower case, letters and digits only), never a
 * substring, so a real employer that merely contains the word is not caught.
 */
export type BlockedSource = {
  /** Display name as it appears on postings. */
  name: string;
  /** Board tokens (any ATS) that belong to it. The normalised name is always matched as well. */
  tokens: string[];
  why: string;
};

export const BLOCKED_SOURCES: BlockedSource[] = [
  {
    name: "Jobgether",
    tokens: ["jobgether"],
    why: "Reposting aggregator (lever:jobgether). Lists thousands of other employers' roles behind an AI-matching funnel and resubmits applications on their behalf; the real employer is rarely named.",
  },
  {
    name: "Lensa",
    tokens: ["lensa"],
    why: "Job-search aggregator that republishes roles scraped from other sites and reroutes applicants through its own pages. Not in the registry today; blocked so it cannot be added or discovered.",
  },
  {
    name: "Talent.com",
    tokens: ["talentcom"],
    why: "Job-search aggregator (formerly Neuvoo) that reposts other employers' listings. Not in the registry today; blocked so it cannot be added or discovered.",
  },
  {
    name: "Jooble",
    tokens: ["jooble"],
    why: "Job-search aggregator that republishes listings from other sites. Not in the registry today; blocked so it cannot be added or discovered.",
  },
  {
    name: "Jobright",
    tokens: ["jobright", "jobrightai"],
    why: "AI job-search aggregator that reposts other employers' roles. Not in the registry today; blocked so it cannot be added or discovered.",
  },
];

/** Lower case, letters and digits only: "Talent.com", "talent-com" and "TalentCom" all become "talentcom". */
export const normalizeSourceKey = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

const BLOCKED_KEYS: ReadonlySet<string> = new Set(
  BLOCKED_SOURCES.flatMap((b) => [b.name, ...b.tokens].map(normalizeSourceKey)),
);

/** True when this company name or board token belongs to a blocked aggregator. */
export function isBlockedCompany(c: { name?: string | null; token?: string | null }): boolean {
  return Boolean((c.name && BLOCKED_KEYS.has(normalizeSourceKey(c.name))) || (c.token && BLOCKED_KEYS.has(normalizeSourceKey(c.token))));
}

/** True when this board (any ATS) is a blocked aggregator's. */
export const isBlockedBoard = (_atsType: string, token: string): boolean => isBlockedCompany({ token });

export class BlockedSourceError extends Error {
  constructor(readonly token: string) {
    super(`"${token}" is a job reposting aggregator, not an employer; Nori does not poll it.`);
    this.name = "BlockedSourceError";
  }
}

/**
 * Close every open job that came from a blocked source and drop the blocked companies, so they leave every user's
 * list without a manual migration. Idempotent: once the rows are gone or closed a second run changes nothing.
 * Jobs are matched through their company row and, for rows with no company, by posting company name; applications
 * and matches that point at a job are left alone (the job row stays, only closed).
 */
export async function purgeBlockedSources(db: Db): Promise<{ closedJobs: number; removedCompanies: number }> {
  const blockedCompanies = (await db.select({ id: companies.id, name: companies.name, token: companies.atsToken }).from(companies))
    .filter((c) => isBlockedCompany(c));
  const ids = blockedCompanies.map((c) => c.id);
  const nameKeys = [...BLOCKED_KEYS];
  const byName = sql`regexp_replace(lower(${jobs.companyName}), '[^a-z0-9]', '', 'g') in (${sql.join(nameKeys.map((k) => sql`${k}`), sql`, `)})`;
  const closed = await db.update(jobs).set({ closedAt: new Date() })
    .where(and(isNull(jobs.closedAt), or(byName, ids.length ? inArray(jobs.companyId, ids) : undefined)))
    .returning();
  if (ids.length) await db.delete(companies).where(inArray(companies.id, ids));
  return { closedJobs: closed.length, removedCompanies: ids.length };
}

