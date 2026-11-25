# Nightly mod builds

`vp run mod:update` turns this fork's `main` into a macOS arm64 build of T3 Code, named E3 Code, and publishes it as a GitHub prerelease on the fork. An installed mod build checks that feed and shows the usual update button in the sidebar. A launchd job runs the update every night at 03:00 and at each login, so a night the Mac was off is caught up.

Each run does the following in its own checkout, `../t3code-mod-build/checkout` beside the main clone:

1. Fetch `upstream` and `origin`, retrying when GitHub drops the connection. Stop if neither `main` moved since the last published build. Pass `--force` to build anyway.
2. Rebase `origin/main` onto `upstream/main` with `git rerere`. When a commit conflicts, Claude Code (`claude -p`, Opus) resolves it.
3. Install dependencies and run `vp run typecheck`. If it fails, Claude Code fixes the plugin code and the run commits the fix as `fix(mods): adapt plugins to upstream changes`.
4. Push to `origin/main` with `--force-with-lease`. Pass `--no-push` to leave `origin/main` alone; the release is still tagged at the rebased commit. Pass `--branch <name>` to build another branch of the fork instead of `main`.
5. Build the app, sign it with the mod certificate, and publish the release.

If Claude Code cannot resolve a conflict or fix the typecheck, the run pushes nothing and shows a notification. Claude's output is in the run's log in `../t3code-mod-build/logs`.

## One-time setup

You need `vp`, Rust from `rustup`, the Xcode command line tools, `gh` signed in as the fork's owner, SSH push access to the fork, and `claude` signed in. The script adds `~/.cargo/bin` to `PATH` itself. Run the commands below from the main clone.

1. Create the signing certificate:

   ```sh
   vp run mod:setup-signing
   ```

   This writes a private keychain to `../t3code-mod-build/signing`. Back that folder up. An installed mod build accepts an update only if it is signed by this certificate. If you lose it, install the next build by hand as in step 3.

2. Merge this folder into the fork's `main`. The nightly job runs the copy in the build checkout, so it needs the pipeline on `main`.

3. Publish the first build and install it in place of T3 Code (Nightly):

   ```sh
   vp run mod:update -- --force
   ```

   Quit T3 Code (Nightly), move `/Applications/T3 Code (Nightly).app` to the Bin, then unpack the new build into `/Applications`:

   ```sh
   ditto -x -k ../t3code-mod-build/out/release/E3-Code-*-arm64.zip /Applications
   ```

   The official app is signed by T3's Apple Developer ID, so its updater cannot install a mod build. This step is the only manual install. On first launch macOS asks once for access to the "T3 Code (Nightly) Safe Storage" keychain item; choose Always Allow. Permissions such as screen recording are asked for again once.

4. Give the nightly run a long-lived Claude Code token, since a normal sign-in expires within weeks. Run `claude setup-token` and save the token it prints to `../t3code-mod-build/claude-token`.

5. Schedule the nightly run:

   ```sh
   vp run mod:install-schedule
   ```

   If the Mac is asleep at 03:00, launchd runs the job when it wakes.

## Recover from a rebase conflict

When Claude Code could not resolve a conflict, resolve it once in a dev checkout. `rerere` records the resolution in the shared `.git`, and the nightly run reuses it.

```sh
git config rerere.enabled true
git fetch upstream && git fetch origin
git switch --detach origin/main
git rebase upstream/main
# resolve each conflict, then: git add <files> && git rebase --continue
git push --force-with-lease=main:origin/main origin HEAD:main
vp run mod:update
```

## Limits

Mod builds have no Apple Developer ID. macOS does not notarize them, and the in-app browser cannot use passkeys. Each release adds about 200 MB to the fork's releases; delete old ones on GitHub when you like.
