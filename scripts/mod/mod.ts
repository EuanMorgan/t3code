// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off extendsNativeError:off - runs before `vp i` in the build checkout, so only Node built-ins exist.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const SCHEDULE_LABEL = "com.t3code.mod-update";
const SCHEDULE_INTERVAL_SECONDS = 30 * 60;
const T3_NIGHTLY = "refs/mod/t3-nightly";
const KEPT_RELEASES = 5;
const APP_NAME = "E3 Code";

function run(command: string, args: ReadonlyArray<string>, options: RunOptions = {}): string {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeoutMs,
    stdio: ["ignore", options.logFd ?? "pipe", options.logFd ?? "pipe"],
  });
  if (result.status !== 0) {
    throw new CommandError(
      command,
      args,
      result.status,
      `${result.stderr || result.error?.message || ""}`.trim(),
    );
  }
  return `${result.stdout ?? ""}`.trim();
}

interface RunOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly logFd?: number;
  readonly timeoutMs?: number;
}

class CommandError extends Error {
  constructor(command: string, args: ReadonlyArray<string>, status: number | null, stderr: string) {
    super(`${command} ${args.join(" ")} exited with ${status}${stderr ? `: ${stderr}` : ""}`);
  }
}

class RebaseConflictError extends Error {}

// Offline is normal on a laptop, so these failures skip the notification.
class NetworkError extends Error {}

const git = (cwd: string, ...args: string[]) => run("git", args, { cwd });

// GitHub often drops the SSH connection mid-transfer, and a fetch can hang overnight.
function gitOverNetwork(cwd: string, ...args: string[]) {
  for (let attempt = 1; ; attempt++) {
    try {
      return run("git", args, { cwd, timeoutMs: 10 * 60_000 });
    } catch (error) {
      if (attempt === 4) throw new NetworkError(String(error), { cause: error });
      NodeChildProcess.spawnSync("sleep", [String(attempt * 30)]);
    }
  }
}

function askClaude(checkout: string, prompt: string, logFd: number) {
  run(
    "claude",
    [
      "-p",
      prompt,
      "--model",
      "opus",
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "Read,Edit,Write,Grep,Glob,Bash(git status:*),Bash(git diff:*),Bash(git log:*),Bash(git show:*),Bash(git add:*),Bash(vp run typecheck:*)",
    ],
    { cwd: checkout, logFd, timeoutMs: 45 * 60_000 },
  );
}

const PLUGIN_CONTEXT =
  "This checkout is E3 Code, a fork of T3 Code whose commits add plugins on top of upstream. " +
  "Read .agents/skills/add-e3-plugin/SKILL.md for how plugins hook into upstream files. " +
  "Keep every upstream change, and keep what each plugin commit was for.";

function conflictMarkers(checkout: string, files: ReadonlyArray<string>) {
  return files.filter((file) => {
    const path = NodePath.join(checkout, file);
    return NodeFS.existsSync(path) && /^(<{7}|>{7})( |$)/m.test(NodeFS.readFileSync(path, "utf8"));
  });
}

function resolveConflicts(checkout: string, files: ReadonlyArray<string>, logFd: number) {
  const commit = git(checkout, "log", "-1", "--format=%h %s", "REBASE_HEAD");
  NodeFS.writeSync(logFd, `\nAsking Claude Code to resolve ${files.join(", ")} in ${commit}\n`);
  let failure: unknown;
  try {
    askClaude(
      checkout,
      `${PLUGIN_CONTEXT} A rebase onto T3 Nightly (${T3_NIGHTLY}) stopped while replaying fork commit ${commit}. ` +
        `Resolve the conflicts in ${files.join(", ")}, then git add each file. ` +
        "Do not commit, continue or abort the rebase, and do not push.",
      logFd,
    );
  } catch (error) {
    failure = error;
  }
  const unresolved = [
    ...new Set([
      ...git(checkout, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean),
      ...conflictMarkers(checkout, files),
    ]),
  ];
  if (failure || unresolved.length > 0) {
    git(checkout, "rebase", "--abort");
    throw new RebaseConflictError(
      `Rebase onto T3 Nightly conflicted in ${files.join(", ")}, and Claude Code could not resolve it.`,
      { cause: failure },
    );
  }
}

