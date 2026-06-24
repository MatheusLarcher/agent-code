# Reviewer Prompt Template

Each reviewer is a subagent (Agent tool, `subagent_type: "general-purpose"`). Its prompt contains:

1. The stated intent (from Step 2)
2. Their assigned lens (full text from references/reviewer-lenses.md)
3. The principles relevant to their lens, if available (file contents, not summaries)
4. The code or diff to review — paste it inline, or name the exact files / `git diff` to read
5. Instructions: "You are an adversarial reviewer. Your job is to find real problems, not
   validate the work. Be specific — cite files, lines, and concrete failure scenarios.
   Rate each finding: high (blocks ship), medium (should fix), low (worth noting).
   You are READ-ONLY: do NOT edit, write, or run anything that changes files — only read and
   reason. Return your findings as a numbered markdown list as your final message."

Spawn all reviewers in parallel — issue every Agent tool call in a single message so they run
concurrently. Each subagent's final message is its findings; collect them all before synthesizing.
