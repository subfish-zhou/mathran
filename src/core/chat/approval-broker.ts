/**
 * Approval broker (Approval Policy 矩阵).
 *
 * The {@link ChatSession} holds one broker per session. For every high-risk
 * tool call the broker decides — in strict precedence order — whether the call
 * runs silently, runs after the user approves, or is denied:
 *
 *   1. Denylist veto (highest priority — overrides any allow rule).
 *   2. Standing rules (session-scoped + inline settings + on-disk files):
 *      an `allow` short-circuits the prompt; a `deny` blocks.
 *   3. The policy matrix (`evaluatePolicy`): `pass` runs, `ask` prompts the
 *      user via the host {@link ApprovalResolver}, `ask-on-failure` defers.
 *
 * On a user `allow_session` / `allow_prefix` decision the broker records a
 * session rule so the same call is auto-approved for the rest of the session.
 * Learning mode (`ApprovalHistory`) tracks repeated decisions and, after a
 * threshold, proposes upgrading them to a standing rule.
 *
 * The broker is host-agnostic: the CLI injects a readline resolver, serve a
 * throw-to-escape resolver, and one-shot / goal hosts inject NONE — in which
 * case any `ask` fails safe to a deny (no silent execution).
 */

import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { evaluatePolicy, isSuspiciousCommand } from "../approval/policy.js";
import type { PolicyContext } from "../approval/policy.js";
import {
  matchDenylist,
  matchRules,
  loadRulesFile,
  appendRule,
} from "../approval/rules.js";
import type { Rule, DenylistEntry } from "../approval/rules.js";
import { derivePrefix, ApprovalHistory } from "../approval/history.js";
import type {
  ApprovalPolicy,
  ApprovalRequest,
  ApprovalDecision,
  ApprovalResolver,
  RiskClass,
  RuleProposalResolver,
} from "../approval/types.js";

/** A tool call the broker evaluates. */
export interface ApprovalCall {
  tool: string;
  riskClass: RiskClass;
  args: Record<string, unknown>;
  rationale?: string;
  /**
   * Stable id for the resulting {@link ApprovalRequest}. The session passes the
   * provider tool-call id so a serve resume can correlate the decision. When
   * omitted, a random uuid is generated.
   */
  id?: string;
}

/** The broker's verdict for the pre-execution phase. */
export type AuthorizeResult =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "defer-on-failure" };

/**
 * Result of {@link ApprovalBroker.preCheck}: either a terminal verdict, or an
 * `ask` carrying the {@link ApprovalRequest} the host must surface.
 */
export type PreCheckResult =
  | AuthorizeResult
  | { kind: "ask"; request: ApprovalRequest };

/** The broker's verdict for the post-failure phase (`on-failure` policy). */
export type FailureResult =
  | { kind: "retry" }
  | { kind: "abandon"; reason: string };

export interface ApprovalBrokerOptions {
  /** Active policy. */
  policy: ApprovalPolicy;
  /** Workspace root for path-escape detection. */
  workspace?: string;
  /** Learning mode on/off (default true). */
  learning?: boolean;
  /** Consecutive-decision threshold before proposing a rule (default 5). */
  proposeAfter?: number;
  /** Inline rules from settings.json (lowest precedence). */
  inlineRules?: Rule[];
  /** Denylist entries (highest priority). */
  denylist?: DenylistEntry[];
  /**
   * Absolute paths of `approval-rules.json` files, highest precedence first
   * (e.g. workspace then user). Read fresh on each authorize so external edits
   * take effect immediately.
   */
  rulesFiles?: string[];
  /** Learning-mode history store (omit to disable persistence). */
  history?: ApprovalHistory;
  /** Host UI for an approval prompt. Absent → `ask` fails safe to deny. */
  resolver?: ApprovalResolver;
  /** Host UI for a learning-mode rule-upgrade prompt. */
  proposalResolver?: RuleProposalResolver;
  /**
   * Where a learning-mode accepted proposal is persisted. When set, accepted
   * proposals append a persistent rule here; otherwise they become session
   * rules only.
   */
  persistentRuleFile?: string;
}

export class ApprovalBroker {
  private readonly policy: ApprovalPolicy;
  private readonly workspace?: string;
  private readonly learning: boolean;
  private readonly proposeAfter: number;
  private readonly inlineRules: Rule[];
  private readonly denylist: DenylistEntry[];
  private readonly rulesFiles: string[];
  private readonly history?: ApprovalHistory;
  private readonly resolver?: ApprovalResolver;
  private readonly proposalResolver?: RuleProposalResolver;
  private readonly persistentRuleFile?: string;
  /** Session-scoped rules accumulated from allow_session / allow_prefix. */
  private readonly sessionRules: Rule[] = [];

