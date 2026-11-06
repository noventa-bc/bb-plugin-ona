import assert from "node:assert/strict";
import { test } from "node:test";
import { commands } from "../src/commands.ts";
import { rpcContract } from "../src/rpc.ts";

const SECTION_COMMANDS = ["status", "sync", "reconnect", "resume"];

test("the settings section can run only status, sync, reconnect and resume", () => {
  const { input } = rpcContract.devbox_command;
  for (const command of SECTION_COMMANDS) {
    assert.equal(input.safeParse({ command }).success, true, command);
  }
  // Every other `bb ona` command is refused, so an extra enum member fails here.
  for (const { name } of commands) {
    if (SECTION_COMMANDS.includes(name)) continue;
    assert.equal(input.safeParse({ command: name }).success, false, name);
  }
});

test("a host id the settings section sends is never read as a CLI flag", () => {
  const { input } = rpcContract.devbox_command;
  assert.equal(input.safeParse({ command: "sync" }).success, true, "no hostId: sync all");
  assert.equal(input.safeParse({ command: "sync", hostId: "host_1" }).success, true);
  for (const hostId of ["", "--", "--json"]) {
    assert.equal(input.safeParse({ command: "sync", hostId }).success, false, JSON.stringify(hostId));
  }
});
