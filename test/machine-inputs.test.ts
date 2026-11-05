import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ONA_MACHINE_PROVIDER_ID,
  ONA_NAME_MESSAGE,
  ONA_NAME_PATTERN,
  projectInputsChange,
  projectOfSavedInputs,
} from "../src/machine-inputs.ts";
import { onaRef, PROVIDER_ID } from "../src/provider.ts";

test("a blank field is ready with mode create only, so the defaultProject setting applies", () => {
  assert.deepEqual(projectInputsChange(""), { status: "ready", value: { mode: "create" } });
  assert.deepEqual(projectInputsChange("   "), { status: "ready", value: { mode: "create" } });
});

test("a typed project is trimmed and sent with mode create", () => {
  assert.deepEqual(projectInputsChange("  my-app "), { status: "ready", value: { mode: "create", project: "my-app" } });
});

test("a refused name is blocked, and the reason quotes the server's message", () => {
  assert.equal(onaRef.safeParse("my app").error?.issues[0]?.message, ONA_NAME_MESSAGE);
  assert.deepEqual(projectInputsChange("my app"), {
    status: "blocked",
    reason: `Invalid project "my app": ${ONA_NAME_MESSAGE}`,
  });
});

test("the name rule matches onaRef on every ASCII character, alone and inside a name", () => {
  for (let code = 0; code < 128; code++) {
    const c = String.fromCharCode(code);
    for (const name of [c, `a${c}`, `${c}a`, `a${c}b`]) {
      assert.equal(ONA_NAME_PATTERN.test(name), onaRef.safeParse(name).success, JSON.stringify(name));
    }
  }
});

test("the name length limit is 80 characters, as in onaRef", () => {
  assert.equal(onaRef.safeParse("a".repeat(80)).success, true);
  assert.equal(onaRef.safeParse("a".repeat(81)).success, false);
  assert.equal(projectInputsChange("a".repeat(80)).status, "ready");
  assert.equal(projectInputsChange("a".repeat(81)).status, "blocked");
});

test("a saved project is read back for the field, and anything else reads as blank", () => {
  assert.equal(projectOfSavedInputs({ mode: "create", project: "my-app" }), "my-app");
  assert.equal(projectOfSavedInputs({ mode: "create" }), "");
  assert.equal(projectOfSavedInputs({ project: 3 }), "");
  assert.equal(projectOfSavedInputs(["my-app"]), "");
  assert.equal(projectOfSavedInputs("my-app"), "");
  assert.equal(projectOfSavedInputs(null), "");
});

test("the field's machine provider id is the one src/provider.ts registers", () => {
  assert.equal(ONA_MACHINE_PROVIDER_ID, PROVIDER_ID);
});
