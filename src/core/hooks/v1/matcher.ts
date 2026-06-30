/**
 * Hooks v1 matcher syntax — same shape as Claude Code's.
 *
 *   - `undefined` / `""` / `"*"` → matches any input (universal)
 *   - exact word (`[A-Za-z0-9_]+`) → strict equality
 *   - pipe-joined exacts (`A|B|C`) → equality against any alternative
 *   - anything else → JS regex against the input
 *
 * Regex compilation failures fall through to a *literal* substring check so a
 * malformed pattern never crashes the dispatcher — it just won't match.
 *
 * `matchAny(matcher, inputs)` short-circuits on the first matching input,
 * which is what makes the alias table efficient: a hook with matcher
 * `"Write"` is checked once against `["write_file", "Write"]` and matches on
 * the second probe.
 */

const EXACT_RE = /^[A-Za-z0-9_]+(?:\|[A-Za-z0-9_]+)*$/u;

/** True when the matcher omits selection entirely (`*` / `""` / undefined). */
export function isUniversal(matcher: string | undefined): boolean {
  if (matcher === undefined) return true;
  return matcher === "" || matcher === "*";
}

/** True when the matcher is pure equality (`Bash` / `Write|Edit`). */
export function isExact(matcher: string): boolean {
  return EXACT_RE.test(matcher);
}

/** True when `matcher` (any syntax) matches `input` (one tool / alias name). */
export function matchOne(matcher: string | undefined, input: string): boolean {
  if (isUniversal(matcher)) return true;
  // exact / pipe-joined
  if (isExact(matcher!)) {
    return matcher!.split("|").some((c) => c === input);
  }
  // regex
  try {
    return new RegExp(matcher!).test(input);
  } catch {
    // fall back to substring on broken regex so we never throw
    return input.includes(matcher!);
  }
}

/** True when `matcher` matches ANY of the supplied inputs. */
export function matchAny(
  matcher: string | undefined,
  inputs: ReadonlyArray<string>,
): boolean {
  if (isUniversal(matcher)) return true;
  for (const input of inputs) {
    if (matchOne(matcher, input)) return true;
  }
  return false;
}
