# mathran

> Standalone agent runtime for mathematical reasoning + Lean theorem proving.

Mathran is a CLI-driven agent that drives an LLM through structured loops to
attempt formal proofs in Lean 4. It is extracted from the [Mathub](https://github.com/subfish-zhou/Mathub)
research platform as a reusable building block — bring your own LLM key, your
own Lean toolchain, and run it locally.

> **Status: v0.1.0-alpha** — early skeleton. The CLI shell, build system, and
> agent loop are in place but the agent runtime depends on stubbed
> Mathub-platform bindings (storage / workspace / logging). The provider-impl
> phase (D2) lights up actual execution. **Not yet usable for real proofs.**

## Install

```bash
# Once published:
npm install -g mathran

# For development:
git clone https://github.com/subfish-zhou/mathran
cd mathran
npm install
npm run build
```

## Quick start

```bash
# Check your environment
mathran doctor

# Set up at least one LLM provider
export AZURE_OPENAI_API_KEY=...
export AZURE_OPENAI_ENDPOINT=https://...

# Prove a theorem
mathran prove path/to/theorem.lean -o ./out
```

## Prerequisites

- Node ≥ 20
- A Lean 4 toolchain installed via `elan` (`elan`, `lake`, `lean` on PATH)
- One of: Azure OpenAI, OpenAI, or Anthropic API key

## CLI

```
mathran prove <file>          Prove a single .lean file
mathran doctor                Environment health check
mathran --version             Print version
mathran --help                Show help
```

## Architecture

Mathran provides four provider interfaces under `src/core/`:

- **LeanProvider** — shells out to local elan/lake/lean
- **LLMProvider** — LLM completion + streaming (Azure / OpenAI / Anthropic built-in)
- **Storage** — agent run state, scratchpad, memory (sqlite by default)
- **ArtifactSink** — writes markdown / lean / logs to disk

The agent loop (`src/lib/agent/executor.ts`) is platform-agnostic and consumes
these interfaces. You can swap any provider via env variables or programmatic
configuration.

## Status

| Phase | Status |
|-------|--------|
| A — Skeleton from Mathub | ✓ |
| B — Provider interfaces  | ✓ |
| C — CLI scaffolding      | ✓ |
| D — Type system passes   | ✓ |
| D2 — Real provider impls | ⏳ in progress |
| E — npm publish          | ⏳ |

## License

MIT © subfish-zhou

## Acknowledgements

This codebase is extracted from [Mathub](https://github.com/subfish-zhou/Mathub),
a research platform for AI-assisted mathematics being built at MSRA.
