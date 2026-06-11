/**
 * W4-v2 path-1 helper: map service-layer domain errors to legacy-shape
 * {@link ToolResult} failures with displayText wording the LLM has been
 * observing pre-migration.
 *
 * `defaults` lets each tool supply friendly messages; if the matched error
 * doesn't have a default, the raw error message is used (mirrors legacy
 * fall-through behaviour).
 *
 * Unknown errors are logged via the structured observability logger and
 * returned as a generic internal-error ToolResult so the executor's
 * external envelope stays consistent. (W6: classification is also logged
 * at info-level for expected outcomes so tool-error stats can be derived.)
 */

// TODO(mathran-v0.1): import { log } from "@/lib/observability/logger";
// TODO(mathran-v0.1): import { getCurrentPrincipal, getTraceId } from "@/lib/observability/trace";
import { PrincipalAuthError } from "@/server/agent-gateway/principal";
import {
  ResourceForbiddenError,
  ResourceNotFoundError,
} from "@/server/agent-gateway/resource-access";
import { SearchQueryError } from "@/server/agent-gateway/services/_common";
import type { ToolResult } from "../types";

function principalSummary() {
  const p = getCurrentPrincipal();
  if (!p) return undefined;
  if (p.type === "user") return { type: "user", id: p.userId };
  if (p.type === "bot") return { type: "bot", id: p.botId };
  return { type: "assistant-builtin", id: `${p.assistantSlug}:${p.conversationId}` };
}

export function serviceErrorToToolResult(
  e: unknown,
  defaults: {
    notFound?: string;
    forbidden?: string;
    unauthorized?: string;
    badInput?: string;
    internal?: string;
  } = {},
): ToolResult {
  const meta = { traceId: getTraceId() || undefined, principal: principalSummary() };
  if (e instanceof ResourceNotFoundError) {
    log.info("tool.error", { ...meta, kind: "not_found" });
    return { success: false, data: null, displayText: defaults.notFound ?? e.message };
  }
  if (e instanceof ResourceForbiddenError) {
    log.info("tool.error", { ...meta, kind: "forbidden" });
    return {
      success: false,
      data: null,
      displayText: defaults.forbidden ?? "You don't have access to this resource.",
    };
  }
  if (e instanceof PrincipalAuthError) {
    log.info("tool.error", { ...meta, kind: "auth" });
    return {
      success: false,
      data: null,
      displayText: defaults.unauthorized ?? "Sign-in required.",
    };
  }
  if (e instanceof SearchQueryError) {
    log.info("tool.error", { ...meta, kind: "bad_input" });
    return { success: false, data: null, displayText: defaults.badInput ?? e.message };
  }
  log.error("tool.error", e, { ...meta, kind: "internal" });
  return { success: false, data: null, displayText: defaults.internal ?? "Internal error" };
}

/** Standard "user principal not resolvable" tool result. */
export function noPrincipalToolResult(): ToolResult {
  return { success: false, data: null, displayText: "Sign-in required." };
}
