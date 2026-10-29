import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { editorSessions } from "./lib/editor-sessions";
import { RetainedEditor } from "./retained-editor";

type ProfileImportStatus = {
  sourceUserDataDirectory: string;
  sourceExtensionsDirectory: string;
  targetUserDataDirectory: string;
  targetExtensionsDirectory: string;
  importedAt: string | null;
  error: string | null;
};

type UrlState =
  | { kind: "loading" }
  | { kind: "detecting" }
  | { kind: "ready"; url: string; profile: ProfileImportStatus | null }
  | { kind: "missing" }
  | { kind: "error"; message: string };

function VsCodeServerContent({ threadId }: { threadId: string | null }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [state, setState] = useState<UrlState>({ kind: "loading" });
  const [isHeaderExpanded, setIsHeaderExpanded] = useState(false);

  const load = useCallback(() => {
    setState({ kind: "loading" });
    rpc.call("vscode_server_url", { threadId }).then(
      ({ url, profile }) =>
        setState(url === null ? { kind: "missing" } : { kind: "ready", url, profile }),
      (cause) =>
        setState({
          kind: "error",
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    );
  }, [rpc, threadId]);

  const discover = useCallback(() => {
    setState({ kind: "detecting" });
    rpc.call("discover_vscode_server_url", { threadId }).then(
      ({ url, profile }) =>
        setState(url === null ? { kind: "missing" } : { kind: "ready", url, profile }),
      (cause) =>
        setState({
          kind: "error",
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    );
  }, [rpc, threadId]);

  useEffect(() => {
    let cancelled = false;
    rpc.call("vscode_server_url", { threadId }).then(
      ({ url, profile }) => {
        if (!cancelled) setState(url === null ? { kind: "missing" } : { kind: "ready", url, profile });
      },
      (cause) => {
        if (!cancelled) setState({ kind: "error", message: cause instanceof Error ? cause.message : String(cause) });
      },
    );
    return () => { cancelled = true; };
  }, [rpc, threadId]);

  if (state.kind === "ready") {
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        <div className="shrink-0 border-b border-border">
          <button
            type="button"
            className="flex h-7 w-full items-center justify-between gap-3 px-3 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            aria-expanded={isHeaderExpanded}
            onClick={() => setIsHeaderExpanded((expanded) => !expanded)}
          >
            <span className="truncate">VS Code Server</span>
            <span>{isHeaderExpanded ? "Hide details" : "Show details"}</span>
          </button>
          {isHeaderExpanded ? (
            <div className="flex items-center justify-between gap-3 border-t border-border px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm text-muted-foreground">{state.url}</p>
                {state.profile === null ? null : <p className={state.profile.error === null ? "truncate text-xs text-muted-foreground" : "truncate text-xs text-destructive"}>
                  {state.profile.error === null
                    ? state.profile.importedAt === null
                      ? `Profile: ${state.profile.targetUserDataDirectory}`
                      : `Profile imported ${new Date(state.profile.importedAt).toLocaleString()}`
                    : state.profile.error}
                </p>}
              </div>
              <button
                type="button"
                className="inline-flex h-8 shrink-0 items-center rounded-md border border-input bg-background px-3 text-sm font-medium text-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                onClick={() => navigate.openUrl(state.url)}
              >
                Open in Browser
              </button>
            </div>
          ) : null}
        </div>
        <RetainedEditor scope={threadId ?? "new-thread"} url={state.url} />
      </div>
    );
  }

  const detail =
    state.kind === "missing"
      ? "Set VS Code Server URL in this plugin’s settings, set VSCODE_SERVER_URL for BB’s server process, or detect a local server on port 8080 or 8000."
      : state.kind === "error"
        ? state.message
        : state.kind === "detecting"
          ? "Detecting a local VS Code Server…"
          : "Loading VS Code Server configuration…";

  return (
    <div className="flex h-full items-center justify-center bg-background p-6">
      <div className="w-full max-w-md space-y-3 rounded-lg border border-border bg-card p-5 shadow-sm">
        <div className="space-y-1">
          <h2 className="text-sm font-medium text-foreground">VS Code Server</h2>
          <p className="text-sm leading-6 text-muted-foreground">{detail}</p>
        </div>
        {state.kind === "loading" || state.kind === "detecting" ? null : state.kind === "missing" ? (
          <button
            type="button"
            className="inline-flex h-8 items-center rounded-md border border-input bg-background px-3 text-sm font-medium text-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
            onClick={discover}
          >
            Detect local server
          </button>
        ) : (
          <button
            type="button"
            className="inline-flex h-8 items-center rounded-md border border-input bg-background px-3 text-sm font-medium text-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
            onClick={load}
          >
            Reload configuration
          </button>
        )}
      </div>
    </div>
  );
}

function ThreadVsCodeServerPanel({ threadId }: { threadId: string }) {
  return <VsCodeServerContent key={threadId} threadId={threadId} />;
}

function NewThreadVsCodeServerPanel() {
  return <VsCodeServerContent threadId={null} />;
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "retained-editor-sessions",
    mount: () => editorSessions.start(document),
  });
  app.slots.experimental_tab({
    context: { kind: "thread" },
    availability: "action",
    id: "vscode-server",
    title: "VS Code",
    icon: "Code",
    component: ThreadVsCodeServerPanel,
    layout: "flush",
    run: ({ openPanel, threadId }) => {
      openPanel({ title: "VS Code", params: { threadId } });
    },
  });
  app.slots.experimental_newThreadPanelAction({
    id: "vscode-server",
    title: "VS Code",
    component: NewThreadVsCodeServerPanel,
    layout: "flush",
    run: ({ openPanel }) => {
      openPanel({ title: "VS Code", params: { source: "new-thread" } });
    },
  });
});
