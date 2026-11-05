import assert from "node:assert/strict";
import { test } from "node:test";
import { onaCommands, usage, type OnaCommandDeps } from "../src/commands.ts";
import { createMove, handOverMessage, type MoveDeps, type OutlineItem } from "../src/move.ts";

// A fake of the bb calls a move makes (MoveDeps): thread t1 on workspace e1 at
// /workspaces/app on host h-src. Hosts h-src and h-dst are Ona devboxes named
// src-box and dst-box; any other host is not. `spawned` records each spawn.

const OUTLINE: OutlineItem[] = [
  { id: "m1", role: "user", preview: "Fix the login bug", attachmentSummary: null },
  { id: "m2", role: "assistant", preview: "Fixed on branch fix-login", attachmentSummary: null },
];

function world(
  options: {
    environmentId?: string | null;
    path?: string | null;
    spawnError?: Error;
    noOutline?: boolean;
    envHost?: string;
  } = {},
) {
  const spawned: unknown[] = [];
  const boxes: Record<string, string> = { "h-src": "src-box", "h-dst": "dst-box" };
  const deps = {
    sdk: {
      threads: {
        get: async () => ({
          projectId: "p1",
          providerId: "codex",
          title: "Login fix",
          titleFallback: null,
          environmentId: options.environmentId === undefined ? "e1" : options.environmentId,
        }),
        conversationOutline: async () => {
          if (options.noOutline) throw new Error("outline unavailable");
          return { items: OUTLINE, maxSeq: 2 };
        },
        spawn: async (args: unknown) => {
          if (options.spawnError) throw options.spawnError;
          spawned.push(args);
          return { id: "t2" };
        },
      },
      environments: {
        get: async () => ({
          hostId: options.envHost ?? "h-src",
          path: options.path === undefined ? "/workspaces/app" : options.path,
        }),
      },
    },
    machineOfHost: async (hostId: string) => (boxes[hostId] ? { resource: { envName: boxes[hostId] } } : null),
  } as unknown as MoveDeps;
  return { move: createMove(deps), spawned };
}

test("a move spawns a thread on the target box at the same path with the hand-over message", async () => {
  const { move, spawned } = world();
  assert.deepEqual(await move({ threadId: "t1", hostId: "h-dst" }), { threadId: "t2" });
  assert.deepEqual(spawned, [
    {
      projectId: "p1",
      providerId: "codex",
      title: "Login fix",
      environment: { type: "host", hostId: "h-dst", workspace: { type: "unmanaged", path: "/workspaces/app" } },
      prompt: handOverMessage({ title: "Login fix", source: "src-box", path: "/workspaces/app", outline: OUTLINE }),
    },
  ]);
});

test("a thread whose outline bb can't give is still moved, with the title alone", async () => {
  const { move, spawned } = world({ noOutline: true });
  await move({ threadId: "t1", hostId: "h-dst" });
  const [args] = spawned as Array<{ prompt: string }>;
  assert.equal(
    args?.prompt,
    handOverMessage({ title: "Login fix", source: "src-box", path: "/workspaces/app", outline: [] }),
  );
});

test("a thread with no workspace is refused as not on an Ona devbox", async () => {
  const { move, spawned } = world({ environmentId: null });
  await assert.rejects(move({ threadId: "t1", hostId: "h-dst" }), /Thread t1 does not run on an Ona devbox/);
  assert.deepEqual(spawned, []);
});

test("a thread on a host that is not an Ona devbox is refused", async () => {
  const { move, spawned } = world({ envHost: "h-mac" });
  await assert.rejects(move({ threadId: "t1", hostId: "h-dst" }), /Thread t1 does not run on an Ona devbox/);
  assert.deepEqual(spawned, []);
});

test("a target host that is not an Ona devbox is refused", async () => {
  const { move, spawned } = world();
  await assert.rejects(move({ threadId: "t1", hostId: "h-mac" }), /Machine h-mac is not an Ona devbox/);
  assert.deepEqual(spawned, []);
});

