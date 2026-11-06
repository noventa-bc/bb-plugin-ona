// The inputs app.tsx sends: the "Ona project" field of the new-thread composer's "New Ona devbox" option, and
// the settings section's devbox_command input (commandArg, devboxCommandInput). app.tsx imports this file, so it
// imports types only (no node modules in the app bundle).
import type { PluginMachineProviderInputsChange } from "@get-bb/plugin-sdk/app";
import type { DevboxCommand } from "./rpc.ts";

// src/provider.ts builds onaRef and PROVIDER_ID from these.
export const ONA_MACHINE_PROVIDER_ID = "ona";
export const ONA_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
export const ONA_NAME_MESSAGE = "use letters, digits, '.', '_' or '-'";

/** What the composer gets for the typed project. A blank field means the defaultProject setting. */
export function projectInputsChange(text: string): PluginMachineProviderInputsChange {
  const project = text.trim();
  if (project === "") return { status: "ready", value: { mode: "create" } };
  if (!ONA_NAME_PATTERN.test(project)) {
    return { status: "blocked", reason: `Invalid project "${project}": ${ONA_NAME_MESSAGE}` };
  }
  return { status: "ready", value: { mode: "create", project } };
}

/** The project a saved value names, for the field to start from. Anything else reads as blank. */
export function projectOfSavedInputs(value: unknown): string {
  const project = (value as { project?: unknown } | null)?.project;
  return typeof project === "string" ? project : "";
}

/** A settings field's text as a devbox command's argument, trimmed. Blank sends none: rename then picks a random
 * name, and keep-alive replies with its usage. */
export function commandArg(text: string): string | undefined {
  return text.trim() || undefined;
}

/** The devbox_command input without its unset keys: bb's RPC client refuses a key whose value is undefined. */
export function devboxCommandInput(command: DevboxCommand, hostId?: string, arg?: string) {
  return { command, ...(hostId === undefined ? {} : { hostId }), ...(arg === undefined ? {} : { arg }) };
}
