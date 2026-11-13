---
name: add-e3-plugin
description: Add, change or remove an E3 Code plugin (a mod in this fork of T3 Code), such as a sidebar button, command palette action, or server feature with its own switch under Settings → Plugins. Use when the user asks for a new plugin or mod, or to change one.
---

# Add an E3 Code plugin

E3 Code is this fork's build of T3 Code. A nightly job rebases the fork's `main` onto upstream `main`, builds it, and publishes it as an update (see `scripts/mod/README.md`). Every line you change in an upstream file can conflict with a later upstream change, so plugins live in their own folders. They touch upstream files only through the few hook lines that already exist.

## Where plugin code lives

| Part       | Folder                                | Registered in                                              |
| ---------- | ------------------------------------- | ---------------------------------------------------------- |
| UI         | `apps/web/src/mods/<id>/`             | `MODS` and the slot hooks in `apps/web/src/mods/index.tsx` |
| Wire types | `packages/contracts/src/mods/<id>.ts` | `packages/contracts/src/mods/index.ts`                     |
| Server     | `apps/server/src/mods/<id>/`          | `apps/server/src/mods/index.ts`                            |

`keepAwake`, `spotify` and `calendar` use all three parts and `refreshSkills` uses only the UI part. Copy the closest one.

## Steps

1. Work in a worktree branched from `origin/main` of the fork (`EuanMorgan/t3code`), never in the shared main checkout.
2. Add a `MODS` entry with `id`, `name` and `description`. It gets an on/off switch on **Settings → Plugins** with no further work. Plugins are on until switched off. Read the switch with `useModsEnabled().isEnabled(id)`.
3. Attach the UI to an existing slot:
   - **Sidebar header button:** set `SidebarHeaderItem` on the `MODS` entry.
   - **Sidebar footer card:** set `SidebarFooterItem` on the `MODS` entry. It sits above Settings at the bottom of the sidebar.
   - **Command palette action:** write a hook that returns a `CommandPaletteActionItem` or `null`, call it in `useModCommandPaletteActions`, and include its item only while `isEnabled(id)`. Give the item a `value` starting with `action:mods:`.
   - **Plugin settings:** set `SettingsItem` on the `MODS` entry. It shows under the plugin's switch on **Settings → Plugins** while the plugin is on. Keep secrets such as links and tokens on the server with `ServerSecretStore`, as `calendar` does.
   - **Pull requests page tab:** `ModPullRequestsListSlot` wraps the page's list with a tab strip. Only Review requests uses it, so it checks that plugin's switch itself.
   - **Clean up when switched off:** set `onDisable`.
4. If the plugin needs the server:
   - In contracts, define `<ID>_METHODS` named `mods.<id>.<verb>`, its `Rpc.make` definitions and its scopes. Add them to `MOD_RPCS` and `MOD_RPC_SCOPES`, and add any subscription tag to `ModSubscriptionRpcTag`.
   - On the server, write an Effect service with a `layer`. In `mods/index.ts`, merge its layer into `layer` and add its methods to `MOD_RPC_AGGREGATES` and to `makeModRpcHandlers`. Read the service with `Effect.serviceOption`, as Keep Awake does, so upstream test harnesses that build the WS layer still work without it.
   - On the web, call the methods with `createEnvironmentRpcCommand` and `createEnvironmentRpcSubscriptionAtomFamily`, as `keepAwake/state.ts` does.
5. Add a new slot only when no existing slot fits. Export the slot from `~/mods`, and hook it into the upstream file with one import and one line. Put the line where upstream rarely edits, such as just before a return or at the end of a list. Then add the slot to this list.

## Finish

1. Run `vp run check:changed`. A user-visible plugin also gets one pass in the real app with `test-t3-app`.
2. Open a PR into the fork's `main`. The fork's CI never starts, because it needs upstream's Blacksmith runners, so merge on the local checks without asking.
3. Build and publish the update straight away. The user wants new plugins at once, not with the nightly build. In the background, run `vp run mod:update` from the build checkout, `t3code-mod-build/checkout` beside the main clone, and wait for it. Run only one build at a time. Tell the user when the build is published. The update button then appears in E3 Code's sidebar. If the build fails, its last output names the log.
