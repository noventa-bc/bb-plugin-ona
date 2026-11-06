import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { git, scrubbed, tempDir } from "./sandbox.ts";

const repo = join(import.meta.dirname, "..");
const script = join(repo, "scripts", "docs-check.sh");

// The repo's own prettier config, so each fixture is judged the way the repo is.
const repoConfig: Record<string, string> = {
  ".prettierrc.json": readFileSync(join(repo, ".prettierrc.json"), "utf8"),
  ".prettierignore": readFileSync(join(repo, ".prettierignore"), "utf8"),
};

const env = scrubbed(process.env);

/** Write the files into a new git repository, stage them (git add skips ignored files), delete `removed` from disk, run docs-check.sh on it. */
function docsCheck(files: Record<string, string>, removed: string[] = []) {
  const dir = tempDir("docs-check-");
  for (const [name, text] of Object.entries({ ...repoConfig, ...files })) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  git(dir, env, "init", "-q");
  git(dir, env, "add", "--all");
  for (const name of removed) rmSync(join(dir, name));
  const run = spawnSync(script, [dir], { env, stdio: "pipe", timeout: 60_000 });
  return { status: run.status, output: String(run.stdout) + String(run.stderr) };
}

// The inline code span and the fenced block hold link examples, which the link scan skips.
const clean: Record<string, string> = {
  "AGENTS.md":
    "# Agents\n\nSee [the factory](FACTORY.md) and `[not a link](nowhere.md)`.\n\n```text\n[example](nowhere.md)\n```\n",
  "FACTORY.md": "# Factory\n",
  "README.md": "# Readme\n\nSee [agents](AGENTS.md).\n",
};

test("clean Markdown passes: prettier, the line limits and the relative links", () => {
  const r = docsCheck(clean);
  assert.equal(r.status, 0, r.output);
});

test("a dead relative link and a file over its line limit both fail the check", () => {
  const r = docsCheck({
    ...clean,
    "AGENTS.md": "- item\n".repeat(301),
    "README.md": "# Readme\n\nSee [gone](gone.md).\n",
  });
  assert.equal(r.status, 1);
  assert.match(r.output, /AGENTS\.md has 301 lines; the limit is 300/);
  assert.match(r.output, /README\.md: dead link gone\.md/);
});

test("Markdown that prettier would reformat fails the check", () => {
  const r = docsCheck({ ...clean, "NOTES.md": "*emphasis* instead of underscores\n" });
  assert.equal(r.status, 1);
  assert.match(r.output, /NOTES\.md/);
});

test("a git-ignored Markdown file is not checked: its dead link and bad formatting pass", () => {
  const r = docsCheck({ ...clean, ".gitignore": ".agent/\n", ".agent/HANDOFF.md": "*notes* [gone](gone.md)\n" });
  assert.equal(r.status, 0, r.output);
});

test("a FACTORY.md over its 300-line limit fails the check", () => {
  const r = docsCheck({ ...clean, "FACTORY.md": "- item\n".repeat(301) });
  assert.equal(r.status, 1);
  assert.match(r.output, /FACTORY\.md has 301 lines; the limit is 300/);
});

test("a missing AGENTS.md fails the check with a message that says so", () => {
  const files = { ...clean };
  delete files["AGENTS.md"];
  const r = docsCheck(files);
  assert.equal(r.status, 1);
  assert.match(r.output, /AGENTS\.md is missing/);
});

test("an https link is not treated as a file", () => {
  const r = docsCheck({ ...clean, "README.md": "# Readme\n\nSee [site](https://example.com/guide.md).\n" });
  assert.equal(r.status, 0, r.output);
});

test("an anchor is not checked, but the file it points into is", () => {
  const ok = docsCheck({ ...clean, "README.md": "# Readme\n\nSee [ok](AGENTS.md#no-such-heading).\n" });
  assert.equal(ok.status, 0, ok.output);
  const dead = docsCheck({ ...clean, "README.md": "# Readme\n\nSee [no](gone.md#a).\n" });
  assert.equal(dead.status, 1);
  assert.match(dead.output, /README\.md: dead link gone\.md/);
});

test("a link title is not part of the file name", () => {
  const r = docsCheck({ ...clean, "README.md": '# Readme\n\nSee [ok](AGENTS.md "the factory").\n' });
  assert.equal(r.status, 0, r.output);
});

test("examples in indented or tilde fences are not link-checked", () => {
  // prettier rewrites a tilde fence, so the exit status is not the point here: the link scan's verdict is.
  const r = docsCheck({
    ...clean,
    "AGENTS.md":
      "# Agents\n\n- item:\n\n  ```text\n  [example](nowhere.md)\n  ```\n\n~~~text\n[example](nowhere2.md)\n~~~\n",
  });
  assert.doesNotMatch(r.output, /dead link nowhere/);
});

test("a tracked Markdown file deleted without git rm is not checked", () => {
  const r = docsCheck({ ...clean, "GONE.md": "# Gone\n" }, ["GONE.md"]);
  assert.equal(r.status, 0, r.output);
});

test("an angle-bracket link target with spaces or parentheses is checked: a missing file fails, a present one passes", () => {
  const readme =
    '# Readme\n\nSee [gone](<my gone.md>) and [gone](<gone(1).md>), [a](AGENTS.md#sec), [t](AGENTS.md "t") and [u](<https://example.com/a(1)>).\n';
  const dead = docsCheck({ ...clean, "README.md": readme });
  assert.equal(dead.status, 1, dead.output);
  assert.match(dead.output, /README\.md: dead link my gone\.md/);
  assert.match(dead.output, /README\.md: dead link gone\(1\)\.md/);
  const ok = docsCheck({ ...clean, "my gone.md": "# Gone\n", "gone(1).md": "# Gone\n", "README.md": readme });
  assert.equal(ok.status, 0, ok.output);
});

// A `plugin config ona set` hint tells the user to change a setting. A changed setting applies only after
// `bb plugin reload ona` (server.ts reads its settings once, at load), so the hint's sentence names it.
const settingHintFiles = [
  "README.md",
  "skills/ona-devboxes/SKILL.md",
  "src/setup.ts",
  "src/commands.ts",
  "docs/sync.md",
];

/** The sentence of each `plugin config ona set` hint in `text` that never names `plugin reload ona`. */
function hintsWithoutReload(text: string): string[] {
  const flat = text.replace(/\s+/g, " ");
  return [...flat.matchAll(/plugin config ona set/g)].flatMap((hint) => {
    const rest = flat.slice(hint.index);
    const end = rest.search(/[.!?](?=[ "']|$)/);
    const sentence = end < 0 ? rest : rest.slice(0, end);
    return sentence.includes("plugin reload ona") ? [] : [sentence];
  });
}

test("a `plugin config ona set` hint in the docs or the CLI's text with no `plugin reload ona` in its sentence fails", () => {
  const offenders = settingHintFiles.flatMap((file) =>
    hintsWithoutReload(readFileSync(join(repo, file), "utf8")).map((sentence) => `${file}: ${sentence}`),
  );
  assert.deepEqual(offenders, []);
});

test("the reload check flags a hint whose own sentence lacks the reload (fails if a later sentence counts, or a hint without it passes)", () => {
  assert.equal(hintsWithoutReload("Run `bb plugin config ona set x 1`, then `bb plugin reload ona`.").length, 0);
  assert.equal(hintsWithoutReload("Run `bb plugin config ona set x 1`. Then run `bb plugin reload ona`.").length, 1);
  assert.equal(hintsWithoutReload("Run `bb plugin config ona set x 1`.").length, 1);
});