function typechecks(checkout: string, logFd: number) {
  try {
    run("vp", ["run", "typecheck"], { cwd: checkout, logFd });
    return true;
  } catch {
    return false;
  }
}

// Upstream can rename something a plugin uses without any textual conflict.
function ensureTypechecks(checkout: string, logFd: number, step: (message: string) => void) {
  step("Typechecking");
  if (typechecks(checkout, logFd)) return;
  step("Typecheck failed; asking Claude Code to fix the plugins");
  askClaude(
    checkout,
    `${PLUGIN_CONTEXT} \`vp run typecheck\` fails after rebasing the fork onto T3 Nightly (${T3_NIGHTLY}). ` +
      `Fix it by changing the fork's plugin code, the files in \`git diff --name-only ${T3_NIGHTLY} HEAD\`. ` +
      "If an error does not come from the fork's changes, leave it alone. " +
      "Run `vp run typecheck` until it passes, then git add your changes. Do not commit or push.",
    logFd,
  );
  if (git(checkout, "status", "--porcelain")) {
    git(checkout, "add", "--all");
    git(checkout, "commit", "-m", "fix(mods): adapt plugins to upstream changes");
  }
  if (!typechecks(checkout, logFd)) {
    throw new Error("The rebased fork does not typecheck, and Claude Code could not fix it.");
  }
}

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
    claudeToken: NodePath.join(home, "claude-token"),
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
  const zipName = `${APP_NAME.replaceAll(" ", "-")}-${version}-arm64.zip`;
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

// Electron finds its helpers as "<CFBundleName> Helper*.app", so they are renamed together.
// The data folder and keychain item follow the build's branding, so installs keep their data.
function renameApp(app: string) {
  const contents = NodePath.join(app, "Contents");
  const setNames = (plist: string, name: string) => {
    run("plutil", ["-replace", "CFBundleName", "-string", name, plist]);
    run("plutil", ["-replace", "CFBundleDisplayName", "-string", name, plist]);
  };
  const mainPlist = NodePath.join(contents, "Info.plist");
  const builtName = run("plutil", ["-extract", "CFBundleName", "raw", mainPlist]);
  setNames(mainPlist, APP_NAME);
  const frameworks = NodePath.join(contents, "Frameworks");
  for (const helper of NodeFS.readdirSync(frameworks)) {
    if (!helper.startsWith(`${builtName} Helper`) || !helper.endsWith(".app")) continue;
    const helperName = helper.slice(0, -".app".length);
    const renamedHelper = `${APP_NAME}${helperName.slice(builtName.length)}`;
    const helperContents = NodePath.join(frameworks, helper, "Contents");
    NodeFS.renameSync(
      NodePath.join(helperContents, "MacOS", helperName),
      NodePath.join(helperContents, "MacOS", renamedHelper),
    );
    const helperPlist = NodePath.join(helperContents, "Info.plist");
    run("plutil", ["-replace", "CFBundleExecutable", "-string", renamedHelper, helperPlist]);
    setNames(helperPlist, renamedHelper);
    NodeFS.renameSync(
      NodePath.join(frameworks, helper),
      NodePath.join(frameworks, `${renamedHelper}.app`),
    );
  }
  const renamed = NodePath.join(NodePath.dirname(app), `${APP_NAME}.app`);
  NodeFS.renameSync(app, renamed);
  return renamed;
}

