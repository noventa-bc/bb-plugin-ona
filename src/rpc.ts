// RPCs behind the thread header's Editor button and spend chip. app.tsx imports only the contract's type.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const devboxSchema = z.object({
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

export const threadCostSchema = z.object({
  provider: z.enum(["codex", "claude-code"]),
  usd: z.number(),
  /** openai-estimate: OpenAI's own per-thread figure; list-price: tokens x Anthropic list prices. */
  basis: z.enum(["openai-estimate", "list-price"]),
  /** Some sessions or models couldn't be priced; the real total is higher. */
  partial: z.boolean(),
  updatedAt: z.number(),
});
export type ThreadCost = z.infer<typeof threadCostSchema>;

export const rpcContract = defineRpcContract({
  devboxes_list: {
    input: z.null(),
    output: z.object({ devboxes: z.array(devboxSchema) }),
  },
  /** The Ona devbox a thread runs on, or null when it runs elsewhere. */
  thread_devbox: {
    input: z.object({ threadId: z.string().min(1) }),
    output: z.object({ devbox: devboxSchema.nullable() }),
  },
  /** Spend so far for a thread on an Ona devbox, or null (other threads, nothing to price yet). */
  thread_cost: {
    input: z.object({ threadId: z.string().min(1) }),
    output: z.object({ cost: threadCostSchema.nullable() }),
  },
  devbox_open_editor: {
    input: z.object({ hostId: z.string().min(1) }),
    output: z.object({ opened: z.boolean() }),
  },
});
