// The `metric` log line (src/ona.ts) and the git=known|unknown flag that a delete's line carries.
import assert from "node:assert/strict";
import { test } from "node:test";
import { gitKnown, metric, type OnaEnvironment } from "../src/ona.ts";

test("metric writes the event, then key=value pairs in the order given (fails if the pairs are sorted or dropped)", () => {
  assert.equal(metric("start", { env: "env-1", via: "resume", up: 41 }), "metric start env=env-1 via=resume up=41");
  assert.equal(metric("cmd", { name: "sync" }), "metric cmd name=sync");
});

test("metric turns a value's spaces and = into _, so a value can't split the line (fails if a value is written as it is)", () => {
  assert.equal(metric("cmd", { name: "a b=c\nd" }), "metric cmd name=a_b_c_d");
});

type Git = NonNullable<NonNullable<NonNullable<OnaEnvironment["status"]>["content"]>["git"]>;
const withGit = (git?: Git): OnaEnvironment => ({ id: "env-1", metadata: {}, status: { content: { git } } });

test("gitKnown is true only when Ona gives both git counts (fails if a box missing a count reads as known)", () => {
  assert.equal(gitKnown(withGit({ totalUnpushedCommits: 0, totalChangedFiles: 0 })), true);
  assert.equal(gitKnown(withGit({ totalUnpushedCommits: "2", totalChangedFiles: 1 })), true);
  assert.equal(gitKnown(withGit({ branch: "main" })), false, "no counts");
  assert.equal(gitKnown(withGit({ totalUnpushedCommits: 0 })), false, "no file count");
  assert.equal(
    gitKnown(withGit({ totalUnpushedCommits: "lots", totalChangedFiles: 0 })),
    false,
    "a count that isn't a number",
  );
  assert.equal(gitKnown({ id: "env-1", metadata: {} }), false, "no status at all");
});
