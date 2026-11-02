import assert from "node:assert/strict";
import { test } from "node:test";
import { friendlyName, randomFriendlyName } from "../src/names.ts";

// adjective-noun-4 hex chars; the noun list has "yo-yo", so the middle part may carry a hyphen.
const SHAPE = /^[a-z]+-[a-z]+(-[a-z]+)?-[0-9a-f]{4}$/;

test("friendlyName is a pure function of the seed", () => {
  assert.equal(friendlyName("thread-1"), friendlyName("thread-1"));
  assert.notEqual(friendlyName("thread-1"), friendlyName("thread-2"));
});

test("friendlyName has the shape adjective-noun-hex and a bounded length", () => {
  for (let i = 0; i < 200; i++) {
    const name = friendlyName(`seed-${i}`);
    assert.match(name, SHAPE);
    assert.ok(name.length <= 20, name);
  }
});

test("friendlyName spreads distinct seeds over distinct names", () => {
  const names = new Set(Array.from({ length: 200 }, (_, i) => friendlyName(`seed-${i}`)));
  assert.ok(names.size >= 195, `${names.size} distinct of 200`);
});

test("randomFriendlyName has the same shape", () => {
  assert.match(randomFriendlyName(), SHAPE);
});
