// Move a thread to another Ona devbox: a new thread on the target box at the
// same path, whose first message hands the work over. bb refuses a fork onto
// another host (docs/ona-notes.md), so this is a plain spawn; the source thread
// stays as it is. bb resumes a stopped target itself, as the user's own action
// (decision 0002); the plugin resumes nothing.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { errorText } from "./ona.ts";

type Sdk = BbPluginApi["sdk"];

/** The parts of bb's plugin API a move uses; the real `bb.sdk` satisfies it. */
export interface MoveDeps {
  sdk: {
    threads: Pick<Sdk["threads"], "get" | "spawn" | "conversationOutline">;
    environments: Pick<Sdk["environments"], "get">;
  };
  /** The Ona devbox behind a bb host, or null for any other host. */
  machineOfHost(hostId: string): Promise<{ resource: { envName: string } } | null>;
}

export type OutlineItem = Awaited<ReturnType<Sdk["threads"]["conversationOutline"]>>["items"][number];

// shortcut: the outline keeps its first item and the last 99 (bb caps each preview, not their count:
// docs/ona-notes.md), upgrade if hand-overs need more of a long thread's middle.
const OUTLINE_MAX_ITEMS = 100;

/** The new thread's first message: where the work came from, and the old conversation's latest outline. */
export function handOverMessage(args: { title: string; source: string; path: string; outline: OutlineItem[] }) {
  const lines = [
    `This thread continues thread "${args.title}", moved from devbox ${args.source} at ${args.path}.`,
    `Uncommitted changes stayed on ${args.source}. This box has its own clone: commits from ${args.source} are here only once pushed, after you fetch that branch.`,
    "Check the branch and state of the checkout before you go on.",
  ];
  if (args.outline.length > 0) {
    lines.push("", "The old thread's conversation, in outline:");
    const leftOut = Math.max(0, args.outline.length - OUTLINE_MAX_ITEMS);
    for (const [index, item] of args.outline.entries()) {
      if (index === 1 && leftOut > 0) lines.push(`(${leftOut} earlier messages left out.)`);
      if (index === 0 || index > leftOut) lines.push(`- ${item.role}: ${item.preview}`);
    }
  }
  return lines.join("\n");
}

const IN_PROGRESS = "A move of this thread is still in progress; wait for the new thread to appear.";

export function createMove({ sdk, machineOfHost }: MoveDeps) {
  /** Threads with a move bb has not finished: thread id -> the refusal a second move gets. */
  const inFlight = new Map<string, string>();
  return async function move({ threadId, hostId }: { threadId: string; hostId: string }) {
    const thread = await sdk.threads.get({ threadId });
    const environment = thread.environmentId
      ? await sdk.environments.get({ environmentId: thread.environmentId })
      : null;
    const source = environment ? await machineOfHost(environment.hostId) : null;
    if (!environment || !source)
      throw new Error(`Thread ${threadId} is not on a devbox this plugin manages right now.`);
    const target = await machineOfHost(hostId);
    if (!target) throw new Error(`Machine ${hostId} is not an Ona devbox.`);
    if (environment.hostId === hostId) throw new Error(`The thread already runs on ${target.resource.envName}.`);
    // bb sets this only for its default providers; any other provider reads null, so null is not refused.
    const kind = environment.workspaceProvisionType;
    if (kind === "managed-worktree" || kind === "personal") {
      throw new Error(
        `The thread runs in a ${kind === "personal" ? "personal workspace" : "bb-managed worktree"}, which does not move; only a thread at a checkout path on the box can.`,
      );
    }
    const path = environment.path;
    if (!path) throw new Error(`The thread's workspace has no path to open on ${target.resource.envName}.`);
    const title = thread.title?.trim() || thread.titleFallback?.trim() || threadId;
    // The outline only helps the agent; without one the hand-over names the title alone.
    const outline = await sdk.threads.conversationOutline({ threadId }).then(
      (result) => result.items,
      () => [],
    );
    const prompt = handOverMessage({ title, source: source.resource.envName, path, outline });
    // Shared by the menu, `bb ona move`, other windows and reloads: a second spawn would make a second thread.
    const refusal = inFlight.get(threadId);
    if (refusal) throw new Error(refusal);
    inFlight.set(threadId, IN_PROGRESS);
    let timedOut = false;
    try {
      const created = await sdk.threads.spawn({
        projectId: thread.projectId,
        // The moved thread keeps its agent kind; without it bb picks the project's default.
        providerId: thread.providerId,
        title,
        environment: { type: "host", hostId, workspace: { type: "unmanaged", path } },
        prompt,
      });
      return { threadId: created.id };
    } catch (error) {
      // The SDK client gives up while bb goes on with the request (docs/ona-notes.md), so bb still creates the thread.
      if (error instanceof Error && error.name === "BbRequestTimeoutError") {
        timedOut = true;
        const starting = `bb is still starting ${target.resource.envName}; the new thread should appear in the project once it is up. Do not move it again.`;
        inFlight.set(threadId, starting);
        throw new Error(starting);
      }
      throw new Error(`bb could not start the thread on ${target.resource.envName}: ${errorText(error)}`);
    } finally {
      if (!timedOut) inFlight.delete(threadId);
    }
  };
}
