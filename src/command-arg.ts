// A settings-section field's text as a devbox command's argument. app.tsx runs it in the browser, so this file
// imports nothing: src/rpc.ts imports the SDK and zod, which the app bundle must not load.

/** The field's text, trimmed; blank gives undefined, so no argument is sent and the CLI picks its default. */
export function commandArg(text: string): string | undefined {
  return text.trim() || undefined;
}
