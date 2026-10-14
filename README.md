# Nexia CLI

During development, the platform automatically cleans up unused old source
bodies while preserving current execution and required recovery sources. The
Developers project development page shows your sandbox's source usage and
provides **Clean up old sources**. Cleanup does not delete local files,
sandbox data, or published versions.

If an interrupted upload's source has expired before runtime preparation,
`nexia dev` re-uploads the local source and continues. Requests already
accepted by the platform keep their original operation and recovery identity.

Public PHP/React App development tools for Node.js 22.12+ (npm 11.x), PHP 8.4+
and Composer. This command interface is a breaking change: old spellings are
rejected, not hidden aliases. Platform authentication, resource generation,
source synchronization, database requests and version review keep their existing
contracts. SSO and named profiles are not implemented.

## Start a project

```sh
npm install -g @nexia/cli@alpha
nexia setup --devtools
nexia create project my-project
cd my-project
nexia create app people
cd people
composer install --no-scripts
npm install
nexia make resource Note
nexia dev
```

`setup --devtools` installs/updates generators in the CLI-owned tools directory,
not global Composer. Plain `setup` asks whether to also install/upgrade Homebrew
PHP and Composer on macOS, shows the plan and requires confirmation. Existing
runtime versions may change; this release does not change the installer's upgrade
policy. On Linux/Windows install prerequisites yourself, then use `--devtools`.
`setup --dry-run` performs no installation. No shell startup files are edited.

To join a project, create an empty project folder and run `nexia connect <project-id>`
there. Approve in the browser, clone the Apps you need as direct child folders,
install their dependencies, then run `nexia dev`. A project folder is not itself
an App repository. Project/App instructions are created without overwriting yours.

## Commands

| Command | Purpose |
| --- | --- |
| `update` | Check and install the newer alpha CLI release |
| `setup` | Prepare environment and generators |
| `create [project\|app]` | Select a creation task; optionally supply the new folder |
| `connect [project-id]` | Authenticate and bind the current project folder |
| `login [project-id]` | Authenticate/re-authenticate without changing folder bindings |
| `logout` | Revoke authentication; retain bindings and data |
| `make [resource\|page]` | Select generated code; optionally supply its PascalCase name |
| `dev config` | Config Apps: save the project’s default development Apps |
| `dev` | Select up to 20 project Apps on one preview connection |
| `check` | Inspect App source; no remote runtime verification |
| `status` | Inspect authentication, project, folder and sandbox |
| `db migrate` | Request an App sandbox migration |
| `db seed [key]` | Run this App's declared development data |
| `db status` | Inspect the App database operation |
| `submit` | Submit an existing Git version tag for review |
| `submit list [--page N]` | List recent submissions for this project or App |
| `submit status\|cancel\|retry [id]` | Choose a recent submission, or use an explicit ID |
| `help [command]`, `--version` | Help and installed CLI version |

## CLI updates

Run `nexia update` to check the npm alpha channel and confirm an update.
`nexia update --dry-run` shows the available update without installing it;
`nexia update --no-interactive --yes` explicitly authorizes installation in automation.
The installer verifies that this CLI belongs to the active npm global installation,
installs the exact version shown, and asks you to rerun your original command.
It does not rerun business operations automatically or use sudo.
For other package managers, source checkouts, or Windows, use your original
installation method; npm users can always run `npm install -g @nexia/cli@alpha`.

Interactive commands (including plain `nexia`) offer **Update now**, **Skip this
time**, or **Remind me in 24 hours**. Registry checks have a two-second timeout
and are cached for 24 hours in the CLI config directory (`update.json`, separate
from authentication). Network/cache failures do not block ordinary commands.
Skipping continues the original command; a failed installation stops it with an
error. Help, version output, CI, non-TTY, `--json`, `--no-interactive`, `--yes`,
`--dry-run`, and source checkouts do not trigger automatic checks or prompts.
Explicit `nexia update` ignores the notification cache and reminder delay.

## Questions and options

