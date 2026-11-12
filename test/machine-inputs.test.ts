import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { commandArg, devboxCommandInput, inputsChange, ONA_NAME_MESSAGE, savedInputs } from "../src/machine-inputs.ts";
import { box, register } from "./provider-fake.ts";

test("a blank field is ready with mode create only, so the defaultProject setting applies", () => {
  assert.deepEqual(inputsChange("create", ""), { status: "ready", value: { mode: "create" } });
  assert.deepEqual(inputsChange("create", "   "), { status: "ready", value: { mode: "create" } });
});

test("a typed project is trimmed and sent with mode create", () => {
  assert.deepEqual(inputsChange("create", "  my-app "), {
    status: "ready",
    value: { mode: "create", project: "my-app" },
  });
});

test("a refused name's reason quotes ONA_NAME_MESSAGE", () => {
  assert.deepEqual(inputsChange("create", "my app"), {
    status: "blocked",
    reason: `Invalid project "my app": ${ONA_NAME_MESSAGE}`,
  });
});

test("the name rule: 1 to 80 characters, a letter or digit first, then letters, digits, '.', '_' or '-'", () => {
  for (const name of ["a".repeat(80), "a_b.c-1", "a", "1app", "App-1", "myApp"]) {
    assert.equal(inputsChange("create", name).status, "ready", `expected ready: ${name}`);
  }
  for (const name of ["a".repeat(81), "-rf", "_a", ".a", "a;b", "a b", "a/b", "a\nb"]) {
    assert.equal(inputsChange("create", name).status, "blocked", `expected blocked: ${name}`);
  }
  for (const c of "$`|&()*?'\"\\#~=:@+,%!<>{}[] \t\r\u0000" + "é١") {
    assert.equal(inputsChange("create", `a${c}b`).status, "blocked", `expected blocked: ${JSON.stringify(c)}`);
  }
  // Two calls in a row on purpose: with a global flag, the pattern keeps lastIndex between calls.
  assert.equal(inputsChange("create", "my-app").status, "ready");
  assert.equal(inputsChange("create", "my-app1").status, "ready");
});

test("a saved project is read back for the field, and anything else reads as create with a blank field", () => {
  assert.deepEqual(savedInputs({ mode: "create", project: "my-app" }), { mode: "create", text: "my-app" });
  assert.deepEqual(savedInputs({ mode: "create" }), { mode: "create", text: "" });
  assert.deepEqual(savedInputs({ project: 3 }), { mode: "create", text: "" });
  assert.deepEqual(savedInputs(["my-app"]), { mode: "create", text: "" });
  assert.deepEqual(savedInputs("my-app"), { mode: "create", text: "" });
  assert.deepEqual(savedInputs(null), { mode: "create", text: "" });
  assert.deepEqual(savedInputs({ mode: "create", environment: "x" }), { mode: "create", text: "" });
});

test("adopt with a blank environment is blocked with a hint (fails if a blank adopt is sent as ready)", () => {
  const blocked = { status: "blocked", reason: "Enter the Ona environment to adopt (name or id)" };
  assert.deepEqual(inputsChange("adopt", ""), blocked);
  assert.deepEqual(inputsChange("adopt", "   "), blocked);
});

test("adopt sends mode adopt and the trimmed environment (fails if the name is sent untrimmed or under project)", () => {
  assert.deepEqual(inputsChange("adopt", "  brave-otter "), {
    status: "ready",
    value: { mode: "adopt", environment: "brave-otter" },
  });
});

test("a bad environment name is blocked quoting ONA_NAME_MESSAGE (fails if adopt skips the name rule)", () => {
  assert.deepEqual(inputsChange("adopt", "my env"), {
    status: "blocked",
    reason: `Invalid environment "my env": ${ONA_NAME_MESSAGE}`,
  });
  assert.equal(inputsChange("adopt", "-rf").status, "blocked");
});

test("a saved adopt value restores mode and environment (fails if a saved adopt reads back as create)", () => {
  assert.deepEqual(savedInputs({ mode: "adopt", environment: "brave-otter" }), { mode: "adopt", text: "brave-otter" });
  assert.deepEqual(savedInputs({ mode: "adopt" }), { mode: "create", text: "" });
});

test("the ready adopt value parses with the provider's inputs schema (fails if the value's shape drifts from the schema)", async () => {
  const { provider } = register({ found: box("RUNNING") });
  const ready = inputsChange("adopt", "brave-otter");
  assert.ok(ready.status === "ready");
  const parsed = await provider.inputs!["~standard"].validate(ready.value);
  assert.deepEqual(parsed, { value: { mode: "adopt", environment: "brave-otter" } });
});

test("a field's text is the argument: blank or spaces-only gives none, and the ends are trimmed (fails if a blank field sends a value or the spaces stay)", () => {
  assert.equal(commandArg(""), undefined);
  assert.equal(commandArg("   "), undefined);
  assert.equal(commandArg(" foo "), "foo");
});

test("a devbox_command input leaves out unset keys, which bb's RPC client refuses (fails if the helper keeps an undefined key)", () => {
  assert.deepStrictEqual(devboxCommandInput("sync", undefined, undefined), { command: "sync" });
  assert.deepStrictEqual(devboxCommandInput("resume", "host-1", undefined), { command: "resume", hostId: "host-1" });
  assert.deepStrictEqual(devboxCommandInput("rename", "host-1", "box"), {
    command: "rename",
    hostId: "host-1",
    arg: "box",
  });
});

// shortcut: matches the name as written in the source, so a name escaped, split or built from a template, or imported from
// another file, slips past; walk app.tsx with the TypeScript parser if a call ever writes it so.
test("every devbox_command name in app.tsx is followed by devboxCommandInput( (fails if a call builds its input by hand, on one line, split by prettier, or through a variable holding the name)", () => {
  const app = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
  const names = app.match(/["'`]devbox_command["'`]/g) ?? [];
  const viaHelper = app.match(/["'`]devbox_command["'`],\s*devboxCommandInput\(/g) ?? [];
  assert.ok(names.length > 0, "app.tsx has no devbox_command name");
  assert.equal(
    viaHelper.length,
    names.length,
    "a devbox_command name in app.tsx is not followed by devboxCommandInput(",
  );
});

test("the settings section has an Update CLIs button (fails if its line leaves app.tsx)", () => {
  const app = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
  assert.ok(app.includes('{ command: "update", label: "Update CLIs" }'), "app.tsx has no Update CLIs button");
});