test("a move to the thread's own box is refused", async () => {
  const { move, spawned } = world();
  await assert.rejects(move({ threadId: "t1", hostId: "h-src" }), /already runs on src-box/);
  assert.deepEqual(spawned, []);
});

test("a workspace with no path is refused", async () => {
  const { move, spawned } = world({ path: null });
  await assert.rejects(move({ threadId: "t1", hostId: "h-dst" }), /no path to open on dst-box/);
  assert.deepEqual(spawned, []);
});

test("bb's refusal of the spawn reaches the user with its message", async () => {
  const { move } = world({ spawnError: new Error("Path /workspaces/app does not exist") });
  await assert.rejects(
    move({ threadId: "t1", hostId: "h-dst" }),
    /could not start the thread on dst-box: Path \/workspaces\/app does not exist/,
  );
});

test("a spawn that times out while bb starts the box says the thread is coming, not that the move failed", async () => {
  const timeout = Object.assign(new Error("request timed out after 75000ms"), { name: "BbRequestTimeoutError" });
  const { move } = world({ spawnError: timeout });
  await assert.rejects(
    move({ threadId: "t1", hostId: "h-dst" }),
    /^Error: bb is still starting dst-box; the new thread appears in the project once it is up\. Do not move it again\.$/,
  );
});

test("the hand-over message keeps only the latest 100 outline items", () => {
  const outline = Array.from({ length: 101 }, (_, i): OutlineItem => ({
    id: `m${i}`,
    role: "user",
    preview: `message ${i}`,
    attachmentSummary: null,
  }));
  const text = handOverMessage({ title: "Login fix", source: "src-box", path: "/workspaces/app", outline });
  assert.doesNotMatch(text, /- user: message 0\n/);
  assert.match(text, /- user: message 1\n/);
  assert.match(text, /- user: message 100$/);
});

test("the hand-over message names the source, says uncommitted changes stayed, and lists the outline", () => {
  assert.equal(
    handOverMessage({ title: "Login fix", source: "src-box", path: "/workspaces/app", outline: OUTLINE }),
    [
      'This thread continues thread "Login fix", moved from devbox src-box at /workspaces/app.',
      "Uncommitted changes stayed on src-box; only what was committed and pushed is here.",
      "Check the branch and state of the checkout before you go on.",
      "",
      "The old thread's conversation, in outline:",
      "- user: Fix the login bug",
      "- assistant: Fixed on branch fix-login",
    ].join("\n"),
  );
});

test("without an outline the hand-over message names the thread alone", () => {
  const text = handOverMessage({ title: "Login fix", source: "src-box", path: "/workspaces/app", outline: [] });
  assert.doesNotMatch(text, /outline/);
  assert.match(text, /continues thread "Login fix"/);
});

// `bb ona move`: only the machine lookup and the move are faked; one machine, ona:box on host_1.
function cli() {
  const moves: string[] = [];
  const run = onaCommands({
    findMachine: async (ref: string) => (ref === "box" ? { hostId: "host_1", machine: "ona:box" } : null),
    move: async ({ threadId, hostId }: { threadId: string; hostId: string }) => {
      moves.push(`${threadId} -> ${hostId}`);
      return { threadId: "thr_2" };
    },
  } as unknown as OnaCommandDeps);
  return { moves, run: (...argv: string[]) => run(argv, {}) };
}

test("bb ona move <thread-id> <ref> moves the thread to the named machine's host", async () => {
  const { run, moves } = cli();
  assert.deepEqual(await run("move", "thr_1", "box"), {
    exitCode: 0,
    stdout: "Started thr_2 on ona:box; thr_1 stays as it is.",
  });
  assert.deepEqual(moves, ["thr_1 -> host_1"]);
});

test("bb ona move refuses a devbox no Ona machine matches, and a missing argument", async () => {
  const { run, moves } = cli();
  assert.deepEqual(await run("move", "thr_1", "elsewhere"), {
    exitCode: 1,
    stderr: 'No Ona-backed bb machine matches "elsewhere".',
  });
  assert.deepEqual(await run("move", "thr_1"), { exitCode: 1, stderr: usage });
  assert.deepEqual(moves, []);
});
