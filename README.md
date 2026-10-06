# Facets

A Pi extension for reusable capability profiles and delegating self-contained work to a fresh Sub Pi without sharing either session's full conversation.

The Main and Sub communicate through a deliberately narrow protocol:

- Main → Sub: messages through `talk`, cancellation of the active turn through `interrupt_sub`, plus explicit closure
- Sub → Main: messages through `talk`
- never exposed by the extension: transcript, thinking blocks, tool history, or session files

Facets requires a supported interactive Sub surface. Herdr is currently the only surface adapter; future adapters may include tmux. Every Sub opens in a labeled Herdr background tab and remains open until the Main calls `close_sub` or the user closes the tab manually.

> Status: early development MVP. The protocol and file channel are implemented; real-Herdr compatibility still needs end-to-end testing.

Requires Node.js 22.19+ and Pi 1.0.4+ (for native MCP tool-name patterns). The test suite includes real Pi SDK checks for isolated built-in extension loading, profile-selected Sub tool context, and native message delivery.

## Why the launch is asynchronous

`delegate` returns after a new or resumed Sub launches. Main and Sub then exchange asynchronous `talk` messages. Facets wakes the Main whenever a Sub sends a message.

## Main context

Main-only orchestration rules can be written in:

```text
~/.pi/agent/facets/MAIN.md                 # global
<cwd-or-ancestor>/.pi/facets/MAIN.md       # trusted project hierarchy
```

Facets contributes non-empty files to the Main Pi system prompt's `facets_main` section in global-to-nearest order. Project files are discovered by walking from the Main Pi working directory to the filesystem root, and are loaded only when project resources are trusted. `MAIN.md` is never loaded by delegated Subs, so use it for delegation policy such as work the Main must route to a specific profile. Keep shared project rules in `AGENTS.md` and keep each profile focused on the selected Sub's capabilities and execution boundaries.

Changes take effect after `/reload`.

## Startup profiles

Facets does not ship built-in profiles. Profiles are user-owned directories loaded from global or trusted project hierarchies:

```text
~/.pi/agent/facets/profiles/reviewer/
├── config.json
└── instructions.md                     # optional; takes precedence

<cwd-or-ancestor>/.pi/facets/profiles/reviewer/
├── config.json
└── instructions.md                     # optional; takes precedence
```

Legacy single-file profiles at `profiles/*.json` remain supported. A directory name (or legacy JSON file stem) must match `name`; defining both forms with the same name in one scope is an error.

Facets walks from the Main Pi working directory to the filesystem root. A profile closer to the current working directory overrides a same-named ancestor profile, and any trusted project profile overrides a same-named global profile. This lets a Pi started under `project/workspace/` use profiles defined at `project/.pi/facets/profiles/`.

`reviewer/config.json`:

```json
{
  "version": 1,
  "name": "reviewer",
  "description": "Read-only code review",
  "model": "anthropic/claude-sonnet-4-5",
  "thinkingLevel": "high",
  "sessionPersistence": "persistent",
  "tools": ["read", "grep", "find", "ls"],
  "skills": ["code-review"],
  "instructions": "Review only; do not modify files."
}
```

Directory profiles prefer the UTF-8 contents of `instructions.md` beside `config.json` over the inline `instructions` field; the two are not concatenated. You can omit inline `instructions` when using the file. When the file is absent, the inline field remains the fallback. Both sources must be non-empty when present and are limited to 65,536 characters; `config.json` must still be valid. Empty, oversized, or unreadable instruction files invalidate the profile rather than silently falling back. Legacy `profiles/<name>.json` profiles continue to use inline instructions only and do not read a shared `profiles/instructions.md`. Project trust and whole-profile override rules also apply to instruction files. Changes take effect on `/reload` for startup profiles or a new Sub launch/resume; already-open Subs retain their launch snapshot.

