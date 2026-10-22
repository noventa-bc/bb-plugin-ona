// Friendly devbox names like "brave-otter-3f2a". Derived from a seed so a
// retried creation computes the same name and finds its own environment.
import { createHash, randomBytes } from "node:crypto";

const ADJECTIVES = [
  "amber", "bold", "brave", "breezy", "bright", "calm", "clever", "cosmic", "crisp", "dapper",
  "eager", "fancy", "fuzzy", "gentle", "giddy", "glossy", "jolly", "keen", "lucky", "lunar",
  "merry", "mighty", "misty", "nimble", "noble", "plucky", "quick", "quiet", "rapid", "rustic",
  "sleepy", "snappy", "solar", "spicy", "sunny", "swift", "tidy", "witty", "zany", "zesty",
];

const NOUNS = [
  "otter", "falcon", "badger", "panda", "lynx", "heron", "koala", "walrus", "gecko", "bison",
  "comet", "nebula", "quasar", "meteor", "pulsar", "aurora", "glacier", "canyon", "lagoon", "summit",
  "pancake", "waffle", "noodle", "pretzel", "muffin", "dumpling", "taco", "bagel", "biscuit", "mango",
  "piano", "rocket", "lantern", "compass", "kettle", "anchor", "teapot", "zeppelin", "yo-yo", "kazoo",
];

export function friendlyName(seed: string): string {
  const hash = createHash("sha256").update(seed).digest();
  const adjective = ADJECTIVES[hash.readUInt16BE(0) % ADJECTIVES.length];
  const noun = NOUNS[hash.readUInt16BE(2) % NOUNS.length];
  return `${adjective}-${noun}-${hash.subarray(4, 6).toString("hex")}`;
}

export function randomFriendlyName(): string {
  return friendlyName(randomBytes(16).toString("hex"));
}