Start with `nexia create` or `nexia make`; select the task with ↑/↓ and Enter. Terminals without raw input accept a number or name.
Missing settings are asked one at a time with defaults. Explicit options are
validated and never asked again. Menu-specific settings are skipped when menu
visibility is disabled. A final summary offers create, edit a setting, or cancel.
Invalid answers retry that field; Ctrl+C/EOF cancels. No generation happens before
confirmation. Generation first runs the existing generator preflight. Resource generation skips
existing files and registration entries; page generation rejects collisions.
Neither overwrites existing source. An OS write failure can still require
inspecting already reported writes.

```sh
nexia create app people --vendor acme --family people
nexia make resource LeaveRequest --label-ko '휴가 신청'
nexia make page Summary --label-ko '요약' --no-record --no-navigation
nexia help make resource
```

App settings: `--name`, `--vendor`, `--family`, `--key`, `--display-name`,
`--table-prefix`, repeatable `--prerequisite`. App folders must be new direct
children. Existing destinations are preserved, including during `--dry-run`.

Resource settings: `--label-ko`, `--label-ko-plural`, `--label-zh`,
`--label-zh-plural`, `--record-owner legal_entity|tenant`, `--navigation` or
`--no-navigation`, `--navigation-group`, `--navigation-subgroup`, `--icon`, `--sort`.
`--sort auto` preserves the generator's next available position. Ownership is not
an access grant. Korean labels are required by the existing generator; English
names are derived and omitted Chinese labels retain their English fallback.
This release deliberately does not change translation generation semantics.

Page settings: `--label-ko`, `--record` or `--no-record`, `--navigation` or
`--no-navigation`, `--navigation-group`, `--sort`. A page does not create a model,
migration or Resource. Implement its business query before using it.

Groups are `insights`, `management`, `operations`, `master-data`, `settings`.
Menu options with `--no-navigation`, duplicate scalar options and contradictory
booleans are errors. Field/type/relationship designers and force-overwrite are
not part of the public CLI. Prompt language follows `LC_ALL`, `LC_MESSAGES`, then
`LANG` (Korean or English); backend/tool diagnostics retain their own language.

## Folder and App selection

App subdirectories work: the CLI walks upward to find the owning App/project.
`--app <folder-or-key>` selects an immediate project App explicitly. Otherwise,
App-local commands use the current App, select the only project App, or ask when
multiple Apps exist. `create app` from an App creates a sibling in the project,
never a nested App. `connect` must run at the project root, outside an App.

`check` checks all Apps from the project root and only the current App from inside
it. Interactive `dev` always opens a picker
that uses the terminal height instead of a fixed eight-row window:
use ↑/↓ to move, Space to toggle an App or **All Apps**, and Enter to start.
Select 1–20 Apps. All Apps is unavailable when the project already has more than
20 Apps. Ctrl+C cancels before connecting. The picker is also shown for a single App.

Run `nexia dev config` to save an App group. Enter saves; Ctrl+C leaves
existing settings unchanged. Every interactive `nexia dev` still displays
**All Apps**, **Config Apps**, and individual Apps. A valid Config group is
checked by default; its members are checked and marked **(Config)** in the list.
Add other Apps with Space. Members included by Config cannot be toggled
individually until Config is unchecked, so the 20-App limit counts unique Apps.
Unchecking Config retains additional manual choices. Selecting All Apps clears
Config and manual selections; selecting an individual App then leaves All Apps
mode and selects only that App. Enter starts the chosen scope.

Reopen `nexia dev config` to edit the preselected group. The startup picker never
rewrites it. Settings are local to `.nexia/dev.json`, scoped to platform/project.
Missing or invalid Config settings disable that option while allowing manual
selection; use `nexia dev config` to repair them. Explicit `--app` skips the
picker for one run and never rewrites settings.

```sh
nexia dev config
nexia dev
nexia dev config --app people,payroll --no-interactive --yes
```

Use comma-separated names/keys or repeat `--app` to skip the picker:

```sh
nexia dev --app people,time-absence,payroll
nexia dev --app people --app time-absence --app payroll
```

Non-interactive `dev` without `--app` retains all-App watching, up to 20 Apps;
larger projects must supply repeated `--app` options. `dev config` also accepts repeated `--app`; other commands accept
only one `--app`. The default port is 4310 (`--port` to change it).
`--container` supports container preview access. A project uses one preview port.
In All Apps mode, new Apps join automatically up to the 20-App limit; restart
and select Apps if the project exceeds it. Individual selections only watch the
selected identities. Duplicate identities and symlink folders are not run.