function githubRepository(checkout: string, remote = "origin") {
  const url = git(checkout, "remote", "get-url", remote);
  const match = /[:/]([^/:]+\/[^/]+?)(?:\.git)?$/.exec(url);
  if (!match?.[1]) throw new Error(`Cannot read owner/repo from ${remote} ${url}.`);
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

// Each release is about 200 MB, and an install only ever updates to the newest.
function pruneReleases(repository: string) {
  const env = { ...process.env, GH_TOKEN: githubToken(repository) };
  const tags = run(
    "gh",
    [
      "release",
      "list",
      "--repo",
      repository,
      "--limit",
      "200",
      "--json",
      "tagName,isPrerelease",
      "--jq",
      '.[] | select(.isPrerelease and (.tagName | contains("-nightly."))) | .tagName',
    ],
    { env },
  );
  for (const tag of tags.split("\n").filter(Boolean).slice(KEPT_RELEASES)) {
    run("gh", ["release", "delete", tag, "--repo", repository, "--cleanup-tag", "--yes"], { env });
  }
}

// Building on T3's own nightly commits keeps E3 Code in step with T3 Nightly, which T3 builds
// and checks first, and limits builds to its few releases a day.
function fetchLatestT3Nightly(checkout: string) {
  let tag: string;
  try {
    tag = run("gh", [
      "release",
      "list",
      "--repo",
      githubRepository(checkout, "upstream"),
      "--limit",
      "20",
      "--json",
      "tagName,isPrerelease",
      "--jq",
      '[.[] | select(.isPrerelease and (.tagName | contains("-nightly.")))][0].tagName // ""',
    ]);
  } catch (error) {
    throw new NetworkError(String(error), { cause: error });
  }
  if (!tag) throw new Error("T3 Code has no nightly release.");
  gitOverNetwork(checkout, "fetch", "--no-tags", "upstream", `+refs/tags/${tag}:${T3_NIGHTLY}`);
  const commit = git(checkout, "rev-parse", `${T3_NIGHTLY}^{commit}`);
  git(checkout, "update-ref", T3_NIGHTLY, commit);
  return { tag, commit };
}

function ensureCheckout(paths: ModPaths) {
  if (NodeFS.existsSync(paths.checkout)) return;
  NodeFS.mkdirSync(paths.home, { recursive: true });
  git(paths.mainCheckout, "fetch", "origin");
  git(paths.mainCheckout, "worktree", "add", "--detach", paths.checkout, "origin/main");
}

function rebaseOntoUpstream(checkout: string, commitCount: number, logFd: number) {
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
  let args = [...rerere, "rebase", T3_NIGHTLY];
  // Each pass replays at least one commit, so a rebase that keeps stopping is stuck.
  for (let pass = 0; pass <= commitCount; pass++) {
    try {
      git(checkout, ...args);
      return;
    } catch (error) {
      if (!rebasing()) throw error;
      const conflicts = git(checkout, "diff", "--name-only", "--diff-filter=U");
      if (conflicts) resolveConflicts(checkout, conflicts.split("\n"), logFd);
      args = [...rerere, "rebase", "--continue"];
    }
  }
  git(checkout, "rebase", "--abort");
  throw new Error("The rebase onto T3 Nightly kept stopping without a conflict.");
}

async function update(paths: ModPaths, flags: { force: boolean; push: boolean; branch: string }) {
  ensureCheckout(paths);
  NodeFS.mkdirSync(paths.logs, { recursive: true });
  const logPath = NodePath.join(paths.logs, `${new Date().toISOString().replaceAll(":", "-")}.log`);
  const logFd = NodeFS.openSync(logPath, "a");
  const step = (message: string) => {
    console.log(message);
    NodeFS.writeSync(logFd, `\n== ${message}\n`);
  };
  const { checkout } = paths;
  // A normal Claude Code sign-in expires within weeks; `claude setup-token` lasts a year.
  if (NodeFS.existsSync(paths.claudeToken)) {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = NodeFS.readFileSync(paths.claudeToken, "utf8").trim();
  }
  let skipped = false;
  try {
    step("Fetching the latest T3 Nightly and origin");
    const nightly = fetchLatestT3Nightly(checkout);
    gitOverNetwork(checkout, "fetch", "origin");
    const upstream = nightly.commit;
    const origin = git(checkout, "rev-parse", `origin/${flags.branch}`);
    const last = NodeFS.existsSync(paths.lastPublished)
      ? (JSON.parse(NodeFS.readFileSync(paths.lastPublished, "utf8")) as {
          upstream: string;
          head: string;
        })
      : undefined;
    if (!flags.force && last?.upstream === upstream && last.head === origin) {
      step(`Nothing changed since ${last.head.slice(0, 12)}; skipping the build`);
      skipped = true;
      return;
    }

    step(`Rebasing origin/${flags.branch} onto T3 Nightly ${nightly.tag}`);
    git(checkout, "reset", "--hard");
    git(checkout, "clean", "-fd");
    git(checkout, "checkout", "--detach", origin);
    const modCommits = Number(git(checkout, "rev-list", "--count", `${T3_NIGHTLY}..${origin}`));
    rebaseOntoUpstream(checkout, modCommits, logFd);

    step("Installing dependencies");
    installDependencies(checkout, logFd);
    ensureTypechecks(checkout, logFd, step);

    const head = git(checkout, "rev-parse", "HEAD");
    if (head !== origin) {
      if (flags.push) {
        step(`Pushing ${head.slice(0, 12)} to origin/${flags.branch}`);
        gitOverNetwork(
          checkout,
          "push",
          `--force-with-lease=${flags.branch}:${origin}`,
          "origin",
          `HEAD:refs/heads/${flags.branch}`,
        );
      } else {
        step(`Leaving origin/${flags.branch} at ${origin.slice(0, 12)} (--no-push)`);
      }
    }

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
    const app = renameApp(extractApp(zip, NodePath.join(paths.release, "app")));
    await signApp(paths, app);
    const files = packageUpdate(app, release.version, paths.release);

    step(`Publishing ${release.tag}`);
    const mods = git(checkout, "log", "--format=- %s", `${T3_NIGHTLY}..HEAD`);
    publishRelease({
      repository,
      release,
      target: head,
      notes: `T3 Code ${nightly.tag} with these mods:\n\n${mods || "- none"}`,
      files,
    });
    NodeFS.writeFileSync(
      paths.lastPublished,
      JSON.stringify({ upstream, head, version: release.version }, null, 2),
    );
    step(`Published ${release.version}. T3 Code will offer it as an update.`);
    try {
      pruneReleases(repository);
    } catch (error) {
      NodeFS.writeSync(logFd, `\nCould not delete old releases: ${error}\n`);
    }
  } catch (error) {
    NodeFS.writeSync(logFd, `\n${error instanceof Error ? error.stack : String(error)}\n`);
    if (!(error instanceof NetworkError)) {
      notify(
        error instanceof RebaseConflictError
          ? `${error.message} Nothing was changed.`
          : `The mod build failed. Log: ${logPath}`,
      );
    }
    throw error;
  } finally {
    NodeFS.closeSync(logFd);
    // Most half-hourly checks find nothing new, and their logs would pile up.
    if (skipped) NodeFS.rmSync(logPath);
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
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>${SCHEDULE_INTERVAL_SECONDS}</integer>
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
  console.log(
    `Scheduled ${paths.checkout} to check every ${SCHEDULE_INTERVAL_SECONDS / 60} minutes (${plist}).`,
  );
}

if (import.meta.main) {
  const [command, ...flags] = process.argv.slice(2);
  const paths = modPaths();
  if (command === "setup-signing") setupSigning(paths);
  else if (command === "install-schedule") installSchedule(paths);
  else if (command === "update") {
    const branchFlag = flags.indexOf("--branch");
    await update(paths, {
      force: flags.includes("--force"),
      push: !flags.includes("--no-push"),
      branch: branchFlag === -1 ? "main" : (flags[branchFlag + 1] ?? "main"),
    });
  } else {
    console.error(
      "Usage: mod.ts setup-signing | update [--force] [--no-push] [--branch <name>] | install-schedule",
    );
    process.exitCode = 2;
  }
}
