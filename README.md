# Nexia CLI

During development, the platform automatically cleans up unused old source
bodies while preserving current execution and required recovery sources. The
Developers project development page shows your sandbox's source usage and
provides **Clean up old sources**. Cleanup does not delete local files,
sandbox data, or published versions.

If an interrupted upload's source has expired before runtime preparation,
`nexia dev` re-uploads the local source and continues. Requests already
accepted by the platform keep their original operation and recovery identity.

Public PHP/React App development tools for Node.js 22.12+ (npm 11.x), PHP 8.5.12+
and Composer. This command interface is a breaking change: old spellings are
rejected, not hidden aliases. Platform authentication, resource generation,
source synchronization, database requests and version review keep their existing
contracts. SSO and named profiles are not implemented.

`nexia dev` combines database and execution status into one request when the
platform advertises support. Older platforms keep the existing separate requests;
App, project, sandbox and selection revision checks still apply.

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

Leave `dev` running. In another terminal inside the App, run `nexia db migrate`
to initialize its database. Run it again explicitly after writing new migrations;
file saves do not change the schema.

`setup --devtools` installs/updates generators in the CLI-owned tools directory,
not global Composer. Run it after upgrading the CLI to receive the PHP 8.5.12 App template (devtools 0.2.12+). Plain `setup` asks whether to also install/upgrade Homebrew
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
| `db seed [key]` | Run an App Seeder or named fixture |
| `db rollback/reset/refresh/fresh` | Explicit development migration lifecycle |
| `db status` | Show migration files, batches and diagnostics |
| `db access` | Show one SQL account for all Apps in your personal sandbox |
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
After installation, the terminal shows a short excerpt from that version's GitHub
release notes and a link to the full description. `--dry-run` previews the notes
without installing. Notes describe the target release, not an aggregate of skipped
versions. Missing notes, timeouts, or GitHub rate limits do not fail the update.
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

After creation, enter the App directory, install its PHP and frontend dependencies,
and run `nexia test` and `nexia test --frontend`. Generated tests and configuration
belong to that App; they do not boot Core or require a Core checkout. Resource and
page generation use the same independently installed PHP devtools package.

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
not part of the public CLI. CLI help, prompts and built-in diagnostics are always in English, regardless of
`LC_ALL`, `LC_MESSAGES` or `LANG`. Public documents default to English;
`--locale ko` explicitly requests Korean document content. App-authored labels
and upstream tool output retain their original language.

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
selection; select **Config Apps** and press Enter to configure it immediately,
or use `nexia dev config`. Explicit `--app` skips the picker for one run and
never rewrites settings.

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

Generated Vite Apps reuse their prepared Backend when only browser source changes:
JS/JSX/TS/TSX/CSS/SCSS in `resources/js/`, or CSS/SCSS in `resources/css/` and
`resources/scss/`. These roots are browser-only inputs; Backend code must not read
them as runtime data. The frontend still rebuilds locally. With a matching Core
and an App rebuilt with the SDK's development-update contract, the Shell replaces
that App without reloading other tabs. Unsaved forms and pending/uncertain writes
defer replacement. This is App-scoped module replacement, not React Fast Refresh:
component-local state can reset when a clean generation is applied. Old SDKs keep
the explicit refresh path. Completed builds use immutable asset directories,
retained during this watch session for existing pages and lazy chunks.

PHP, routes, declarations, migrations, shared `resources/lang` translations,
Blade views, public files, build configuration and dependencies still prepare a
new Backend. Mixed changes follow that same full preparation path. The local
runtime fingerprint is computed from the exact uploaded snapshot; the full source
digest and remote revision are never rewritten to claim that local edits were
uploaded. Legacy state gets a one-time preparation if its full source no longer
matches. Publication and explicit database operations still upload complete source.

With the matching Core update, builds and runtime preparation show a pending state
and are polled automatically. A compile error is shown separately and recovers
after a successful build. Stopped execution and denied access remain blocked.
Older Core versions may still show a generic error while preparation is pending.

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

