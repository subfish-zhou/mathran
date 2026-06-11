/**
 * Trigger — hook called when a researcher is verified.
 * Kicks off the initial paper import in the background.
 */

import { initialImport } from "./sync";
import { log } from "@/lib/observability/logger";

/**
 * Called after a researcher is verified. Starts the paper import
 * process asynchronously (does not block the caller).
 */
export function onResearcherVerified(userId: string): void {
  // Fire-and-forget — errors are logged inside initialImport
  initialImport(userId).then((result) => {
    log.info("agent.papers.onResearcherVerified_done", {
      userId,
      imported: result.imported,
      analyzed: result.analyzed,
      knowledge: result.knowledgeEntries,
      skills: result.skillsUpserted,
    });
  }).catch((err) => {
    log.error("agent.papers.onResearcherVerified_failed", err, { userId });
  });
}
