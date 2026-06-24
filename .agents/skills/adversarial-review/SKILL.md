---
name: adversarial-review
description: >-
  Adversarial code review. Spawns parallel Claude subagents, each attacking the work from a
  distinct critical lens (Skeptic, Architect, Minimalist), then synthesizes a single verdict
  with findings and a lead judgment. Read-only — never edits code. Triggers: "adversarial review".
schedule: "After sessions that produce large diffs (200+ lines), implement plan phases, or complete a planning session"
---

# Adversarial Review

Spawn reviewers that challenge the work from distinct lenses, then synthesize a verdict.
The deliverable is a **synthesized verdict — do NOT make changes** to the code.

**How reviewers run (adapted for Claude Code):** spawn each reviewer as a parallel subagent
via the **Agent tool** (`subagent_type: "general-purpose"`), all in a single message so they
run concurrently. Each subagent gets ONE lens and returns its findings as its final message —
no temp files needed. Reviewers are READ-ONLY: their prompt must forbid editing files.

> Note: this skill was adapted from a cross-model design (which shelled out to a `codex`/`claude`
> CLI with safety checks disabled). Here reviewers run as native in-session subagents instead:
> safer, no external CLI, and works without any extra install. The diversity comes from the
> distinct lenses rather than from a different model.

## Step 1 — Load Principles (if present)

If a `brain/principles.md` exists in the project, read it and follow every `[[wikilink]]` to the
linked principle files — these ground reviewer judgments. If there is no `brain/` directory
(the usual case), skip this: the lenses in `references/reviewer-lenses.md` already encode the
principles as concrete questions.

## Step 2 — Determine Scope and Intent

Identify what to review from context (recent diffs via `git diff`, referenced plans, the user's
message). If the scope is ambiguous, ask the user what to review before spawning anyone.

Determine the **intent** — what the author is trying to achieve. This is critical: reviewers
challenge whether the work *achieves the intent well*, not whether the intent is correct.
State the intent explicitly before proceeding.

Assess change size and pick the reviewer count:

| Size | Threshold | Reviewers |
|------|-----------|-----------|
| Small | < 50 lines, 1-2 files | 1 (Skeptic) |
| Medium | 50-200 lines, 3-5 files | 2 (Skeptic + Architect) |
| Large | 200+ lines or 5+ files | 3 (Skeptic + Architect + Minimalist) |

Read `references/reviewer-lenses.md` for the lens definitions.

## Step 3 — Spawn Reviewers (parallel subagents)

Spawn one subagent per lens, ALL in a single message so they run in parallel. For each, use the
**Agent tool** with `subagent_type: "general-purpose"` and a prompt built from
`references/reviewer-prompt.md` containing:

1. The stated intent (from Step 2)
2. Their assigned lens (full text from `references/reviewer-lenses.md`)
3. The exact code or diff to review (paste it, or tell them the precise files/`git diff` to read)
4. The read-only + output instructions from the template

Each subagent's final message IS its findings (a numbered markdown list, severity-rated). The
Agent tool returns that text to you directly — collect all of them before synthesizing.

If a subagent returns nothing or errors, note the failed reviewer in the verdict — do not
silently skip a lens.

## Step 4 — Synthesize Verdict

Collect every reviewer's findings. Deduplicate overlapping findings across lenses. Produce a
single verdict using the format in `references/verdict-format.md`.

## Step 5 — Render Judgment

After synthesizing, apply your own judgment. Using the stated intent (and any brain principles)
as your frame, state which findings you accept and which you reject — and why. Reviewers are
adversarial by design; not every finding warrants action. Call out false positives, overreach,
and findings that mistake style for substance.

Append the Lead Judgment section to the verdict (see `references/verdict-format.md`).
