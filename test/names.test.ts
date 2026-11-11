import assert from "node:assert/strict";
import { test } from "node:test";
import { envNameForKey, friendlyName, randomFriendlyName } from "../src/names.ts";

// adjective-noun-4 hex chars; the noun list has "yo-yo", so the middle part may carry a hyphen.
const SHAPE = /^[a-z]+-[a-z]+(-[a-z]+)?-[0-9a-f]{4}$/;

test("friendlyName is a pure function of the seed", () => {
  // Pinned: a retried creation must compute the name it gave the box before, to find it.
  assert.equal(friendlyName("thread-1"), "eager-kazoo-c328");
  assert.notEqual(friendlyName("thread-1"), friendlyName("thread-2"));
});

test("friendlyName has the shape adjective-noun-hex and a bounded length", () => {
  for (let i = 0; i < 200; i++) {
    const name = friendlyName(`seed-${i}`);
    assert.match(name, SHAPE);
    assert.ok(name.length <= 20, name);
  }
});

test("randomFriendlyName has the same shape", () => {
  assert.match(randomFriendlyName(), SHAPE);
});

// A changed formula would orphan every box already made with it.
test("envNameForKey keeps its formula, so existing boxes keep their names (fails if the formula changes)", () => {
  assert.equal(envNameForKey("key-1"), "bold-pancake-6978");
});
