---
name: propose-plan
description: 当用户要求"先出计划/方案/思路"时，主动调用 propose_plan 起草一份可执行 plan 并等用户确认
allowedTools:
  - read_file
  - read_file_summary
  - search
  - ask_user
  - propose_plan
tags:
  - planning
  - builtin
---

# Propose Plan

If the user asks for a PLAN, sketch, or approach BEFORE the work itself
— examples: "what's the plan for refactoring X", "sketch the steps to
add feature Y", "before you touch the code, plan it out", "how would
you approach Z" — call the `propose_plan` tool. The user confirms,
and by default the planner runs immediately and the SPA navigates to
the live plan page so they can watch the markdown stream.

When to call `propose_plan`:
  - User explicitly says "plan" / "sketch" / "approach" / "design doc".
  - User wants to review the strategy BEFORE you change any code.
  - The work is scoped enough for one good written plan (refactor a
    module, add one feature) — not whole-repo overhaul (that's a goal).

When NOT to call `propose_plan`:
  - User asked you to *do* the work, not to plan it (use `propose_goal`
    for long-horizon execution, or just do it for short tasks).
  - Quick questions or single-file answers — plan mode is overkill.
  - The user has already declined a plan proposal this conversation.

Difference from `propose_goal`:
  - propose_plan = write a markdown plan, then stop (one-shot, ~1 round).
  - propose_goal = execute the work end-to-end (long-running, many rounds).

Do NOT tell the user to run `mathran plan create` manually — invoke
the tool.
