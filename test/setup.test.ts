import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findOnaBinary, planSetup } from "../src/setup.ts";

test("findOnaBinary prefers the configured path, then PATH", () => {
  const dir = mkdtempSync(join(tmpdir(), "ona-bin-"));
  const ona = join(dir, "ona");
  writeFileSync(ona, "#!/bin/sh\n");
  chmodSync(ona, 0o755);
  assert.equal(findOnaBinary(ona, ""), ona);
  assert.equal(findOnaBinary("/nope/ona", dir), ona);
  writeFileSync(join(dir, "not-exec"), "");
  assert.notEqual(findOnaBinary(join(dir, "not-exec"), ""), join(dir, "not-exec"));
});

const ready = {
  onaBinary: "/opt/homebrew/bin/ona",
  login: { ok: true as const, user: "Ada", org: "example.com" },
  sshConfigured: true,
  settings: { defaultMachineAccess: "direct", machineServerUrl: "http://127.0.0.1:38886", machineGitCredentialsEnabled: false },
  serverUrl: "http://127.0.0.1:38886",
  keepGitCredentials: false,
};

test("planSetup reports nothing to do when configured", () => {
  assert.ok(planSetup(ready).every((step) => step.state === "ok"));
});

test("planSetup lists changes and blockers", () => {
  const steps = planSetup({
    ...ready,
    login: { ok: false, message: "not logged in" },
    sshConfigured: false,
    settings: { defaultMachineAccess: "connect", machineServerUrl: null, machineGitCredentialsEnabled: true },
  });
  const state = Object.fromEntries(steps.map((step) => [step.id, step.state]));
  assert.deepEqual(state, {
    ona: "ok",
    login: "blocked",
    "ssh-config": "change",
    access: "change",
    "server-url": "change",
    "git-credentials": "change",
  });
});

test("planSetup blocks without the ona CLI and can keep git credentials", () => {
  const steps = planSetup({
    ...ready,
    onaBinary: null,
    login: null,
    keepGitCredentials: true,
    settings: { ...ready.settings, machineGitCredentialsEnabled: true },
  });
  assert.deepEqual(steps.map((step) => [step.id, step.state]), [["ona", "blocked"], ["access", "ok"], ["server-url", "ok"]]);
});
