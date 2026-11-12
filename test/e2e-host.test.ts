import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { asRoot, local, startHost } from "./e2e-host.ts";

// This file runs in its own process: its TMPDIR is private to it, so the listings below show only what its starts made.
const privateTmp = mkdtempSync(join(tmpdir(), "e2e-host-"));
process.env.TMPDIR = privateTmp;
after(() => rmSync(privateTmp, { recursive: true, force: true }));

// A closed server stays in the list for a few loop turns, so the counts below wait for them to pass.
async function settle() {
  for (let turn = 0; turn < 10; turn++) await new Promise((resolve) => setImmediate(resolve));
}

const openServers = () => process.getActiveResourcesInfo().filter((name) => name === "TCPServerWrap").length;

test(
  "a failed start rethrows the plugin's own error and leaves no folder or open server (fails if the cleanup is skipped, the error is replaced or a server stays open)",
  local,
  async () => {
    const boom = new Error("plugin start failed");
    await settle();
    const serversBefore = openServers();
    await assert.rejects(
      startHost({}, async () => {
        throw boom;
      }),
      (error) => error === boom,
    );
    await settle();
    assert.equal(openServers(), serversBefore, "a server stays open after the failed start");
    assert.deepEqual(readdirSync(privateTmp), [], "a folder stays in the temp dir after the failed start");
  },
);

test(
  "a cleanup that fails after a failed start still rethrows the plugin's own error (fails if the cleanup's error is not caught)",
  { skip: local.skip || asRoot },
  async () => {
    const boom = new Error("plugin start failed");
    let folder = "";
    try {
      await assert.rejects(
        startHost({}, async () => {
          // Read-only: the cleanup cannot remove the files in it, so close throws.
          const name = readdirSync(privateTmp).find((entry) => entry.startsWith("bb-ona-e2e-"))!;
          folder = join(privateTmp, name);
          chmodSync(folder, 0o555);
          throw boom;
        }),
        (error) => error === boom,
      );
      assert.ok(existsSync(folder), "the read-only folder is gone, so the cleanup did not fail");
    } finally {
      if (existsSync(folder)) {
        chmodSync(folder, 0o755);
        rmSync(folder, { recursive: true, force: true });
      }
    }
  },
);
