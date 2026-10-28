type StatefulParent = HTMLElement & {
  moveBefore(node: Node, child: Node | null): void;
};

type Session = {
  scope: string;
  url: string;
  frame: HTMLIFrameElement;
  anchor: HTMLElement | null;
  closeButton: Element | null;
  panel: HTMLElement | null;
  route: string;
};

export function createEditorSessions() {
  const sessions = new Set<Session>();
  let parking: HTMLDivElement | null = null;
  let stop: (() => void) | null = null;

  function destroy(session: Session) {
    sessions.delete(session);
    session.frame.remove();
    if (sessions.size === 0) {
      parking?.remove();
      parking = null;
    }
  }

  return {
    start(document: Document) {
      stop?.();
      const onClose = (event: Event) => {
        const path = event.composedPath();
        // BB exposes no tab-close lifecycle hook. Match the exact close control
        // captured from this panel, never a global button with the same label.
        for (const session of sessions) {
          if (session.closeButton && path.includes(session.closeButton)) {
            queueMicrotask(() => {
              if (!session.closeButton?.isConnected) destroy(session);
            });
          }
        }
      };
      document.addEventListener("click", onClose, true);
      const observer = new MutationObserver(() => {
        for (const session of sessions) {
          // A thread navigation may reuse the same panel DOM. Drop the old
          // close-control binding before a later visit can resemble a close.
          if (session.route !== document.location.pathname || !session.panel?.isConnected) {
            session.closeButton = null;
            session.panel = null;
          }
          if (
            session.closeButton &&
            !session.closeButton.isConnected &&
            session.panel?.isConnected &&
            session.route === document.location.pathname &&
            session.anchor === null
          ) {
            destroy(session);
          }
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        document.removeEventListener("click", onClose, true);
        observer.disconnect();
        for (const session of [...sessions]) destroy(session);
        parking?.remove();
        parking = null;
        if (stop === dispose) stop = null;
      };
      stop = dispose;
      return dispose;
    },

    attach(scope: string, url: string, anchor: HTMLElement) {
      const document = anchor.ownerDocument;
      if (typeof (anchor as Partial<StatefulParent>).moveBefore !== "function") {
        throw new Error("This browser does not support retaining editor sessions.");
      }
      for (const session of [...sessions]) {
        if (session.scope === scope && session.url !== url && session.anchor === null) {
          destroy(session);
        }
      }
      let session = [...sessions].find(
        (item) => item.scope === scope && item.url === url && item.anchor === null,
      );
      if (!parking) {
        parking = document.createElement("div");
        parking.hidden = true;
        parking.dataset.vscodeSessionParking = "";
        document.body.append(parking);
      }
      if (!session) {
        const frame = document.createElement("iframe");
        frame.title = "VS Code Server";
        frame.src = url;
        frame.className = "h-full w-full border-0 bg-background";
        frame.allow = "clipboard-read; clipboard-write; fullscreen";
        frame.referrerPolicy = "no-referrer";
        session = { scope, url, frame, anchor: null, closeButton: null, panel: null, route: "" };
        sessions.add(session);
        anchor.append(frame);
      } else {
        (anchor as StatefulParent).moveBefore(session.frame, null);
      }
      session.anchor = anchor;
      session.panel = anchor.closest("aside");
      session.route = document.location.pathname;
      session.closeButton = session.panel
        ?.querySelector('[data-tab-pill] button[aria-pressed="true"]')
        ?.closest("[data-tab-pill]")
        ?.querySelector("[data-tab-pill-close]") ?? null;
      const current = session;
      return {
        release() {
          if (!sessions.has(current) || current.anchor !== anchor) return;
          current.anchor = null;
          // React's layout-effect cleanup runs before the panel is detached.
          // appendChild would reload even this same iframe; use an atomic move.
          if (parking?.isConnected && current.frame.isConnected) {
            (parking as unknown as StatefulParent).moveBefore(current.frame, null);
          } else {
            destroy(current);
          }
        },
        destroy() {
          destroy(current);
        },
      };
    },
  };
}

export const editorSessions = createEditorSessions();
