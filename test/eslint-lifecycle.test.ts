import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { ESLint } from "eslint";

const repo = join(import.meta.dirname, "..");
// Snippets are linted as this file, which the tsconfig includes, so the type-aware rules can parse them.
const filePath = join(repo, "test", "eslint-lifecycle.test.ts");
const eslint = new ESLint({ cwd: repo });

const NAMES = ["suspend", "resume", "reconcile"];
const HEADS = ["", "await ", "void "];
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
  assert.deepEqual(
    result!.messages.filter((message) => message.fatal),
    [],
    "a snippet does not parse",
  );
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

test("a lifecycle call whose result is kept, returned, passed on, tested or read as a member is not flagged", async () => {
  const lines = [
    "const host = await bb.sdk.hosts.experimental_suspend({ hostId });",
    "const posted = await bb.sdk.hosts.experimental_suspend({ hostId }).catch(onError);",
    "track(bb.sdk.hosts.experimental_suspend({ hostId }).host);",
    "track(bb.sdk.hosts.experimental_suspend({ hostId }).host).then(next);",
    "track(bb.sdk.hosts.experimental_suspend({ hostId }).catch(onError).then(next).host);",
    "track(bb.sdk.hosts.experimental_suspend({ hostId }).catch(onError).then(next).finally(done).host);",
    "await track(bb.sdk.hosts.experimental_suspend({ hostId }).host);",
    "await track(bb.sdk.hosts.experimental_suspend({ hostId }).host).then(next);",
    "await track(bb.sdk.hosts.experimental_suspend({ hostId }).catch(onError).then(next).host);",
    "await track(bb.sdk.hosts.experimental_suspend({ hostId }).catch(onError).then(next).finally(done).host);",
    "void track(bb.sdk.hosts.experimental_suspend({ hostId }).host);",
    "void track(bb.sdk.hosts.experimental_suspend({ hostId }).host).then(next);",
    "export function resume() { return bb.sdk.hosts.experimental_resume({ hostId }); }",
    "track(bb.sdk.hosts.experimental_suspend({ hostId }));",
    "const run = () => bb.sdk.hosts.experimental_resume({ hostId });",
    "const host = bb.sdk.hosts.experimental_suspend({ hostId });",
    "if (bb.sdk.hosts.experimental_suspend({ hostId })) {}",
    "bb.sdk.hosts.experimental_suspend_all({ hostId });", // another name: the rule matches the three names whole
  ];
  assert.deepEqual(await flaggedLines(lines), []);
});
