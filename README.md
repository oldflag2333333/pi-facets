# Facets

A Pi extension for reusable capability profiles and delegating self-contained work to a fresh Sub Pi without sharing either session's full conversation.

The Main and Sub communicate through a deliberately narrow protocol:

- Main → Sub: messages through `talk`, cancellation of the active turn through `interrupt_sub`, plus explicit closure
- Sub → Main: messages through `talk`
- never exposed by the extension: transcript, thinking blocks, tool history, or session files

Facets requires a supported interactive Sub surface. Herdr is currently the only surface adapter; future adapters may include tmux. Every Sub opens in a labeled Herdr background tab and remains open until the Main calls `close_sub` or the user closes the tab manually.

> Status: early development MVP. The protocol and file channel are implemented; real-Herdr compatibility still needs end-to-end testing.

Requires Node.js 22.19+ and targets Pi 1.0.2. The test suite includes real Pi SDK checks for isolated built-in extension loading and direct/nested tool policy enforcement.

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
└── config.json

<cwd-or-ancestor>/.pi/facets/profiles/reviewer/
└── config.json
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

Profile `instructions` are additive. Facets uses Pi's mutable `systemPromptOptions.sections` API rather than replacing the full system prompt: Main contributes `facets_profiles` (capability catalog), `facets_profile` (selected profile instructions), and `facets_main` (`MAIN.md`); Sub contributes only `facets_sub_protocol` and `facets_profile`. Pi continues to assemble its native role, tool summaries, rules, documentation, project context, skills, and cwd according to the user's Pi configuration. Normal prompts record changed sections as transcript updates without repeating unchanged sections. Pi's idle custom-message runs bypass `before_agent_start`, so Facets also supplements missing or changed owned sections through `context_with_system` for those requests; this request-local fallback keeps profile instructions and the Sub protocol present without replacing native context.

`thinkingLevel` is passed to Pi rather than constrained by a Facets-owned enum. `sessionPersistence` is `ephemeral` by default or `persistent`: ephemeral conversations remain in memory only, while persistent conversations are saved by Pi and can later be resumed through `delegate.resumeSessionId`. Both remain open until the Main calls `close_sub` or the user closes the Herdr tab. Skill entries may be standard skill names or paths relative to the profile file. Named project skills are also resolved from the Main Pi working directory and its ancestors, but only when project resources are trusted. Untrusted projects cannot contribute automatically discovered named skills. User-configured explicit skill paths remain relative to the profile file and are still honored independently of project discovery. Selecting a skill in a profile is an explicit capability choice, so Facets makes it model-visible even when its source declares `disable-model-invocation: true`; the source is not modified, and relative skill assets remain available through a private runtime mirror. Valid profile names, scope, and descriptions are injected into the Main Pi system context only as a capability catalog, so it can select a profile without calling a discovery tool; Main routing policy belongs in `MAIN.md`. Users can still run `/profiles` for diagnostics; profiles cannot be switched inside a running session.

Starting Pi without `--profile` preserves Pi's existing model, thinking, tools, and skills. A selected profile replaces the active tool list exactly and enforces its tool allowlist through Pi's tool-call pipeline, including Codemode/nested calls and tools registered later. Pi's active tool set alone is not a capability boundary: registered `codemode`/`deferred` tools can remain callable while inactive. Profile initialization errors fail closed for tool execution. Include `delegate`, `talk`, `interrupt_sub`, `close_sub`, and `list_sub` in an orchestrator profile when those controls should remain available. To opt into a startup profile:

```bash
pi --profile reviewer
```

For strict skill selection in a directly started Pi, also pass `--no-skills`; Facets contributes only the selected profile's skill paths. Delegated Subs always use `--no-skills` plus the resolved profile skills.

