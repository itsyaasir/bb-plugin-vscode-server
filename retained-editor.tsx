import { useLayoutEffect, useRef, useState } from "react";
import { editorSessions } from "./lib/editor-sessions";

export function RetainedEditor({ scope, url }: { scope: string; url: string }) {
  const anchor = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const lease = useRef<ReturnType<typeof editorSessions.attach> | null>(null);
  useLayoutEffect(() => {
    if (!anchor.current) return;
    setError(null);
    try {
      const current = editorSessions.attach(scope, url, anchor.current);
      lease.current = current;
      return () => {
        current.release();
        if (lease.current === current) lease.current = null;
      };
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [scope, url, revision]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {error ? <p role="alert" className="p-3 text-sm text-destructive">{error}</p> : null}
      <div ref={anchor} className="min-h-0 flex-1" data-vscode-editor-scope={scope} />
      <button
        type="button"
        className="h-6 shrink-0 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => {
          if (!window.confirm("Reload this editor session? Save any unsaved work first.")) return;
          lease.current?.destroy();
          setRevision((value) => value + 1);
        }}
      >
        Reload editor
      </button>
    </div>
  );
}
