/**
 * Built-in `user_profile_read` tool (user-distillation Phase 1).
 *
 * READ-ONLY surface over `~/.mathran/profile/`. Lets the model query
 * what the user has authored / cited / is working on, so chat
 * responses can reference the user's own work accurately ("your 2024
 * arXiv paper on …") instead of generic small talk.
 *
 * There is intentionally NO `user_profile_write` model tool — all
 * profile mutations happen via the SPA (user-driven) or, in later
 * phases, via an ask_user gated approval flow with mandatory
 * evidence. See _tasks/user-distillation/PLAN.md design principle #2
 * ("Writes always ask before commit").
 *
 * 2026-06-26.
 */

import type { ToolSpec } from "../session.js";
import {
  readCitedPapers,
  readOwnPapers,
  readProjects,
  readSnapshot,
} from "../../profile/index.js";

export interface UserProfileReadToolOptions {
  /**
   * Override the profile dir (test seam). When omitted the store
   * defaults to `~/.mathran/profile/`.
   */
  profileDir?: string;
  /** Hard cap on returned JSON bytes (default 4 KiB). */
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 4 * 1024;

type Slice = "papers-own" | "papers-cited" | "projects" | "all";
const SLICES: Slice[] = ["papers-own", "papers-cited", "projects", "all"];

export function createUserProfileReadTool(
  opts: UserProfileReadToolOptions = {},
): ToolSpec {
  const profileDir = opts.profileDir;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  return {
    name: "user_profile_read",
    riskClass: "read",
    readOnly: true,
    description:
      "Read the user's research profile (papers they've authored / cited as " +
      "important, active projects, taste notes). USE THIS LIBERALLY when the " +
      "conversation touches the user's own work or their current research " +
      "direction — your default 'mathematician interlocutor' should know " +
      "what the user does. Slices:\n" +
      "  - 'papers-own'    : the user's own papers (author/coauthor/advisor)\n" +
      "  - 'papers-cited'  : papers they've tagged as important / cite-worthy\n" +
      "  - 'projects'      : active research projects they've described\n" +
      "  - 'all'           : everything in one shot (default)\n" +
      "Returns JSON. The profile is user-authored — treat as ground truth, " +
      "not inference. If the profile is empty, gracefully note that the user " +
      "hasn't populated it yet — do NOT make assumptions to fill it in.",
    parameters: {
      type: "object",
      properties: {
        slice: {
          type: "string",
          enum: SLICES,
          description:
            "Which slice to return (default 'all'). Prefer a narrow slice " +
            "when you only need one kind of entry — keeps your context tight.",
        },
      },
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>) {
      const sliceArg =
        typeof args.slice === "string" && (SLICES as string[]).includes(args.slice)
          ? (args.slice as Slice)
          : "all";

      try {
        let payload: unknown;
        switch (sliceArg) {
          case "papers-own":
            payload = { papersOwn: await readOwnPapers(profileDir) };
            break;
          case "papers-cited":
            payload = { papersCited: await readCitedPapers(profileDir) };
            break;
          case "projects":
            payload = { projects: await readProjects(profileDir) };
            break;
          case "all":
          default:
            payload = await readSnapshot(profileDir);
            break;
        }
        const json = JSON.stringify(payload, null, 2);
        if (Buffer.byteLength(json, "utf-8") > maxBytes) {
          // Truncated payload still lets the model see the shape +
          // most-recent rows; full data is one HTTP fetch away from
          // the SPA if the model really needs it.
          const truncated = Buffer.from(json, "utf-8")
            .subarray(0, maxBytes)
            .toString("utf-8");
          return {
            ok: true,
            content:
              `${truncated}\n\n[... truncated at ${maxBytes} bytes; ` +
              `request a narrower 'slice' to see the rest]`,
          };
        }
        return { ok: true, content: json };
      } catch (err: any) {
        return {
          ok: false,
          content: `user_profile_read error: ${err?.message ?? String(err)}`,
        };
      }
    },
  };
}
