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

/** The new thread's first message: where the work came from, and the old conversation's outline. */
export function handOverMessage(args: { title: string; source: string; path: string; outline: OutlineItem[] }) {
  const lines = [
    `This thread continues thread "${args.title}", moved from devbox ${args.source} at ${args.path}.`,
    `Uncommitted changes stayed on ${args.source}; only what was committed and pushed is here.`,
    "Check the branch and state of the checkout before you go on.",
  ];
  if (args.outline.length > 0) {
    lines.push("", "The old thread's conversation, in outline:");
    for (const item of args.outline) lines.push(`- ${item.role}: ${item.preview}`);
  }
  return lines.join("\n");
}

export function createMove({ sdk, machineOfHost }: MoveDeps) {
  return async function move({ threadId, hostId }: { threadId: string; hostId: string }) {
    const thread = await sdk.threads.get({ threadId });
    const environment = thread.environmentId
      ? await sdk.environments.get({ environmentId: thread.environmentId })
      : null;
    const source = environment ? await machineOfHost(environment.hostId) : null;
    if (!environment || !source) throw new Error(`Thread ${threadId} does not run on an Ona devbox.`);
    const target = await machineOfHost(hostId);
    if (!target) throw new Error(`Machine ${hostId} is not an Ona devbox.`);
    if (environment.hostId === hostId) throw new Error(`The thread already runs on ${target.resource.envName}.`);
    const path = environment.path;
    if (!path) throw new Error(`The thread's workspace has no path to open on ${target.resource.envName}.`);
    const title = thread.title ?? thread.titleFallback ?? threadId;
    // The outline only helps the agent; without one the hand-over names the title alone.
    const outline = await sdk.threads.conversationOutline({ threadId }).then(
      (result) => result.items,
      () => [],
    );
    const prompt = handOverMessage({ title, source: source.resource.envName, path, outline });
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
      throw new Error(`bb could not start the thread on ${target.resource.envName}: ${errorText(error)}`);
    }
  };
}