Profile `instructions` are additive. Facets uses Pi's mutable `systemPromptOptions.sections` API rather than replacing the full system prompt: Main contributes `facets_profiles` (capability catalog), `facets_profile` (selected profile instructions), and `facets_main` (`MAIN.md`); Sub contributes only `facets_sub_protocol` and `facets_profile`. Pi continues to assemble its native role, tool summaries, rules, documentation, project context, skills, and cwd according to the user's Pi configuration. Facets delivers `talk` through Pi's `sendUserMessage()` API. Idle deliveries use the normal input pipeline and `before_agent_start` prompt assembly, which records changed sections without repeating unchanged ones. Busy deliveries enter the native follow-up queue and reuse the active run's prompt sections, just like queued user input; they do not individually rerun `before_agent_start`. Facets does not patch model requests through `context_with_system`.

`thinkingLevel` is passed to Pi rather than constrained by a Facets-owned enum. `sessionPersistence` is `ephemeral` by default or `persistent`: ephemeral conversations remain in memory only, while persistent conversations are saved by Pi and can later be resumed through `delegate.resumeSessionId` (agent-invokable sessions) or a user profile command (manual sessions). Both remain open until the Main calls `close_sub` or the user closes the Herdr tab. Skill entries may be standard skill names or paths relative to the profile file. Named project skills are also resolved from the Main Pi working directory and its ancestors, but only when project resources are trusted. Untrusted projects cannot contribute automatically discovered named skills. User-configured explicit skill paths remain relative to the profile file and are still honored independently of project discovery. Facets passes original skill paths to Pi without rewriting frontmatter or creating runtime mirrors. Pi's native visibility rules apply, including `disable-model-invocation: true`. For skills intended only for a specific profile, use the profile-private `skills/` directory rather than hiding a shared skill and overriding its visibility. Agent-invokable profile names, scope, and descriptions are injected into the Main Pi system context only as a capability catalog, so it can select a profile without calling a discovery tool; Main routing policy belongs in `MAIN.md`. Users can still run `/profiles` for diagnostics; profiles cannot be switched inside a running session.

Starting Pi without `--profile` preserves Pi's existing model, thinking, tools, and skills. A selected profile configures the non-MCP tool context, model, skills, and instructions; it is not a security policy and installs no tool-call permission guard. MCP tools and their discovery helpers are left outside profile selection. When starting Pi directly with `--profile`, already-loaded `codemode`/`deferred` tools may remain discoverable and callable even while inactive. Delegated Subs start with Pi's native `--tools` selection for non-MCP tools and only the profile's extensions plus built-in MCP support, keeping unrelated non-MCP tools out of their registry and Codemode listings. Invalid profile settings are still reported rather than silently ignored. Include `delegate`, `talk`, `interrupt_sub`, `close_sub`, and `list_sub` in an orchestrator profile when those controls should remain available. To opt into a startup profile:

```bash
pi --profile reviewer
```

For strict skill selection in a directly started Pi, also pass `--no-skills`; Facets contributes only the selected profile's skill paths. Delegated Subs always use `--no-skills` plus the resolved profile skills.

### Manually invoked specialists

Set `"invocation": "manual"` for a specialist the user, rather than Main, decides when to invoke. The default, `"both"`, allows both model delegation and user commands. For example, keep an `oracle` profile available to Main for architecture advice, but make company MR review an explicitly initiated workflow.

`review/config.json`:

```json
{
  "version": 1,
  "name": "review",
  "description": "Review a user-specified MR and report actionable findings; not general architecture consulting.",
  "invocation": "manual",
  "sessionPersistence": "persistent",
  "tools": ["read", "bash"],
  "instructions": "Review the requested MR. Report findings and related follow-ups to Main using talk. Do not modify code."
}
```

After `/reload`, invoke the profile with its namespaced command:

```text
/sub:review Review MR 42
```

Typing `/review` in the editor lets Pi's native fuzzy completion find `/sub:review`; accept that completion before submitting. Facets registers only `/sub:<profile>`, not a bare `/review` alias or a generic `/sub` command.

