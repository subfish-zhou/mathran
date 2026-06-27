import { describe, expect, it } from "vitest";
import { searchMathOverflow, moKeywords } from "./mathoverflow-search.js";

const problem = { title: "Lonely Runner Conjecture", tags: ["combinatorics"] };

function mockApi(
  questions: unknown[],
  answers: unknown[],
): (url: string) => Promise<unknown> {
  return async (url: string) => {
    if (url.includes("/search/advanced")) return { items: questions };
    if (url.includes("/answers")) return { items: answers };
    return { items: [] };
  };
}

describe("moKeywords", () => {
  it("strips stopwords and short tokens", () => {
    const kw = moKeywords(problem);
    expect(kw).toContain("lonely");
    expect(kw).toContain("runner");
    expect(kw).not.toContain("the");
    expect(kw).not.toContain("conjecture");
  });
});

describe("searchMathOverflow", () => {
  it("keeps only answers with score >= minAnswerScore and sorts by score", async () => {
    const questions = [
      { question_id: 1, title: "Status of the Lonely Runner Conjecture", score: 40, link: "https://mathoverflow.net/q/1" },
      { question_id: 2, title: "A small lonely runner question", score: 5, link: "https://mathoverflow.net/q/2" },
    ];
    const answers = [
      { answer_id: 11, question_id: 1, score: 80, body_markdown: "Here is a long survey-quality answer about the conjecture.", owner: { display_name: "Expert" } },
      { answer_id: 22, question_id: 2, score: 10, body_markdown: "short", owner: { display_name: "Nobody" } },
    ];
    const hits = await searchMathOverflow(problem, { apiFetch: mockApi(questions, answers), rateDelayMs: 0 });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.score).toBe(80);
    expect(hits[0]!.answerAuthor).toBe("Expert");
    expect(hits[0]!.source).toBe("mathoverflow");
    expect(hits[0]!.questionScore).toBe(40);
    expect(hits[0]!.matchedKeywords).toContain("lonely");
  });

  it("keeps the highest-scoring qualifying answer per question and truncates excerpt", async () => {
    const longBody = "x".repeat(800);
    const questions = [{ question_id: 5, title: "Lonely runner overview", score: 30, link: "https://mathoverflow.net/q/5" }];
    const answers = [
      { answer_id: 1, question_id: 5, score: 60, body_markdown: longBody },
      { answer_id: 2, question_id: 5, score: 90, body_markdown: "best " + longBody },
    ];
    const hits = await searchMathOverflow(problem, { apiFetch: mockApi(questions, answers), rateDelayMs: 0 });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.score).toBe(90);
    expect(hits[0]!.answerExcerpt.length).toBeLessThanOrEqual(500);
  });

  it("returns [] when no questions found", async () => {
    const hits = await searchMathOverflow(problem, { apiFetch: mockApi([], []), rateDelayMs: 0 });
    expect(hits).toEqual([]);
  });

  it("is failure-isolated when the API throws", async () => {
    const hits = await searchMathOverflow(problem, {
      apiFetch: async () => {
        throw new Error("API down");
      },
      rateDelayMs: 0,
    });
    expect(hits).toEqual([]);
  });

  it("respects maxHits", async () => {
    const questions = Array.from({ length: 5 }, (_, i) => ({
      question_id: i + 1,
      title: `Lonely runner topic ${i}`,
      score: 10,
      link: `https://mathoverflow.net/q/${i + 1}`,
    }));
    const answers = questions.map((q, i) => ({
      answer_id: 100 + i,
      question_id: q.question_id,
      score: 50 + i,
      body_markdown: "survey",
    }));
    const hits = await searchMathOverflow(problem, { apiFetch: mockApi(questions, answers), rateDelayMs: 0 }, { maxHits: 2 });
    expect(hits).toHaveLength(2);
  });
});