  constructor(opts: ApprovalBrokerOptions) {
    this.policy = opts.policy;
    this.workspace = opts.workspace;
    this.learning = opts.learning ?? true;
    this.proposeAfter = opts.proposeAfter ?? 5;
    this.inlineRules = opts.inlineRules ?? [];
    this.denylist = opts.denylist ?? [];
    this.rulesFiles = opts.rulesFiles ?? [];
    this.history = opts.history;
    this.resolver = opts.resolver;
    this.proposalResolver = opts.proposalResolver;
    this.persistentRuleFile = opts.persistentRuleFile;
  }

  /** The active policy (read-only accessor for hosts / tests). */
  get activePolicy(): ApprovalPolicy {
    return this.policy;
  }

  /** Expose the live session rules (read-only copy) for tests / inspection. */
  get sessionRulesSnapshot(): Rule[] {
    return [...this.sessionRules];
  }

  /** Merge all rule sources, highest precedence first. */
  private async allRules(): Promise<Rule[]> {
    const fileRules: Rule[] = [];
    for (const f of this.rulesFiles) {
      const loaded = await loadRulesFile(f);
      fileRules.push(...loaded.rules);
    }
    // Precedence: session > files > inline.
    return [...this.sessionRules, ...fileRules, ...this.inlineRules];
  }

  /** Build the policy context (path escape + suspicious command) for a call. */
  private buildPolicyContext(
    tool: string,
    args: Record<string, unknown>,
  ): PolicyContext {
    const command = typeof args.command === "string" ? args.command : "";
    const suspiciousCommand = command ? isSuspiciousCommand(command) : false;
    let pathEscapesWorkspace = false;
    if (this.workspace) {
      for (const key of ["path", "cwd"]) {
        const p = args[key];
        if (typeof p === "string" && p) {
          const abs = path.isAbsolute(p)
            ? p
            : path.resolve(this.workspace, p);
          const rel = path.relative(this.workspace, abs);
          if (rel.startsWith("..") || path.isAbsolute(rel)) {
            pathEscapesWorkspace = true;
          }
        }
      }
    }
    return { suspiciousCommand, pathEscapesWorkspace };
  }

  /** Build a human-readable preview for the approval UI. */
  private buildPreview(call: ApprovalCall): string {
    const { tool, args } = call;
    if (typeof args.command === "string") {
      const cwd = typeof args.cwd === "string" ? ` (cwd: ${args.cwd})` : "";
      return `${args.command}${cwd}`;
    }
    if (typeof args.path === "string") {
      const content =
        typeof args.content === "string"
          ? args.content
          : typeof args.new_string === "string"
            ? args.new_string
            : "";
      const snippet = content
        ? `\n  ${content.slice(0, 200).replace(/\n/g, "\n  ")}${content.length > 200 ? " …" : ""}`
        : "";
      return `${args.path}${snippet}`;
    }
    return `${tool}(${JSON.stringify(args).slice(0, 200)})`;
  }

  private buildRequest(
    call: ApprovalCall,
    trigger: ApprovalRequest["trigger"],
  ): ApprovalRequest {
    return {
      id: call.id ?? randomUUID(),
      tool: call.tool,
      riskClass: call.riskClass,
      trigger,
      preview: this.buildPreview(call),
      args: call.args,
      rationale: call.rationale,
    };
  }

  /**
   * Pre-execution authorization. Returns whether the call may run, must be
   * denied, deferred (run then ask on failure), or needs a user prompt.
   *
   * When the verdict is `ask`, the caller (ChatSession) is responsible for
   * surfacing `request` to the user and feeding the decision back through
   * {@link resolveDecision}. This split lets the session yield an
   * `approval_request` event around the (possibly long) user interaction —
   * which serve mode needs to keep its SSE stream alive.
   */
  async preCheck(call: ApprovalCall): Promise<PreCheckResult> {
    const { tool, riskClass, args } = call;

    // 1. Denylist veto.
    const denied = matchDenylist(this.denylist, tool, args);
    if (denied) {
      return { kind: "deny", reason: `blocked by denylist rule: ${denied}` };
    }

    // 2. Standing rules.
    const ruleAction = matchRules(await this.allRules(), tool, args);
    if (ruleAction === "deny") {
      return { kind: "deny", reason: `blocked by approval rule for ${tool}` };
    }
    if (ruleAction === "allow") {
      return { kind: "allow" };
    }

    // 3. Policy matrix.
    const context = this.buildPolicyContext(tool, args);
    const outcome = evaluatePolicy(this.policy, riskClass, context);
    if (outcome === "pass") return { kind: "allow" };
    if (outcome === "ask-on-failure") return { kind: "defer-on-failure" };

    // outcome === "ask" — a user prompt is required.
    const trigger: ApprovalRequest["trigger"] =
      this.policy === "untrusted" ? "untrusted" : "policy";
    return { kind: "ask", request: this.buildRequest(call, trigger) };
  }

