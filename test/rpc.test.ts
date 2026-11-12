import assert from "node:assert/strict";
import { test } from "node:test";
import { commands } from "../src/commands.ts";
import { devboxCommandSchema, devboxOf, rpcContract } from "../src/rpc.ts";
import type { Row } from "../src/sync.ts";

const SECTION_COMMANDS = ["status", "sync", "reconnect", "resume", "rename", "keep-alive", "update"];

test("the settings section can run only status, sync, reconnect, resume, rename, keep-alive and update", () => {
  const { input } = rpcContract.devbox_command;
  assert.deepEqual(devboxCommandSchema.options, SECTION_COMMANDS);
  // update needs a host id, so it is tested below.
  for (const command of SECTION_COMMANDS.filter((name) => name !== "update")) {
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

test("a new name or duration the settings section sends is never read as a CLI flag (fails if a leading dash or an empty value passes)", () => {
  const { input } = rpcContract.devbox_command;
  assert.equal(input.safeParse({ command: "rename", hostId: "host_1", arg: "new-name" }).success, true);
  assert.equal(input.safeParse({ command: "keep-alive", hostId: "host_1", arg: "off" }).success, true);
  for (const arg of ["", "--", "--json"]) {
    assert.equal(input.safeParse({ command: "rename", hostId: "host_1", arg }).success, false, JSON.stringify(arg));
  }
});

test("an arg without a host id is refused, since the CLI would read it as the devbox (fails if it is accepted)", () => {
  const { input } = rpcContract.devbox_command;
  assert.equal(input.safeParse({ command: "rename", arg: "new-name" }).success, false);
});

test("only rename and keep-alive take an arg (fails if status, sync, reconnect, resume or update accepts one)", () => {
  const { input } = rpcContract.devbox_command;
  for (const command of ["status", "sync", "reconnect", "resume", "update"]) {
    assert.equal(input.safeParse({ command, hostId: "host_1", arg: "x" }).success, false, command);
  }
});

test("update runs for one devbox only: without a host id it is refused (fails if update passes without one, or is refused with one)", () => {
  const { input } = rpcContract.devbox_command;
  assert.equal(input.safeParse({ command: "update", hostId: "host_1" }).success, true);
  assert.equal(input.safeParse({ command: "update" }).success, false);
});

const row: Row = {
  hostId: "host_1",
  machine: "rapid-mango",
  status: "connected",
  phase: "active",
  lastSeenAt: null,
  resource: { envId: "env-1", envName: "rapid-mango-box", adopted: true, key: "key-1" },
};

test("devboxOf shows the machine, its box, its status and ssh command, with the tunnel it is given (fails if a field is read from the wrong place)", () => {
  assert.deepEqual(devboxOf(row, "up"), {
    machine: "rapid-mango",
    hostId: "host_1",
    envId: "env-1",
    envName: "rapid-mango-box",
    status: "connected",
    tunnel: "up",
    adopted: true,
    sshCommand: "ssh env-1.ona.environment",
  });
});

test("devboxOf passes each tunnel state through unchanged (fails if the tunnel is fixed to one state)", () => {
  for (const tunnel of ["up", "connecting", "off"] as const) {
    assert.equal(devboxOf(row, tunnel).tunnel, tunnel);
  }
});

test("devboxOf reports a box bb did not adopt as not adopted (fails if adopted is a constant)", () => {
  const unadopted = { ...row, resource: { ...row.resource, adopted: false } };
  assert.equal(devboxOf(unadopted, "off").adopted, false);
});
