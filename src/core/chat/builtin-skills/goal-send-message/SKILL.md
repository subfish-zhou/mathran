---
name: goal-send-message
description: 当用户想 steer 一个**已存在**的 goal（追问 / 调整方向 / 提醒新信息）时，主动调用 goal_send_message 把消息排进目标 goal 的下一轮 LLM 循环
allowedTools:
  - goal_send_message
tags:
  - planning
  - builtin
---

# Goal Send Message

If the user wants to nudge / steer / give new information / ask for a
status change to an **already-running (or recently failed) goal** —
examples: "tell the X goal to also verify Y", "make goal abc123 stop
once tests pass", "the build broke, let goal know to rerun npm
install", "ask the W goal to skip the deploy step" — call the
`goal_send_message` tool. The steer text is queued and consumed at the
target goal's next round-top probe (or kicks a fresh round if the goal
is idle / failed).

## When to call `goal_send_message`

- The user explicitly references an **existing goal** by id, URL
  (`/goal/<id>`), short name, or "the goal you just started".
- The user gives information that the running goal should know about —
  new constraints, a correction, a hint, a "stop after X" instruction.
- A goal is in `failed` status (e.g. infra outage, copilot token died)
  and the user wants to revive it with a steer that explains what
  changed and what to do next. `goal_send_message` automatically
  resurrects `failed`/`cancelled` goals before queueing the steer.
- The user wants to redirect a goal that's still running — e.g. "the
  goal is going down a wrong rabbit hole, tell it to back up and try
  approach Z instead."

## When NOT to call `goal_send_message`

- The user wants to start a **new** long-horizon task → use
  `propose_goal` (which creates a fresh Goal record).
- The user wants a one-shot plan/sketch → use `propose_plan`.
- The user is just chatting / asking a quick question → answer
  directly, don't queue a steer.
- The user explicitly says "kill the goal" / "cancel" → that's a
  different operation (cancel endpoint), not a steer.

## Difference from `propose_goal`

|                | `propose_goal`                       | `goal_send_message`                              |
|----------------|--------------------------------------|--------------------------------------------------|
| Target         | **New** goal (creates record)        | **Existing** goal (must already exist by id)     |
| User flow      | Confirmation modal → goal starts     | Steer is queued silently, no confirmation        |
| Effect on LLM  | Spawns a fresh long-running run      | Injected as `[Steer from user: …]` next round    |
| Failed handling| N/A (new goal)                       | Auto-resurrects `failed`/`cancelled` then queues |

If the user's intent is ambiguous ("start over with a fresh goal" vs
"keep the current one but redirect"), prefer `goal_send_message` only
when the existing goal id is clearly known and the user's wording
implies continuation. Otherwise ask, or propose a new goal.

## Required argument: `goalId`

The tool requires the **full UUID**, not a prefix. How to get it:

1. From a prior `propose_goal` tool-result in this same conversation
   (the `goalId` field).
2. From the user — they may paste it from the goal panel URL
   (`/goal/<full-uuid>`).
3. From the most recent goals if the user just said "the goal you
   started" — the tool's error message lists the 5 most recent goals
   when it can't find an id, use that to disambiguate with the user.

Do NOT try to "guess" a goalId from a partial prefix; let the tool's
error handler surface the candidates and ask the user to pick.

## Error handling

When `goal_send_message` returns `ok: false`, read the `content`
carefully — it usually carries a `Recent goals in this workspace:` list.
Present those to the user as a multiple-choice ("did you mean goal `abc…`
or `def…`?") and call the tool again with the correct id once they
choose.

If the error mentions "no attached conversation yet", the goal was
created but never run. Tell the user to start the first round (open the
goal panel and click Run, or call `/api/goals/<id>/run/stream`) before
steering — the conversation needs to exist for the steer to attach.

If the resurrect step itself fails (rare; usually a disk I/O issue),
fall back to the user-facing instructions in the error message
("edit the goal file by hand or use the goal panel to reset") —
don't loop the tool blindly.

## `kickIfIdle` — when to override the default

- Default `kickIfIdle=true` is right almost always: if the goal's
  stream is idle, the tool starts a fresh run so the steer takes
  effect immediately.
- Pass `kickIfIdle=false` only if the user explicitly says "queue
  this but don't restart" — e.g. they want to batch several steers
  before the next manual run.

## Examples

User: "tell goal abc12345-... to also verify the integration tests pass before mark_done"
→ Call `goal_send_message({goalId:"abc12345-...", message:"Before
  calling mark_done, also run the integration tests (cd packages/foo
  && npm run test:integration) and include the output in your final
  summary."})`.

User: "goal `9d3e…` failed — the copilot token expired. Refresh it and tell the goal to retry the build step."
→ Call `goal_send_message({goalId:"9d3e…", message:"Copilot token
  refreshed. Re-run the failed build step (npm run build in ~/mathran)
  and continue."})`. The tool will auto-resurrect the failed goal
  before queueing.

User: "the goal is going in circles on the type error in foo.ts — tell it to skip that file for now and finish the other tasks."
→ Call `goal_send_message` with the existing goalId and a steer text
  describing the redirection.

Do NOT call `goal_send_message` to chat with the user about the goal
— that's just regular chat. Only invoke it when there's an actual
steer/instruction to deliver into the goal's loop.