Run `nexia db access` from the connected project root or an App folder inside it. One personal sandbox account can read and write all managed App data. The CLI shows IP registration, server/gateway progress and elapsed time, then prints connection details and an **App name → schema name** list. Core data, database administration and App schema DDL are excluded. Use existing App CLI commands such as `nexia db migrate` for schema changes.

Create **one** PostgreSQL connection in DBeaver using the printed `Host`, `Port`, `Database`, `User` and `Password`. Select SSL `verify-full` and keep the printed hostname. Find each App in `App schemas`. New managed App schemas include the App name, such as `dev_people_<identity>`; existing schema names and data are preserved. This does not install PostgreSQL or create a database on your computer.

The account is separate from App runtime credentials. Stopping `nexia dev` or replacing an App execution does not replace it. Reuse the connection while the sandbox and your development access remain valid. New App schemas receive access during server synchronization; subsequent migration tables receive DML privileges automatically. Refresh DBeaver's schema list; do not rerun `db access` for every new App. Data stored in an App's local PostgreSQL database is not part of this server connection.

When watching all Apps, `nexia dev` discovers an App created with `nexia create app` in another terminal. If watching selected Apps, restart with a selection that includes the new App. After registration and database preparation, run `nexia db migrate` in that App's folder.

Use `nexia db access --ip <public-ipv4>` when your SQL client's public address changes, or `nexia db access --revoke` to close this personal sandbox SQL account's external connections while retaining data. Sandbox expiry/deletion or removal of development access ends access. Replace old per-App connection details with the new sandbox account. The new CLI requires matching Core and database gateway updates.

To keep one development App's data on your PC, **use your existing local PostgreSQL server and create an empty, dedicated database**. `nexia db local` does not install or start PostgreSQL and does not create the database itself. In DBeaver, connect to the local server's existing `postgres` database with an administrator account, open its SQL editor, and run `CREATE DATABASE nexia_app;`. Then connect DBeaver to `nexia_app` to confirm it exists. You can also use `createdb -h 127.0.0.1 -p 5432 -U postgres nexia_app`. Use a different database name for each App. The account passed to `nexia db local` must be able to create login roles and an App schema in that database; a PostgreSQL cluster administrator such as `postgres` has the required permissions.

From the App folder in a connected project with an active sandbox, set `PGHOST=127.0.0.1`, `PGPORT=5432`, `PGDATABASE=nexia_app`, `PGUSER` to that administrator account, and `PGPASSWORD` to its password, then run `nexia db local`. It registers App metadata first if needed, without starting runtime execution. The command creates the existing App migrator and runtime roles, copies only Core reference IDs needed by App foreign keys, and saves the non-secret connection settings in `.nexia/local-database.json`. The administrator password stays on your PC and is not saved in that file; clear `PGPASSWORD` from the shell after setup. Run this before the App's first sandbox migration; an App already allocated on the managed database cannot be moved silently.

If you do not have a local PostgreSQL server, Docker is one optional way to run one. This macOS/zsh example initializes `nexia_app` only when the named volume is new; keep that volume if the App data should survive container replacement. Run it from the selected App folder **before the first `nexia dev`**.

```sh
printf 'Local PostgreSQL administrator password: '
read -rs POSTGRES_PASSWORD
printf '\n'
export POSTGRES_PASSWORD
docker run -d --name nexia-local-pg \
  -e POSTGRES_PASSWORD -e POSTGRES_DB=nexia_app \
  -p 127.0.0.1:55432:5432 \
  -v nexia-local-pg-data:/var/lib/postgresql/data \
  postgres:17
docker exec nexia-local-pg pg_isready -U postgres -d nexia_app
export PGHOST=127.0.0.1 PGPORT=55432 PGDATABASE=nexia_app PGUSER=postgres
export PGPASSWORD="$POSTGRES_PASSWORD"
nexia db local
unset POSTGRES_PASSWORD PGPASSWORD
nexia dev
```

Wait for `pg_isready` to report that PostgreSQL accepts connections before running `nexia db local`. Keep this terminal running `nexia dev`. Open a **second terminal** in the same App folder for `nexia db migrate`, `nexia db status`, and later migration commands. For an already running local PostgreSQL server, skip the Docker steps and create the dedicated DB with `createdb`; use its actual loopback port and administrator account in the `PG*` variables.

