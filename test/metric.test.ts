// The `metric` log line (src/ona.ts), and gitKnown, which sends a remove to a delete or to a `git=unknown` keep line.
import assert from "node:assert/strict";
import { test } from "node:test";
import { gitKnown, metric, type OnaEnvironment } from "../src/ona.ts";

test("metric turns a value's spaces and = into _, so a value can't split the line (fails if a value is written as it is)", () => {
  assert.equal(metric("cmd", { name: "a b=c\nd" }), "metric cmd name=a_b_c_d");
});

type Git = NonNullable<NonNullable<NonNullable<OnaEnvironment["status"]>["content"]>["git"]>;
const withGit = (git?: Git): OnaEnvironment => ({ id: "env-1", metadata: {}, status: { content: { git } } });

test("gitKnown is true whenever Ona's listing has a git block, counts or not (fails if a clean box reads as unknown, or a box with no git block as known)", () => {
  assert.equal(gitKnown(withGit({ totalUnpushedCommits: 0, totalChangedFiles: 0 })), true);
  assert.equal(gitKnown(withGit({ totalUnpushedCommits: "2", totalChangedFiles: 1 })), true);
  assert.equal(gitKnown(withGit({ branch: "main" })), true, "a clean box: Ona leaves out a zero count");
  assert.equal(gitKnown(withGit()), false, "no git block");
  assert.equal(gitKnown({ id: "env-1", metadata: {} }), false, "no status at all");
});
