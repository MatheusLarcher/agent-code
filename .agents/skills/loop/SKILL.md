---
name: "loop"
description: "Execute a prompt repeatedly on a fixed interval or with self-paced wakeups. Use when the user asks to run a task periodically, monitor status, poll a deploy or log, or keep iterating until a stated condition is met."
---

# Loop

## What This Skill Does

Runs the requested prompt immediately, then schedules repeated execution either with a fixed cron interval or with dynamic self-pacing. It must stop only when the user gives an explicit stop condition or the requested work is complete.

## Parsing

- A leading interval such as `5m`, `2h`, or `1d` is fixed-interval mode.
- A trailing clause such as `every 20m` or `every 5 minutes` is fixed-interval mode.
- Without an interval, use dynamic mode and choose the next wakeup based on observable progress or elapsed time.
- If a fixed interval does not map cleanly to cron, round to the nearest practical cadence and state the rounding.

## Fixed-Interval Mode

1. Run the parsed prompt immediately; do not wait for the first scheduled fire.
2. Convert the interval to a cron expression.
3. Create a recurring session schedule with `CronCreate`.
4. Tell the user the cadence, cron expression, seven-day auto-expiration, and cancellation identifier.
5. Do not push or publish anything unless the prompt explicitly asks for it.

Intervals under one hour use minute granularity. Hour and day intervals use the nearest valid hourly or daily cron expression. Recurring schedules are session-only and expire after seven days.

## Dynamic Mode

1. Run the prompt immediately.
2. If progress depends on a file, process, CI job, deploy, log line, or PR event, arm a persistent monitor when available.
3. Report what was done and whether a monitor is the primary wake signal.
4. Schedule a fallback wakeup, normally 20–30 minutes for idle work, or sooner when the observed task needs it.
5. On each iteration, reassess progress rather than blindly repeating the same action.

## Safety and Completion

- Honor explicit exit conditions exactly; never invent an earlier completion condition.
- Do not claim success without checking the requested outcome.
- Cover failure and terminal states when monitoring commands.
- Stop the dynamic loop with `ScheduleWakeup({ stop: true })` when the task is complete or the user asks to stop, and stop any monitor armed for it.
- Never use a loop to repeatedly perform destructive or externally visible actions without explicit authorization for each requested workflow.

## Common Examples

- `/loop 5m check the deploy` — fixed five-minute polling.
- `/loop every 20 minutes run the smoke tests` — fixed recurring tests.
- `/loop monitor the build` — immediate run plus dynamic monitoring and fallback wakeups.
