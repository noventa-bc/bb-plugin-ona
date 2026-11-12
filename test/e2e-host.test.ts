import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { asRoot, FAKE_ENV, local, startHost } from "./e2e-host.ts";

// This file runs in its own process: its TMPDIR is private to it, so the listings below show only what its starts made.
const privateTmp = mkdtempSync(join(tmpdir(), "e2e-host-"));
process.env.TMPDIR = privateTmp;
after(() => rmSync(privateTmp, { recursive: true, force: true }));

// A closed server stays in the list for a few loop turns, so the counts below wait for them to pass.
async function settle() {
  for (let turn = 0; turn < 10; turn++) await new Promise((resolve) => setImmediate(resolve));
}

const openServers = () => process.getActiveResourcesInfo().filter((name) => name === "TCPServerWrap").length;
// Counts only the variables startHost sets: another FAKE_ variable in the shell is not the helper's.
const fakeEnv = () => FAKE_ENV.filter((key) => process.env[key] !== undefined);

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

test(
  "a close whose disposal throws still releases the server, the env and the folder, and the disposal's error comes out when the release works (fails if the release is skipped after a failed disposal)",
  local,
  async () => {
    // Bug: close awaited the disposal before it released the server, the env and the folder, so a disposal that threw left all three.
    const boom = new Error("disposal failed");
    await settle();
    const serversBefore = openServers();
    const { host, close } = await startHost({});
    const dispose = host.harness.lifecycle.dispose;
    // The real disposal runs first, so the fake host's own storage folder is gone before the failure.
    host.harness.lifecycle.dispose = async () => {
      await dispose();
      throw boom;
    };
    try {
      await assert.rejects(close(), (error) => error === boom, "the disposal's error does not come out");
      await settle();
      assert.equal(openServers(), serversBefore, "a server stays open after the failed close");
      assert.deepEqual(fakeEnv(), [], "an env var stays set after the failed close");
      assert.deepEqual(readdirSync(privateTmp), [], "a folder stays in the temp dir after the failed close");
    } finally {
      host.harness.lifecycle.dispose = dispose;
      await close();
    }
  },
);

test(
  "a throw while the fake host is built leaves no open server, env or helper folder (fails if the server listens before the guarded region)",
  local,
  async () => {
    // Bug: a throw in createFakePluginHost came outside the try, after the health server listened and the env was set, so nothing released them or the helper's folder.
    const boom = new Error("host build failed");
    // The SDK reads every property of machineBootstrap while it builds the host: a getter that throws fails the build.
    const machineBootstrap = {
      get bootstrap(): never {
        throw boom;
      },
    };
    await settle();
    const serversBefore = openServers();
    try {
      await assert.rejects(
        startHost({ machineBootstrap }, async () => {
          throw new Error("the plugin must not start");
        }),
        (error) => error === boom,
      );
      await settle();
      assert.equal(openServers(), serversBefore, "a server stays open after the failed build");
      assert.deepEqual(fakeEnv(), [], "an env var stays set after the failed build");
      // The check names the helper's folders by their `bb-ona-e2e-` prefix.
      assert.deepEqual(
        readdirSync(privateTmp).filter((name) => name.startsWith("bb-ona-e2e-")),
        [],
        "a folder stays in the temp dir after the failed build",
      );
    } finally {
      // Empties the temp dir and the helper's env names, so the other tests' listing of the temp dir is clean in any order.
      for (const name of readdirSync(privateTmp)) rmSync(join(privateTmp, name), { recursive: true, force: true });
      for (const key of fakeEnv()) delete process.env[key];
    }
  },
);
