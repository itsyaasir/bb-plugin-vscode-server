import { cp, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const profileImportStatusSchema = z.object({
  sourceUserDataDirectory: z.string(),
  sourceExtensionsDirectory: z.string(),
  targetUserDataDirectory: z.string(),
  targetExtensionsDirectory: z.string(),
  importedAt: z.string().datetime().nullable(),
  error: z.string().nullable(),
});

const configuredUrlSchema = z.object({
  url: z.string().url().nullable(),
  profile: profileImportStatusSchema.nullable(),
});

type ProfileImportStatus = z.infer<typeof profileImportStatusSchema>;

const loopbackCandidates = ["http://127.0.0.1:8080", "http://127.0.0.1:8000"];
const homeDirectory = homedir();
const defaultSourceUserDataDirectory = resolve(homeDirectory, "Library/Application Support/Code/User");
const defaultSourceExtensionsDirectory = resolve(homeDirectory, ".vscode/extensions");
const defaultTargetUserDataDirectory = resolve(homeDirectory, ".local/share/code-server");
const defaultTargetExtensionsDirectory = resolve(homeDirectory, ".local/share/code-server/extensions");


export const rpcContract = defineRpcContract({
  vscode_server_url: {
    input: z.object({ threadId: z.string().min(1).nullable() }),
    output: configuredUrlSchema,
  },
  discover_vscode_server_url: {
    input: z.object({ threadId: z.string().min(1).nullable() }),
    output: configuredUrlSchema,
  },
});

function normalizeServerUrl(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;

  try {
    const url = new URL(trimmed);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== ""
    ) {
      return null;
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function parseMachineServerUrls(value: string): Record<string, string> {
  if (value.trim() === "") return {};
  let entries: Record<string, string>;
  try {
    entries = z.record(z.string().min(1), z.string()).parse(JSON.parse(value));
  } catch {
    throw new Error("Editor URLs by machine must be a JSON object mapping machine IDs to HTTP(S) URLs.");
  }
  return Object.fromEntries(Object.entries(entries).map(([hostId, value]) => {
    const url = normalizeServerUrl(value);
    if (url === null) throw new Error(`Invalid editor URL for machine ${hostId}. Use an HTTP(S) URL without embedded credentials.`);
    return [hostId, url];
  }));
}

export function withWorkspaceFolder(serverUrl: string, workspacePath: string): string {
  const url = new URL(serverUrl);
  url.searchParams.set("folder", workspacePath);
  return url.toString();
}

function isLoopbackUrl(url: string): boolean {
  const hostname = new URL(url).hostname;
  return hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost";
}

function normalizeDirectory(value: string): string {
  const trimmed = value.trim();
  return trimmed === "" ? "" : resolve(trimmed);
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export async function discoverServerUrl(): Promise<string | null> {
  for (const url of loopbackCandidates) {
    try {
      const response = await fetch(`${url}/healthz`, {
        redirect: "error",
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) return url;
    } catch {}
  }
  return null;
}

export async function discoverAndStoreServerUrl(
  storeServerUrl: (url: string) => Promise<void>,
): Promise<string | null> {
  const url = await discoverServerUrl();
  if (url !== null) await storeServerUrl(url);
  return url;
}

function createProfileStatus(
  sourceUserDataDirectory: string,
  sourceExtensionsDirectory: string,
  targetUserDataDirectory: string,
  targetExtensionsDirectory: string,
): ProfileImportStatus {
  return {
    sourceUserDataDirectory,
    sourceExtensionsDirectory,
    targetUserDataDirectory,
    targetExtensionsDirectory,
    importedAt: null,
    error: null,
  };
}

export async function importLocalProfile(
  url: string,
  profile: ProfileImportStatus,
): Promise<ProfileImportStatus> {
  if (!isLoopbackUrl(url)) {
    return {
      ...profile,
      error: "Profile import is available only for a local VS Code Server URL.",
    };
  }

  if (
    !(await isDirectory(profile.sourceUserDataDirectory)) ||
    !(await isDirectory(profile.sourceExtensionsDirectory))
  ) {
    return {
      ...profile,
      error: "The configured desktop VS Code profile or extensions directory was not found.",
    };
  }

  try {
    await cp(profile.sourceUserDataDirectory, resolve(profile.targetUserDataDirectory, "User"), {
      recursive: true,
      force: true,
    });
    await cp(profile.sourceExtensionsDirectory, profile.targetExtensionsDirectory, {
      recursive: true,
      force: true,
    });
    return { ...profile, importedAt: new Date().toISOString(), error: null };
  } catch (cause) {
    return {
      ...profile,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    serverUrl: {
      type: "string",
      label: "VS Code Server URL",
      description:
        "The http(s) URL of code-server or VS Code Server. Saving a local URL imports the configured desktop profile. Overrides VSCODE_SERVER_URL.",
      default: "",
    },
    machineServerUrls: {
      type: "string",
      label: "Editor URLs by machine",
      description: "JSON mapping BB machine IDs to browser-reachable editor URLs. When configured, each thread uses its machine's URL; missing machines show an error instead of falling back to another computer.",
      experimental_multiline: true,
      experimental_schema: z.string().superRefine((value, context) => {
        try { parseMachineServerUrls(value); }
        catch (cause) {
          context.addIssue({ code: "custom", message: cause instanceof Error ? cause.message : String(cause) });
        }
      }),
      default: "",
    },
    autoCaptureLocalServer: {
      type: "boolean",
      label: "Capture local server",
      description:
        "Turn on to restore the standard VS Code profile paths, then detect code-server or VS Code Server on ports 8080 and 8000. Turn off to clear every plugin setting.",
      default: false,
    },
    sourceUserDataDirectory: {
      type: "string",
      label: "Desktop VS Code profile",
      description: "The desktop VS Code User directory to import after a local server URL is configured.",
      default: defaultSourceUserDataDirectory,
    },
    sourceExtensionsDirectory: {
      type: "string",
      label: "Desktop VS Code extensions",
      description: "The desktop VS Code extensions directory to import after a local server URL is configured.",
      default: defaultSourceExtensionsDirectory,
    },
    targetUserDataDirectory: {
      type: "string",
      label: "code-server profile",
      description: "The code-server user-data directory that receives the imported VS Code profile.",
      default: defaultTargetUserDataDirectory,
    },
    targetExtensionsDirectory: {
      type: "string",
      label: "code-server extensions",
      description: "The code-server extensions directory that receives the imported VS Code extensions.",
      default: defaultTargetExtensionsDirectory,
    },
  });

  const getProfile = async (): Promise<ProfileImportStatus> => {
    const configured = await settings.get();
    return createProfileStatus(
      normalizeDirectory(configured.sourceUserDataDirectory),
      normalizeDirectory(configured.sourceExtensionsDirectory),
      normalizeDirectory(configured.targetUserDataDirectory),
      normalizeDirectory(configured.targetExtensionsDirectory),
    );
  };
  const getResponse = async (threadId: string | null) => {
    const { serverUrl, machineServerUrls } = await settings.get();
    const url = normalizeServerUrl(serverUrl) ?? normalizeServerUrl(process.env.VSCODE_SERVER_URL ?? "");
    const machineUrls = parseMachineServerUrls(machineServerUrls);
    const useMachineUrls = Object.keys(machineUrls).length > 0;
    const profile = await getProfile();
    const storedProfile = await bb.storage.kv.get<ProfileImportStatus>("profile-import");
    if (threadId === null || (url === null && !useMachineUrls)) return { url, profile: storedProfile ?? profile };

    const thread = await bb.sdk.threads.get({ threadId });
    const environment = thread.environmentId === null
      ? null
      : await bb.sdk.environments.get({ environmentId: thread.environmentId });
    const workspace = environment?.path != null
      ? { hostId: environment.hostId, path: environment.path }
      : await bb.sdk.threads.storageLocation({ threadId }).then((storage) => ({
          hostId: storage.hostId, path: storage.storageRootPath,
        }));
    if (useMachineUrls) {
      if (workspace.hostId === null || !Object.hasOwn(machineUrls, workspace.hostId)) {
        throw new Error(`No editor URL configured for machine ${workspace.hostId ?? "unknown"}. Add it in Editor URLs by machine.`);
      }
      // These editors own their profiles on their execution machines. The BB
      // server's local profile-import status does not describe them.
      return { url: withWorkspaceFolder(machineUrls[workspace.hostId], workspace.path), profile: null };
    }
    return { url: url === null ? null : withWorkspaceFolder(url, workspace.path), profile: storedProfile ?? profile };
  };
  let activeImport: Promise<ProfileImportStatus> | null = null;
  let activeImportKey: string | null = null;
  const importProfile = async (url: string): Promise<ProfileImportStatus> => {
    const profile = await getProfile();
    const importKey = `${url}\n${profile.sourceUserDataDirectory}\n${profile.sourceExtensionsDirectory}\n${profile.targetUserDataDirectory}\n${profile.targetExtensionsDirectory}`;
    if (activeImport !== null && activeImportKey === importKey) return activeImport;

    activeImportKey = importKey;
    activeImport = importLocalProfile(url, profile).then(async (result) => {
      await bb.storage.kv.set("profile-import", result);
      return result;
    });
    try {
      return await activeImport;
    } finally {
      activeImport = null;
      activeImportKey = null;
    }
  };

  const storeServerUrl = async (serverUrl: string): Promise<void> => {
    await settings.experimental_set({ serverUrl });
  };

  const clearSettings = async (): Promise<void> => {
    await bb.storage.kv.delete("profile-import");
    await settings.experimental_set({
      serverUrl: "",
      machineServerUrls: "",
      sourceUserDataDirectory: "",
      sourceExtensionsDirectory: "",
      targetUserDataDirectory: "",
      targetExtensionsDirectory: "",
    });
  };

  const restoreSettings = async (): Promise<void> => {
    await settings.experimental_set({
      sourceUserDataDirectory: defaultSourceUserDataDirectory,
      sourceExtensionsDirectory: defaultSourceExtensionsDirectory,
      targetUserDataDirectory: defaultTargetUserDataDirectory,
      targetExtensionsDirectory: defaultTargetExtensionsDirectory,
    });
  };

  const captureLocalServer = async (): Promise<string | null> => {
    await restoreSettings();
    return discoverAndStoreServerUrl(storeServerUrl);
  };

  settings.onChange((next, previous) => {
    if (next.autoCaptureLocalServer && !previous.autoCaptureLocalServer) {
      void captureLocalServer();
    }
    if (!next.autoCaptureLocalServer && previous.autoCaptureLocalServer) {
      void clearSettings();
    }
    if (
      next.serverUrl === previous.serverUrl &&
      next.sourceUserDataDirectory === previous.sourceUserDataDirectory &&
      next.sourceExtensionsDirectory === previous.sourceExtensionsDirectory &&
      next.targetUserDataDirectory === previous.targetUserDataDirectory &&
      next.targetExtensionsDirectory === previous.targetExtensionsDirectory
    ) {
      return;
    }
    const url = normalizeServerUrl(next.serverUrl);
    if (url !== null) void importProfile(url);
  });

  bb.rpc.register(rpcContract, {
    vscode_server_url: ({ threadId }) => getResponse(threadId),
    discover_vscode_server_url: async ({ threadId }) => {
      const url = await captureLocalServer();
      if (url !== null) await importProfile(url);
      return getResponse(threadId);
    },
  });
}
