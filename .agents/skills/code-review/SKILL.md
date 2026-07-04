---
name: code-review
description: >-
  Review the current diff for correctness bugs and reuse/simplification/efficiency cleanups
  at a given effort level (low/medium: fewer, high-confidence findings; high→max: broader
  coverage, may include uncertain findings; ultra: deep multi-agent review in the cloud).
  Pass --comment to post findings as inline PR comments, or --fix to apply the findings to
  the working tree after the review. Triggers: "revisar código", "revisar antes de commitar",
  "code review", "/code-review".
---

# Code Review

Review the **current diff** (uncommitted changes, or the diff since the branch point if
requested) for two categories of problem:

1. **Correctness bugs** — logic errors, edge cases not handled, wrong types/units, race
   conditions, off-by-one, broken null/error handling, security issues (injection, XSS, secrets).
2. **Reuse/simplification/efficiency** — duplicated logic that should reuse an existing
   helper, unnecessary complexity, dead code, avoidable re-renders/queries/allocations.

This skill does **not** hunt for style nits or opinions — only defects with a concrete
failure scenario, and cleanups with a concrete cost. If you can't state how something breaks
or what it costs, it isn't a finding.

## Step 1 — Determine scope and effort

- **Scope**: default to `git diff` (unstaged + staged) plus untracked new files relevant to the
  task just completed. If the user names specific files/a PR, use that instead.
- **Effort** (default `medium` unless the user names one):
  - `low` / `medium` — a single focused pass. Report only findings you're confident are real.
  - `high` → `max` — broader coverage: check more files, more edge cases, more of the
    reuse/efficiency angle. May include findings you're less certain about — mark them.
  - `ultra` — do not run this yourself. Tell the user this launches the multi-agent cloud
    review (`/code-review ultra` or `/code-review ultra <PR#>`) and that it's user-triggered
    and billed — you cannot launch it on their behalf.

## Step 2 — Review

Read every changed file fully (not just the diff hunks) — a bug is often visible only with
surrounding context (the caller, the type definition, the existing test). For each candidate
finding, verify it against the actual code before reporting: re-read the exact lines, confirm
the failure scenario actually reproduces given the real signatures/types involved. Discard
anything you can't concretely pin down.

At `high` and above, spawn one or two parallel subagents (Agent tool, read-only, no edits) to
independently check the same diff from a different angle (e.g. one for correctness, one for
reuse/efficiency) and merge their findings with yours, deduplicating overlaps.

## Step 3 — Report

Rank findings most-severe first. If the `ReportFindings` tool is available, use it — one call,
verified findings only, empty array if nothing survived scrutiny. Otherwise report as a
markdown list: file:line, one-sentence defect summary, concrete failure scenario.

If invoked as part of a pre-commit check (user says "revisar antes de comitar" or similar) and
findings remain unresolved, **say so explicitly before any commit happens** — do not let the
user commit unaware that open findings exist.

## Step 4 — Optional flags

- `--comment`: post the findings as inline PR review comments via `gh api` instead of (or in
  addition to) printing them — only when reviewing an actual GitHub PR.
- `--fix`: after reporting, apply fixes for the confirmed findings directly to the working
  tree, then re-run the affected checks (typecheck/tests) to confirm the fix didn't break
  anything. Do not silently fix — tell the user what was changed and why.

## Rules

- Never invent findings to pad the list — an empty result is a valid, good outcome.
- Don't flag style/formatting preferences already enforced by lint/prettier.
- If the diff is empty or trivial (e.g. a one-line typo fix), say so and skip the full pass.