Start or restart `nexia dev` after setup. While it runs, the CLI keeps an authenticated tunnel to the sandbox Manager, which forwards the App's PostgreSQL traffic to your loopback database. The App stops when that tunnel is unavailable; keep PostgreSQL and `nexia dev` running for migrations, SQL access and requests. Run `nexia db local` again when new Core reference IDs are needed. Existing reference IDs are retained so local App foreign keys remain valid. Local `db reset` and `db fresh` are unavailable; `migrate`, `status`, `rollback`, and `refresh` use the selected local database. This mode requires matching Core, CLI and Manager versions and an operator-configured tunnel endpoint.

`nexia dev` watches source without applying migrations or initialization. Keep it running while writing migration files. From the App folder in another terminal, run `nexia db migrate` when ready. The command uploads the current local source, pins that revision, and waits for completion; the watcher then resumes. A new App waits for its first explicit migration without administrator review. Development migrations can be rolled back, edited and run again. Published migration files remain immutable; add new files for published version upgrades.

From the project root, DB commands run all Apps sequentially; `--app=people` selects one, and an App folder selects that App. A failed App does not skip later Apps; any failure produces a nonzero exit code. `db status` lists migration files, batches and changed/missing/interrupted diagnostics, plus the last command. Status does not boot App PHP or initialize its schema. `db rollback` reverses the last batch (`--step` or `--batch` selects a range), `db reset` runs every `down()`, `db refresh` rolls back then migrates, and `db fresh` erases only the selected development schemas before migrating. Destructive commands confirm all selected Apps once.

`db migrate --step` records one batch per file. `--pretend` on migrate/rollback/reset previews SQL with literal values redacted. `db seed` runs pending versions registered by `VersionedTenantAppSeederContribution` (or the ordinary App DatabaseSeeder when no versioned contribution exists); use `--class` for an App-owned Seeder class. `db seed <key>` retains declared fixture behavior. `db fresh --seed` and `db refresh --seed` run a Seeder afterwards. Other database connections and paths cannot be passed through.

Keep `nexia dev` running while correcting errors. Use `migrate → status → rollback → edit → migrate`. Editing an applied file does not replay it automatically. If a nontransactional migration fails, inspect its effects, repair the App database, then run migrate explicitly; source changes and administrator approval are not prerequisites. Successful rollback cannot be assumed for an unrecorded failed file. `fresh` is optional and deletes data. A lost response can be queried with the original `--request-id` (one App only), preserving the original source and options. New commands require matching CLI, Core and Manager versions.

Commit and push source and the intended version tag with Git yourself. From the
App run `nexia check`, then `nexia submit --tag v1.0.0`. If repository connection is
missing, interactive submission opens Developers for approval. Automated callers
must connect it in Developers first. Submission does not create tags, push code,
publish or install an App. Use the returned ID with `submit status`; cancel/retry
are subject to server state and authorization. New source requires a new tag.

### Submission receipts and next actions

App developers verify the App, merge the release through their repository's PR
workflow, push its version tag, submit it, and address review feedback. In the
official workspace, task PRs target `develop`, then a release PR promotes
`develop` to `main` before tagging. Nexia administrators approve and publish;
operators deploy. Customer installation remains separate.

From an App or subdirectory, use `nexia submit --tag v1.0.0`. From the connected
project root, omitting `--app` opens an App picker when several Apps exist; one
App is selected automatically, and no Apps yields an error. Noninteractive
selection with multiple Apps requires an explicit target:

```sh
nexia submit --app people --tag v1.0.0 --no-interactive --yes --json
nexia submit list
nexia submit status
```

Git tag creation and push still run in the App's own repository. The project
root is not a shared Git repository. Status without an ID opens a submission
picker in a terminal and returns a list without one.

Matching Core submission receipts include `submission_reused`: `true` means
an existing submission was returned, including request-ID recovery or a tag
already received by automatic submission. HTTP 202 and the existing submission
ID are preserved. Deploy Core before this CLI to enable explicit duplicate
notices; absent this field, the CLI does not claim a newly created submission.