When `dev` first observes an App with development execution off, it requests
one switch to development using the existing platform API. A pending switch
waits for server-confirmed shutdown. Later Console stop decisions are respected;
the watcher never repeatedly switches an App back on. A changed selection,
permission failure, or uncertain response stops that App with its cause and a
link to development settings; inspect the state before restarting. Automatic
resume is a request, not proof that runtime preparation has completed.

`dev` handles registration, sandbox preparation, immutable source snapshots and
frontend watching. A snapshot is limited to 2000 files, 2 MiB/file, 16 MiB total;
it excludes secrets/dotfiles, dependencies and symlinks. Snapshot retention limits
remain 100 revisions/512 MiB per sandbox. Data is never automatically reset.
Stopping the local watcher retains data. Remote runtime management stays in
Developers; a writer lease or pending preparation may prevent another writer.

## Authentication

`login` uses the current project ID when known, or asks for one. It still requests
project-scoped browser approval, not account-wide authority. `connect` authenticates
and creates the local project binding. `create project` also includes approval.
`--no-browser` prints the URL without opening it. Logout does not disconnect the
folder or erase its data. `status` reports a mismatch; no command silently retargets
an App to the currently authenticated project.

The default is https://developers.nexia.to. Platform maintainers can set
`NEXIA_ENDPOINT` for `login`, `connect` or `create project`; a bound project's origin
wins during re-authentication. Changing endpoint clears the old authentication.
Do not commit `.nexia/` or copy the private global CLI credential file.

## Database and submission

Database commands operate only on the registered App's active sandbox. `db seed`
asks from this App's declared fixture keys; other installed Apps are not targets.
A returned `queued` operation is not completion: inspect `db status`. Stop `dev`
first if it owns the writer lease. Retry a lost response using the same printed
`--request-id`; a review-required operation needs operator inspection.

Commit and push source and the intended version tag with Git yourself. From the
App run `nexia check`, then `nexia submit --tag v1.0.0`. If repository connection is
missing, interactive submission opens Developers for approval. Automated callers
must connect it in Developers first. Submission does not create tags, push code,
publish or install an App. Use the returned ID with `submit status`; cancel/retry
are subject to server state and authorization. New source requires a new tag.

## Automation and recovery

`--no-interactive` prevents prompts. Non-TTY and `--json` do the same. Required
values and ambiguous App selection fail; optional values use documented defaults.
Use `--yes` to accept the final mutation plan. It does not supply missing values
or bypass browser approval/permissions. `--dry-run` skips the final confirmation
because no files/packages are changed. It is supported by setup and generators.

```sh
nexia make resource Note --app people --label-ko '메모' --no-interactive --yes
nexia submit --app people --tag v1.0.0 --no-interactive --yes --json
nexia submit status <submission-id> --json
```

`--json` is supported by status, DB and submission commands. Stdout contains one
JSON result (or `{ "error": { "code", "message" } }`); diagnostics go to stderr.
Exit codes: 0 success/request accepted, 1 operation failure, 2 invalid/missing
input, 130 cancellation. Request acceptance is not job completion.

After authentication expires, run `nexia login` in the project. On lost project
creation responses, rerun the same folder/name to resume approval. A saved pending
approval is not a second project. On a source/build failure, fix the reported
cause and restart `dev`; do not reset data as a repair shortcut.

## Migration and retained internals

Replace `init` with `create app`, `create-project` with `create project`,
`link-project` with `connect`, `make:resource/page` with `make resource/page`,
`validate` with `check`, and `submissions` with `submit`. Run in the intended
folder or use `--app`; trailing directory arguments are no longer supported.
Replace `--without-navigation/record` with `--no-navigation/record`.

Separate register/sync/runtime/repository/doctor commands, browser templates,
DB reset/references, cross-App fixtures, resource catalogs, signature generators,
Filament flags, runtime-image inspection and local MCP are not public CLI commands.
Their existing platform, SDK or internal implementations are not deleted. Direct
manual source snapshotting and launching MCP through `nexia` are consequently no
longer available; source sync remains in `dev`. Do not assume every excluded
command has an equivalent Console action. Signature/Filament generators remain in
PHP devtools for their existing callers; they are not advertised in basic CLI help.

