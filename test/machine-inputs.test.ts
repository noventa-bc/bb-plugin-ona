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

test("a refused name's reason quotes ONA_NAME_MESSAGE", () => {
  assert.deepEqual(projectInputsChange("my app"), {
    status: "blocked",
    reason: `Invalid project "my app": ${ONA_NAME_MESSAGE}`,
  });
});

test("the name rule: 1 to 80 characters, a letter or digit first, then letters, digits, '.', '_' or '-'", () => {
  for (const name of ["a".repeat(80), "a_b.c-1", "a", "1app", "App-1", "myApp"]) {
    assert.equal(projectInputsChange(name).status, "ready", `expected ready: ${name}`);
  }
  for (const name of ["a".repeat(81), "-rf", "_a", ".a", "a;b", "a b", "a/b", "a\nb"]) {
    assert.equal(projectInputsChange(name).status, "blocked", `expected blocked: ${name}`);
  }
  for (const c of "$`|&()*?'\"\\#~=:@+,%!<>{}[] \t\r\u0000" + "é١") {
    assert.equal(projectInputsChange(`a${c}b`).status, "blocked", `expected blocked: ${JSON.stringify(c)}`);
  }
  // Two calls in a row on purpose: with a global flag, the pattern keeps lastIndex between calls.
  assert.equal(projectInputsChange("my-app").status, "ready");
  assert.equal(projectInputsChange("my-app1").status, "ready");
});

test("a saved project is read back for the field, and anything else reads as blank", () => {
  assert.equal(projectOfSavedInputs({ mode: "create", project: "my-app" }), "my-app");
  assert.equal(projectOfSavedInputs({ mode: "create" }), "");
  assert.equal(projectOfSavedInputs({ project: 3 }), "");
  assert.equal(projectOfSavedInputs(["my-app"]), "");
  assert.equal(projectOfSavedInputs("my-app"), "");
  assert.equal(projectOfSavedInputs(null), "");
});
