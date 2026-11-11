import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { ESLint } from "eslint";

const repo = join(import.meta.dirname, "..");
// The selectors are esquery, so each case runs the repo's eslint.config.js on a snippet. The file is one the tsconfig
// includes, so the config's type-aware rules can parse the snippet.
const filePath = join(repo, "test", "eslint-lifecycle.test.ts");
const eslint = new ESLint({ cwd: repo });

const NAMES = ["suspend", "resume", "reconcile"];
const HEADS = ["", "await ", "void "];
// The calls made on the lifecycle result, from none to four.
const CHAINS = [
  "",
  ".catch(onError)",
  ".catch(onError).finally(done)",
  ".then(next).catch(onError).finally(done)",
  ".then(next).catch(onError).finally(done).then(next)",
];

/** The lines of `lines` (one statement each) that the lifecycle rule flags, as their text. */
async function flaggedLines(lines: string[]) {
  const [result] = await eslint.lintText(lines.join("\n"), { filePath });
  return result!.messages
    .filter((message) => message.ruleId === "no-restricted-syntax" && message.message.startsWith("bb can accept this"))
    .map((message) => lines[message.line - 1]!);
}

test("a discarded lifecycle call is flagged after zero to four calls on its result, bare, awaited or void", async () => {
  const lines = NAMES.flatMap((name) =>
    HEADS.flatMap((head) => CHAINS.map((chain) => `${head}bb.sdk.hosts.experimental_${name}({ hostId })${chain};`)),
  );
  assert.deepEqual(await flaggedLines(lines), lines);
});

test("a lifecycle call whose result is kept, returned, passed on or read as a member is not flagged", async () => {
  const lines = [
    "const host = await bb.sdk.hosts.experimental_suspend({ hostId });",
    "const posted = await bb.sdk.hosts.experimental_suspend({ hostId }).catch(onError);",
    "export function resume() { return bb.sdk.hosts.experimental_resume({ hostId }); }",
    "track(bb.sdk.hosts.experimental_suspend({ hostId }));",
    "await track(bb.sdk.hosts.experimental_suspend({ hostId }));",
    "track(bb.sdk.hosts.experimental_suspend({ hostId }).host);",
    "const run = () => bb.sdk.hosts.experimental_resume({ hostId });",
    "const run = () => bb.sdk.hosts.experimental_resume({ hostId }).catch(onError);",
    "items.map(() => bb.sdk.hosts.experimental_suspend({ hostId }).catch(onError));",
  ];
  assert.deepEqual(await flaggedLines(lines), []);
});
