// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEditorSessions } from "./editor-sessions";

// jsdom cannot model browser document preservation. These tests exercise
// session ownership/cleanup; the Electron browser check verifies actual loads.
beforeEach(() => {
  vi.stubGlobal("confirm", () => false);
  Object.defineProperty(HTMLElement.prototype, "moveBefore", {
    configurable: true,
    value(this: HTMLElement, node: Node, before: Node | null) {
      this.insertBefore(node, before);
    },
  });
  history.replaceState({}, "", "/threads/one");
});
afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function panel() {
  const aside = document.createElement("aside");
  aside.innerHTML = '<div data-tab-pill><button aria-pressed="true">VS Code</button><button data-tab-pill-close aria-label="Close VS Code">Close</button></div><div data-anchor></div>';
  document.body.append(aside);
  return {
    aside,
    close: aside.querySelector<HTMLButtonElement>("[data-tab-pill-close]")!,
    anchor: aside.querySelector<HTMLElement>("[data-anchor]")!,
  };
}

describe("retained editor sessions", () => {
  it("cleans up all sessions on plugin unload and tolerates late duplicate disposal", () => {
    const sessions = createEditorSessions();
    const disposeOld = sessions.start(document);
    const one = panel(), two = panel();
    const lease = sessions.attach("one", "http://localhost:8080/?folder=/one", one.anchor);
    sessions.attach("two", "http://localhost:8080/?folder=/two", two.anchor);
    const first = one.anchor.querySelector("iframe")!;
    const second = two.anchor.querySelector("iframe")!;
    lease.release();
    disposeOld();
    expect(first.isConnected).toBe(false);
    expect(second.isConnected).toBe(false);
    const disposeNew = sessions.start(document);
    sessions.attach("one", "http://localhost:8080/?folder=/one", one.anchor);
    const replacement = one.anchor.querySelector("iframe")!;
    disposeOld();
    lease.release();
    expect(replacement.isConnected).toBe(true);
    disposeNew();
    expect(replacement.isConnected).toBe(false);
  });

  it("reattaches the same connected frame after a panel unmount", () => {
    const sessions = createEditorSessions();
    const dispose = sessions.start(document);
    const first = panel();
    const lease = sessions.attach("one", "http://localhost:8080/?folder=/one", first.anchor);
    const frame = first.anchor.querySelector("iframe")!;
    lease.release();
    lease.release();
    first.anchor.remove();
    expect(frame.isConnected).toBe(true);
    const second = panel();
    sessions.attach("one", frame.src, second.anchor);
    expect(second.anchor.querySelector("iframe")).toBe(frame);
    dispose();
    expect(frame.isConnected).toBe(false);
    expect(document.querySelector("[data-vscode-session-parking]")).toBeNull();
  });

  it("keeps workspaces separate and does not steal an editor from another pane", () => {
    const sessions = createEditorSessions();
    const dispose = sessions.start(document);
    const one = panel(), two = panel(), sameThread = panel();
    const a = sessions.attach("one", "http://localhost:8080/?folder=/one", one.anchor);
    const b = sessions.attach("two", "http://localhost:8080/?folder=/two", two.anchor);
    sessions.attach("one", "http://localhost:8080/?folder=/one", sameThread.anchor);
    const first = one.anchor.querySelector("iframe");
    const second = two.anchor.querySelector("iframe");
    expect(first).not.toBe(second);
    expect(first).not.toBe(sameThread.anchor.querySelector("iframe"));
    a.release(); b.release();
    sessions.attach("one", "http://localhost:8080/?folder=/one", one.anchor);
    sessions.attach("two", "http://localhost:8080/?folder=/two", two.anchor);
    expect(one.anchor.querySelector("iframe")).toBe(first);
    expect(two.anchor.querySelector("iframe")).toBe(second);
    dispose();
  });

  it("discards the old parked frame when a thread changes its workspace URL", () => {
    const sessions = createEditorSessions();
    const dispose = sessions.start(document);
    const p = panel();
    const lease = sessions.attach("one", "http://localhost:8080/?folder=/old", p.anchor);
    const old = p.anchor.querySelector("iframe")!;
    lease.release();
    sessions.attach("one", "http://localhost:8080/?folder=/new", p.anchor);
    expect(old.isConnected).toBe(false);
    expect(p.anchor.querySelector("iframe")!.src).toContain("/new");
    dispose();
  });

  it("releases a closed tab without releasing another workspace", async () => {
    const sessions = createEditorSessions();
    const dispose = sessions.start(document);
    const one = panel(), two = panel();
    const lease = sessions.attach("one", "http://localhost:8080/?folder=/one", one.anchor);
    sessions.attach("two", "http://localhost:8080/?folder=/two", two.anchor);
    const first = one.anchor.querySelector("iframe")!;
    const second = two.anchor.querySelector("iframe")!;
    one.close.addEventListener("click", () => { lease.release(); one.close.remove(); });
    one.close.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(first.isConnected).toBe(false);
    expect(second.isConnected).toBe(true);
    dispose();
  });

  it("handles tab removal without a click, including keyboard close", async () => {
    const sessions = createEditorSessions();
    const dispose = sessions.start(document);
    const p = panel();
    const lease = sessions.attach("one", "http://localhost:8080", p.anchor);
    const frame = p.anchor.querySelector("iframe")!;
    const otherCloseButton = document.createElement("button");
    otherCloseButton.setAttribute("aria-label", "Close VS Code");
    p.aside.append(otherCloseButton);
    lease.release();
    p.close.remove();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(frame.isConnected).toBe(false);
    dispose();
  });

  it("does not mistake navigation to another thread for closing the editor", async () => {
    const sessions = createEditorSessions();
    const dispose = sessions.start(document);
    const p = panel();
    const lease = sessions.attach("one", "http://localhost:8080", p.anchor);
    const frame = p.anchor.querySelector("iframe")!;
    history.replaceState({}, "", "/threads/two");
    lease.release();
    p.close.remove();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(frame.isConnected).toBe(true);
    history.replaceState({}, "", "/threads/one");
    p.aside.append(document.createElement("span"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(frame.isConnected).toBe(true);
    dispose();
  });
});
