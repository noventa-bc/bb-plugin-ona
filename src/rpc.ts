// RPCs behind the thread header's Editor button and spend chip, the thread menu's Move to devbox, and the settings section's devbox buttons. app.tsx imports only the contract's type.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const devboxSchema = z.object({
  machine: z.string(),
  hostId: z.string(),
  envId: z.string(),
  envName: z.string(),
  status: z.string(),
  tunnel: z.enum(["up", "connecting", "off"]),
  adopted: z.boolean(),
  sshCommand: z.string(),
});
export type Devbox = z.infer<typeof devboxSchema>;

const threadCostSchema = z.object({
  provider: z.enum(["codex", "claude-code"]),
  usd: z.number(),
  /** openai-estimate: OpenAI's own per-thread figure; list-price: tokens x Anthropic list prices. */
  basis: z.enum(["openai-estimate", "list-price"]),
  /** Some sessions or models couldn't be priced; the real total is higher. */
  partial: z.boolean(),
  updatedAt: z.number(),
});
export type ThreadCost = z.infer<typeof threadCostSchema>;

export const devboxCommandSchema = z.enum(["status", "sync", "reconnect", "resume", "rename", "update"]);
export type DevboxCommand = z.infer<typeof devboxCommandSchema>;

const devboxCommandReplySchema = z.object({
  exitCode: z.number(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
});
export type DevboxCommandReply = z.infer<typeof devboxCommandReplySchema>;

export const rpcContract = defineRpcContract({
  devboxes_list: {
    input: z.null(),
    output: z.object({ devboxes: z.array(devboxSchema) }),
  },
  /** The Ona devbox a thread runs on, or null when it runs elsewhere; `pending` while it has no workspace yet. */
  thread_devbox: {
    input: z.object({ threadId: z.string().min(1) }),
    output: z.object({ devbox: devboxSchema.nullable(), pending: z.boolean().optional() }),
  },
  /** Spend so far for a thread on an Ona devbox, or null (other threads, nothing to price yet). */
  thread_cost: {
    input: z.object({ threadId: z.string().min(1) }),
    output: z.object({ cost: threadCostSchema.nullable() }),
  },
  /** A new thread on another devbox at the same path, handed the work over (src/move.ts). */
  thread_move: {
    input: z.object({ threadId: z.string().min(1), hostId: z.string().min(1) }),
    output: z.object({ threadId: z.string() }),
  },
  devbox_open_editor: {
    input: z.object({ hostId: z.string().min(1) }),
    output: z.object({ opened: z.boolean() }),
  },
  /**
   * The settings section's buttons: a `bb ona` command, as the CLI runs it (src/commands.ts), for one devbox or all,
   * except update, which needs a host id (the refine below).
   */
  devbox_command: {
    input: z
      .object({
        command: devboxCommandSchema,
        // No leading "-": the CLI reads "--" as a flag or as the end of its arguments, and then `sync` acts on every box.
        hostId: z.string().regex(/^[^-]/, "a bb host id").optional(),
        // The new name for `rename`: no leading "-" either. The refine below allows it only for rename and only after
        // a host id, since the CLI reads the first value after the command as the devbox.
        arg: z.string().regex(/^[^-]/, "a name").optional(),
      })
      .refine(
        (input) => input.arg === undefined || (input.hostId !== undefined && input.command === "rename"),
        "arg needs a hostId, and only rename takes one",
      )
      .refine(
        (input) => input.command !== "update" || input.hostId !== undefined,
        "update needs a hostId: without one the CLI updates every devbox",
      ),
    output: devboxCommandReplySchema,
  },
});
