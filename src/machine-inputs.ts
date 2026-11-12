// The inputs app.tsx sends: the "Ona devbox" option of the new-thread composer (create a fresh devbox from an Ona
// project, or adopt an existing Ona environment), and the settings section's devbox_command input (commandArg,
// devboxCommandInput). app.tsx imports this file, so it imports types only (no node modules in the app bundle).
import type { PluginMachineProviderInputsChange } from "@get-bb/plugin-sdk/app";
import type { DevboxCommand } from "./rpc.ts";

// src/provider.ts builds onaRef and PROVIDER_ID from these.
export const ONA_MACHINE_PROVIDER_ID = "ona";
export const ONA_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
export const ONA_NAME_MESSAGE = "use letters, digits, '.', '_' or '-'";

type DevboxMode = "create" | "adopt";

/** What the composer gets for the mode and the typed text. Create: a blank field means the defaultProject setting. */
export function inputsChange(mode: DevboxMode, text: string): PluginMachineProviderInputsChange {
  const typed = text.trim();
  if (typed === "") {
    return mode === "adopt"
      ? { status: "blocked", reason: "Enter the Ona environment to adopt (name or id)" }
      : { status: "ready", value: { mode: "create" } };
  }
  if (!ONA_NAME_PATTERN.test(typed)) {
    const what = mode === "adopt" ? "environment" : "project";
    return { status: "blocked", reason: `Invalid ${what} "${typed}": ${ONA_NAME_MESSAGE}` };
  }
  return { status: "ready", value: mode === "adopt" ? { mode, environment: typed } : { mode, project: typed } };
}

/** The mode and text a saved value starts the field with. Anything but a saved adopt reads as create. */
export function savedInputs(value: unknown): { mode: DevboxMode; text: string } {
  const saved = value as { mode?: unknown; project?: unknown; environment?: unknown } | null;
  if (saved?.mode === "adopt" && typeof saved.environment === "string") {
    return { mode: "adopt", text: saved.environment };
  }
  return { mode: "create", text: typeof saved?.project === "string" ? saved.project : "" };
}

/** The mode and text after a select pick. The text is cleared: typed text belongs to the mode it was typed under. */
export function switchedInputs(selected: string): { mode: DevboxMode; text: string } {
  return { mode: selected === "adopt" ? "adopt" : "create", text: "" };
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
