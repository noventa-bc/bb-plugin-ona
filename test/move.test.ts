import assert from "node:assert/strict";
import { test } from "node:test";
import { onaCommands, usage, type OnaCommandDeps } from "../src/commands.ts";
import { createMove, handOverMessage, remember, type MoveDeps, type OutlineItem } from "../src/move.ts";
import type { Devbox } from "../src/rpc.ts";

// A fake of the bb calls a move makes (MoveDeps): thread t1 on workspace e1 at
// /workspaces/app on host h-src. Hosts h-src and h-dst are Ona devboxes named
// src-box and dst-box; any other host is not. `spawned` records each spawn that
// returned; `spawnCalls` counts every call, and `onSpawn` runs inside each one
// (throw to fail it, or wait to keep it pending).

const OUTLINE: OutlineItem[] = [
  { id: "m1", role: "user", preview: "Fix the login bug", attachmentSummary: null },
  { id: "m2", role: "assistant", preview: "Fixed on branch fix-login", attachmentSummary: null },
];

function world(
  options: {
    environmentId?: string | null;
    path?: string | null;
    onSpawn?: () => Promise<void>;
    /** Runs inside every environment read after the first (hold it to delay a second move's reads). */
    onLaterEnvRead?: () => Promise<void>;
    provisionType?: "managed-worktree" | "personal" | "unmanaged" | null;
    noOutline?: boolean;
    envHost?: string;
    title?: string | null;
    titleFallback?: string | null;
  } = {},
) {
  const spawned: unknown[] = [];
  let spawnCalls = 0;
  let envReads = 0;
  const boxes: Record<string, string> = { "h-src": "src-box", "h-dst": "dst-box" };
  const deps = {
    sdk: {
      threads: {
        get: async () => ({
          projectId: "p1",
          providerId: "codex",
          title: options.title === undefined ? "Login fix" : options.title,
          titleFallback: options.titleFallback ?? null,
          environmentId: options.environmentId === undefined ? "e1" : options.environmentId,
        }),
        conversationOutline: async () => {
          if (options.noOutline) throw new Error("outline unavailable");
          return { items: OUTLINE, maxSeq: 2 };
        },
        spawn: async (args: unknown) => {
          spawnCalls++;
          await options.onSpawn?.();
          spawned.push(args);
          return { id: "t2" };
        },
      },
      environments: {
        get: async () => {
          if (envReads++ > 0) await options.onLaterEnvRead?.();
          return {
            hostId: options.envHost ?? "h-src",
            path: options.path === undefined ? "/workspaces/app" : options.path,
            workspaceProvisionType: options.provisionType ?? null,
          };
        },
      },
    },
    machineOfHost: async (hostId: string) => (boxes[hostId] ? { resource: { envName: boxes[hostId] } } : null),
  } as unknown as MoveDeps;
  return { move: createMove(deps), spawned, spawnCalls: () => spawnCalls };
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

/** Moves t1 to dst-box and returns the spawned title and prompt. */
async function spawnedFor(options: Parameters<typeof world>[0]) {
  const { move, spawned } = world(options);
  await move({ threadId: "t1", hostId: "h-dst" });
  return (spawned as Array<{ title: string; prompt: string }>)[0];
}

test("a thread with no title takes bb's fallback title", async () => {
  const args = await spawnedFor({ title: null, titleFallback: "Fix login" });
  assert.equal(args?.title, "Fix login");
  assert.match(args?.prompt ?? "", /continues thread "Fix login"/);
});

test("an empty title takes bb's fallback title", async () => {
  const args = await spawnedFor({ title: "  ", titleFallback: "Fix login" });
  assert.equal(args?.title, "Fix login");
});

test("a thread with neither a title nor a fallback is named by its id", async () => {
  const args = await spawnedFor({ title: null, titleFallback: null });
  assert.equal(args?.title, "t1");
  assert.match(args?.prompt ?? "", /continues thread "t1"/);
});

test("a thread with no workspace is refused as not on a managed devbox", async () => {
  const { move, spawned } = world({ environmentId: null });
  await assert.rejects(
    move({ threadId: "t1", hostId: "h-dst" }),
    /Thread t1 is not on a devbox this plugin manages right now/,
  );
  assert.deepEqual(spawned, []);
});

test("a thread on a host that is not an Ona devbox is refused", async () => {
  const { move, spawned } = world({ envHost: "h-mac" });
  await assert.rejects(
    move({ threadId: "t1", hostId: "h-dst" }),
    /Thread t1 is not on a devbox this plugin manages right now/,
  );
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

test("a thread in a bb-managed worktree or the personal workspace is refused", async () => {
  for (const [provisionType, name] of [
    ["managed-worktree", "bb-managed worktree"],
    ["personal", "personal workspace"],
  ] as const) {
    const { move, spawnCalls } = world({ provisionType });
    await assert.rejects(
      move({ threadId: "t1", hostId: "h-dst" }),
      new RegExp(`runs in a ${name}, which does not move`),
    );
    assert.equal(spawnCalls(), 0);
  }
});

test("a workspace with no path is refused", async () => {
  const { move, spawned } = world({ path: null });
  await assert.rejects(move({ threadId: "t1", hostId: "h-dst" }), /no path to open on dst-box/);
  assert.deepEqual(spawned, []);
});

test("bb's refusal of the spawn reaches the user with its message", async () => {
  const { move } = world({
    onSpawn: async () => {
      throw new Error("Path /workspaces/app does not exist");
    },
  });
  await assert.rejects(
    move({ threadId: "t1", hostId: "h-dst" }),
    /could not start the thread on dst-box: Path \/workspaces\/app does not exist/,
  );
});

test("a spawn that times out while bb starts the box says the thread is coming, not that the move failed", async () => {
  const timeout = Object.assign(new Error("request timed out after 75000ms"), { name: "BbRequestTimeoutError" });
  const { move, spawnCalls } = world({
    onSpawn: async () => {
      throw timeout;
    },
  });
  const starting =
    /^Error: bb is still starting dst-box; the new thread should appear in the project once it is up\. Do not move it again\.$/;
  await assert.rejects(move({ threadId: "t1", hostId: "h-dst" }), starting);
  // bb is still creating that thread, so a second move is refused the same way and spawns nothing.
  await assert.rejects(move({ threadId: "t1", hostId: "h-dst" }), starting);
  assert.equal(spawnCalls(), 1);
});

test("a second move while the first spawn is pending is refused, and spawn runs once", async () => {
  let release = () => {};
  let started = () => {};
  const spawnStarted = new Promise<void>((resolve) => (started = resolve));
  const { move, spawnCalls } = world({
    onSpawn: () =>
      new Promise<void>((resolve) => {
        release = resolve;
        started();
      }),
  });
  const first = move({ threadId: "t1", hostId: "h-dst" });
  await spawnStarted;
  await assert.rejects(move({ threadId: "t1", hostId: "h-dst" }), /a move of this thread is still in progress/i);
  release();
  assert.deepEqual(await first, { threadId: "t2" });
  assert.equal(spawnCalls(), 1);
});

test("a second move whose reads finish after the first spawn returned is still refused", async () => {
  let releaseSecond = () => {};
  const secondHeld = new Promise<void>((resolve) => (releaseSecond = resolve));
  const { move, spawnCalls } = world({ onLaterEnvRead: () => secondHeld });
  const first = move({ threadId: "t1", hostId: "h-dst" });
  const second = move({ threadId: "t1", hostId: "h-dst" });
  assert.deepEqual(await first, { threadId: "t2" });
  releaseSecond();
  await assert.rejects(second, /a move of this thread is still in progress/i);
  assert.equal(spawnCalls(), 1);
});

test("a spawn that fails with another error lets a retry spawn again", async () => {
  let failures = 1;
  const { move, spawned, spawnCalls } = world({
    onSpawn: async () => {
      if (failures-- > 0) throw new Error("host unavailable");
    },
  });
  await assert.rejects(move({ threadId: "t1", hostId: "h-dst" }), /host unavailable/);
  assert.deepEqual(await move({ threadId: "t1", hostId: "h-dst" }), { threadId: "t2" });
  assert.equal(spawnCalls(), 2);
  assert.equal(spawned.length, 1);
});

test("the hand-over message keeps the first outline item and the last 99, and says how many it left out", () => {
  const outline = Array.from({ length: 101 }, (_, i): OutlineItem => ({
    id: `m${i}`,
    role: "user",
    preview: `message ${i}`,
    attachmentSummary: null,
  }));
  const text = handOverMessage({ title: "Login fix", source: "src-box", path: "/workspaces/app", outline });
  const kept = Array.from({ length: 99 }, (_, i) => `- user: message ${i + 2}`);
  assert.ok(
    text.endsWith(["- user: message 0", "(1 earlier message left out.)", ...kept].join("\n")),
    "item 0, the note, then items 2 to 100",
  );
  assert.doesNotMatch(text, /message 1\n/);
});

test("the hand-over message names the source, says uncommitted changes stayed, and lists the outline", () => {
  assert.equal(
    handOverMessage({ title: "Login fix", source: "src-box", path: "/workspaces/app", outline: OUTLINE }),
    [
      'This thread continues thread "Login fix", moved from devbox src-box at /workspaces/app.',
      "Uncommitted changes stayed on src-box. This box has its own clone: commits from src-box are here only once pushed, after you fetch that branch.",
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

const BOX = { hostId: "h-dst", envName: "dst-box" } as Devbox;

test("remember skips a pending null, so the thread is asked again", () => {
  const known = {};
  assert.equal(remember(known, "t2", { devbox: null, pending: true }), known);
  assert.deepEqual(remember(known, "t2", { devbox: BOX }), { t2: BOX });
  assert.deepEqual(remember(known, "t3", { devbox: null }), { t3: null }, "a settled null is kept");
});

test("remember keeps an entry already stored, such as the box a move placed", () => {
  const known = { t2: BOX };
  assert.equal(remember(known, "t2", { devbox: null }), known);
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
