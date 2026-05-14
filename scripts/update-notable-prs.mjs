#!/usr/bin/env node
// Regenerates the "Notable Contributions" section of README.md.
//
// The lowlighter/metrics "notable" plugin is backed by GitHub's
// `repositoriesContributedTo` field, which only surfaces *recent*
// contributions. `user.pullRequests` instead returns the full lifetime
// history, so years-old PRs still show up here.

import { readFile, writeFile } from "node:fs/promises";

const TOKEN = process.env.GITHUB_TOKEN;
const USER = process.env.PROFILE_USER || process.env.GITHUB_REPOSITORY_OWNER;
const MAX_PRS = Number(process.env.MAX_PRS || 10);
const MIN_STARS = Number(process.env.MIN_STARS || 0);
const ONE_PER_REPO = (process.env.ONE_PER_REPO || "true").toLowerCase() !== "false";
const README_PATH = process.env.README_PATH || "README.md";

const START = "<!-- NOTABLE-PRS:START -->";
const END = "<!-- NOTABLE-PRS:END -->";

if (!TOKEN) {
  console.error("GITHUB_TOKEN is required");
  process.exit(1);
}
if (!USER) {
  console.error("Could not determine profile user (set PROFILE_USER or GITHUB_REPOSITORY_OWNER)");
  process.exit(1);
}

const QUERY = `
query($user: String!, $after: String) {
  user(login: $user) {
    pullRequests(
      first: 100
      after: $after
      states: MERGED
      orderBy: { field: CREATED_AT, direction: DESC }
    ) {
      pageInfo { hasNextPage endCursor }
      nodes {
        title
        url
        mergedAt
        repository {
          nameWithOwner
          stargazerCount
          isFork
          isPrivate
          owner { login }
        }
      }
    }
  }
}`;

async function fetchAllMergedPRs() {
  const prs = [];
  let after = null;
  for (;;) {
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: QUERY, variables: { user: USER, after } }),
    });
    if (!res.ok) {
      throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
    }
    const json = await res.json();
    if (json.errors) {
      throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
    }
    const conn = json.data.user.pullRequests;
    prs.push(...conn.nodes);
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return prs;
}

function formatStars(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

function escapePipes(s) {
  return s.replace(/\|/g, "\\|");
}

function buildSection(prs) {
  let candidates = prs.filter((pr) => {
    const repo = pr.repository;
    if (!repo || repo.isPrivate || repo.isFork) return false;
    if (repo.owner.login.toLowerCase() === USER.toLowerCase()) return false;
    if (repo.stargazerCount < MIN_STARS) return false;
    return true;
  });

  const countByRepo = new Map();
  for (const pr of candidates) {
    const key = pr.repository.nameWithOwner;
    countByRepo.set(key, (countByRepo.get(key) || 0) + 1);
  }

  candidates.sort((a, b) => {
    const byStars = b.repository.stargazerCount - a.repository.stargazerCount;
    if (byStars !== 0) return byStars;
    return new Date(b.mergedAt) - new Date(a.mergedAt);
  });

  if (ONE_PER_REPO) {
    const seen = new Set();
    candidates = candidates.filter((pr) => {
      const key = pr.repository.nameWithOwner;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  const notable = candidates.slice(0, MAX_PRS);
  if (notable.length === 0) {
    return "_No notable contributions found yet._";
  }

  const rows = notable.map((pr) => {
    const repo = pr.repository;
    const year = new Date(pr.mergedAt).getFullYear();
    let prCell = `[${escapePipes(pr.title)}](${pr.url})`;
    if (ONE_PER_REPO) {
      const total = countByRepo.get(repo.nameWithOwner) || 1;
      if (total > 1) {
        const searchUrl = `https://github.com/${repo.nameWithOwner}/pulls?q=is%3Apr+author%3A${USER}`;
        prCell += ` ([+${total - 1} more](${searchUrl}))`;
      }
    }
    return `| [${repo.nameWithOwner}](https://github.com/${repo.nameWithOwner}) | ${prCell} | ⭐ ${formatStars(repo.stargazerCount)} | ${year} |`;
  });

  return [
    "| Repository | Pull Request | Stars | Merged |",
    "| --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

async function main() {
  const prs = await fetchAllMergedPRs();
  const section = buildSection(prs);
  const readme = await readFile(README_PATH, "utf8");

  const startIdx = readme.indexOf(START);
  const endIdx = readme.indexOf(END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    console.error(`Could not find markers in ${README_PATH}:\n  ${START}\n  ${END}`);
    process.exit(1);
  }

  const updated =
    readme.slice(0, startIdx + START.length) +
    "\n\n" +
    section +
    "\n\n" +
    readme.slice(endIdx);

  if (updated === readme) {
    console.log(`README already up to date (${prs.length} merged PRs scanned).`);
    return;
  }
  await writeFile(README_PATH, updated);
  console.log(`Updated ${README_PATH} (${prs.length} merged PRs scanned).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
