import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type * as NodeFsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import plugin, { discoverAndStoreServerUrl, discoverServerUrl, importLocalProfile, withWorkspaceFolder } from "./server";

// Configuring a loopback URL makes the plugin copy the desktop VS Code profile
// and extensions into the code-server directories, and `isDirectory` passes
// whenever those directories exist on the machine running the suite. Left real,
// a test that reaches this path performs a multi-hundred-megabyte copy: slow
// enough to blow the 5s timeout, and it overwrites the code-server profile of
// whoever runs it. Copies between the suite's temp directories stay real, so the
// import tests still exercise a genuine copy.
const copiedProfilePaths = vi.hoisted(() => [] as Array<{ source: string; destination: string }>);
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>();
  const home = process.env.HOME ?? "";
  // Names the directories that belong to the developer rather than the suite.
  const touchesRealProfile = (path: string) => {
    const value = String(path);
    return (
      value.startsWith(`${home}/.local/share/code-server`) ||
      value.startsWith(`${home}/Library/Application Support/Code`) ||
      value.startsWith(`${home}/.vscode`)
    );
  };
  return {
    ...actual,
    cp: vi.fn(async (source: string, destination: string, options?: object) => {
      if (touchesRealProfile(source) || touchesRealProfile(destination)) {
        copiedProfilePaths.push({ source: String(source), destination: String(destination) });
        return;
      }
      return actual.cp(source, destination, options);
    }),
  };
});

