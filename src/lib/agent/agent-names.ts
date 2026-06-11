/**
 * Agent nickname pool source. Names are chosen for memorability + flavor; no
 * real-person, mythological, or politically charged names. Mathub theme is a
 * mix of Frieren-style fantasy + AI-research lab nicknames.
 *
 * Inspired by codex `~/code/codex/codex-rs/core/src/agent/agent_names.txt`,
 * but a Mathub-curated subset so display strings stay short and culturally
 * neutral for our user base.
 *
 * The order matters: the nickname pool walks the list head-to-tail, so the
 * most "iconic" Mathub character names come first.
 *
 * Ported: 2026-06-10 (commit 4/6 of mathub-ai-codex-upgrade).
 */

export const AGENT_NAMES: readonly string[] = [
  // Mathub canonical agent crew
  "Frieren",
  "Fern",
  "Stark",
  "Heiter",
  "Eisen",
  "Himmel",
  "Aura",
  "Linie",
  "Lugner",
  "Sense",
  "Wirbel",
  "Yachiyo",
  "Iroha",
  "Noi",
  "Kaguya",
  "Haruka",
  // Color / element themed (fallback bench)
  "Aoi",
  "Akari",
  "Hikari",
  "Sora",
  "Hoshi",
  "Tsuki",
  "Kaze",
  "Mizu",
  "Hana",
  "Yuki",
  "Sakura",
  "Kumo",
  "Ame",
  "Nagi",
  // Generic fantasy bench
  "Aria",
  "Lyra",
  "Nova",
  "Echo",
  "Vega",
  "Orion",
  "Selene",
  "Astra",
  "Iris",
  "Kira",
  "Mira",
  "Rin",
  "Sage",
  "Sol",
  "Talia",
  "Vesper",
  "Wren",
  "Zara",
  "Zen",
];
