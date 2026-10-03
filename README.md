# Nexia CLI

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
| `setup` | Prepare environment and generators |
| `create [project\|app]` | Select a creation task; optionally supply the new folder |
| `connect [project-id]` | Authenticate and bind the current project folder |
| `login [project-id]` | Authenticate/re-authenticate without changing folder bindings |
| `logout` | Revoke authentication; retain bindings and data |
| `make [resource\|page]` | Select generated code; optionally supply its PascalCase name |
| `dev` | Watch the entire project, including from inside an App |
| `check` | Inspect App source; no remote runtime verification |
| `status` | Inspect authentication, project, folder and sandbox |
| `db migrate` | Request an App sandbox migration |
| `db seed [key]` | Run this App's declared development data |
| `db status` | Inspect the App database operation |
| `submit` | Submit an existing Git version tag for review |
| `submit status\|cancel\|retry [id]` | Inspect or manage an identified submission |
| `help [command]`, `--version` | Help and installed CLI version |

## Questions and options

Start with `nexia create` or `nexia make`; select the task by number or name.
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
it. `dev` deliberately preserves project-wide watching from either location;
`dev --app people` selects one. The default port is 4310 (`--port` to change it).
`--container` supports container preview access. A project uses one preview port.
New Apps join automatically; duplicate identities and symlink folders are not run.

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

Developer support: https://github.com/nexia-cloud-os/developer-support/issues.
Include sanitized reproduction and package versions, never credentials or data.