Status shows check results, analysis progress when available, review notes and
the next action. Waiting builds need no repeated submission. Retry is offered
only for a confirmed retryable source failure; use `nexia submit retry` to choose
it. Uncertain builds require operator reconciliation. Rejected or cancelled
submissions and changed source need a new version tag. Moving an already
submitted tag to different code causes a version conflict; the accepted commit
remains fixed. Recover a lost response with the original tag and `--request-id`.

Approved means awaiting publication. Published does not prove deployment or
installation: inspect `nexia status` and confirm availability with the operator.

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
cause while `dev` keeps watching; do not reset data as a repair shortcut.

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
in App execution; correct the reported cause while source watching stays open. Keep the printed operation ID and
`.nexia` recovery state. Do not remove and restore App folders to bypass a failure.

`dev` retries temporary connection failures, timeouts and HTTP 502/503/504 while
synchronizing source or recovering a preparation. An uncertain preparation keeps
its original request ID, including when local files change. Retry messages name
the affected request; keep `.nexia` and let the existing process recover.
Authorization failures still require valid login and project permission.

Developer support: https://github.com/nexia-cloud-os/developer-support/issues.
Include sanitized reproduction and package versions, never credentials or data.

### Find and stop a background development session

From a project (or one of its Apps), use:

```sh
nexia ps
nexia ps --json
nexia stop --port 4310
nexia stop
nexia status
```

For Docker sessions, run these commands inside the same container.

`ps` lists this folder's tracked local sessions, PIDs, preview ports, selected
Apps and workspace links. `stop --port` can find a tracked session from another
project folder. `stop` asks those authenticated Nexia processes to shut down
their watchers and preview servers, including sessions started by an assistant.
It never kills an arbitrary port owner or deletes remote data. An acknowledgement
of `stopping` means shutdown has not finished; check `ps` again. Dead authenticated
records are removed; an unreachable live record is not proof that its process is
healthy. Sessions started by older CLI versions are not tracked: use their
terminal's Ctrl+C, or inspect `lsof -nP -iTCP:4310 -sTCP:LISTEN` and stop only the
intended process.

`status` also reports the project's Git connection, last checked Git tag,
latest submitted tag, published version and deployed version when the platform
supports this metadata. Deployed means the current platform environment, not a
tenant's installed version. Open the App's repository page in Console to refresh
remote tags. Unknown or unchecked values are not inferred from published versions.

## Terminal links

`nexia ps` and `nexia dev` emit OSC 8 hyperlinks for workspace and development
settings URLs in interactive terminals. `nexia dev` starts with a responsive dot
logo, then keeps project, scope, workspace, actual **Local address**, and App
progress in one boxed dashboard. App tasks use explicit `WAITING`, `PROCESSING`,
`DONE`, `ACTION` and `FAILED` labels with color and icons; long-running tasks
update elapsed time in place instead of appending repeated lines. Copy the local
address into the workspace's local App address field; changing `--port` is
reflected in that line. Recognized terminals show short labels; unknown terminals
retain the full visible URL with the hyperlink destination.
Piped output, CI, dumb terminals and Apple Terminal retain plain URLs. JSON
session data keeps the original URL without escape sequences. Click gestures
depend on the terminal (for example, Command-click in iTerm2); browser opening
is always initiated by the user.

Build and runtime logs remain prefixed with their App and source. Default output
collapses repeated Vite chunk-placement warnings and bounds long diagnostics;
use `nexia dev --verbose` when the complete file-level build detail is needed.

### Preparation error details

Source-update failures retain the operation ID, update ID, failed source revision,
and same-platform Details URL when supplied by Core. Failure text wraps without
being shortened, including piped output:

```sh
nexia dev --verbose 2>&1 | tee nexia-dev.log
```

A source validation label alone does not establish an App PHP error. Newer Core
responses distinguish stopped executions, changed editing ownership, and unavailable
or invalid source. When the previous execution is confirmed stopped, the CLI
prepares the pending source again without resetting data or running migrations.
Existing source-update receipts remain available for diagnosis.

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


### Development execution errors

