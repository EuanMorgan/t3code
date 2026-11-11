// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off extendsNativeError:off - runs before `vp i` in the build checkout, so only Node built-ins exist.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const SCHEDULE_LABEL = "com.t3code.mod-update";
const SCHEDULE_HOUR = 3;

function run(command: string, args: ReadonlyArray<string>, options: RunOptions = {}): string {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", options.logFd ?? "pipe", options.logFd ?? "pipe"],
  });
  if (result.status !== 0) {
    throw new CommandError(command, args, result.status, `${result.stderr ?? ""}`.trim());
  }
  return `${result.stdout ?? ""}`.trim();
}

interface RunOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly logFd?: number;
}

class CommandError extends Error {
  constructor(command: string, args: ReadonlyArray<string>, status: number | null, stderr: string) {
    super(`${command} ${args.join(" ")} exited with ${status}${stderr ? `: ${stderr}` : ""}`);
  }
}

class RebaseConflictError extends Error {}

const git = (cwd: string, ...args: string[]) => run("git", args, { cwd });

function modPaths() {
  const repoRoot = NodePath.resolve(import.meta.dirname, "../..");
  const commonDir = NodePath.resolve(repoRoot, git(repoRoot, "rev-parse", "--git-common-dir"));
  const mainCheckout = NodePath.dirname(commonDir);
  const home =
    process.env.T3_MOD_HOME ?? NodePath.join(NodePath.dirname(mainCheckout), "t3code-mod-build");
  return {
    home,
    mainCheckout,
    checkout: NodePath.join(home, "checkout"),
    keychain: NodePath.join(home, "signing", "signing.keychain-db"),
    keychainPassword: NodePath.join(home, "signing", "keychain-password"),
    identity: NodePath.join(home, "signing", "identity"),
    build: NodePath.join(home, "out", "build"),
    release: NodePath.join(home, "out", "release"),
    logs: NodePath.join(home, "logs"),
    lastPublished: NodePath.join(home, "last-published.json"),
  };
}
type ModPaths = ReturnType<typeof modPaths>;

function setupSigning(paths: ModPaths) {
  if (NodeFS.existsSync(paths.keychain)) {
    throw new Error(
      `${paths.keychain} already exists. Installed mod builds only accept updates signed by it, so it is never replaced.`,
    );
  }
  const dir = NodePath.dirname(paths.keychain);
  NodeFS.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const scratch = NodeFS.mkdtempSync(NodePath.join(dir, "setup-"));
  try {
    const config = NodePath.join(scratch, "cert.cnf");
    NodeFS.writeFileSync(
      config,
      [
        "[req]",
        "distinguished_name=dn",
        "x509_extensions=ext",
        "prompt=no",
        "[dn]",
        "CN=T3 Code Mods",
        "[ext]",
        "basicConstraints=critical,CA:false",
        "keyUsage=critical,digitalSignature",
        "extendedKeyUsage=critical,codeSigning",
        "",
      ].join("\n"),
    );
    const key = NodePath.join(scratch, "key.pem");
    const cert = NodePath.join(scratch, "cert.pem");
    const p12 = NodePath.join(scratch, "identity.p12");
    const p12Password = NodeCrypto.randomBytes(16).toString("hex");
    // The designated requirement pins this certificate, so it must outlive every install.
    run("/usr/bin/openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:3072",
      "-nodes",
      "-days",
      "36500",
      "-keyout",
      key,
      "-out",
      cert,
      "-config",
      config,
    ]);
    run("/usr/bin/openssl", [
      "pkcs12",
      "-export",
      "-inkey",
      key,
      "-in",
      cert,
      "-out",
      p12,
      "-passout",
      `pass:${p12Password}`,
    ]);
    const keychainPassword = NodeCrypto.randomBytes(24).toString("hex");
    NodeFS.writeFileSync(paths.keychainPassword, keychainPassword, { mode: 0o600 });
    // A private keychain with a known password lets the nightly job sign with no prompt, and
    // codesign accepts the certificate without it being trusted.
    run("security", ["create-keychain", "-p", keychainPassword, paths.keychain]);
    run("security", ["set-keychain-settings", paths.keychain]);
    run("security", ["unlock-keychain", "-p", keychainPassword, paths.keychain]);
    run("security", [
      "import",
      p12,
      "-k",
      paths.keychain,
      "-P",
      p12Password,
      "-T",
      "/usr/bin/codesign",
    ]);
    run("security", [
      "set-key-partition-list",
      "-S",
      "apple-tool:,apple:,codesign:",
      "-s",
      "-k",
      keychainPassword,
      paths.keychain,
    ]);
    const fingerprint = run("/usr/bin/openssl", [
      "x509",
      "-noout",
      "-fingerprint",
      "-sha1",
      "-in",
      cert,
    ]);
    NodeFS.writeFileSync(paths.identity, fingerprint.replace(/^.*=/, "").replaceAll(":", ""));
  } finally {
    NodeFS.rmSync(scratch, { recursive: true, force: true });
  }
  console.log(`Created the signing keychain in ${dir}. Back this folder up.`);
}