describe("VS Code Server configuration", () => {
  it.each([
    ["host_m4", "http://127.0.0.1:8000"],
    ["host_devbox", "https://devbox.example.ts.net:8443"],
  ])("routes an identical workspace path to the editor for %s", async (hostId, serverUrl) => {
    const workspacePath = "/Users/yasirdev/Dev/Consultancy/shipzen";
    const { bb, harness } = createFakePluginHost({
      pluginId: "vscode-server",
      settings: {
        serverUrl: "http://127.0.0.1:8000",
        machineServerUrls: JSON.stringify({
          host_m4: "http://127.0.0.1:8000",
          host_devbox: "https://devbox.example.ts.net:8443",
        }),
      },
      sdk: {
        threads: { get: async () => ({ environmentId: "env_project" }) },
        environments: { get: async () => ({ hostId, path: workspacePath }) },
      },
    });
    await plugin(bb);
    await expect(harness.behavior.callRpc("vscode_server_url", { threadId: "thread_project" }))
      .resolves.toMatchObject({ url: withWorkspaceFolder(serverUrl, workspacePath), profile: null });
  });

  it("does not fall back to the local editor for an unmapped machine", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "vscode-server",
      settings: {
        serverUrl: "http://127.0.0.1:8000",
        machineServerUrls: JSON.stringify({ host_m4: "http://127.0.0.1:8000" }),
      },
      sdk: {
        threads: { get: async () => ({ environmentId: "env_remote" }) },
        environments: { get: async () => ({ hostId: "host_remote", path: "/work/project" }) },
      },
    });
    await plugin(bb);
    await expect(harness.behavior.callRpc("vscode_server_url", { threadId: "thread_remote" }))
      .rejects.toThrow(/No editor URL configured for machine host_remote/);
  });

  it("uses the thread-storage machine when a thread has no environment", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "vscode-server",
      settings: { machineServerUrls: JSON.stringify({ host_devbox: "https://devbox.example.ts.net:8443" }) },
      sdk: {
        threads: {
          get: async () => ({ environmentId: null }),
          storageLocation: async () => ({ hostId: "host_devbox", storageRootPath: "/storage/thread" }),
        },
      },
    });
    await plugin(bb);
    await expect(harness.behavior.callRpc("vscode_server_url", { threadId: "thread_storage" }))
      .resolves.toMatchObject({
        url: withWorkspaceFolder("https://devbox.example.ts.net:8443", "/storage/thread"), profile: null,
      });
  });

  it("routes a pathless environment to the machine owning its storage folder", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "vscode-server",
      settings: { machineServerUrls: JSON.stringify({ host_storage: "https://storage.example.ts.net" }) },
      sdk: {
        environments: { get: async () => ({ hostId: "host_workspace", path: null }) },
        threads: {
          get: async () => ({ environmentId: "env_pathless" }),
          storageLocation: async () => ({ hostId: "host_storage", storageRootPath: "/storage/thread" }),
        },
      },
    });
    await plugin(bb);
    await expect(harness.behavior.callRpc("vscode_server_url", { threadId: "thread_storage" }))
      .resolves.toMatchObject({ url: withWorkspaceFolder("https://storage.example.ts.net", "/storage/thread") });
  });

  it.each(["not json", "[]", '{"host_remote":"file:///work/project"}', '{"host_remote":"https://user:example@example.com"}'])(
    "rejects invalid machine configuration: %s", async (machineServerUrls) => {
      const { bb, harness } = createFakePluginHost({ pluginId: "vscode-server" });
      await plugin(bb);
      await expect(harness.behavior.setSettings({ machineServerUrls })).rejects.toThrow();
    },
  );

  it("normalizes a configured server URL before exposing it to the panel", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "vscode-server",
      settings: { serverUrl: "http://127.0.0.1:8080/" },
    });
    await plugin(bb);

    await expect(harness.behavior.callRpc("vscode_server_url", { threadId: null })).resolves.toMatchObject({
      url: "http://127.0.0.1:8080",
      profile: {
        importedAt: null,
        error: null,
      },
    });
  });

  it("keeps the panel unconfigured when no explicit URL or environment fallback exists", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "vscode-server",
      settings: { serverUrl: "" },
    });
    await plugin(bb);

    await expect(harness.behavior.callRpc("vscode_server_url", { threadId: null })).resolves.toMatchObject({
      url: null,
      profile: {
        importedAt: null,
        error: null,
      },
    });
  });

  it("opens the server at the selected workspace folder", () => {
    expect(withWorkspaceFolder("http://127.0.0.1:8080", "/work/project")).toBe(
      "http://127.0.0.1:8080/?folder=%2Fwork%2Fproject",
    );
  });


  it("captures a local server when the settings switch is enabled and clears it when disabled", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "vscode-server",
      settings: { serverUrl: "" },
    });
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    try {
      await plugin(bb);
      await harness.behavior.setSettings({ autoCaptureLocalServer: true });
      await vi.waitFor(async () => {
        await expect(
          harness.behavior.callRpc("vscode_server_url", { threadId: null }),
        ).resolves.toMatchObject({ url: "http://127.0.0.1:8080" });
      });
      await harness.behavior.setSettings({ autoCaptureLocalServer: false });
      await vi.waitFor(async () => {
        await expect(
          harness.behavior.callRpc("vscode_server_url", { threadId: null }),
        ).resolves.toMatchObject({ url: null });
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("clears every configured setting when the settings switch is disabled", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "vscode-server",
      settings: {
        serverUrl: "http://127.0.0.1:8080",
        autoCaptureLocalServer: true,
        sourceUserDataDirectory: "/source-user",
        sourceExtensionsDirectory: "/source-extensions",
        targetUserDataDirectory: "/target-user",
        targetExtensionsDirectory: "/target-extensions",
      },
    });
    await plugin(bb);

    await harness.behavior.setSettings({ autoCaptureLocalServer: false });
    await vi.waitFor(async () => {
      await expect(
        harness.behavior.callRpc("vscode_server_url", { threadId: null }),
      ).resolves.toMatchObject({
        url: null,
        profile: {
          sourceUserDataDirectory: "",
          sourceExtensionsDirectory: "",
          targetUserDataDirectory: "",
          targetExtensionsDirectory: "",
        },
      });
    });
  });

  it("restores profile paths before panel detection", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "vscode-server",
      settings: {
        serverUrl: "",
        sourceUserDataDirectory: "",
        sourceExtensionsDirectory: "",
        targetUserDataDirectory: "",
        targetExtensionsDirectory: "",
      },
    });
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    try {
      await plugin(bb);
      copiedProfilePaths.length = 0;
      await expect(
        harness.behavior.callRpc("discover_vscode_server_url", { threadId: null }),
      ).resolves.toMatchObject({
        url: "http://127.0.0.1:8080",
        profile: {
          sourceUserDataDirectory: expect.stringMatching(/Code\/User$/),
          sourceExtensionsDirectory: expect.stringMatching(/\.vscode\/extensions$/),
          targetUserDataDirectory: expect.stringMatching(/\.local\/share\/code-server$/),
          targetExtensionsDirectory: expect.stringMatching(/\.local\/share\/code-server\/extensions$/),
        },
      });
      // The point of restoring the paths first: the import that follows has to
      // use the restored directories, not the empty ones the settings held.
      expect(copiedProfilePaths).toEqual([
        {
          source: expect.stringMatching(/Code\/User$/),
          destination: expect.stringMatching(/\.local\/share\/code-server\/User$/),
        },
        {
          source: expect.stringMatching(/\.vscode\/extensions$/),
          destination: expect.stringMatching(/\.local\/share\/code-server\/extensions$/),
        },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("stores a detected loopback URL through its supplied setting writer", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const storeServerUrl = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", fetch);

    try {
      await expect(discoverAndStoreServerUrl(storeServerUrl)).resolves.toBe(
        "http://127.0.0.1:8080",
      );
      expect(storeServerUrl).toHaveBeenCalledWith("http://127.0.0.1:8080");
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("detects a loopback server that exposes the VS Code health endpoint", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    try {
      await expect(discoverServerUrl()).resolves.toBe("http://127.0.0.1:8080");
      expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:8080/healthz", {
        redirect: "error",
        signal: expect.any(AbortSignal),
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("imports a local desktop profile into the configured code-server directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "vscode-server-profile-"));
    const sourceUserDataDirectory = join(root, "Code", "User");
    const sourceExtensionsDirectory = join(root, "extensions");
    const targetUserDataDirectory = join(root, "code-server");
    const targetExtensionsDirectory = join(targetUserDataDirectory, "extensions");

    try {
      await mkdir(sourceUserDataDirectory, { recursive: true });
      await mkdir(sourceExtensionsDirectory, { recursive: true });
      await writeFile(join(sourceUserDataDirectory, "settings.json"), '{"workbench.colorTheme":"Dark Modern"}');
      await writeFile(join(sourceExtensionsDirectory, "theme.txt"), "extension");

      const result = await importLocalProfile("http://127.0.0.1:8080", {
        sourceUserDataDirectory,
        sourceExtensionsDirectory,
        targetUserDataDirectory,
        targetExtensionsDirectory,
        importedAt: null,
        error: null,
      });

      expect(result).toMatchObject({ error: null });
      await expect(readFile(join(targetUserDataDirectory, "User", "settings.json"), "utf8")).resolves.toBe(
        '{"workbench.colorTheme":"Dark Modern"}',
      );
      await expect(readFile(join(targetExtensionsDirectory, "theme.txt"), "utf8")).resolves.toBe("extension");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("imports the configured profile when a URL is saved in plugin settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "vscode-server-settings-"));
    const sourceUserDataDirectory = join(root, "Code", "User");
    const sourceExtensionsDirectory = join(root, "extensions");
    const targetUserDataDirectory = join(root, "code-server");
    const targetExtensionsDirectory = join(targetUserDataDirectory, "extensions");
    const { bb, harness } = createFakePluginHost({
      pluginId: "vscode-server",
      settings: {
        serverUrl: "",
        sourceUserDataDirectory,
        sourceExtensionsDirectory,
        targetUserDataDirectory,
        targetExtensionsDirectory,
      },
    });

    try {
      await mkdir(sourceUserDataDirectory, { recursive: true });
      await mkdir(sourceExtensionsDirectory, { recursive: true });
      await writeFile(join(sourceUserDataDirectory, "settings.json"), '{"editor.minimap.enabled":false}');
      await plugin(bb);
      await harness.behavior.setSettings({ serverUrl: "http://127.0.0.1:8080" });

      await vi.waitFor(async () => {
        await expect(readFile(join(targetUserDataDirectory, "User", "settings.json"), "utf8")).resolves.toBe(
          '{"editor.minimap.enabled":false}',
        );
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
