/**
 * ArtifactSink contract — implementation-agnostic behavioural test suite.
 *
 * Any `ArtifactSink` implementation (LocalFsArtifactSink today; a host-side
 * MathubWikiSink in the future) can be validated against the same set of
 * expectations by calling `runArtifactSinkContract` from a `*.test.ts` file.
 * This realises PRD §6.2 EX4: one contract, many backends.
 *
 * The factory is invoked fresh for every test (via `beforeEach`) so each
 * case runs against a clean, isolated instance with no cross-talk.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { ArtifactSink } from "../artifact-sink.js";

export function runArtifactSinkContract(
  makeSink: () => Promise<ArtifactSink> | ArtifactSink,
  label: string,
): void {
  describe(`ArtifactSink contract: ${label}`, () => {
    let sink: ArtifactSink;

    beforeEach(async () => {
      sink = await makeSink();
    });

    it("describes itself", async () => {
      const d = await sink.describe();
      expect(typeof d.name).toBe("string");
      expect(d.name.length).toBeGreaterThan(0);
    });

    describe("createPage", () => {
      it("returns an id and a slug derived from the title", async () => {
        const p = await sink.createPage({
          title: "My Page",
          body: "hello body",
          authorId: "u1",
          tags: ["tag1", "tag2"],
        });
        expect(p.id).toBeTruthy();
        expect(p.slug).toBe("my-page");
      });

      it("disambiguates slugs on collision with a suffix", async () => {
        const a = await sink.createPage({ title: "Same", body: "", authorId: "u1" });
        const b = await sink.createPage({ title: "Same", body: "", authorId: "u1" });
        expect(a.slug).toBe("same");
        expect(b.slug).toBe("same-2");
        expect(a.id).not.toBe(b.id);
      });
    });

    describe("updatePage", () => {
      it("updates body and metadata of an existing page", async () => {
        const p = await sink.createPage({ title: "T", body: "v1", authorId: "u1" });
        await expect(
          sink.updatePage(p.id, { body: "v2", tags: ["updated"] }),
        ).resolves.toBeUndefined();
      });

      it("throws when updating a missing page", async () => {
        await expect(sink.updatePage("nope", { body: "x" })).rejects.toThrow();
      });
    });

    describe("commit", () => {
      it("returns a sha for a committed page", async () => {
        const p = await sink.createPage({ title: "T", body: "v1", authorId: "u1" });
        const c = await sink.commit({ pageId: p.id, body: "v2", authorId: "u1", message: "msg" });
        expect(typeof c.commitSha).toBe("string");
        expect(c.commitSha.length).toBeGreaterThan(0);
      });

      it("throws when committing a missing page", async () => {
        await expect(
          sink.commit({ pageId: "nope", body: "x", authorId: "u1" }),
        ).rejects.toThrow();
      });
    });

    describe("notify / postActivity", () => {
      it("notify does not throw", async () => {
        await expect(
          sink.notify("u1", { kind: "run.completed", title: "hi", body: "done", url: "/x" }),
        ).resolves.toBeUndefined();
      });

      it("postActivity does not throw", async () => {
        await expect(
          sink.postActivity({
            actorId: "u1",
            verb: "created",
            objectType: "page",
            objectId: "x",
          }),
        ).resolves.toBeUndefined();
      });
    });
  });
}
