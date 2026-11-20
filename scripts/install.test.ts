// @effect-diagnostics nodeBuiltinImport:off - Drives the real shell installer against a local GitHub fixture.
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

/** The launcher install.sh, `t3 install`, and `t3 update` write; exec by absolute path. */
const launcherScript = (executable: string) =>
  `#!/bin/sh\nexec '${executable.replaceAll("'", "'\\''")}' "$@"\n`;

const repository = "applejxd/t3code";

const nightlies = Array.from({ length: 100 }, (_, index) => ({
  tag_name: `v1.2.4-nightly.20261020.${200 - index}`,
}));

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("installer home", () => {
  it("installs a relative home from a directory ending in a newline", async () => {
    const temporaryRoot = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-home-")),
    );
    const root = NodePath.join(temporaryRoot, "cwd\n");
    const homeName = "-custom home\\home\n";
    const home = NodePath.join(root, homeName);
    const version = "1.2.3";
    const target = NodePath.join(home, "runtime/versions", version);
    const launcher = NodePath.join(root, "bin/t3");
    try {
      await NodeFSP.mkdir(target, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(target, ".install-complete"), `${version}\n`);
      await NodeFSP.writeFile(NodePath.join(target, "t3"), "#!/bin/sh\necho 't3 v1.2.3'\n", {
        mode: 0o755,
      });
      const install = () =>
        NodeChildProcess.spawnSync("sh", [NodePath.resolve(import.meta.dirname, "install.sh")], {
          cwd: root,
          env: {
            ...process.env,
            HOME: root,
            T3CODE_HOME: homeName,
            T3CODE_VERSION: version,
            T3CODE_INSTALL_BIN_DIR: NodePath.dirname(launcher),
            T3CODE_RELEASE_BASE_URL: "http://127.0.0.1:1",
          },
          encoding: "utf8",
        });
      // The second run replaces the launcher the first wrote, newlines in its path and all.
      const first = install();
      expect(first.status, first.stdout + first.stderr).toBe(0);
      const { status, stdout, stderr } = install();
      expect(status, stdout + stderr).toBe(0);
      expect(stderr).toContain(`Installed T3 Code ${version}`);
      expect(await NodeFSP.readFile(launcher, "utf8")).toBe(
        launcherScript(NodePath.join(target, "t3")),
      );
      expect(
        NodeChildProcess.execFileSync(launcher, ["--version"], {
          cwd: NodeOS.tmpdir(),
          encoding: "utf8",
        }).trim(),
      ).toBe("t3 v1.2.3");
    } finally {
      await NodeFSP.rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});

/** Commands install.sh needs to resolve a release and write the launcher, none of them gh. */
const releaseTools = [
  "sh",
  "uname",
  "tar",
  "cut",
  "curl",
  "grep",
  "mkdir",
  "mktemp",
  "rm",
  "mv",
  "ln",
  "chmod",
  "sed",
  "sort",
  "head",
  "cat",
  "tr",
  "wc",
  "sleep",
];

const commandPath = (command: string) =>
  NodeChildProcess.spawnSync("sh", ["-c", 'command -v "$1"', "sh", command], {
    encoding: "utf8",
  }).stdout.trim();

/**
 * A fake gh: logs each call and prints `page-<n>` or fails. `auth token` prints a token only when
 * `has-token` exists; `auth status` succeeds only when `status-ok` exists, like the real one it
 * aggregates every account and host, so it can fail while the active account is fine.
 */
const ghStub = `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_STUB_DIR/calls"
case "$1 $2" in
  "auth token") [ -f "$GH_STUB_DIR/has-token" ] && echo stub-token; exit $? ;;
  "auth status") [ -f "$GH_STUB_DIR/status-ok" ]; exit $? ;;
esac
case "$1" in
  api)
    for argument in "$@"; do case "$argument" in repos/*) endpoint="$argument" ;; esac; done
    page="\${endpoint##*page=}"
    if [ -f "$GH_STUB_DIR/page-$page" ]; then cat "$GH_STUB_DIR/page-$page"; exit 0; fi
    # A failing gh can leave output behind; the installer must not read it.
    printf '{"tag_name":"v9.9.9-fork.9"}\\n'
    exit 1 ;;
esac
exit 1
`;

type GhMode =
  | "absent"
  | "signed-out"
  | "signed-in"
  /** gh holds a token, but `gh auth status` fails because another account or host is stale. */
  | "stale-account"
  | "token"
  | "failing"
  | "failing-page-2";

/** Resolves the release against a local GitHub fixture and a fake gh (or none). */
async function lookupRelease(input: {
  readonly channel: string;
  readonly pinned: string;
  readonly version: string;
  readonly failures: number;
  readonly page1: readonly string[];
  readonly page2: readonly string[];
  readonly gh: GhMode;
  /** What gh lists as page 2 when it can; the fixture server keeps `page2`. */
  readonly ghPage2?: readonly string[];
}) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-index-"));
  const target = NodePath.join(root, "home/runtime/versions", input.version);
  const pages: Record<string, readonly string[]> = {
    "1": [
      ...input.page1,
      ...nightlies.slice(input.page1.length).map((release) => release.tag_name),
    ],
    "2": input.page2,
  };
  const apiPages: string[] = [];
  let failures = input.failures;
  const server = NodeHttp.createServer((request, response) => {
    if (failures-- > 0) return response.writeHead(504).end();
    const url = new URL(request.url ?? "/", "http://fixture");
    if (url.pathname === `/repos/${repository}/releases`) {
      apiPages.push(url.searchParams.get("page") ?? "");
    }
    const body =
      url.pathname === `/${repository}/releases/latest` &&
      request.headers.accept === "application/json"
        ? { tag_name: "v1.2.3" }
        : url.pathname === `/repos/${repository}/releases`
          ? pages[url.searchParams.get("page") ?? ""]?.map((tag_name) => ({ tag_name }))
          : undefined;
    if (body === undefined) response.statusCode = 404;
    // The API pretty-prints and the installer reads it line by line.
    response.end(JSON.stringify(body ?? [], null, 2));
  });
  try {
    // An existing completed install isolates release resolution from archive downloads.
    await NodeFSP.mkdir(target, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(target, ".install-complete"), `${input.version}\n`);

    // gh prints one compact object per release, drafts blanked, as install.sh's --jq filter asks.
    const ghDir = NodePath.join(root, "gh");
    await NodeFSP.mkdir(ghDir);
    await NodeFSP.writeFile(NodePath.join(ghDir, "gh"), ghStub, { mode: 0o755 });
    const ghPages = { "1": pages["1"] ?? [], "2": input.ghPage2 ?? input.page2 };
    const served =
      input.gh === "signed-in" || input.gh === "stale-account" || input.gh === "token"
        ? (["1", "2"] as const)
        : input.gh === "failing-page-2"
          ? (["1"] as const)
          : [];
    for (const page of served) {
      await NodeFSP.writeFile(
        NodePath.join(ghDir, `page-${page}`),
        ghPages[page].map((tag_name) => `${JSON.stringify({ tag_name })}\n`).join(""),
      );
    }
    if (input.gh !== "signed-out" && input.gh !== "token") {
      await NodeFSP.writeFile(NodePath.join(ghDir, "has-token"), "");
    }
    if (input.gh !== "signed-out" && input.gh !== "stale-account" && input.gh !== "token") {
      await NodeFSP.writeFile(NodePath.join(ghDir, "status-ok"), "");
    }

    // Without gh on PATH at all, only the tools the installer needs are reachable.
    const tools = NodePath.join(root, "tools");
    await NodeFSP.mkdir(tools);
    for (const command of [
      ...releaseTools,
      ...["sha256sum", "shasum"].filter((tool) => commandPath(tool) !== ""),
    ]) {
      await NodeFSP.symlink(commandPath(command), NodePath.join(tools, command));
    }

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
    const origin = `http://127.0.0.1:${address.port}`;
    const source = await NodeFSP.readFile(
      NodePath.resolve(import.meta.dirname, "install.sh"),
      "utf8",
    );
    const installer = NodePath.join(root, "install.sh");
    await NodeFSP.writeFile(installer, source.replace(/https:\/\/(api\.)?github\.com/g, origin));
    const { code, output } = await new Promise<{ code: number | null; output: string }>(
      (resolve, reject) => {
        const child = NodeChildProcess.spawn("sh", [installer], {
          env: {
            ...process.env,
            // The developer's own gh and tokens must never leak into a lookup test.
            PATH: input.gh === "absent" ? tools : `${ghDir}:${process.env.PATH ?? ""}`,
            GH_STUB_DIR: ghDir,
            GH_TOKEN: input.gh === "token" ? "stub-token" : undefined,
            GITHUB_TOKEN: undefined,
            T3CODE_VERSION: input.pinned,
            T3CODE_CHANNEL: input.channel,
            T3CODE_HOME: NodePath.join(root, "home"),
            T3CODE_INSTALL_BIN_DIR: NodePath.join(root, "bin"),
            // A wrong version must fail here instead of downloading a real release.
            T3CODE_RELEASE_BASE_URL: origin,
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
        child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, output }));
      },
    );
    const ghCalls = await NodeFSP.readFile(NodePath.join(ghDir, "calls"), "utf8").then(
      (calls) => calls.split("\n").filter((call) => call !== ""),
      () => [],
    );
    return { code, output, ghCalls, apiPages };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
}

const forkPage1 = ["v1.9.9-fork.12", "v2.0.0"];
const forkPage2 = [
  "v1.4.0-preview.20261019.50",
  "v1.2.3",
  "v1.10.0-fork.2",
  "v1.10.0-fork.10",
  "v1.10.0-fork.9",
  "v1.11.0-fork.1-rc.1",
  "v1.11.0-fork",
];

// regression: #22490
describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("installer channel lookup", () => {
  it.each([
    // regression: #32897
    // No fork release: the plain release /releases/latest names is the fallback.
    { channel: "stable", pinned: "", version: "1.2.3", failures: 1, page2: ["v1.2.3"] },
    {
      channel: "preview",
      pinned: "",
      version: "1.2.4-preview.20261019.50",
      failures: 0,
      page2: ["v1.2.4-preview.20261019.50", "v1.2.3"],
    },
    // Highest base version, then highest fork number, as numbers and wherever they sit in the
    // list, ahead of a newer plain release; the lookalikes are not fork releases.
    {
      channel: "stable",
      pinned: "",
      version: "1.10.0-fork.10",
      failures: 1,
      page1: forkPage1,
      page2: forkPage2,
    },
    // An explicit version of either form is installed as given, whatever is newest.
    {
      channel: "stable",
      pinned: "1.2.3-fork.1",
      version: "1.2.3-fork.1",
      failures: 0,
      page2: ["v1.10.0-fork.10"],
    },
    {
      channel: "stable",
      pinned: "1.2.3",
      version: "1.2.3",
      failures: 0,
      page2: ["v1.10.0-fork.10"],
    },
  ])(
    "installs $version on $channel (T3CODE_VERSION='$pinned') behind nightlies and $failures HTTP 504s",
    async ({ page1 = [], ...row }) => {
      const { code, output, ghCalls } = await lookupRelease({
        ...row,
        page1,
        gh: "signed-out",
      });
      expect(code, output).toBe(0);
      expect(output).toContain(`Installed T3 Code ${row.version}`);
      expect(ghCalls.filter((call) => call.startsWith("api "))).toEqual([]);
    },
  );

  // The fixture server lists fork.10 as the newest; only gh's own listing has fork.11.
  const ghListing = {
    channel: "stable",
    pinned: "",
    failures: 0,
    page1: forkPage1,
    page2: forkPage2,
    ghPage2: [...forkPage2, "v1.10.0-fork.11"],
  };
  it.each([
    // A token in gh, or GH_TOKEN set: the listing runs through gh and never touches the anonymous API.
    {
      ...ghListing,
      gh: "signed-in",
      version: "1.10.0-fork.11",
      ghCalls: ["auth", "api", "api"],
      apiPages: [],
    },
    {
      ...ghListing,
      gh: "token",
      version: "1.10.0-fork.11",
      ghCalls: ["api", "api"],
      apiPages: [],
    },
    {
      ...ghListing,
      gh: "signed-in",
      channel: "preview",
      page2: ["v1.2.4-preview.20261019.49"],
      ghPage2: ["v1.2.4-preview.20261019.50"],
      version: "1.2.4-preview.20261019.50",
      ghCalls: ["auth", "api", "api"],
      apiPages: [],
    },
    // regression: `gh auth status` exits 1 when any other account or host fails verification, so
    // it must not gate gh. A token and a working listing are enough.
    {
      ...ghListing,
      gh: "stale-account",
      version: "1.10.0-fork.11",
      ghCalls: ["auth", "api", "api"],
      apiPages: [],
    },
    // The plain-release fallback is still github.com's /releases/latest, behind an HTTP 504.
    {
      ...ghListing,
      gh: "signed-in",
      failures: 1,
      page1: [],
      ghPage2: ["v1.2.3"],
      version: "1.2.3",
      ghCalls: ["auth", "api", "api"],
      apiPages: [],
    },
    // Present but without a token, or not installed: exactly the anonymous lookup.
    {
      ...ghListing,
      gh: "signed-out",
      version: "1.10.0-fork.10",
      ghCalls: ["auth"],
      apiPages: ["1", "2"],
    },
    { ...ghListing, gh: "absent", version: "1.10.0-fork.10", ghCalls: [], apiPages: ["1", "2"] },
    // gh fails: its leftover output is ignored, gh is not asked again, and the anonymous lookup wins.
    {
      ...ghListing,
      gh: "failing",
      version: "1.10.0-fork.10",
      ghCalls: ["auth", "api"],
      apiPages: ["1", "2"],
    },
    {
      ...ghListing,
      gh: "failing-page-2",
      version: "1.10.0-fork.10",
      ghCalls: ["auth", "api", "api"],
      apiPages: ["2"],
    },
    // A pinned version needs no lookup, so gh is never run.
    {
      ...ghListing,
      gh: "signed-in",
      pinned: "1.2.3-fork.1",
      version: "1.2.3-fork.1",
      ghCalls: [],
      apiPages: [],
    },
  ] as const)(
    "installs $version on $channel (T3CODE_VERSION='$pinned') with gh $gh and $failures HTTP 504s",
    async ({ ghCalls: expectedCalls, apiPages: expectedPages, ...row }) => {
      const { code, output, ghCalls, apiPages } = await lookupRelease(row);
      expect(code, output).toBe(0);
      expect(output).toContain(`Installed T3 Code ${row.version}`);
      expect(ghCalls.map((call) => call.split(" ")[0])).toEqual(expectedCalls);
      expect(apiPages).toEqual(expectedPages);
      // The same endpoint and page size as the anonymous request, against github.com.
      for (const call of ghCalls) {
        expect(call).toMatch(
          call.startsWith("auth ")
            ? /^auth token --hostname github\.com$/u
            : new RegExp(
                `^api --hostname github\\.com repos/${repository}/releases\\?per_page=100&page=[12] --jq `,
                "u",
              ),
        );
      }
    },
  );
});

// regression: #35834
describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")(
  "installer archive download",
  () => {
    it.each(["1.2.3", "1.2.3-fork.1"])(
      "names the archive of %s when it returns 404",
      async (version) => {
        const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-archive-"));
        const arch = HostProcess.Architecture.defaultValue() === "arm64" ? "arm64" : "x64";
        const archive = `t3-${version}-linux-${arch}.tar.gz`;
        const server = NodeHttp.createServer((request, response) => {
          if (request.url === `/v${version}/SHA256SUMS`)
            return response.end(`${"0".repeat(64)}  ${archive}\n`);
          response.writeHead(404).end();
        });
        try {
          await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
          const address = server.address();
          if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
          const { code, output } = await new Promise<{ code: number | null; output: string }>(
            (resolve, reject) => {
              const child = NodeChildProcess.spawn(
                "sh",
                [NodePath.resolve(import.meta.dirname, "install.sh")],
                {
                  env: {
                    ...process.env,
                    T3CODE_CHANNEL: "",
                    T3CODE_VERSION: version,
                    T3CODE_HOME: NodePath.join(root, "home"),
                    T3CODE_INSTALL_BIN_DIR: NodePath.join(root, "bin"),
                    T3CODE_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}`,
                  },
                  stdio: ["ignore", "pipe", "pipe"],
                },
              );
              let output = "";
              child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
              child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
              child.on("error", reject);
              child.on("close", (code) => resolve({ code, output }));
            },
          );
          expect(code, output).not.toBe(0);
          expect(output).toMatch(new RegExp(`t3 install: .*${archive.replaceAll(".", "\\.")}`));
        } finally {
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
          await NodeFSP.rm(root, { recursive: true, force: true });
        }
      },
    );
  },
);

/** Runs an installer for a version that is already unpacked, so only the t3 command step runs. */
async function installOver(input: {
  readonly script: "install.sh" | "install.ps1";
  readonly home: string;
  readonly binDir: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
}) {
  const target = NodePath.join(input.home, "runtime", "versions", "1.2.3");
  await NodeFSP.mkdir(target, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(target, ".install-complete"), "1.2.3\n");
  const installer = NodePath.resolve(import.meta.dirname, input.script);
  const [command, args] =
    input.script === "install.sh"
      ? ["sh", [installer]]
      : ["powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installer]];
  const result = NodeChildProcess.spawnSync(command, args, {
    encoding: "utf8",
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    env: {
      ...process.env,
      T3CODE_CHANNEL: "",
      T3CODE_VERSION: "1.2.3",
      T3CODE_HOME: input.home,
      T3CODE_INSTALL_BIN_DIR: input.binDir,
      T3CODE_RELEASE_BASE_URL: "http://127.0.0.1:9",
      ...input.env,
    },
  });
  return { code: result.status, output: `${result.stdout}${result.stderr}`, target };
}

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("install.sh t3 command", () => {
  it("replaces only this home's own launchers and prints a PATH command", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-link-"));
    try {
      const home = NodePath.join(root, "home");
      const binDir = NodePath.join(root, "bin");
      const link = NodePath.join(binDir, "t3");
      await NodeFSP.mkdir(binDir, { recursive: true });

      await NodeFSP.writeFile(link, "#!/bin/sh\necho mine\n");
      const foreign = await installOver({ script: "install.sh", home, binDir });
      expect(foreign.code).not.toBe(0);
      expect(foreign.output).toContain(`another t3 is already at ${link}`);
      expect(await NodeFSP.readFile(link, "utf8")).toBe("#!/bin/sh\necho mine\n");
      // Not even from inside the versions folder, where `.` would resolve into it.
      const fromVersions = await installOver({
        script: "install.sh",
        home,
        binDir,
        cwd: foreign.target,
      });
      expect(fromVersions.code).not.toBe(0);
      expect(await NodeFSP.readFile(link, "utf8")).toBe("#!/bin/sh\necho mine\n");

      // A link that only looks like it points into versions (join() would normalize the ..).
      await NodeFSP.rm(link);
      await NodeFSP.mkdir(NodePath.join(home, "other"), { recursive: true });
      await NodeFSP.writeFile(NodePath.join(home, "other/t3"), "#!/bin/sh\n");
      await NodeFSP.symlink(`${home}/runtime/versions/../../other/t3`, link);
      const climbing = await installOver({ script: "install.sh", home, binDir });
      expect(climbing.code).not.toBe(0);
      expect(await NodeFSP.readlink(link)).toBe(`${home}/runtime/versions/../../other/t3`);

      // Only `<version>/t3` counts, not another program inside a version.
      await NodeFSP.rm(link);
      await NodeFSP.symlink(NodePath.join(home, "runtime/versions/1.0.0/helper"), link);
      const sibling = await installOver({ script: "install.sh", home, binDir });
      expect(sibling.code).not.toBe(0);
      expect(await NodeFSP.readlink(link)).toBe(
        NodePath.join(home, "runtime/versions/1.0.0/helper"),
      );

      // An upgrade over an older version's link, written through a symlinked T3 home.
      await NodeFSP.rm(link);
      await NodeFSP.symlink(NodePath.join(home, "runtime/versions/1.0.0/t3"), link);
      await NodeFSP.symlink(home, NodePath.join(root, "alias"));
      const upgrade = await installOver({
        script: "install.sh",
        home: NodePath.join(root, "alias"),
        binDir,
        env: { HOME: root, SHELL: "/bin/zsh", PATH: "/usr/bin:/bin" },
      });
      expect(upgrade.code, upgrade.output).toBe(0);
      expect(await NodeFSP.readFile(link, "utf8")).toBe(
        launcherScript(NodePath.join(root, "alias/runtime/versions/1.2.3/t3")),
      );
      expect(upgrade.output).toContain(
        `printf '\\n%s\\n' 'export PATH="$PATH:$HOME/bin"' >> ~/.zshrc`,
      );

      // Containers and CI often have no SHELL; `set -u` must not stop the installer there.
      const noShell = await installOver({
        script: "install.sh",
        home,
        binDir,
        env: { HOME: root, SHELL: undefined, PATH: "/usr/bin:/bin" },
      });
      expect(noShell.code, noShell.output).toBe(0);
      expect(noShell.output).toContain(`Add ${binDir} to your PATH`);

      // Its folder on PATH with a trailing slash is still this t3, not another one.
      const slashed = await installOver({
        script: "install.sh",
        home,
        binDir,
        env: { HOME: root, PATH: `${binDir}/:/usr/bin:/bin` },
      });
      expect(slashed.code, slashed.output).toBe(0);
      expect(slashed.output).toContain("Run t3 to use T3 Code here");

      // A relative folder is made absolute, so the PATH command never follows the working directory.
      const relative = await installOver({
        script: "install.sh",
        home,
        binDir: "bin",
        cwd: root,
        env: { HOME: root, SHELL: "/bin/zsh", PATH: "/usr/bin:/bin" },
      });
      expect(relative.code, relative.output).toBe(0);
      expect(relative.output).toContain(`'export PATH="$PATH:$HOME/bin"'`);

      // A launcher script someone edited is theirs now.
      const edited = `${launcherScript(NodePath.join(home, "runtime/versions/1.2.3/t3"))}# mine\n`;
      await NodeFSP.writeFile(link, edited);
      const overEdited = await installOver({ script: "install.sh", home, binDir });
      expect(overEdited.code).not.toBe(0);
      expect(await NodeFSP.readFile(link, "utf8")).toBe(edited);

      await NodeFSP.rm(link);
      await NodeFSP.symlink(NodePath.join(home, "bin/t3"), link);
      const overDesktop = await installOver({
        script: "install.sh",
        home: `${home}//`,
        binDir: `${binDir}/`,
      });
      expect(overDesktop.code, overDesktop.output).toBe(0);
      expect(await NodeFSP.readFile(link, "utf8")).toBe(
        launcherScript(NodePath.join(home, "runtime/versions/1.2.3/t3")),
      );
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(HostProcess.Platform.defaultValue() !== "win32")("install.ps1 t3 command", () => {
  it("replaces only its own t3.cmd, also in non-ASCII and bracketed paths", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-ps1-"));
    try {
      // Windows PowerShell 5.1 reads files as ANSI by default and expands wildcards in paths.
      const home = NodePath.join(root, "José", ".t3");
      const binDir = NodePath.join(root, "bin[t3]");
      const shim = NodePath.join(binDir, "t3.cmd");
      await NodeFSP.mkdir(binDir, { recursive: true });

      const desktopShim = '@echo off\r\n"C:\\Program Files\\T3 Code\\T3 Code.exe" "x" %*\r\n';
      await NodeFSP.writeFile(shim, desktopShim);
      const foreign = await installOver({ script: "install.ps1", home, binDir });
      expect(foreign.code).not.toBe(0);
      expect(foreign.output).toContain("another t3 is already at");
      expect(await NodeFSP.readFile(shim, "utf8")).toBe(desktopShim);

      // A hand-edited wrapper may set its own environment; replacing it would drop that.
      const edited = `@echo off\r\nset "T3CODE_HOME=D:\\other"\r\n"${NodePath.join(home, "runtime", "versions", "1.0.0", "t3.exe")}" %*`;
      await NodeFSP.writeFile(shim, edited, "utf8");
      const wrapper = await installOver({ script: "install.ps1", home, binDir });
      expect(wrapper.code).not.toBe(0);
      expect(await NodeFSP.readFile(shim, "utf8")).toBe(edited);

      const climbing = `@echo off\r\n"${NodePath.join(home, "runtime", "versions")}\\..\\other\\t3.exe" %*`;
      await NodeFSP.writeFile(shim, climbing, "utf8");
      const outside = await installOver({ script: "install.ps1", home, binDir });
      expect(outside.code).not.toBe(0);
      expect(await NodeFSP.readFile(shim, "utf8")).toBe(climbing);

      const older = NodePath.join(home, "runtime", "versions", "1.0.0", "t3.exe");
      await NodeFSP.writeFile(shim, `@echo off\r\n"${older}" %*`, "utf8");
      const upgrade = await installOver({ script: "install.ps1", home, binDir });
      expect(upgrade.code, upgrade.output).toBe(0);
      expect(await NodeFSP.readFile(shim, "utf8")).toContain(
        NodePath.join(upgrade.target, "t3.exe"),
      );

      const again = await installOver({ script: "install.ps1", home, binDir });
      expect(again.code, again.output).toBe(0);

      // Another t3 first on PATH still runs, so the installer names this one in full.
      const otherBin = NodePath.join(root, "other");
      await NodeFSP.mkdir(otherBin);
      await NodeFSP.writeFile(NodePath.join(otherBin, "t3.cmd"), "@echo off\r\n");
      // Windows spells it Path; a second PATH key would be ambiguous.
      const pathKey =
        Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
      const shadowed = await installOver({
        script: "install.ps1",
        home,
        binDir,
        env: { [pathKey]: `${otherBin};${process.env[pathKey] ?? ""}` },
      });
      expect(shadowed.code, shadowed.output).toBe(0);
      expect(shadowed.output).toContain(
        `Another t3 at ${NodePath.join(otherBin, "t3.cmd")} runs first`,
      );

      // Its own folder on PATH with a trailing separator is already on PATH.
      const slashed = await installOver({
        script: "install.ps1",
        home,
        binDir,
        env: { [pathKey]: `${binDir}\\;${process.env[pathKey] ?? ""}` },
      });
      expect(slashed.code, slashed.output).toBe(0);
      expect(slashed.output).toContain("to use T3 Code here");
      // The same when the install folder itself is given with a trailing separator.
      const bothSlashed = await installOver({
        script: "install.ps1",
        home,
        binDir: `${binDir}\\`,
        env: { [pathKey]: `${binDir}\\;${process.env[pathKey] ?? ""}` },
      });
      expect(bothSlashed.code, bothSlashed.output).toBe(0);
      expect(bothSlashed.output).toContain("to use T3 Code here");
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("installer checksum", () => {
  it.each(
    ["home\\data", "home\ndata"].flatMap((homeName) =>
      [true, false].map((validChecksum) => ({ homeName, validChecksum })),
    ),
  )(
    "verifies home $homeName with valid checksum $validChecksum",
    async ({ homeName, validChecksum }) => {
      const availableTools = ["sha256sum", "shasum"].filter(
        (tool) =>
          NodeChildProcess.spawnSync("sh", ["-c", 'command -v "$1"', "sh", tool]).status === 0,
      );
      expect(availableTools.length).toBeGreaterThan(0);
      for (const checksumTool of availableTools) {
        const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-checksum-"));
        const home = NodePath.join(root, homeName);
        const version = "1.2.3";
        const stem = `t3-${version}-linux-${HostProcess.Architecture.defaultValue()}`;
        const archiveName = `${stem}.tar.gz`;
        const server = NodeHttp.createServer();
        try {
          const tools = NodePath.join(root, "tools");
          await NodeFSP.mkdir(tools);
          for (const command of [
            "sh",
            "uname",
            "tar",
            "gzip",
            "cut",
            "curl",
            "grep",
            "mkdir",
            "mktemp",
            "rm",
            "mv",
            "ln",
            "chmod",
            "sed",
            checksumTool,
          ]) {
            const executable = NodeChildProcess.execFileSync(
              "sh",
              ["-c", 'command -v "$1"', "sh", command],
              { encoding: "utf8" },
            ).trim();
            await NodeFSP.symlink(executable, NodePath.join(tools, command));
          }
          await NodeFSP.mkdir(NodePath.join(root, stem));
          await NodeFSP.writeFile(
            NodePath.join(root, stem, "t3"),
            "#!/bin/sh\necho 't3 v1.2.3'\n",
            { mode: 0o755 },
          );
          const archivePath = NodePath.join(root, archiveName);
          NodeChildProcess.execFileSync("tar", ["-czf", archivePath, "-C", root, stem]);
          const archive = await NodeFSP.readFile(archivePath);
          const digest = NodeCrypto.createHash("sha256").update(archive).digest("hex");
          server.on("request", (request, response) => {
            response.end(
              request.url?.endsWith("/SHA256SUMS")
                ? `${validChecksum ? digest : "0".repeat(64)}  ${archiveName}\n`
                : archive,
            );
          });
          await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
          const address = server.address();
          if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
          const { code, output } = await new Promise<{ code: number | null; output: string }>(
            (resolve, reject) => {
              const child = NodeChildProcess.spawn(
                "sh",
                [NodePath.resolve(import.meta.dirname, "install.sh")],
                {
                  env: {
                    ...process.env,
                    PATH: tools,
                    T3CODE_VERSION: version,
                    T3CODE_HOME: home,
                    T3CODE_INSTALL_BIN_DIR: NodePath.join(root, "bin"),
                    T3CODE_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}`,
                  },
                  stdio: ["ignore", "pipe", "pipe"],
                },
              );
              let output = "";
              child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
              child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
              child.on("error", reject);
              child.on("close", (code) => resolve({ code, output }));
            },
          );
          const versions = NodePath.join(home, "runtime/versions");
          if (validChecksum) {
            expect(code, `${checksumTool}: ${output}`).toBe(0);
            expect(
              await NodeFSP.readFile(NodePath.join(versions, version, ".install-complete"), "utf8"),
            ).toBe("1.2.3\n");
            expect(
              NodeChildProcess.execFileSync(NodePath.join(root, "bin/t3"), ["--version"], {
                encoding: "utf8",
              }).trim(),
            ).toBe("t3 v1.2.3");
          } else {
            expect(code).not.toBe(0);
            expect(output).toContain("checksum mismatch");
            expect(output).not.toContain("Installed T3 Code");
            expect(await NodeFSP.readdir(versions)).toEqual([]);
          }
        } finally {
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
          await NodeFSP.rm(root, { recursive: true, force: true });
        }
      }
    },
  );
});

// regression: #38234
describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("concurrent installers", () => {
  it("publishes one runtime without nesting the other install's staging directory", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-concurrent-"));
    const version = "1.2.3";
    const stem = `t3-${version}-linux-${HostProcess.Architecture.defaultValue()}`;
    const archiveName = `${stem}.tar.gz`;
    const target = NodePath.join(root, "home/runtime/versions", version);
    const waiting = new Map<string, NodeHttp.ServerResponse>();
    const server = NodeHttp.createServer();
    try {
      const tools = NodePath.join(root, "tools");
      await NodeFSP.mkdir(tools);
      await NodeFSP.mkdir(NodePath.join(root, stem));
      await NodeFSP.writeFile(NodePath.join(root, stem, "t3"), "#!/bin/sh\necho 't3 v1.2.3'\n", {
        mode: 0o755,
      });
      const archivePath = NodePath.join(root, archiveName);
      NodeChildProcess.execFileSync("tar", ["-czf", archivePath, "-C", root, stem]);
      const archive = await NodeFSP.readFile(archivePath);
      const digest = NodeCrypto.createHash("sha256").update(archive).digest("hex");
      server.on("request", (request, response) => {
        if (request.url?.startsWith("/ready/")) {
          waiting.set(request.url.slice(7), response);
          if (waiting.size === 2) waiting.get("first")!.end("go");
        } else if (request.url === "/published") {
          waiting.get("second")!.end("go");
          response.end("ok");
        } else {
          response.end(
            request.url?.endsWith("/SHA256SUMS") ? `${digest}  ${archiveName}\n` : archive,
          );
        }
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
      const origin = `http://127.0.0.1:${address.port}`;
      const realMv = NodeChildProcess.execFileSync("sh", ["-c", "command -v mv"], {
        encoding: "utf8",
      }).trim();
      // Hold publication until both installers have removed the destination, then let them rename in order.
      const wrapper = NodePath.join(tools, "mv.mjs");
      await NodeFSP.writeFile(
        wrapper,
        `
import { execFileSync } from 'node:child_process';
await fetch(process.env.T3_TEST_ORIGIN + '/ready/' + process.env.T3_TEST_INSTALLER);
execFileSync(${JSON.stringify(realMv)}, process.argv.slice(2));
if (process.env.T3_TEST_INSTALLER === 'first') await fetch(process.env.T3_TEST_ORIGIN + '/published');
`,
      );
      await NodeFSP.writeFile(
        NodePath.join(tools, "mv"),
        `#!/bin/sh\nexec '${process.execPath}' '${wrapper}' "$@"\n`,
        { mode: 0o755 },
      );
      const install = (id: string) =>
        new Promise<{ code: number | null; output: string }>((resolve, reject) => {
          const child = NodeChildProcess.spawn(
            "sh",
            [NodePath.join(import.meta.dirname, "install.sh")],
            {
              env: {
                ...process.env,
                PATH: `${tools}:${process.env.PATH}`,
                T3CODE_VERSION: version,
                T3CODE_HOME: NodePath.join(root, "home"),
                T3CODE_INSTALL_BIN_DIR: NodePath.join(root, "bin", id),
                T3CODE_RELEASE_BASE_URL: origin,
                T3_TEST_ORIGIN: origin,
                T3_TEST_INSTALLER: id,
              },
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          let output = "";
          child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
          child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
          child.on("error", reject);
          child.on("close", (code) => resolve({ code, output }));
        });
      const results = await Promise.all([install("first"), install("second")]);
      for (const result of results) expect(result.code, result.output).toBe(0);
      expect(
        (await NodeFSP.readdir(target)).filter((name) => name.startsWith(".staging-")),
        "concurrent installs must not leave a nested runtime",
      ).toEqual([]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
