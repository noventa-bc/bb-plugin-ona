import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ONA_NAME_MESSAGE,
  ONA_NAME_PATTERN,
  projectInputsChange,
  projectOfSavedInputs,
} from "../src/machine-inputs.ts";
import { onaRef } from "../src/provider.ts";

test("a blank field is ready with mode create only, so the defaultProject setting applies", () => {
  assert.deepEqual(projectInputsChange(""), { status: "ready", value: { mode: "create" } });
  assert.deepEqual(projectInputsChange("   "), { status: "ready", value: { mode: "create" } });
});

test("a typed project is trimmed and sent with mode create", () => {
  assert.deepEqual(projectInputsChange("  my-app "), { status: "ready", value: { mode: "create", project: "my-app" } });
});

test("a name bb ona new refuses is blocked with the same reason", () => {
  assert.deepEqual(projectInputsChange("my app"), {
    status: "blocked",
    reason: `Invalid project "my app": ${ONA_NAME_MESSAGE}`,
  });
});

test("the name rule matches the server's onaRef on each sample name", () => {
  const samples = ["my-app", "a", "a.b_c-d", "a".repeat(80), "a".repeat(81), "my app", "-a", "a/b", ""];
  for (const name of samples) {
    const parsed = onaRef.safeParse(name);
    assert.equal(ONA_NAME_PATTERN.test(name), parsed.success, name);
    if (!parsed.success) assert.equal(parsed.error.issues[0]?.message, ONA_NAME_MESSAGE, name);
  }
});

test("a saved project is read back for the field, and anything else reads as blank", () => {
  assert.equal(projectOfSavedInputs({ mode: "create", project: "my-app" }), "my-app");
  assert.equal(projectOfSavedInputs({ mode: "create" }), "");
  assert.equal(projectOfSavedInputs({ project: 3 }), "");
  assert.equal(projectOfSavedInputs(["my-app"]), "");
  assert.equal(projectOfSavedInputs(null), "");
});
