/**
 * Contract conformance tests — runs the implementation-agnostic Storage
 * contract (EX4) against every concrete Storage backend. Each backend gets
 * a fresh, isolated instance per test.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runStorageContract } from "../../core/providers/__contract__/storage.contract.js";
import { InMemoryStorage } from "./in-memory.js";
import { FsStorage } from "./fs.js";

runStorageContract(() => new InMemoryStorage(), "InMemoryStorage");

runStorageContract(async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-storage-contract-"));
  return new FsStorage({ rootDir });
}, "FsStorage");