## Working on the platform

Set `NEXIA_DEVTOOLS_PATH` to an independently installed devtools executable when
working on its source. Install that checkout's Composer dependencies first;
`setup --devtools` is unnecessary when `NEXIA_DEVTOOLS_PATH` is set. The managed
installer is for CLI consumers, not the Core production host. No global alias or
global Composer change is required.
Never point it at a script inside the App being generated/checked.

## Troubleshooting

Find the exact terminal error in the [CLI troubleshooting guide](https://developers.nexia.to/docs/troubleshooting-common-installation-errors).
It covers setup, project bindings, Vite/source uploads, HTTP errors, preparation,
database requests, and submissions. `APP_PREPARATION_FAILED` identifies failures
that never started or have an approved safe retry; `APP_PREPARATION_REVIEW_REQUIRED`
requires an operator to verify the outcome. Keep the printed operation ID and
`.nexia` recovery state. Do not remove and restore App folders to bypass a failure.

`dev` retries temporary connection failures, timeouts and HTTP 502/503/504 while
synchronizing source or recovering a preparation. An uncertain preparation keeps
its original request ID, including when local files change. Retry messages name
the affected request; keep `.nexia` and let the existing process recover.
Authorization failures and preparations requiring operator review still stop.

Developer support: https://github.com/nexia-cloud-os/developer-support/issues.
Include sanitized reproduction and package versions, never credentials or data.

### Find and stop a background development session

From the same project (or one of its Apps), use:

```sh
nexia ps
nexia ps --json
nexia stop --port 4310
nexia stop
nexia status
```

For Docker sessions, run these commands inside the same container.

`ps` lists this folder's tracked local sessions, PIDs, preview ports, selected
Apps and workspace links. `stop` asks those Nexia processes to shut down their
watchers and preview servers, including sessions started by an assistant. It
never kills an arbitrary port owner or deletes remote data. An acknowledgement
of `stopping` means shutdown has not finished; check `ps` again. An unreachable
record may be stale and is not proof of a running process. Sessions started by
older CLI versions are not tracked: use their terminal's Ctrl+C, or inspect
`lsof -nP -iTCP:4310 -sTCP:LISTEN` and stop only the intended process.

`status` also reports the project's Git connection, last checked Git tag,
latest submitted tag, published version and deployed version when the platform
supports this metadata. Deployed means the current platform environment, not a
tenant's installed version. Open the App's repository page in Console to refresh
remote tags. Unknown or unchecked values are not inferred from published versions.

## Terminal links

`nexia ps` and `nexia dev` emit OSC 8 hyperlinks for workspace and development
settings URLs in interactive terminals. `nexia dev` also prints the actual
**Local App address (copy)** as plain text, including its listening port, on its own line at startup
and in the development-off notice. Copy this address into the workspace’s local
App address field; changing `--port` is reflected in that line. Recognized terminals show short labels;
unknown terminals retain the full visible URL with the hyperlink destination.
Piped output, CI, dumb terminals and Apple Terminal retain plain URLs. JSON
session data keeps the original URL without escape sequences. Click gestures
depend on the terminal (for example, Command-click in iTerm2); browser opening
is always initiated by the user.

### Preparation error details

When the server provides safe failure details, `nexia dev` shows the failed step
and recovery guidance. `SDK_VERSION_MISMATCH` includes the App's required PHP SDK
range and the server version: contact developer support with those versions and
the operation ID. Local Composer installation cannot update the server runtime.
`DEPENDENCY_BUILD_FAILED` points to supported composer.json dependencies and
server build inspection; other failures show the preparation stage.
The operation's existing retry/review instructions still apply. No failure
detail triggers an automatic retry, deletes .nexia, or resets data. Older servers
and operations without details retain the existing generic guidance.
## Public developer documentation

```sh
nexia docs
nexia docs search "Resource permission" --locale en
nexia docs read app-sdk-sdk-contracts --locale en
nexia docs search "권한" --locale ko --json
```

These commands work from any directory without login, project bindings or reading
stored credentials. They use https://developers.nexia.to, or NEXIA_ENDPOINT when
explicitly set, and require a Developers deployment with the documentation API.
If either the CLI or server does not support this yet, read the
[App development guide](https://developers.nexia.to/docs/getting-started-agent-assisted-development).
Search matches all whitespace-separated terms, ranks title/description matches
first and returns at most 20 results with the total count; narrow broad queries.
Read prints Markdown; `--json` returns structured results. Source URLs and actual
source languages are included. A missing translation may use a fallback edition.
Check documented requirements against the SDK versions in your lockfiles and
installed public types: these documents are not an installed-version snapshot.

The public HTTP contract is `GET /developer-api/docs?q=<query>&locale=en` for
search and `GET /developer-api/docs/<document-id>?locale=en` for a document.
Search returns `{query, locale, total, documents}`; each summary contains
`id`, `title`, `description`, `url`, `locale`, `source_locale`, and `locale_status`.
Read adds `content` (Markdown). Invalid input returns 422, missing/unpublished
IDs return 404, and rate limits return 429. No bearer token is sent.
New project/App instruction templates point to the guide. Existing AGENTS.md
files belong to developers and are never synchronized by this feature.

## Submission selection and sign-in lifecycle

`nexia submit status` shows recent submissions for the current App, or the whole
project from its root. Choose by App, Git tag, state and creation time with
↑/↓ and Enter; Esc or Ctrl+C cancels. Older/newer pages remain available in the
picker. `nexia submit list --page 2` prints 20 items per page and their IDs.
An explicit ID still works. Without a terminal, `submit status` without an ID
returns the list (also with `--json`); cancel/retry require an explicit ID and
confirmation. The server rechecks current project access on every request.
The list API must be deployed before this CLI's selection flow is distributed.

- `connect`: bind a project folder and sign in through browser approval.
- `login`: sign in again for that folder. It does not recreate or delete a sandbox.
- `stop`: stop tracked local dev watchers/preview servers; keep remote data.
- `logout`: revoke this CLI login and clear its local token. It does not stop local
  processes, delete the project/sandbox/workspace, or sign out the browser.

For a pause, use `nexia stop`. To also sign out, run `nexia logout` afterward.
To resume, use `nexia login` if needed, `nexia status`, then `nexia dev`. A watcher
keeps the login it started with; after reauthentication stop/restart old watchers.
An expired/revoked token can still be cleared by logout, and status reports that
sign-in is required. Network failures are reported rather than treated as logout.

Help is grouped by task. Interactive selections use arrows and highlight the
current row; terminals without raw input retain numbered choices. `NO_COLOR`
or `TERM=dumb` disables colors. Piped/JSON output stays plain and noninteractive.

### Development logs

`nexia dev` prints App-prefixed warnings, errors and build failures. Use
`nexia dev --verbose` to include general browser/PHP logs and successful request
timings. Routine messages are filtered before serialization and transmission in
the default mode. Vite uses its warning log level by default.

Browser diagnostics include console calls attributed to the local App, uncaught
errors, rejected promises, API failures and React boundary errors. Host-only
messages are not attributed to an App. Output is batched, with at most 20 queued
events, 16 KiB per request and 120 events per App per minute. Object inspection is
bounded and does not evaluate getters; the browser console remains the local source.

With a supporting Core and runtime image, PHP diagnostics are read every two
seconds. The runtime retains 100 messages of at most 2 KiB in a local temporary
file bounded to 800 KiB + 256 bytes per App scope, reused across revisions. It
writes one fixed slot per event, uses nonblocking locks and limits recording to
120 events/minute plus an overflow notice. Polling reads only new slots. Verbose
collection expires within 15 seconds after polling stops. No log rows are written
to the database; this is not an administrator error archive.

Build output has bounded partial lines and rate limits; a slow terminal pipe
cannot accumulate an unlimited output queue. Overload, lock contention or slow
consumers may drop messages to protect development. These bounds are not a
measured CPU or memory performance guarantee.

Reconnects use a cursor and report expired history. Logs from customer
installations, other developers and other Apps are not exposed. Disconnection
does not stop development; Ctrl+C closes log polling together with the watchers.
Older servers report unsupported PHP logs rather than implying no errors.

Common credential fields are masked, but developers must still avoid logging
secrets or unnecessary personal data. PHP startup failures before application
logging is initialized and operator/container logs remain outside this stream.
Deploy the matching runtime image and Core API before the CLI. No new dependency
or external logging service is required.
