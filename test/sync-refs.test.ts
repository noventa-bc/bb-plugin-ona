import assert from "node:assert/strict";
import { test } from "node:test";
import { matchesRef, rowForRef, type Row } from "../src/sync.ts";

test("a ref matches a row by host id, machine name, env id or env name, and nothing else", () => {
  const row = { hostId: "h1", machine: "box-one", resource: { envId: "env-1", envName: "one" } } as Row;
  for (const ref of ["h1", "box-one", "env-1", "one"]) assert.equal(matchesRef(row, ref), true, ref);
  assert.equal(matchesRef(row, "two"), false);
});

// Bug: a ref took the first row that matched it, so another box's env name could win over the host id the ref names.
test("a ref picks the box whose host id it is, not an earlier box that has it as an env name, and an env name still picks its box (fails if the first matching row wins, or if only host ids match)", () => {
  const earlier = { hostId: "h-a", machine: "box-a", resource: { envId: "env-a", envName: "h-b" } } as Row;
  const named = { hostId: "h-b", machine: "box-b", resource: { envId: "env-b", envName: "box-b-env" } } as Row;
  assert.equal(rowForRef([earlier, named], "h-b"), named);
  assert.equal(rowForRef([earlier, named], "box-b-env"), named);
});

// Bug: a ref two boxes share by env name picked the first one listed, so bb acted on a box the user did not name.
test("a ref two boxes share by name is refused and names both boxes (fails if the first match wins)", () => {
  const first = { hostId: "h-1", machine: "api", resource: { envId: "env-1", envName: "api" } } as Row;
  const second = { hostId: "h-2", machine: "api", resource: { envId: "env-2", envName: "api" } } as Row;
  assert.throws(() => rowForRef([first, second], "api"), {
    message: '"api" matches 2 devboxes: api (h-1), api (h-2). Use a host id.',
  });
  assert.equal(rowForRef([first, second], "h-2"), second);
});

test("a host id wins over two boxes that share an env name equal to it (fails if the name match is checked first)", () => {
  const named = { hostId: "h-x", machine: "box-x", resource: { envId: "env-x", envName: "h-1" } } as Row;
  const first = { hostId: "h-1", machine: "api", resource: { envId: "env-1", envName: "api" } } as Row;
  const second = { hostId: "h-2", machine: "api", resource: { envId: "env-2", envName: "h-1" } } as Row;
  assert.equal(rowForRef([named, first, second], "h-1"), first);
});
