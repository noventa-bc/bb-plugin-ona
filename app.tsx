// Thread header Editor button for threads that run on an Ona devbox: opens the
// box in the Ona editor. bb's own terminal panel already covers shells.
import { useEffect, useRef, useState } from "react";
import type { PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import { definePluginApp, experimental_Icon as Icon, useRpc } from "@get-bb/plugin-sdk/app";
import type { Devbox, rpcContract } from "./src/rpc.ts";

const editorButton = [
  "inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-muted-foreground shadow-sm",
  "transition-colors hover:bg-accent hover:text-foreground",
  "focus-visible:relative focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
].join(" ");

const NATIVE_OPEN_SELECTOR =
  'button[aria-label^="Open workspace in "], button[aria-label="Choose another app to open workspace"]';

/**
 * bb's native "Open in" can't reach Ona devboxes, so hide it in this thread's
 * header while our buttons are shown, and restore it when they go away. The
 * header re-renders, so keep re-applying with a MutationObserver.
 */
function useHideNativeOpenIn(anchor: React.RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    if (!active || !anchor.current) return;
    // Climb to the nearest ancestor that also holds the native control: this thread's header.
    let header: HTMLElement | null = anchor.current.parentElement;
    for (let depth = 0; header && depth < 8 && !header.querySelector(NATIVE_OPEN_SELECTOR); depth++) {
      header = header.parentElement;
    }
    if (!header) return;
    const hidden = new Set<HTMLElement>();
    const hide = () => {
      header!.querySelectorAll<HTMLElement>(NATIVE_OPEN_SELECTOR).forEach((button) => {
        // The control is a span holding the split button; hide the whole span.
        const control = button.closest<HTMLElement>("span.inline-flex") ?? button;
        if (control.contains(anchor.current)) return;
        if (control.style.display !== "none") {
          control.style.display = "none";
          hidden.add(control);
        }
      });
    };
    hide();
    const observer = new MutationObserver(hide);
    observer.observe(header, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      hidden.forEach((control) => {
        control.style.display = "";
      });
    };
  }, [anchor, active]);
}

function DevboxEditor({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [devbox, setDevbox] = useState<Devbox | null>(null);
  const root = useRef<HTMLButtonElement>(null);
  useHideNativeOpenIn(root, devbox !== null);

  useEffect(() => {
    let cancelled = false;
    rpc
      .call("thread_devbox", { threadId })
      .then(({ devbox }) => !cancelled && setDevbox(devbox))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [rpc, threadId]);

  if (!devbox) return null;
  return (
    <button
      ref={root}
      type="button"
      className={editorButton}
      aria-label={`Open ${devbox.envName} in the Ona editor`}
      title={`Open ${devbox.envName} in your Ona editor`}
      onClick={() => void rpc.call("devbox_open_editor", { hostId: devbox.hostId })}
    >
      <Icon name="Code" fallback="SquarePen" className="size-3.5" aria-hidden />
      {!isCompactViewport && <span>Editor</span>}
    </button>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadHeaderAction({
    id: "devbox",
    title: "Devbox editor",
    component: DevboxEditor,
  });
});