With no task text, `/sub:review` asks the Sub to perform its profile-defined task in the current workspace, requesting missing details from Main. The command itself does not ask Main's model to delegate. Main stays in its current tab; the Sub reports back through the normal `talk` flow.

Profile commands are registered for trusted effective profiles, including manual ones. Existing commands are never overwritten: if `/sub:review` is already occupied, Facets reports the conflict and does not register that profile command. An existing `/review` remains independent; choose `/sub:review` from completion to invoke the specialist. `/profiles` lists all profiles for the user, including their invocation mode.

Manual invocation is a routing rule, not merely a hidden name:

- Manual profiles are absent from Main's delegation catalog and unavailable to `delegate`, even after the user has invoked them.
- Their running Subs, session listings, and returned messages are marked **user-invoked specialist**, with the profile's purpose. Main may interpret findings, make fixes, and ask related follow-ups, but should not assign unrelated tasks or substitute them for general consulting profiles.
- Manual persistent sessions are not advertised to unrelated Main sessions by `list_sub`. Their owning Main can see the open or closed specialist after invocation; only a user command resumes a closed manual session.
- This controls the Facets workflow, not filesystem secrecy or an OS permission boundary.

Commands bind by **Main session ID + profile name**, not globally or per project. The first invocation creates a Sub; repeated invocations reuse it and queue behind active work. Closing a persistent Sub's tab and invoking it again reopens the same Pi session with its history, although the Herdr tab and run ID are new. `/reload` and resuming the same saved Main preserve the binding. A new or forked Main gets its own binding; a Main using `--no-session` has no binding to restore after process exit. Ephemeral Subs can be reused while open but start fresh after closure.

Bindings and session identities are stored as non-context entries in the Main's native session. Missing saved sessions or ambiguous Herdr availability produce an error rather than silently creating a replacement persistent session. Manual commands share the normal open-Sub limit, but reusing an already-open Sub does not consume another slot. Profile changes apply on a new launch/resume; an already-open Sub retains its launch configuration.

### Profile-private skills

Directory profiles automatically load skills from their own `skills/` folder:

```text
~/.pi/agent/facets/profiles/reviewer/
├── config.json
└── skills/
    └── code-review/
        ├── SKILL.md
        └── references/
            └── checklist.md
```

The same layout works under trusted project `.pi/facets/profiles/`. No `skills` config entry is required, even when the field is omitted or `[]`. Only selecting this profile (via `--profile`, `delegate`, or a user profile command) contributes these skills; other profiles and an unprofiled Main do not automatically receive them. This is discovery isolation, not a filesystem access restriction.

Facets recursively discovers `SKILL.md` directories, stopping at each skill root so supporting files are not treated as skills. Standalone `.md` files directly inside `skills/` are also supported; hidden directories and `node_modules` are skipped. Private skills precede explicit `skills` references, with duplicate source files removed (including symlinks). Pi handles skill validation and same-name collisions using its first-loaded-wins rule. For startup profiles, ambient skills may still take precedence unless `--no-skills` is passed.

Profile overrides replace the entire private skill set: a project profile does not inherit a global profile's skills. Legacy `profiles/<name>.json` files do not auto-discover private skills; migrate to `<name>/config.json` or keep using explicit paths. Private skills are loaded from their original paths and follow Pi's native frontmatter semantics, just like explicitly selected skills. To make a private skill model-visible, omit `disable-model-invocation` or set it to `false`; its profile directory already limits discovery to the selected profile. Reload a startup profile with `/reload`; already launched Subs retain their resolved skill selection.

For delegated Subs, Facets resolves non-MCP profile tools through Pi's canonical `sourceInfo.path` and loads the extensions that own those tools. Native tools such as `read` and `bash` need no extension. Subs also explicitly load `builtin:codemode`, `builtin:tool-search`, and `builtin:mcp`, because `--no-extensions` disables them along with unrelated ambient extensions. In-memory SDK tools without a loadable extension path are still rejected.

