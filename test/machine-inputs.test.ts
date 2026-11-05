import assert from "node:assert/strict";
import { test } from "node:test";
import { ONA_NAME_MESSAGE, projectInputsChange, projectOfSavedInputs } from "../src/machine-inputs.ts";

test("a blank field is ready with mode create only, so the defaultProject setting applies", () => {
  assert.deepEqual(projectInputsChange(""), { status: "ready", value: { mode: "create" } });
  assert.deepEqual(projectInputsChange("   "), { status: "ready", value: { mode: "create" } });
});

test("a typed project is trimmed and sent with mode create", () => {
  assert.deepEqual(projectInputsChange("  my-app "), { status: "ready", value: { mode: "create", project: "my-app" } });
});

test("a refused name is blocked, and the reason quotes the server's message", () => {
  assert.deepEqual(projectInputsChange("my app"), {
    status: "blocked",
    reason: `Invalid project "my app": ${ONA_NAME_MESSAGE}`,
  });
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