async function signApp(paths: ModPaths, app: string) {
  const identity = NodeFS.readFileSync(paths.identity, "utf8").trim();
  run("security", [
    "unlock-keychain",
    "-p",
    NodeFS.readFileSync(paths.keychainPassword, "utf8"),
    paths.keychain,
  ]);
  const { sign } = await import("@electron/osx-sign");
  await sign({
    app,
    identity,
    keychain: paths.keychain,
    identityValidation: false,
    platform: "darwin",
    // Hardened runtime only matters for notarization, which needs an Apple Developer ID.
    optionsForFile: () => ({ hardenedRuntime: false, timestamp: "none" }),
  });
  const requirement = run("codesign", ["-d", "-r-", app]);
  if (!requirement.toLowerCase().includes(`certificate leaf = h"${identity.toLowerCase()}"`)) {
    throw new Error(`${app} is not pinned to the mod signing certificate:\n${requirement}`);
  }
}

function packageUpdate(app: string, version: string, outDir: string) {
  NodeFS.mkdirSync(outDir, { recursive: true });
  const zipName = `T3-Code-${version}-arm64.zip`;
  const zip = NodePath.join(outDir, zipName);
  run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, zip]);
  const bytes = NodeFS.readFileSync(zip);
  const sha512 = NodeCrypto.createHash("sha512").update(bytes).digest("base64");
  const manifest = NodePath.join(outDir, "nightly-mac.yml");
  NodeFS.writeFileSync(
    manifest,
    [
      `version: ${version}`,
      "files:",
      `  - url: ${zipName}`,
      `    sha512: ${sha512}`,
      `    size: ${bytes.length}`,
      `path: ${zipName}`,
      `sha512: ${sha512}`,
      `releaseDate: '${new Date().toISOString()}'`,
      "",
    ].join("\n"),
  );
  return [zip, manifest];
}

function extractApp(zip: string, outDir: string) {
  NodeFS.rmSync(outDir, { recursive: true, force: true });
  run("ditto", ["-x", "-k", zip, outDir]);
  const app = NodeFS.readdirSync(outDir).find((entry) => entry.endsWith(".app"));
  if (!app) throw new Error(`${zip} holds no .app bundle.`);
  return NodePath.join(outDir, app);
}

function githubRepository(checkout: string) {
  const url = git(checkout, "remote", "get-url", "origin");
  const match = /[:/]([^/:]+\/[^/]+?)(?:\.git)?$/.exec(url);
  if (!match?.[1]) throw new Error(`Cannot read owner/repo from origin ${url}.`);
  return match[1];
}

function githubToken(repository: string) {
  try {
    return run("gh", ["auth", "token", "--user", repository.split("/")[0]!]);
  } catch {
    return run("gh", ["auth", "token"]);
  }
}