For delegated Subs, Facets resolves profile tools through Pi's canonical `sourceInfo.path` and loads only the extensions that own those tools. Native tools such as `read` and `bash` need no extension; selected `codemode` and `tool_search` tools explicitly load `builtin:codemode` and `builtin:tool-search`, because `--no-extensions` also disables built-in extensions in Pi 1.0. It does not inherit unrelated ambient extensions. Ambient built-in MCP tools are rejected before launch: isolated MCP server selection is not implemented, and loading all configured servers would widen the profile's capabilities. In-memory SDK tools without a loadable extension path are also rejected.

## Tools

### Main Pi

- `delegate` — launch a fresh Sub or resume a persistent Sub session by session ID; model-only, so it cannot be called through Codemode or other nested tools
- `talk` — queue one message to an existing Sub through Pi's native follow-up scheduling
- `interrupt_sub` — request cancellation of the current Sub turn without closing its session or tab. Requests are tied to the active input/work boundary, including native follow-ups, so a late request cannot cancel subsequent work. Pi's cancellation is cooperative; a tool that ignores abort may continue running.
- `close_sub` — stop active work if needed and close the Sub session
- `list_sub` — render `subs` with Herdr's live `working`/`blocked`/`idle` status for open Subs and `closed · resumable` for saved sessions. By default, show working or blocked Subs and all persistent Subs (including idle open and closed resumable sessions); use `all: true` to include idle or unknown ephemeral Subs. Status is `unknown` if Herdr cannot report it.

### Sub Pi

- `talk` — queue one message to the Main and end the current turn; model-only to keep its turn-ending behavior at the direct tool boundary

Sub mode is selected internally with `PI_FACETS_ROLE=sub`. Nested delegation is intentionally disabled in the MVP.

## Context boundary

Subs launch with:

- a Herdr tab; no headless fallback is available
- `--no-session` for ephemeral profiles; persistent profiles use a normal saved Pi session
- `--no-extensions -e <Facets>` so unrelated ambient extensions are not inherited
- `--approve` when the Main project is trusted, otherwise `--no-approve`
- a fresh initial prompt rather than a Main session fork
- an explicit tool allowlist

A Sub receives the configured profile tools plus the mandatory `talk` protocol tool. It validates effective tool activation at startup and enforces the same allowlist for direct and nested calls; a missing or hidden configured tool stops initialization instead of silently dropping a capability. The Main resolves the profile once and stores that immutable launch snapshot in the channel manifest, so later config edits cannot change an already-running Sub.

The Main TUI renders each launch with the selected profile plus its configured tool and skill names; long capability lists are compacted. Facets does not add separate Sub-created or Sub-closed lifecycle messages. Each Sub `talk` message is stored as one visible custom message in the Main session, rendered with the Sub title and a three-line preview. This exposes only explicit `talk` deliveries, never the Sub transcript.

File arrivals enter Pi's native follow-up queue even while the receiver is busy. Facets adds no separate queue display; messages become visible through the existing formal inbox block when the receiving session records them.

This is a protocol boundary, not an operating-system sandbox. A Sub with shell access runs as the same OS user and may be able to access files outside the project. A future hardened adapter should run write-capable Subs in a container or restricted worktree environment.

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

A `talk` tool result confirms queuing, not peer acceptance. Message files stay in the inbox until the receiving Pi records a custom-message receipt with the matching run ID, message ID, and direction. Saved receipts prevent duplicate delivery after reload; ephemeral sessions keep receipts only in memory. In-flight IDs suppress duplicate enqueues and survive extension reload because Pi may retain its native queue. Failed submissions remain queued for retry. Abort alone pauses work without resending potentially retained native messages; a subsequent normal run retries withdrawn messages that still have no receipt, and a fresh receiving session recovers from the file inbox. This is not an exactly-once guarantee across every process or system crash.

Closing a Sub does not discard queued Sub-to-Main messages: its closed state and channel are retained until the Main receives them, without consuming an open-Sub slot. Protocol errors are reported once per unchanged failure and retried on subsequent watch/lifecycle wakes or fallback scans; one broken channel does not stop other Subs. Corrupt payloads remain available for manual inspection rather than being silently discarded.

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
