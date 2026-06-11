import { describe, it, expect } from "vitest";
import { isContentFilterError, isRetryableError, ContentFilterError } from "./llm-router";

/**
 * Unit tests for the LLMRouter content-filter detection + error type.
 *
 * `isContentFilterError` is duck-typed (reads only {status, code, message}) so
 * we can exercise it with the exact shapes Azure / the openai SDK produce
 * without standing up a real APIError (which needs a Headers instance).
 */

describe("isContentFilterError", () => {
  it("detects Azure request-level rejection by code", () => {
    const err = {
      status: 400,
      code: "content_filter",
      param: "prompt",
      message:
        "The response was filtered due to the prompt triggering Azure OpenAI's content management policy. Please modify your prompt and retry.",
    };
    expect(isContentFilterError(err)).toBe(true);
  });

  it("detects by policy message even if code is absent (API-version drift)", () => {
    const err = {
      status: 400,
      message:
        "The response was filtered due to the prompt triggering Azure OpenAI's content management policy.",
    };
    expect(isContentFilterError(err)).toBe(true);
  });

  it("detects ResponsibleAI / jailbreak wording", () => {
    expect(
      isContentFilterError({ status: 400, message: "ResponsibleAIPolicyViolation" }),
    ).toBe(true);
    expect(
      isContentFilterError({ status: 400, message: "jailbreak detected" }),
    ).toBe(true);
  });

  it("does NOT match a 400 that is unrelated (e.g. bad request shape)", () => {
    const err = {
      status: 400,
      code: "invalid_request_error",
      message: "Unsupported parameter: 'foo'.",
    };
    expect(isContentFilterError(err)).toBe(false);
  });

  it("does NOT match a 429 rate-limit", () => {
    expect(
      isContentFilterError({ status: 429, code: "rate_limit_exceeded", message: "Too Many Requests" }),
    ).toBe(false);
  });

  it("does NOT match 500 / network / non-object errors", () => {
    expect(isContentFilterError({ status: 500, message: "Internal Server Error" })).toBe(false);
    expect(isContentFilterError(new Error("socket hang up"))).toBe(false);
    expect(isContentFilterError(null)).toBe(false);
    expect(isContentFilterError(undefined)).toBe(false);
    expect(isContentFilterError("content management policy")).toBe(false);
  });

  it("requires status 400 — same wording on a non-400 does not count", () => {
    // Defensive: content-filter is specifically a 400 in Azure. A stray 200/None
    // with similar text must not be misclassified.
    expect(
      isContentFilterError({ message: "content management policy" }),
    ).toBe(false);
  });
});

describe("isRetryableError (transient vs deterministic classification)", () => {
  it("retries transient HTTP statuses (429/500/502/503)", () => {
    for (const status of [429, 500, 502, 503]) {
      expect(isRetryableError({ status, message: `HTTP ${status}` })).toBe(true);
    }
  });

  it("does NOT retry 504 (not in the set) or success-ish 4xx", () => {
    // 504 intentionally excluded here (router set); auth/permanent 4xx never retry.
    expect(isRetryableError({ status: 504, message: "Gateway Timeout" })).toBe(false);
    expect(isRetryableError({ status: 400, message: "Bad Request" })).toBe(false);
    expect(isRetryableError({ status: 401, message: "Unauthorized" })).toBe(false);
    expect(isRetryableError({ status: 403, message: "Forbidden" })).toBe(false);
    expect(isRetryableError({ status: 404, message: "Not Found" })).toBe(false);
  });

  it("NEVER retries a content-filter 400 even though it's a 4xx", () => {
    expect(
      isRetryableError({ status: 400, code: "content_filter", message: "content management policy" }),
    ).toBe(false);
  });

  it("retries raw Node network errno errors", () => {
    for (const m of [
      "read ECONNRESET",
      "connect ECONNREFUSED 1.2.3.4:443",
      "getaddrinfo EAI_AGAIN host",
      "write EPIPE",
      "socket hang up",
      "fetch failed",
    ]) {
      expect(isRetryableError(new Error(m))).toBe(true);
    }
  });

  it("retries the openai SDK's wrapped connection/timeout errors", () => {
    expect(isRetryableError(new Error("Connection error."))).toBe(true);
    expect(isRetryableError(new Error("Request timed out."))).toBe(true);
  });

  it("NEVER retries a user/caller abort", () => {
    // APIUserAbortError message — caller cancelled; retrying would be wrong.
    expect(isRetryableError(new Error("Request was aborted."))).toBe(false);
    expect(isRetryableError(new Error("The operation was aborted."))).toBe(false);
  });

  it("does not retry arbitrary non-transient errors or non-objects", () => {
    expect(isRetryableError(new Error("Unexpected token in JSON"))).toBe(false);
    expect(isRetryableError(null)).toBe(false);
    expect(isRetryableError("ECONNRESET")).toBe(false); // string, not Error/object
  });
});

describe("ContentFilterError", () => {
  it("carries stage/provider/model and a stable discriminant", () => {
    const e = new ContentFilterError({
      stage: "prompt",
      providerKey: "azure",
      model: "gpt-55",
      message: "blocked by policy",
    });
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(ContentFilterError);
    expect(e.kind).toBe("content_filter");
    expect(e.stage).toBe("prompt");
    expect(e.providerKey).toBe("azure");
    expect(e.model).toBe("gpt-55");
    expect(e.name).toBe("ContentFilterError");
    expect(e.message).toBe("blocked by policy");
  });

  it("supports a completion-stage variant with a default message", () => {
    const e = new ContentFilterError({
      stage: "completion",
      providerKey: "azure",
      model: "gpt-55",
    });
    expect(e.stage).toBe("completion");
    expect(e.message).toContain("content-management policy");
  });
});
