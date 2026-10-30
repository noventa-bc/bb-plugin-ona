// Thread header for threads that run on an Ona devbox: what the thread has
// spent so far, and an Editor button that opens the box in the Ona editor.
// bb's own terminal panel already covers shells.
import { useEffect, useRef, useState } from "react";
import type { PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import { definePluginApp, experimental_Icon as Icon, useRpc } from "@get-bb/plugin-sdk/app";
import type { Devbox, rpcContract, ThreadCost } from "./src/rpc.ts";

const editorButton = [
  "inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-muted-foreground shadow-sm",
  "transition-colors hover:bg-accent hover:text-foreground",
  "focus-visible:relative focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
].join(" ");

const NATIVE_OPEN_SELECTOR =
  'button[aria-label^="Open workspace in "], button[aria-label="Choose another app to open workspace"]';

/**
 * bb's native "Open in" can't reach Ona devboxes, so hide it in this thread's
 * header while our buttons are shown, and restore it when they go away. bb
 * renders the control late (only once the workspace is ready, e.g. after a
 * devbox wakes up), so keep looking for it with a MutationObserver.
 */
function useHideNativeOpenIn(anchor: React.RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    if (!active || !anchor.current) return;
    const hidden = new Set<HTMLElement>();
    const hide = () => {
      // The nearest ancestor that also holds the native control is this thread's header.
      let header: HTMLElement | null = anchor.current?.parentElement ?? null;
      for (let depth = 0; header && depth < 8 && !header.querySelector(NATIVE_OPEN_SELECTOR); depth++) {
        header = header.parentElement;
      }
      if (!header?.querySelector(NATIVE_OPEN_SELECTOR)) return;
      header.querySelectorAll<HTMLElement>(NATIVE_OPEN_SELECTOR).forEach((button) => {
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
    // Batch bursts of DOM changes (streaming messages) into one check per frame.
    let frame = 0;
    const observer = new MutationObserver(() => {
      if (frame === 0) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          hide();
        });
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      hidden.forEach((control) => {
        control.style.display = "";
      });
    };
  }, [anchor, active]);
}

const costChip =
  "inline-flex h-7 items-center rounded-md border border-border bg-background px-2 text-xs font-medium tabular-nums text-muted-foreground shadow-sm";

function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(usd >= 100 ? 0 : 2)}`;
}

function ago(timestamp: number): string {
  const minutes = Math.round((Date.now() - timestamp) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

/** What this thread has cost so far, refreshed every minute while it's open. */
function ThreadCostChip({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [cost, setCost] = useState<ThreadCost | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      rpc
        .call("thread_cost", { threadId })
        .then(({ cost }) => !cancelled && setCost(cost))
        .catch(() => undefined);
    void load();
    const timer = setInterval(() => void load(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [rpc, threadId]);

  if (!cost) return null;
  const source =
    cost.basis === "openai-estimate" ? "Codex · OpenAI's usage estimate" : "Claude Code · tokens × Anthropic list prices";
  const partial = cost.partial ? " · some usage couldn't be priced, so the real total is higher" : "";
  return (
    <span className={costChip} title={`Spent in this thread so far. ${source} · updated ${ago(cost.updatedAt)}${partial}`}>
      {cost.partial ? "≥" : ""}
      {formatUsd(cost.usd)}
    </span>
  );
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
    <span className="inline-flex items-center gap-1.5">
      <ThreadCostChip threadId={threadId} />
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
    </span>
  );
}

/**
 * Codex warns on every session start when a repo's
 * .codex/config.toml has a setting it ignores (`shell_environment_policy.include`).
 * It is harmless and bb has no way to mute it, so hide those timeline rows.
 * bb renders each warning as its own row with the full text in a title.
 */
const HIDDEN_WARNING_CSS =
  '[data-timeline-row-id*=":op:warning:"]:has([title*="`shell_environment_policy.include` is ignored"]) { display: none !important; }';

function hideKnownWarnings() {
  if (typeof document === "undefined" || document.getElementById("bb-ona-hidden-warnings")) return;
  const style = document.createElement("style");
  style.id = "bb-ona-hidden-warnings";
  style.textContent = HIDDEN_WARNING_CSS;
  document.head.appendChild(style);
}

export default definePluginApp((app) => {
  hideKnownWarnings();
  app.slots.experimental_threadHeaderAction({
    id: "devbox",
    title: "Devbox editor",
    component: DevboxEditor,
  });
});
