import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import {
  DEFAULT_WRITER_MODEL,
  DEFAULT_REVIEWER_MODEL,
  resolveModelPair,
  persistModelPair,
  loadModelPair,
} from "./model-pair.js";

let projectDir: string;

beforeEach(async () => {
  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-modelpair-"));
  await fs.mkdir(path.join(projectDir, ".mathran"), { recursive: true });
});
afterEach(async () => {
  await fs.rm(projectDir, { recursive: true, force: true });
  delete process.env.MATHRAN_WRITER_MODEL;
  delete process.env.MATHRAN_REVIEWER_MODEL;
});

describe("resolveModelPair", () => {
  it("falls back to empty-string sentinel (provider-default) when nothing is configured", async () => {
    // Hard defaults (gpt-5.5 / opus-4.8) used to fire here, but they were
    // injecting a broken `openai/...` model into copilot-only environments
    // (dogfood run 3). Now the sentinel is "" and the ModelRouter picks.
    const pair = await resolveModelPair({}, projectDir);
    expect(pair.writerModel).toBe("");
    expect(pair.reviewerModel).toBe("");
    expect(pair.identical).toBe(true);
  });

  it("uses contextDefault (the user's ctx.model) when no other source is set", async () => {
    const pair = await resolveModelPair({}, projectDir, "copilot/claude-sonnet-4");
    expect(pair.writerModel).toBe("copilot/claude-sonnet-4");
    expect(pair.reviewerModel).toBe("copilot/claude-sonnet-4");
    expect(pair.identical).toBe(true);
  });

  it("MATHRAN_*_MODEL env overrides beat contextDefault", async () => {
    process.env.MATHRAN_WRITER_MODEL = "envw/w";
    process.env.MATHRAN_REVIEWER_MODEL = "envr/r";
    const pair = await resolveModelPair({}, projectDir, "copilot/anything");
    expect(pair.writerModel).toBe("envw/w");
    expect(pair.reviewerModel).toBe("envr/r");
  });

  it("explicit config beats env, contextDefault, and defaults", async () => {
    process.env.MATHRAN_WRITER_MODEL = "envw/w";
    const pair = await resolveModelPair(
      { writerModel: "cfg/writer" },
      projectDir,
      "copilot/anything",
    );
    expect(pair.writerModel).toBe("cfg/writer");
  });

  it("honours explicit config over defaults", async () => {
    const pair = await resolveModelPair(
      { writerModel: "x/writer", reviewerModel: "y/reviewer" },
      projectDir,
    );
    expect(pair.writerModel).toBe("x/writer");
    expect(pair.reviewerModel).toBe("y/reviewer");
  });

  it("honours env overrides when config is unset", async () => {
    process.env.MATHRAN_WRITER_MODEL = "env/writer";
    process.env.MATHRAN_REVIEWER_MODEL = "env/reviewer";
    const pair = await resolveModelPair({}, projectDir);
    expect(pair.writerModel).toBe("env/writer");
    expect(pair.reviewerModel).toBe("env/reviewer");
  });

  it("config beats env", async () => {
    process.env.MATHRAN_WRITER_MODEL = "env/writer";
    const pair = await resolveModelPair({ writerModel: "cfg/writer" }, projectDir);
    expect(pair.writerModel).toBe("cfg/writer");
  });

  it("falls back to persisted settings when config + env are unset", async () => {
    await persistModelPair(projectDir, { writerModel: "saved/writer", reviewerModel: "saved/reviewer" });
    const pair = await resolveModelPair({}, projectDir);
    expect(pair.writerModel).toBe("saved/writer");
    expect(pair.reviewerModel).toBe("saved/reviewer");
  });

  it("flags identical writer/reviewer models", async () => {
    const pair = await resolveModelPair({ writerModel: "same/m", reviewerModel: "same/m" }, projectDir);
    expect(pair.identical).toBe(true);
  });
});

describe("persistModelPair / loadModelPair", () => {
  it("round-trips and preserves other settings keys", async () => {
    await fs.writeFile(
      path.join(projectDir, ".mathran", "settings.json"),
      JSON.stringify({ schemaVersion: 1, editor: "vim" }, null, 2),
      "utf-8",
    );
    await persistModelPair(projectDir, { writerModel: "w/m", reviewerModel: "r/m" });

    const loaded = await loadModelPair(projectDir);
    expect(loaded).toEqual({ writerModel: "w/m", reviewerModel: "r/m" });

    const raw = JSON.parse(
      await fs.readFile(path.join(projectDir, ".mathran", "settings.json"), "utf-8"),
    );
    expect(raw.schemaVersion).toBe(1);
    expect(raw.editor).toBe("vim");
    expect(raw.initProject.writerModel).toBe("w/m");
  });

  it("returns empty when no settings file exists", async () => {
    await fs.rm(path.join(projectDir, ".mathran"), { recursive: true, force: true });
    expect(await loadModelPair(projectDir)).toEqual({});
  });
});
