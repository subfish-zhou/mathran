/**
 * Builtins boot module — registers all builtin agents at import time.
 *
 * Pattern mirrors hooks/boot.ts: this file's side effect is the registration
 * of each builtin agent template into the registry. The executor / tools
 * import this module so the registry is populated before the first spawn.
 *
 * Ported: 2026-06-10 (commit 08/sprint-2 of mathub-ai-codex-upgrade).
 */

// Each import below has a side effect: it calls registerBuiltinAgent at
// module-load. Add new builtins by adding an import here.
import "./awaiter";
