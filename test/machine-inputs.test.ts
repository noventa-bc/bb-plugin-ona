import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  commandArg,
  devboxCommandInput,
  inputsChange,
  ONA_NAME_MESSAGE,
  savedInputs,
  switchedInputs,
} from "../src/machine-inputs.ts";
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

test("switchedInputs gives the mode its option names and an empty text (fails if the text is kept or the modes are swapped)", () => {
  assert.deepEqual(switchedInputs("adopt"), { mode: "adopt", text: "" });
  assert.deepEqual(switchedInputs("create"), { mode: "create", text: "" });
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

test("the composer's select calls switchedInputs, its text field keeps the mode, and its help text is the new one (fails if a handler or the help text in app.tsx reverts)", () => {
  const app = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
  assert.ok(app.includes("setInputs(switchedInputs(event.target.value))"), "the select does not call switchedInputs");
  assert.ok(
    app.includes("setInputs((inputs) => ({ ...inputs, text: event.target.value }))"),
    "the text field does not keep the mode",
  );
  assert.ok(
    app.includes(
      `{adopt ? "Removing the machine keeps the environment" : "Blank uses the plugin's defaultProject setting"}`,
    ),
    "the adopt help text is not the new one",
  );
});

test("the Rename form's typed name reaches devbox_command (fails if app.tsx renames the input, fieldArg reads another field, run drops the name, or run stops passing arg on)", () => {
  const app = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
  assert.ok(app.includes('name="arg"'), "the Rename input is not named arg");
  assert.ok(app.includes('new FormData(form).get("arg")'), "fieldArg does not read the arg field");
  assert.ok(
    app.includes('run("rename", box.hostId, fieldArg(event.currentTarget))'),
    "the Rename form does not send its field's text",
  );
  assert.ok(app.includes("devboxCommandInput(command, hostId, arg)"), "run does not pass arg to devboxCommandInput");
});

test("the hidden-warning rule hides the shell_environment_policy and multi_agent warning rows (fails if either selector is dropped, the rule stops hiding, or it is no longer applied)", () => {
  const app = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
  assert.ok(
    app.includes(
      `'[data-timeline-row-id*=":op:warning:"]:has([title*="\`shell_environment_policy.include\` is ignored"]), ' +`,
    ),
  );
  assert.ok(
    app.includes(
      `'[data-timeline-row-id*=":op:warning:"]:has([title*="\`[features].multi_agent\` is deprecated"]) { display: none !important; }';`,
    ),
  );
  assert.ok(app.includes("style.textContent = HIDDEN_WARNING_CSS;"), "the rule is not applied");
});

type Element = { id: string; textContent: string };

/** Runs app.tsx's own hideKnownWarnings source against a stub document; returns HIDDEN_WARNING_CSS. */
function runHideKnownWarnings(document: object): string {
  const app = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
  const start = app.indexOf("function hideKnownWarnings() {");
  const body = app.slice(start, app.indexOf("\n}\n", start) + 2);
  const css = /const HIDDEN_WARNING_CSS =[\s\S]*?';\n/.exec(app)?.[0] ?? "";
  return new Function("document", `${css}\n${body}\nhideKnownWarnings();\nreturn HIDDEN_WARNING_CSS;`)(document);
}

test("hideKnownWarnings replaces the rule in a style element an older plugin version left (fails if it returns early on an existing element or creates a second one)", () => {
  // Bug: a bb window kept the older rule after `bb plugin reload ona`, so a newly hidden warning still showed.
  const old = { id: "bb-ona-hidden-warnings", textContent: "old rule" };
  const rule = runHideKnownWarnings({
    getElementById: (id: string) => (id === old.id ? old : null),
    createElement: () => assert.fail("created a second style element"),
    head: { appendChild: () => assert.fail("appended a style element again") },
  });
  assert.equal(old.textContent, rule, "the older rule was kept");
});

test("hideKnownWarnings adds one style element with the rule to a fresh window (fails if the element is not appended to head or has no id)", () => {
  const appended: Element[] = [];
  const rule = runHideKnownWarnings({
    getElementById: () => null,
    createElement: (tag: string) => ({ tag, id: "", textContent: "" }),
    head: { appendChild: (el: Element) => appended.push(el) },
  });
  assert.deepEqual(appended, [{ tag: "style", id: "bb-ona-hidden-warnings", textContent: rule }]);
});