MCP follows Pi's normal configuration in the Sub's environment and working directory, including server enabled state, project trust, credentials, and tool exposure. Facets does not copy Main's server configuration, isolate servers, or select MCP tools by profile. Sub launch makes Codemode, tool search, all `mcp__*` tools, and MCP resource tools eligible through Pi's native tool selection. MCP names in `profile.tools` are unnecessary and do not narrow this set or force indirect tools into direct declarations. They also do not fail startup while servers are still connecting; Pi owns connection waiting and error reporting.

## Tools

### Main Pi

- `delegate` — launch a fresh agent-invokable Sub or resume an agent-invokable persistent Sub session by session ID; model-only, so it cannot be called through Codemode or other nested tools
- `talk` — queue one message to an existing Sub through Pi's native follow-up scheduling
- `interrupt_sub` — request cancellation of the current Sub turn without closing its session or tab. Requests are tied to the active input/work boundary, including native follow-ups, so a late request cannot cancel subsequent work. Pi's cancellation is cooperative; a tool that ignores abort may continue running.
- `close_sub` — stop active work if needed and close the Sub session
- `list_sub` — render `subs` with Herdr's live `working`/`blocked`/`idle` status for open Subs and `closed · resumable` for saved sessions. By default, show working or blocked Subs and all persistent Subs (including idle open and closed resumable sessions; manual specialists are limited to their owning Main); use `all: true` to include idle or unknown ephemeral Subs. Status is `unknown` if Herdr cannot report it.

### Sub Pi

- `talk` — queue one message to the Main and end the current turn; model-only to keep its turn-ending behavior at the direct tool boundary

Sub mode is selected internally with `PI_FACETS_ROLE=sub`. Nested delegation is intentionally disabled in the MVP.

## Context boundary

Subs launch with:

- a Herdr tab; no headless fallback is available
- `--no-session` for ephemeral profiles; persistent profiles use a normal saved Pi session
- `--no-extensions -e <Facets>` plus explicit profile extensions and native MCP support, without unrelated ambient extensions
- `--approve` when the Main project is trusted, otherwise `--no-approve`
- a fresh initial prompt rather than a Main session fork
- profile-selected non-MCP tools plus native MCP tools and discovery helpers through Pi's `--tools` option

A fresh Sub receives Pi's native base instructions and project context (including trusted `AGENTS.md` files), ambient MCP context, the profile-selected non-MCP tools and skills, profile instructions, and the mandatory `talk` protocol. It does not inherit the Main conversation or Facets `MAIN.md`. Pi's native startup tool selection also filters unselected non-MCP tools from extensions that register multiple tools, including Codemode listings; Facets adds no execution-time permission checks. A missing or hidden configured non-MCP tool stops initialization instead of silently producing the wrong starting context. The Main resolves the profile once and stores that launch snapshot in the channel manifest, so later profile config edits do not change an already-running Sub. Explicitly resuming a persistent Sub restores that Sub's own history.

The Main TUI renders each launch with the selected profile plus its configured tool and skill names; long capability lists are compacted. Facets does not add separate Sub-created or Sub-closed lifecycle messages. Each `talk` delivery is stored and rendered as one native user message, with an explicit Main/Sub source label and a delivery identity header. This exposes only explicit `talk` deliveries, never the Sub transcript. Legacy custom messages in saved sessions retain their original renderer.

File arrivals enter Pi's native follow-up queue while the receiver is busy and appear in its normal pending-input display. Idle submissions are serialized through prompt preflight to avoid starting competing runs. Deliveries use input source `extension`, with slash-command and prompt-template expansion disabled; peer text is not executed as a command.

Profiles control startup context, not security isolation. Subs run as the same OS user; tool and skill selection is not an operating-system sandbox.

## Herdr lifecycle