App errors are reported in the terminal and Developers console while `nexia dev`
keeps watching and uploading source. Fix the reported code, dependency declaration
or migration; changed source starts a new preparation after the previous execution
has stopped. Failed database commands are never automatically replayed: correct
the issue and run `nexia db migrate` or `nexia db seed <key>` explicitly.

`needs_review` identifies a submitted App awaiting human review. It does not lock
development. Failed submission checks include reasons; correct the App and submit
a new Git tag. There is no development recovery command or administrator retry
approval. Keep `.nexia`, existing data and migration history.

Failed sandbox SQL access is retried with `nexia db access`; it does not require
an operator approval. Retry keeps the sandbox SQL identity and all App data.
Persistent server or platform failures remain visible to platform operations.

Applied migration files must retain their original contents. Use new migrations
for subsequent changes. A partially applied nontransactional migration still
requires its database effects to be corrected; keeping the watcher open does not
mean that migration succeeded.

Quiet development sessions keep checking local source at the normal interval but
read unchanged remote status at most every 15 seconds. Source changes and writer
lease renewal bypass that delay. Empty runtime log responses back off from 2 to
10 seconds; new output restores the normal interval. Cancellation remains immediate.
With wake-capable Core/Manager versions, a server-side idle sleep does not close
`nexia dev` or require a manual resume; the next real App request wakes the runtime.

### Independent App tests

Run `nexia test` inside an App with its development dependencies installed
(`composer install --no-scripts`). The command runs Pest or PHPUnit directly,
using the App's `phpunit.xml` or `phpunit.xml.dist` and local SDK dependencies.
It does not install or boot Nexia Core, authenticate, or run Composer scripts.
From a connected project, use `--app <key>` or run all discovered Apps.

Use `nexia test --database` for persistence tests. Docker starts a disposable
PostgreSQL 17 container with an ephemeral loopback port and memory-backed data,
then removes it on success, failure or cancellation. Tests receive
`NEXIA_TEST_DB_PORT` and standard `DB_*` settings. App-owned test fixtures must
use these values for their isolated schemas and apply their own migrations.
The command never applies migrations to a development or production sandbox.

`--filter <pattern>` and `--testsuite <name>` select a narrower check. The App's
PHPUnit configuration defines the coverage; excluded legacy tests and actual
container-to-platform integration are not established by this local run.
A failing or empty selection returns a nonzero exit status.

Run `nexia test --frontend` to execute the App’s installed Vitest runner directly,
using its own configuration and setup. `--filter <pattern>` selects test names.
This mode needs no PHP, Core checkout, login, or database; `--database` and
`--testsuite` apply only to PHP tests. Test failures and empty suites fail the command.

### SDK compatibility warnings

SDK warnings identify actually used deprecated frontend aliases and their
replacement APIs. Repeated watcher warnings are shown once per symbol. A newer
SDK release alone does not mean an API is deprecated. No removal release is
claimed when the SDK has not scheduled one; type-only and PHP annotations are
not detected by the emitted-JavaScript import check.

Versioned seeding records each version in its own transaction. Failed versions can be fixed and retried without administrator approval; completed versions are skipped. Editing completed code produces a development warning. `db fresh --seed` deletes the selected App development data and history before running all versions. Full `db refresh --seed` also clears seeding history; `db rollback` only reverses migrations. Published seeder changes must be restored and implemented as a new version/class before publication. Named `db seed demo` fixtures and explicit `--class` calls remain repeatable and do not update version checkpoints.

CLI alpha.42 sandbox self-recovery requires Core 0.8.153. Versioned seeding also requires PHP SDK 0.10.11 and Manager alpha.76 runtime adoption; upgrading the CLI alone does not upgrade a sandbox runtime.

### Saving code during development

With a compatible platform/runtime, `nexia dev` applies PHP source changes to the
existing development environment. It preserves the execution and DB connection;
source saves do not rerun migrations or seeders. Use explicit `nexia db` commands
for schema/data changes. Failed source validation leaves the previous code running.
Interrupted update requests resume with the same receipt on reconnect.

This requires matching Core, Manager, runtime-image and CLI support. Existing
legacy environments keep their previous preparation behavior until a compatible
environment is prepared. SDK/dependency changes must fit the pinned runtime image.
