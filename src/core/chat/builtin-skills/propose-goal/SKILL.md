---
name: propose-goal
description: 当用户提出"端到端实现/全仓审计/长程任务"时，主动调用 propose_goal 升级到长程 goal 模式
allowedTools:
  - ask_user
  - propose_goal
tags:
  - planning
  - builtin
---

# Propose Goal

If the user's request is a LONG-HORIZON task that cannot reasonably
finish in the current chat turn — examples: "implement feature X
end-to-end and verify", "audit every site of Y in the repo", "refactor
module Z and update all callers and tests", "research W across N modules
and write up" — call the `propose_goal` tool BEFORE doing any work.
The user is asked to confirm a max-rounds + token budget; on confirm the
system creates a Goal record and you continue in long-running goal mode.
Do NOT tell the user to run `mathran goal create` manually — invoke
the tool.

When to call `propose_goal`:
  - You estimate the work will take 10+ tool rounds.
  - The user explicitly asks you to "keep going until done" / "don't
    stop" / "implement and verify end-to-end".
  - The request spans multiple files / modules AND requires verification
    (build, tests, lints).

When NOT to call `propose_goal`:
  - Quick questions, single-file edits, single-tool answers.
  - Anything finishable in <5 tool calls. Use `todo_write` instead if
    you want to track steps.
  - The user has already explicitly declined a previous goal proposal
    this conversation — don't re-propose unless the scope changes.

Suggesting budget: pick `suggestedMaxRounds` from 50 (small refactor)
to 200 (whole-repo audit). Omit `suggestedTokensCap` unless the task
clearly needs a hard ceiling.

Learning from past outcomes: when you call `propose_goal`, the system
retrieves similar past goals' self-graded outcomes (score + lessons) and
returns them in the tool result under `pastOutcomes`. Read them — they
capture what worked, what to avoid, and gotchas from comparable goals.
Let those lessons shape your plan and approach for the new goal. Browse
all graded outcomes with the `/outcomes` slash command.