The Herdr adapter performs:

1. `herdr tab create` with a label such as `↳ pi · Review auth`
2. `herdr agent start ... --kind pi` in the new tab's root pane and wait for idle readiness
3. explicitly load Herdr's installed Pi lifecycle integration when available
4. submit the task through `herdr agent prompt` so Herdr observes the working transition
5. continue communication through the private file channel, not terminal scraping
6. keep the tab open until `close_sub` or manual closure

The adapter requires a current Herdr release that supports `tab create` and `agent start --kind`. If Herdr is unavailable, `delegate` fails instead of falling back to a non-interactive process.

Once tab creation supplies a tab ID, startup failures, exceptions, and cancellation roll back the tab without inheriting the cancelled signal. If rollback also fails, Facets retains the run and surface handle and reports its run ID for a `close_sub` retry. An explicit close checks Herdr's result: a failed close keeps the run open and its channel intact. A malformed creation response without a recoverable tab ID still requires manual cleanup.

### Hide/show Facets Subs

The companion plugin under `herdr-plugin/` marks Facets Subs as hidden in Herdr's Agents panel by default and exposes show/hide/toggle actions:

```bash
herdr plugin link /absolute/path/to/facets/herdr-plugin
herdr plugin action invoke facets.agent-visibility.hide-subs
herdr plugin action invoke facets.agent-visibility.toggle-subs
```

This is a global flat-list filter, not per-Main tree expansion. It changes only the built-in Agents view; `agent list`, lifecycle state, notifications, and attention counts remain unchanged. See [`herdr-plugin/README.md`](herdr-plugin/README.md) for the optional keybinding.

## File channel

Runtime data lives under:

```text
$XDG_RUNTIME_DIR/pi-facets-<uid>/<main-session>/<run-id>/
├── manifest.json
├── to-main/
├── to-sub/
├── to-main-sequence.json
├── to-sub-sequence.json
├── session.json
├── close.json
└── closed.json
```

Directories use mode `0700`, files use `0600`, writes use atomic rename, and every payload carries a random capability token plus exact Main/run identity. Each direction has one writer and a persisted sequence counter, so messages retain their send order across same-millisecond writes, clock rollback, and extension reloads. Late writes cannot recreate a removed channel. Directory watches notify only the affected channel, with a 20 ms coalescing window; temporary files and unrelated control writes are ignored. A five-second rescan retries unavailable watches and recovers missed events. Startup and reload perform an initial scan, and shutdown releases watchers and timers.

A `talk` tool result confirms queuing, not peer acceptance. Message files stay in the inbox until the receiving Pi records a user message whose leading `[Facets delivery v1]` header matches the run ID, message ID, and direction. User messages have no custom `details` field, so this identity is carried in the message text; input-transforming extensions must preserve the header for acknowledgment. Legacy custom-message receipts are also recognized after an upgrade. Saved receipts prevent duplicate delivery after reload; ephemeral sessions keep receipts only in memory. In-flight IDs suppress duplicate enqueues and survive extension reload because Pi may retain its native queue. Failed submissions remain queued for retry. Abort alone pauses work without resending potentially retained native messages; a subsequent normal run retries withdrawn messages that still have no receipt, and a fresh receiving session recovers from the file inbox. This is not an exactly-once guarantee across every process or system crash.

Closing a Sub does not discard queued Sub-to-Main messages: its closed state and channel are retained until the Main receives them, without consuming an open-Sub slot. Protocol errors are reported once per unchanged failure and retried on subsequent watch/lifecycle wakes or fallback scans; one broken channel does not stop other Subs. Corrupt payloads remain available for manual inspection rather than being silently discarded.

## CI and automatic npm releases

GitHub Actions runs type checks, tests, package metadata validation, and a packaging dry run for pull requests and pushes to `main` and `dev`, on Node.js 22.19 and 24.

A **version increase in `package.json` pushed to `main`** releases automatically after both check jobs pass:

