// startHost's cleanup when the plugin fails at start (test/e2e-host.ts): what it opened is closed, and the caller
// gets the plugin's own error.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { local, startHost } from "./e2e-host.ts";

test(
  "a start that throws rejects with the plugin's own error and leaves no folder (fails if the cleanup is skipped or the error is replaced)",
  local,
  async () => {
    const boom = new Error("plugin start failed");
    // A private TMPDIR, so the listing shows only what this start made.
    const privateTmp = mkdtempSync(join(tmpdir(), "e2e-host-"));
    const savedTmp = process.env.TMPDIR;
    process.env.TMPDIR = privateTmp;
    try {
      await assert.rejects(
        startHost({}, async () => {
          throw boom;
        }),
        (error) => error === boom,
      );
      assert.deepEqual(readdirSync(privateTmp), []);
    } finally {
      if (savedTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = savedTmp;
      rmSync(privateTmp, { recursive: true, force: true });
    }
  },
);
