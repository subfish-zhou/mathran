import { describe, expect, it } from "vitest";

import { parseLLMResponse, mapToFormalizedProblem } from "./parser.js";

describe("parseLLMResponse", () => {
  it("parses a SINGLE response (nested problem object)", () => {
    const reply = JSON.stringify({
      status: "single",
      problem: {
        title: "Twin Prime Conjecture",
        formalStatement: "There are infinitely many primes p with p+2 prime.",
        description: "A classic open problem.",
        background: "Studied since antiquity; Zhang 2014 bounded gaps.",
        tags: ["Analytic Number Theory", "Sieve Theory"],
        mscCodes: ["11N05"],
        mathStatus: "OPEN",
      },
    });
    const out = parseLLMResponse(reply);
    expect(out.status).toBe("single");
    expect(out.problem?.title).toBe("Twin Prime Conjecture");
    expect(out.problem?.tags).toContain("Sieve Theory");
    expect(out.problem?.mathStatus).toBe("OPEN");
  });

  it("handles legacy JSON with math_status (and flat fields) at top level", () => {
    // mathub quirk: single-problem fields live at the TOP LEVEL, snake_case,
    // with `math_status` rather than a nested `problem` object.
    const reply = `Here you go:
\`\`\`json
{
  "status": "single",
  "title": "Binary Goldbach Conjecture",
  "formal_statement": "Every even n > 2 is a sum of two primes.",
  "description": "Posed 1742.",
  "background_summary": "Chen (1+2), 1966.",
  "tags": ["Analytic Number Theory"],
  "math_status": "open"
}
\`\`\`
`;
    const out = parseLLMResponse(reply);
    expect(out.status).toBe("single");
    expect(out.problem?.title).toBe("Binary Goldbach Conjecture");
    expect(out.problem?.formalStatement).toMatch(/two primes/);
    expect(out.problem?.background).toMatch(/Chen/);
    expect(out.problem?.mathStatus).toBe("OPEN");
  });

  it("parses a MULTIPLE response into candidates", () => {
    const reply = JSON.stringify({
      status: "multiple",
      candidates: [
        { title: "Strong Goldbach", description: "even = p+p", why: "default reading" },
        { title: "Weak Goldbach", description: "odd = p+p+p", why: "Helfgott 2013" },
      ],
    });
    const out = parseLLMResponse(reply);
    expect(out.status).toBe("multiple");
    expect(out.candidates).toHaveLength(2);
    expect(out.candidates?.[0]?.title).toBe("Strong Goldbach");
  });

  it("parses an INSUFFICIENT response into suggestions", () => {
    const reply = JSON.stringify({
      status: "insufficient",
      suggestions: ["Which field?", "Name a specific conjecture."],
    });
    const out = parseLLMResponse(reply);
    expect(out.status).toBe("insufficient");
    expect(out.suggestions).toHaveLength(2);
  });

  it("routes a leftover program status to insufficient", () => {
    const reply = JSON.stringify({ status: "program", suggestions: ["pick a sub-problem"] });
    const out = parseLLMResponse(reply);
    expect(out.status).toBe("insufficient");
  });

  it("throws when no JSON can be extracted", () => {
    expect(() => parseLLMResponse("no json here")).toThrow();
  });
});

describe("mapToFormalizedProblem", () => {
  it("falls back to top-level math_status when nested object omits it", () => {
    const nested = { title: "X", formalStatement: "s" };
    const root = { ...nested, math_status: "PARTIALLY_SOLVED" };
    const p = mapToFormalizedProblem(nested, root);
    expect(p.mathStatus).toBe("PARTIALLY_SOLVED");
  });
});