1. Validate the matching version in `package-lock.json`.
2. Reserve `v<version>` at the exact checked commit.
3. Publish the npm tarball through OIDC trusted publishing, with provenance.
4. Create the GitHub Release with automatically generated release notes.

Ordinary code/dependency changes with no version increase do not publish. Neither PRs, `dev` pushes, tag pushes, nor installing the workflow alone publish a package. Stable versions use npm's `latest` tag; prereleases such as `0.6.0-rc.1` use `next` and GitHub's prerelease flag.

### One-time npm setup

In the npm settings for **pi-facets**, add a **GitHub Actions Trusted Publisher**:

| Setting | Value |
| --- | --- |
| Organization or user | `oldflag2333333` |
| Repository | `pi-facets` |
| Workflow filename | `release.yml` (filename only, not a path) |
| Environment | Leave blank; this workflow does not use a GitHub Environment |
| Allowed actions | Allow direct `npm publish` |

No `NPM_TOKEN` secret is needed. GitHub supplies its built-in `GITHUB_TOKEN` for tags/releases; only the release job has `contents: write` and `id-token: write`. Publishing runs on a GitHub-hosted runner with Node 24 and a pinned npm 11 CLI. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) for package-side setup.

Commit the workflow to GitHub and enable Actions before the first version bump. Keep `package.json`'s `repository.url` aligned with this repository; npm provenance and the release script verify that identity.

### Releasing

On your feature/release branch:

```bash
npm version minor --no-git-tag-version
# Or: npm version patch --no-git-tag-version
git add package.json package-lock.json
git commit -m "chore: release v0.6.0"
```

Merge that change into `main` (or push it directly if your branch policy allows). The workflow handles the tag, npm publication, and GitHub Release; do not run `npm publish` yourself.

If publishing fails, correct the external setup and **re-run the original failed workflow** on its original commit. An identical already-published artifact is not republished, so a failed GitHub Release step can be completed safely. An existing tag pointing elsewhere, an npm version with different contents, or a version that would move a dist-tag backwards causes an error instead of an overwrite. A failed npm publish may leave its reserved Git tag, but no GitHub Release is announced until publication succeeds. Publish one version at a time.

GitHub Releases created by `GITHUB_TOKEN` do not trigger a second release workflow, so npm publication and Release creation deliberately run in the same job.

## Install for development

```bash
npm install
npm run check
pi -e ./src/index.ts
```

Or register the local package:

```bash
pi install ./
```

Then restart Pi or run `/reload`.

## Example

Ask the Main Pi:

```text
Delegate a read-only Sub to review the authentication refresh flow. Give its Herdr tab the title "Review auth".
```

Equivalent model-facing call:

```json
{
  "title": "Review auth",
  "task": "Review the authentication refresh flow. Return concrete risks with file and symbol references.",
  "profile": "reviewer"
}
```

## Current limitations

- no built-in profiles; every delegated Sub requires an explicit global or trusted-project profile
- custom profile tools must already be registered in the Main Pi so Facets can resolve their owning extension; in-memory SDK tools cannot be recreated in delegated Subs
- built-in MCP tools cannot yet be delegated; explicit isolated MCP server selection is required before this can be supported
- maximum four open Sub sessions
- no nested Subs
- no worktree adapter yet
- no OS-level sandbox
- Main shutdown and `/reload` preserve open Sub sessions and channels
- a graceful manual close of a Herdr tab is reported back; its retained channel is released after final Sub-to-Main messages are received. Hard crashes still require manual cleanup
- hard Herdr or Sub crashes without graceful shutdown require manual cleanup
- each `talk` message is bounded to 1 MiB

## Planned next steps

1. fake-Herdr adapter integration tests
2. real Herdr end-to-end test for delegate → talk → talk → close
3. tmux surface adapter
4. worktree-backed write mode
5. external adapter registration API
6. optional hardened/container launcher