  /**
   * Pre-execution authorization with the broker's own resolver driving the
   * prompt (used by the CLI host + tests). Falls back to a fail-safe deny when
   * a prompt is required but no resolver is wired.
   */
  async authorize(call: ApprovalCall): Promise<AuthorizeResult> {
    const pre = await this.preCheck(call);
    if (pre.kind !== "ask") return pre;
    if (!this.resolver) {
      return {
        kind: "deny",
        reason:
          "auto-denied: no approval resolver available (non-interactive host)",
      };
    }
    const decision = await this.resolver(pre.request);
    return this.resolveDecision(call, decision);
  }

  /**
   * Build the {@link ApprovalRequest} for the post-failure (`on-failure`)
   * retry prompt. The host surfaces it and feeds the decision to
   * {@link applyFailureDecision}.
   */
  buildFailureRequest(
    call: ApprovalCall,
    failureContent: string,
  ): ApprovalRequest {
    return this.buildRequest(
      { ...call, rationale: failureContent },
      "on-failure",
    );
  }

  /** Map a post-failure user decision to retry / abandon. */
  applyFailureDecision(decision: ApprovalDecision): FailureResult {
    if (decision.outcome === "retry") return { kind: "retry" };
    return {
      kind: "abandon",
      reason: decision.reason ?? "user abandoned after failure",
    };
  }

  /**
   * The post-failure phase for `on-failure` policy with the broker's own
   * resolver driving the prompt (CLI host + tests).
   */
  async onFailure(
    call: ApprovalCall,
    failureContent: string,
  ): Promise<FailureResult> {
    if (!this.resolver) {
      return {
        kind: "abandon",
        reason: "tool failed and no approval resolver is available to retry",
      };
    }
    const decision = await this.resolver(
      this.buildFailureRequest(call, failureContent),
    );
    return this.applyFailureDecision(decision);
  }

  /**
   * Translate a user decision (from a host prompt) into an
   * {@link AuthorizeResult} plus side effects (session rules, learning
   * history, rule proposals). Public so the session can drive the prompt
   * itself (serve) and feed the decision back.
   */
  async resolveDecision(
    call: ApprovalCall,
    decision: ApprovalDecision,
  ): Promise<AuthorizeResult> {
    return this.applyDecision(call, decision);
  }

  /** Translate a user decision into an {@link AuthorizeResult} + side effects. */
  private async applyDecision(
    call: ApprovalCall,
    decision: ApprovalDecision,
  ): Promise<AuthorizeResult> {
    const { tool, args } = call;
    if (decision.outcome === "deny") {
      await this.record(call, "deny");
      return {
        kind: "deny",
        reason: decision.reason ?? "user denied this tool call",
      };
    }

    // Any allow_* outcome permits this call.
    if (decision.outcome === "allow_session") {
      this.addSessionRule({ tool, action: "allow", scope: "session" });
    } else if (decision.outcome === "allow_prefix") {
      const prefix = decision.prefix ?? derivePrefix(tool, args);
      if (typeof args.path === "string" && !args.command) {
        this.addSessionRule({
          tool,
          pathGlob: prefix,
          action: "allow",
          scope: "session",
        });
      } else {
        this.addSessionRule({
          tool,
          prefix,
          action: "allow",
          scope: "session",
        });
      }
    }
    await this.record(call, "allow");
    return { kind: "allow" };
  }

  private addSessionRule(rule: Rule): void {
    const dup = this.sessionRules.some(
      (r) =>
        r.tool === rule.tool &&
        r.prefix === rule.prefix &&
        r.pathGlob === rule.pathGlob &&
        r.action === rule.action,
    );
    if (!dup) this.sessionRules.push(rule);
  }

  /**
   * Record the decision in learning history and, when the consecutive streak
   * crosses the threshold, offer to upgrade it to a standing rule.
   */
  private async record(
    call: ApprovalCall,
    outcome: "allow" | "deny",
  ): Promise<void> {
    if (!this.learning || !this.history) return;
    const prefix = derivePrefix(call.tool, call.args);
    const now = Date.now();
    const streak = await this.history.recordDecision(
      call.tool,
      prefix,
      outcome,
      now,
    );
    if (streak === null || streak < this.proposeAfter) return;
    if (!this.proposalResolver) return;
    const accepted = await this.proposalResolver({
      tool: call.tool,
      prefix,
      count: streak,
    });
    await this.history.recordProposal(call.tool, prefix, now);
    if (!accepted) return;
    // Promote to a rule. Persist when a target file is configured, else
    // session-scoped.
    const rule: Rule = {
      tool: call.tool,
      prefix,
      action: "allow",
      scope: this.persistentRuleFile ? "persistent" : "session",
    };
    if (this.persistentRuleFile) {
      await appendRule(this.persistentRuleFile, rule);
    } else {
      this.addSessionRule(rule);
    }
  }
}
