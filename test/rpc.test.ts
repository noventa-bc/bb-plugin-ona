import assert from "node:assert/strict";
import { test } from "node:test";
import { commands } from "../src/commands.ts";
import { devboxCommandSchema, rpcContract } from "../src/rpc.ts";

const SECTION_COMMANDS = ["status", "sync", "reconnect", "resume", "rename"];

test("the settings section can run only status, sync, reconnect, resume and rename (fails if update or another command passes)", () => {
  const { input } = rpcContract.devbox_command;
  assert.deepEqual(devboxCommandSchema.options, SECTION_COMMANDS);
  for (const command of SECTION_COMMANDS) {
    assert.equal(input.safeParse({ command }).success, true, command);
  }
  // Every other `bb ona` command is refused, so an extra enum member fails here.
  for (const { name } of commands) {
    if (SECTION_COMMANDS.includes(name)) continue;
    assert.equal(input.safeParse({ command: name }).success, false, name);
  }
  assert.equal(input.safeParse({ command: "update", hostId: "host_1" }).success, false, "update");
});

test("a host id the settings section sends is never read as a CLI flag", () => {
  const { input } = rpcContract.devbox_command;
  assert.equal(input.safeParse({ command: "sync" }).success, true, "no hostId: sync all");
  assert.equal(input.safeParse({ command: "sync", hostId: "host_1" }).success, true);
  for (const hostId of ["", "--", "--json"]) {
    assert.equal(input.safeParse({ command: "sync", hostId }).success, false, JSON.stringify(hostId));
  }
});

test("a new name the settings section sends is never read as a CLI flag (fails if a leading dash or an empty value passes)", () => {
  const { input } = rpcContract.devbox_command;
  assert.equal(input.safeParse({ command: "rename", hostId: "host_1", arg: "new-name" }).success, true);
  for (const arg of ["", "--", "--json"]) {
    assert.equal(input.safeParse({ command: "rename", hostId: "host_1", arg }).success, false, JSON.stringify(arg));
  }
});

test("an arg without a host id is refused, since the CLI would read it as the devbox (fails if it is accepted)", () => {
  const { input } = rpcContract.devbox_command;
  assert.equal(input.safeParse({ command: "rename", arg: "new-name" }).success, false);
});

test("only rename takes an arg (fails if status, sync, reconnect, or resume accepts one)", () => {
  const { input } = rpcContract.devbox_command;
  for (const command of ["status", "sync", "reconnect", "resume"]) {
    assert.equal(input.safeParse({ command, hostId: "host_1", arg: "x" }).success, false, command);
  }
});