function nightlyRelease(checkout: string, sha: string, now = new Date()) {
  const iso = now.toISOString();
  const date = iso.slice(0, 10).replaceAll("-", "");
  // Upstream run numbers are in the thousands; a leading 1 keeps these above them and
  // increasing within a day.
  const runNumber = `1${iso.slice(11, 19).replaceAll(":", "")}`;
  const output = run(
    process.execPath,
    ["scripts/resolve-nightly-release.ts", "--date", date, "--run-number", runNumber, "--sha", sha],
    { cwd: checkout },
  );
  const fields = Object.fromEntries(
    output
      .split("\n")
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  return { version: fields.version!, tag: fields.tag!, name: fields.name! };
}

function installDependencies(checkout: string, logFd: number) {
  NodeFS.copyFileSync(NodePath.join(checkout, ".env.example"), NodePath.join(checkout, ".env"));
  run("vp", ["i", "--frozen-lockfile", "--", "--yes"], { cwd: checkout, logFd });
}

function buildApp(input: {
  readonly checkout: string;
  readonly version: string;
  readonly repository: string;
  readonly outDir: string;
  readonly logFd: number;
}) {
  const env = {
    ...process.env,
    PATH: `${NodePath.join(NodeOS.homedir(), ".cargo", "bin")}:${process.env.PATH ?? ""}`,
    T3CODE_DESKTOP_UPDATE_REPOSITORY: input.repository,
  };
  const options = { cwd: input.checkout, env, logFd: input.logFd };
  NodeFS.rmSync(input.outDir, { recursive: true, force: true });
  try {
    run(process.execPath, ["scripts/update-release-package-versions.ts", input.version], options);
    run(
      process.execPath,
      [
        "scripts/build-desktop-artifact.ts",
        "--platform",
        "mac",
        "--target",
        "zip",
        "--arch",
        "arm64",
        "--build-version",
        input.version,
        "--output-dir",
        input.outDir,
      ],
      options,
    );
  } finally {
    git(input.checkout, "checkout", "--", ".");
  }
  const zip = NodeFS.readdirSync(input.outDir).find((entry) => entry.endsWith("-arm64.zip"));
  if (!zip) throw new Error(`The build left no arm64 zip in ${input.outDir}.`);
  return NodePath.join(input.outDir, zip);
}

function publishRelease(input: {
  readonly repository: string;
  readonly release: ReturnType<typeof nightlyRelease>;
  readonly target: string;
  readonly notes: string;
  readonly files: ReadonlyArray<string>;
}) {
  run(
    "gh",
    [
      "release",
      "create",
      input.release.tag,
      ...input.files,
      "--repo",
      input.repository,
      "--target",
      input.target,
      "--title",
      input.release.name,
      "--notes",
      input.notes,
      "--prerelease",
      "--latest=false",
    ],
    { env: { ...process.env, GH_TOKEN: githubToken(input.repository) } },
  );
}

function ensureCheckout(paths: ModPaths) {
  if (NodeFS.existsSync(paths.checkout)) return;
  NodeFS.mkdirSync(paths.home, { recursive: true });
  git(paths.mainCheckout, "fetch", "origin");
  git(paths.mainCheckout, "worktree", "add", "--detach", paths.checkout, "origin/main");
}

function rebaseOntoUpstream(checkout: string, commitCount: number) {
  const rerere = [
    "-c",
    "rerere.enabled=true",
    "-c",
    "rerere.autoUpdate=true",
    "-c",
    "core.editor=true",
  ];
  const rebasing = () =>
    NodeFS.existsSync(
      git(checkout, "rev-parse", "--path-format=absolute", "--git-path", "rebase-merge"),
    );
  let args = [...rerere, "rebase", "upstream/main"];
  // Each pass replays at least one commit, so a rebase that keeps stopping is stuck.
  for (let pass = 0; pass <= commitCount; pass++) {
    try {
      git(checkout, ...args);
      return;
    } catch (error) {
      if (!rebasing()) throw error;
      const conflicts = git(checkout, "diff", "--name-only", "--diff-filter=U");
      if (conflicts) {
        git(checkout, "rebase", "--abort");
        throw new RebaseConflictError(
          `Rebase onto upstream/main conflicted in ${conflicts.split("\n").join(", ")}.`,
        );
      }
      args = [...rerere, "rebase", "--continue"];
    }
  }
  git(checkout, "rebase", "--abort");
  throw new Error("The rebase onto upstream/main kept stopping without a conflict.");
}

async function update(paths: ModPaths, flags: { force: boolean; push: boolean }) {
  ensureCheckout(paths);
  NodeFS.mkdirSync(paths.logs, { recursive: true });
  const logPath = NodePath.join(paths.logs, `${new Date().toISOString().replaceAll(":", "-")}.log`);
  const logFd = NodeFS.openSync(logPath, "a");
  const step = (message: string) => {
    console.log(message);
    NodeFS.writeSync(logFd, `\n== ${message}\n`);
  };
  const { checkout } = paths;
  try {
    step("Fetching upstream and origin");
    git(checkout, "fetch", "upstream");
    git(checkout, "fetch", "origin");
    const upstream = git(checkout, "rev-parse", "upstream/main");
    const origin = git(checkout, "rev-parse", "origin/main");
    const last = NodeFS.existsSync(paths.lastPublished)
      ? (JSON.parse(NodeFS.readFileSync(paths.lastPublished, "utf8")) as {
          upstream: string;
          head: string;
        })
      : undefined;
    if (!flags.force && last?.upstream === upstream && last.head === origin) {
      step(`Nothing changed since ${last.head.slice(0, 12)}; skipping the build`);
      return;
    }

    step("Rebasing origin/main onto upstream/main");
    git(checkout, "reset", "--hard");
    git(checkout, "clean", "-fd");
    git(checkout, "checkout", "--detach", origin);
    const modCommits = Number(git(checkout, "rev-list", "--count", `upstream/main..${origin}`));
    rebaseOntoUpstream(checkout, modCommits);
    const head = git(checkout, "rev-parse", "HEAD");
    if (head !== origin) {
      if (flags.push) {
        step(`Pushing ${head.slice(0, 12)} to origin/main`);
        git(
          checkout,
          "push",
          `--force-with-lease=main:${origin}`,
          "origin",
          "HEAD:refs/heads/main",
        );
      } else {
        step(`Leaving origin/main at ${origin.slice(0, 12)} (--no-push)`);
      }
    }

    step("Installing dependencies");
    installDependencies(checkout, logFd);
    const repository = githubRepository(checkout);
    const release = nightlyRelease(checkout, head);
    step(`Building ${release.version} for ${repository} (log: ${logPath})`);
    const zip = buildApp({
      checkout,
      version: release.version,
      repository,
      outDir: paths.build,
      logFd,
    });
    step("Signing");
    const app = extractApp(zip, NodePath.join(paths.release, "app"));
    await signApp(paths, app);
    const files = packageUpdate(app, release.version, paths.release);

    step(`Publishing ${release.tag}`);
    const mods = git(checkout, "log", "--format=- %s", "upstream/main..HEAD");
    publishRelease({
      repository,
      release,
      target: head,
      notes: `Upstream ${upstream.slice(0, 12)} with these mods:\n\n${mods || "- none"}`,
      files,
    });
    NodeFS.writeFileSync(
      paths.lastPublished,
      JSON.stringify({ upstream, head, version: release.version }, null, 2),
    );
    step(`Published ${release.version}. T3 Code will offer it as an update.`);
  } catch (error) {
    NodeFS.writeSync(logFd, `\n${error instanceof Error ? error.stack : String(error)}\n`);
    notify(
      error instanceof RebaseConflictError
        ? `${error.message} Nothing was changed.`
        : `The mod build failed. Log: ${logPath}`,
    );
    throw error;
  } finally {
    NodeFS.closeSync(logFd);
  }
}

function notify(message: string) {
  NodeChildProcess.spawnSync("osascript", [
    "-e",
    `display notification ${JSON.stringify(message)} with title "T3 Code mods"`,
  ]);
}

function installSchedule(paths: ModPaths) {
  ensureCheckout(paths);
  NodeFS.mkdirSync(paths.logs, { recursive: true });
  const plist = NodePath.join(
    NodeOS.homedir(),
    "Library",
    "LaunchAgents",
    `${SCHEDULE_LABEL}.plist`,
  );
  const xml = (value: string) =>
    value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const command = `cd '${paths.checkout.replaceAll("'", "'\\''")}' && vp run mod:update`;
  NodeFS.writeFileSync(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SCHEDULE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>${xml(command)}</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${SCHEDULE_HOUR}</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(NodePath.join(paths.logs, "schedule.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(NodePath.join(paths.logs, "schedule.log"))}</string>
</dict>
</plist>
`,
  );
  const domain = `gui/${process.getuid?.()}`;
  NodeChildProcess.spawnSync("launchctl", ["bootout", `${domain}/${SCHEDULE_LABEL}`]);
  run("launchctl", ["bootstrap", domain, plist]);
  console.log(`Scheduled ${paths.checkout} to update daily at ${SCHEDULE_HOUR}:00 (${plist}).`);
}

if (import.meta.main) {
  const [command, ...flags] = process.argv.slice(2);
  const paths = modPaths();
  if (command === "setup-signing") setupSigning(paths);
  else if (command === "install-schedule") installSchedule(paths);
  else if (command === "update") {
    await update(paths, { force: flags.includes("--force"), push: !flags.includes("--no-push") });
  } else {
    console.error("Usage: mod.ts setup-signing | update [--force] [--no-push] | install-schedule");
    process.exitCode = 2;
  }
}
