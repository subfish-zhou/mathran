/**
 * Contract conformance tests — runs the implementation-agnostic ArtifactSink
 * contract (EX4) against LocalFsArtifactSink (flat mode). Each run gets a
 * fresh temp directory per test.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runArtifactSinkContract } from "../../core/providers/__contract__/artifact-sink.contract.js";
import { LocalFsArtifactSink } from "./local-fs.js";

runArtifactSinkContract(async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-sink-contract-"));
  return new LocalFsArtifactSink(rootDir);
}, "LocalFsArtifactSink");
