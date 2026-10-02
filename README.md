# Nexia Developer Kit

Experimental `@nexia/cli` alpha package for Node.js 22 or newer. It contains
plain ESM JavaScript and requires no transpilation.

## Project workspace (PHP/React Apps)

Use Node.js 22.12+, npm 11.x, PHP 8.4+ (including 8.5) and Composer.
Install the CLI and its generators once. Create an account in Developers;
project creation is confirmed by that account in the browser.

```sh
npm install -g @nexia/cli@alpha
nexia setup --devtools
nexia create-project my-project
cd my-project
nexia init people --vendor acme --family people --name People
cd people
composer install --no-scripts
npm install
nexia make:resource Note --label-ko '메모'
cd ..
nexia dev
```

The project folder is a local workspace, not a Git repository. Each App is an
independent repository in an immediate child folder. `init` generates files
only; `dev` registers their identities, prepares your personal sandbox if
needed, watches all Apps and serves them on **one port** (default 4310).
Create or clone more Apps while it runs; install their frontend dependencies
and they join automatically. Hidden, duplicate-key and symlink folders are not
run. A Git merge/rebase must finish before source is synchronized.

`create-project` and `link-project` add a project-level `AGENTS.md` without
overwriting an existing file. Native App generation keeps its own App-level
`AGENTS.md`. Console's AI instructions page offers both original templates for
copying; App templates replace `{{ appKey }}` with the generated App key.

Open the printed workspace URL and connect the one local address. New Apps
appear automatically without changing your active work tab. The generated
Vite watcher runs with `dev`; a failed compile waits for repair. A dirty form
still requires confirmation before refreshing. In Developers, grant the App's
test permissions explicitly, then create, save and reopen a record to verify
its behavior. Local preview never grants API authority.

### Join an existing project

Ask a project owner/admin to invite your developer account, accept the invite,
then connect your own local folder:

```sh
mkdir my-project
cd my-project
nexia link-project <project-id>
git clone <people-repository> people
cd people
composer install --no-scripts
npm install
cd ..
nexia dev
```

Clone only the Apps you need. `dev` reconnects a registered App to its existing
identity; an unregistered App is registered if the current project can own it.
An identity owned by a different account cannot be claimed by changing a local
ID or manifest. Project members share App identity and submitted versions;
each developer gets separate sandbox data. Existing shared sandboxes remain
with their project owner after the Core migration. Current quota permits one
active sandbox per developer across projects.

### Command locations and recovery

- `create-project`: parent folder; `link-project`: project root.
- `init`: project root. Existing destinations are never overwritten. Native
  generation publishes the folder only when complete.
- `dev`: project root or anywhere inside an App; both watch the entire project.
  Use `--app people` to watch only that App, or `--port 4311` for a second
  independent project. One App/sandbox permits one active dev writer.
- `make:resource`, `make:page`, `validate`, `sync`, `app register`, `app runtime`
  and `deploy`: App folder, or project root with `--app people`.
- `deploy --app people --version 1.0.0` submits an immutable shared version for
  review. It does not replace another developer's sandbox or publish/install
  a release. The existing version reservation/review rules apply to all members;
  coordinate versions instead of overwriting another submission.

`nexia app register` remains available explicitly but is not needed before
project `dev`. Standalone Apps retain `login`, `link`, `app register`, `dev`.
Changing the global CLI login/endpoint while watching stops the old run; restart
in the intended project. Do not edit bindings during a run. On a lost creation
response, rerun the **same** `create-project` path/name: its private pending
approval is recovered. An expired unapproved pairing is discarded with a retry
instruction; a revoked approved pairing never creates a second project.

Stopping `dev` retains source, databases and pending operations. A second writer
must wait for the first to stop or its two-minute lease to expire. Pending or
uncertain database preparation must finish or receive operator review before a
new writer can proceed. Core exposes only `retry_allowed` after an operator has
reviewed a stopped failure; review details remain private. Restart `dev` to use
that result and submit the current source. Resolve a per-App terminal error and restart `dev` (or
remove and restore that folder); other Apps keep running. Use the console to
renew/recover an expired or failed sandbox. No automatic data reset occurs.

Commit `nexia.json` and App code. Keep `.nexia/` ignored: it contains local
project/App bindings and recovery state, never CLI bearer credentials. Pushing
those bindings grants no authority; the server rechecks current membership,
ownership and sandbox on every authorized operation.

The official platform is the default. Only for a local/alternate Developers
host, use `nexia config endpoint <URL>` before `link-project`, or pass
`create-project --endpoint <URL>`. This selects the API destination; it does
not start or configure the production server.

### Working on Nexia itself

Use the local CLI and generator checkout explicitly (no global alias required):

```sh
export NEXIA_DEVTOOLS_PATH=/absolute/path/app-sdk/packages/devtools/bin/nexia-app
node /absolute/path/cli/src/cli.js create-project my-project --endpoint http://developers.example.localhost:8081
```

Install the devtools checkout's Composer dependencies first. With
`NEXIA_DEVTOOLS_PATH` set, `setup --devtools` is unnecessary. That setup command
installs generators into the CLI-owned tools directory for ordinary consumers;
it is not an installation step for the Core production host. It neither changes
global Composer packages nor installs Apps into Core.

## Install or update PHP and Composer

```sh
nexia setup --dry-run
nexia setup
```

This explicit setup command currently supports **macOS** only.
It displays its plan, refreshes Homebrew metadata, and installs or upgrades the
unversioned `php` and `composer` stable formulas. Homebrew resolves their runtime
dependencies. Versions are reported from current Homebrew formula metadata;
"latest" means the latest stable versions available through Homebrew, which may
lag upstream releases. Required dependencies may also be upgraded. There is no
npm postinstall hook and preview commands never install system software.

If Homebrew is absent, setup downloads the installer from the exact HTTPS URL
published on [Homebrew's official site](https://brew.sh), saves it in a private
temporary directory, and runs `/bin/bash` with that filename as an argument.
It does not interpolate downloaded content into a shell command. An interactive
terminal is required: the official installer may ask for confirmation and your
macOS administrator password. Nexia neither captures the password nor bypasses
those prompts. The downloaded file is removed afterward. Homebrew determines
system compatibility and handles its Command Line Tools prerequisite.

The CLI locates Homebrew through standard Apple Silicon/Intel paths (or an
existing PATH installation), then uses its absolute executable path. If a step
fails, completed changes remain installed; resolve the reported error and rerun.
Existing PHP/Composer installations outside Homebrew are not changed. Setup
prints the selected PHP/Composer executable paths and checks whether the current
PATH resolves to them. If it does not, the command explicitly reports remaining
shell configuration and gives the directories to add; it does not claim the
shell is ready or silently modify shell startup files. See Homebrew's
[post-installation instructions](https://docs.brew.sh/Installation#post-installation-steps).
Linux and Windows
automatic installation are not implemented. No host installation has been run
as part of package verification.

## Legacy static browser Apps (explicit template)

Choose local CLI or Docker execution for the same App directory. Platform
repositories are maintained by administrators; App developers do not clone or
modify CLI, Core or Sandbox source. For the local path, install the public CLI
as above, approve login, and use:

```sh
nexia init my-app --template browser
nexia validate my-app
nexia dev my-app
```

Open the printed **Nexia workspace** URL, enter the project sandbox, and connect
the local app. It opens as a real Nexia work tab alongside the sidebar, settings,
and other workspace features. Edit `my-app/public/index.html`. Saving public
files triggers a browser refresh using filesystem events locally and polling for Docker bind mounts. Unsupported local watchers fall back to polling in the CLI.
Keep dev running in one terminal; use another for validate/deploy. Stop the server with Ctrl+C. If the port is busy, choose `--port 4311`.
Restart the preview and reconnect after changing screen routes in `nexia.json`.
Allow local-network access if the browser prompts. The manifest is readable
only by the exact project workspace origin; local app files receive no Nexia
cookies or tokens. An expired sandbox must be restored by the operator.

`init` requires a new directory and never replaces existing files. Parent
directories must already exist. A filesystem failure can leave a partially
created directory; inspect it and choose a new target before retrying.

The preview serves only the `public/` tree, refuses hidden paths and escaping
symlinks, binds to `127.0.0.1`, and rejects other Host/origin values. Do not put
secrets in public assets. It runs no project commands and provides no API proxy,
tenant API authority, React bundling, or a Functions runtime. Authentication and
the full Nexia workspace run on the remote sandbox. Core source and runtime
images are never included in the developer kit or generated Docker environment.
Automatic refresh is full-page reload, not state-preserving HMR.

## Legacy browser manifest

`nexia.json` is the canonical experimental remote-app manifest for this draft.
It is not a replacement for existing PHP App manifests. General YAML parsing is
not implemented. The protocol package owns validation and schema evolution.

```json
{
  "schema_version": "1",
  "app": { "id": "dev.local.my-app", "name": "My app", "version": "0.1.0" },
  "screens": [{ "id": "home", "route": "/", "entry": "public/index.html" }],
  "permissions": { "required": [] }
}
```

`validate` checks schema and local entry existence. CLI preview entries must
reside inside `public/`. This does not establish Core installability or remote
permission authorization.

## Discover the Core host

```sh
nexia doctor --endpoint https://your-nexia-host
# Local development only:
nexia doctor --endpoint http://127.0.0.1:8000 --allow-insecure-loopback
```

The shared client reads `/.well-known/nexia-developer-platform` and validates its
response. Discovery proves only that the host advertises the protocol. Core 0.6.0 advertises project pairing, project management, manifest validation
and review submission. Create projects in the web console, then use `login` and
`deploy` as described below. Remote Function execution remains unavailable.

## Read-only MCP

Configure an MCP client to run Node with absolute arguments:

```json
{
  "mcpServers": {
    "nexia-local": {
      "command": "nexia",
      "args": ["mcp", "/absolute/path/my-app"]
    }
  }
}
```

The stdio adapter offers `validate_manifest` and `get_project`, taking no tool
arguments. The project directory is fixed at startup. `get_project` reads an
optional `.nexia/project.json` and returns only `project_id`, `app_id`,
`environment`, and the endpoint origin. It strips endpoint credentials, paths,
and query strings. These fields describe a local binding, never verified remote
state. `link` creates that binding after checking the CLI connection; `init` only creates source files.
There are no mutation tools in this MCP adapter.

The minimal adapter supports MCP protocol `2024-11-05`, initialization, ping,
tool listing/calls, and newline-delimited JSON-RPC. It has no remote transport,
resources, prompts, subscriptions, or authentication support. Client
interoperability remains to be verified during finalization.

## Validation and release

Run focused tests with `npm test --workspace @nexia/cli` from the
development workspace, or `npm test` from this package after installing its
dependencies. The tests exercise local preview, CLI commands, MCP, and setup
dry-run. They never install or upgrade host PHP/Composer. Public releases use
the `alpha` dist-tag. `UNLICENSED` metadata reserves rights; npm availability
does not grant an open-source license. Publication requires explicit release
authorization and npm organization access.

## Project connection and review

Create a developer account and project in the Nexia developer console. Prepare
its sandbox before running `dev`; preparation may take a few minutes.
The default platform is `https://developers.nexia.to`. Login opens the approval
page locally and prints its URL for Docker, SSH or an automatic-opening failure.
Login does not request your password in the terminal:

```sh
nexia login <project-id>
# Open the displayed URL and approve the displayed code for your project.
nexia init my-app --vendor acme --family other --name MyApp
cd my-app
nexia link
nexia make:resource Note --label-ko '메모'
nexia app register
composer install --no-scripts
npm install
npm run build
nexia dev
```

Keep `dev` running and confirm a saved record in the workspace. In another
terminal in the App directory, validate and submit the version for review:

```sh
nexia validate
nexia submit --tag v1.0.0
```

For a local or separately operated platform only, use
`nexia config endpoint <URL>` with the operator-provided address before login.
Changing the endpoint clears the saved CLI connection.

`init` only creates local files. Use `nexia link` explicitly for both new and
existing Apps. `nexia status` shows the server-confirmed connection;
`nexia logout` revokes it. Connections expire after 30 days and can be revoked in
the console. Credentials are stored with owner-only permissions outside the app
in `~/.config/nexia/connection.json` (`NEXIA_CONFIG_HOME` overrides this directory).
Never put that file in source control, an image, or an AI prompt.

For PHP/React Apps, `deploy --version` synchronizes the registered App's source
and requests an isolated artifact build. Check the returned build ID with
`nexia submissions status <build-id>`. Build processing, review approval,
publication and installation are separate steps; submission grants no tenant
data access.

For legacy static browser Apps, `deploy` uses the version in `nexia.json` and
uploads at most 100 public files and 5 MB. It never runs project scripts,
uploads hidden files, follows public symlinks, or executes server code.
Static versions are immutable; retrying identical content is idempotent.
Changed content requires a new manifest version. A successful static submission
is `pending_review`; it does not publish or install the App.

## Docker development (alternative to local CLI)

Start from a PHP/React App directory generated with the public tools in
[First PHP/React App](#first-phpreact-app), or an existing App checkout. Its
generated Dockerfile installs PHP, Composer, Node.js, npm, CLI and devtools;
continuing development in this directory requires only Docker with Compose
on the host. The standalone Node-only CLI image does not include the PHP
generators and cannot create a PHP/React App by itself.

```sh
cd my-app
export NEXIA_UID="$(id -u)" NEXIA_GID="$(id -g)"
docker compose build
docker compose run --rm dev login <project-id>
docker compose run --rm dev link
docker compose run --rm dev app register
docker compose run --rm --entrypoint npm dev install
docker compose run --rm --entrypoint npm dev run build
docker compose up
```

For an alternate platform only, run
`docker compose run --rm dev config endpoint <URL>` before login. Docker has a
separate connection; selecting an endpoint in the host CLI does not configure
Docker. The official platform is the default in both modes.

Approve the printed URL in your host browser. Grant the App's test permissions
in the console, then open its workspace and save/reopen a record as described
above. While editing React, use another terminal for
`docker compose run --rm --entrypoint npm dev run build -- --watch`.
After verification, submit with `docker compose run --rm dev deploy --version 1.0.0`.

Repeat the UID/GID export in each macOS/Linux terminal using Compose. On Windows
PowerShell omit the export line and use the default container UID. Both modes
share App files and project binding, but each has its own private login. Log in
and link when switching modes; do not copy credentials. Stop the previous
preview first to avoid port conflicts. Preserve `.nexia/runtime.json` and the
login volume; stopping development does not delete sandbox data.

The generated image installs public tools without copying App files or
credentials into its layers. Compose mounts only the App source and a dedicated
login volume, runs as a non-root user, and never mounts the Docker socket.
Preview binds to host loopback. Set `NEXIA_PORT=4312` before `docker compose up`
for a second App; the default port is 4310. Local platform DNS maps through
Docker's host gateway; use HTTPS for a remote platform.

## AI handoff

The project's **Ask AI to build** page supplies scoped copyable instructions,
including platform selection, login, starter creation, preview, and review
submission. The starter's `AGENTS.md` keeps public assets and credentials apart.
The read-only `nexia mcp` adapter can expose manifest validation and non-secret
project metadata to a coding assistant. No AI provider key or billing account is
created by this workflow.

## Developer support

For setup, SDK, CLI, Docker, AI-tool or sandbox problems, search and report at https://github.com/nexia-cloud-os/developer-support/issues. Include package versions, development mode, sanitized reproduction steps and the incident time. Never attach credentials, Core source or customer data. Prepare the report for the developer to review before submission.

## Sandbox resource contracts

After project login and sandbox preparation, run `nexia resources list` or
`nexia resources list --json`. The current platform returns published resource
keys, versions, field/search contracts, declared permissions, actions and public
events for that project's active sandbox. Internal descriptors, removed contracts
and inactive Apps are excluded. This is metadata discovery, not record access or
permission assignment. Calls still need their existing tenant, actor, organization
and owning-App authorization. Native runtime SDK transport is not enabled by this
command; resources without a public ResourceDescriptor are not auto-generated yet.


## PHP/React App generation

Install or update the PHP generators with `nexia setup --devtools`. It installs the public Composer package `nexia-cloud-os/devtools` within `^0.1`, migrates previous managed package names, and updates its dependencies when a lock already exists. Explicit version pins and unrelated requirements are preserved. PHP 8.4+
is required. Create an App and add a resource without a Core checkout. `init` only creates
local source and does not contact the platform or reuse a saved login to link it.
Select the project explicitly with `nexia link`, then use `nexia app register`:

```sh
nexia init leave-manager --vendor acme --family people --name LeaveManager
nexia make:resource Request leave-manager --label-ko '휴가 신청'
nexia make:page LeaveCalendar leave-manager --label-ko '휴가 달력'
```

The PHP namespace is `Nexia\Apps\Acme\LeaveManager`, the Composer package
is `acme/leave-manager`, and the frontend package is `@acme/leave-manager`.
`--vendor acme` supplies the Composer/npm vendor and the `Acme` namespace segment.
`--name LeaveManager` supplies the PHP class segment and default App key
`leave-manager`; the directory name is used when `--name` is omitted.
`--family people` groups the App in navigation and is not its package name.
`--key` changes the App key and package suffix; `--table-prefix` changes the
database prefix; `--display-name` changes only the displayed title. `--dry-run`
previews files. Registration uses `nexia app register <directory>` after login
and link. The generator never installs the App into a tenant or runs its PHP
bootstrap. PHP/React is the default. Use `--template browser` only for a legacy static App.

### Development fixtures

Use the connected project's active sandbox to inspect installed Apps' declared
fixture keys. You do not need another App's source or database credentials.

```sh
nexia fixtures list
nexia fixtures run <app-key> <fixture-key>
nexia fixtures status <run-id>
```

`run` submits a background job; `queued` is not completion. The CLI prints a
request ID before submission. If the response is lost, repeat the same command
with `--request-id <request-id>` to retrieve/recover that request, not a new seed.
Use `--json` for machine-readable output. A `needs_review` result can mean the DB
commit succeeded but its status could not be confirmed; ask the platform
administrator to inspect it before submitting a new request. Revoked connections,
expired sandboxes and unavailable Apps are rejected. Required installation data
runs during installation and does not require this optional fixture command.

Native `nexia.json` uses `schema_version: "2"`, `runtime: "laravel"`, and an
`app` object containing the App metadata. Optional `core_version` and
`test_paths` also belong in nexia.json; test paths are relative to the App.
Composer retains dependencies and autoload declarations; remove duplicate
`extra.nexia` fields when adopting the native declaration. `nexia validate`
delegates native metadata and PHP checks to the independently installed public
PHP tool. Native manifests do not require preview screens or public/index.html.
PHP package registration requires the native v2 manifest. Browser-only preview
remains a separate workflow. The public preview and submission reject symbolic
links, including a linked public/ directory; copy intended browser assets into
that directory. Native source validation does not submit or execute an App.

### Private native source snapshots

After registering the App and preparing its sandbox, run `nexia sync` from the
App directory (or `nexia sync <directory>`). This saves a private immutable source
revision; it does not start a runtime, submit a review or install the App. The
same files produce the same revision in the same sandbox. Missing files are
absent from the next complete snapshot; this never deletes database records.

The snapshot includes supported code/assets under `src`, `database`, `resources`,
`routes`, `config`, `tests`, `public`, and the supported root manifests/lockfiles.
It excludes dotfiles, `.nexia`, `vendor` and `node_modules`, rejects symlinks,
Composer `auth.json` and PHP files under `public`, and runs no App scripts.
Do not embed credentials in code. Limits are 2000 files, 2 MiB per file and
16 MiB total. The platform retains at most 100 revisions/512 MiB per sandbox;
it refuses further distinct snapshots rather than deleting an in-use revision.

## Native App source watch

After `nexia link` and `nexia app register`, run `nexia dev` in the generated
PHP/React App directory. A `composer.json` selects Native source watch; it never
serves PHP source through the browser preview. The sandbox operator must enable
and run Native preparation. The CLI uses public source/runtime-operation APIs;
it does not receive database passwords or run App scripts locally.

Source changes are serialized behind the previous preparation. `.nexia/runtime.json`
retains revision and request identities without credentials. Keep it across
restarts: if a response is lost, rerunning `nexia dev` resolves the same request
instead of issuing another migration. Failed or uncertain operations require
operator review. Confirmed shutdown permits a fresh preparation; shutdown still
pending must finish first. Ctrl+C stops watching, preserving data and pending
requests; it does not log out, delete data, publish or switch to a catalog release.
The watcher stays bound to its starting platform, project and App. Changing a
binding in another terminal stops it before syncing source to a different App.
Restore the original binding before resuming its retained runtime request.

When the platform returns HTTP 429, the watcher keeps its pending request and
waits for `Retry-After` before trying again. Ctrl+C still stops the wait. Status
polling uses a separate bounded server quota so watching several Apps does not
consume the source-upload and registration quota.

Keep the watcher running and use another terminal in the same linked App directory
to select `nexia app runtime off` or `nexia app runtime development`. These commands
persist the choice for this App in its sandbox. Off stops new preparation and
requests operator-confirmed shutdown; it preserves source, migrations and data.
Resume after shutdown is confirmed. The running watcher observes the new choice,
including a queued preparation cancelled by off. Concurrent stale changes are
rejected: inspect the current response before retrying. These commands do not
install or select a published release.

The same bounded source polling works on local files and Docker bind mounts.
Preparation completion only confirms the operator's preparation result. React
workspace routing, authenticated business requests and release installation have
separate integration requirements; a preparation message does not establish them.

Native `nexia dev` also serves the App's compiled `dist/frontend` files, includes
its public `resources/lang/{en,ko,zh}.json` catalogs in the workspace manifest, and prints
the workspace launch address. Use `--port` for another App's listener, and
`--container` with a matching loopback Docker port mapping. For generated Apps,
the CLI starts the installed Vite build watcher after connection validation.
It does not invoke `package.json` scripts; Vite loads the App's config and plugins.
It never serves PHP, `.env`, source maps,
hidden files or linked files. The workspace reads a connection manifest; the
opaque App frame reads compiled assets through a per-process capability URL.
Keep that URL local. Restarting the CLI rotates it. The manifest is unavailable
until both the frontend build and a completed runtime preparation exist.


## Native version submission

On a platform with artifact builds configured, run `nexia submit --tag v1.0.0`
from the registered PHP/React App directory. It saves an immutable private source
snapshot and requests a build; it never packages only the browser files or runs
local App scripts. Keep the build's dependency locks, including package-lock.json.
Use `nexia submissions status <build-id> [--json]` to inspect the recorded result.
Docker uses `docker compose run --rm dev deploy --version 1.0.0` and
`docker compose run --rm dev submissions status <build-id>`.

A `built` result records verified archive storage, not review approval, publication
or installation. Repeating identical source/version returns the existing build;
changed source requires a new version. Accepted submissions survive development
Sandbox expiry and CLI disconnection. Browser-only Apps continue to use the version
in nexia.json without `--version`.

Submission status separates the build state from the required review checks.
A missing check remains pending; a changed source, artifact or policy cannot reuse
an earlier pass. Internal evidence and policy data are not exposed in CLI status.

Use `nexia submissions cancel <build-id> [--json]` to withdraw a queued or completed
Native submission. A running build must finish or be reconciled by the operator
first. Withdrawal preserves source, artifacts and App data, and releases the
active-submission slot. The old version remains reserved; submit a new version.
Retrying cancellation is safe. Docker: `docker compose run --rm dev submissions
cancel <build-id>`. Sandbox expiry does not prevent withdrawal with a valid
project connection.

Business pages include related read/edit routes sharing one lazy RecordSurface by default. Use `--without-record` to omit them and `--without-navigation` to omit the menu entry. No model or Resource is inferred; implement the generated business controller methods before using them.

## Explicit signature document sources

In a PHP App directory after running `nexia setup --devtools`:

```sh
nexia make:signature-data-source NoteFields . --subject-resource-key workshop.note --source-resource-key workshop.note
```

The default previews the descriptor and provider paths without writing. Add
`--write` to create them; replacing existing files additionally requires
`--force`. The provider fails closed until the App implements authorization
and provenance. Field contracts are explicit; no database columns are inferred.
For bounded collections use `--cardinality many --min-items 0 --max-items 12`.

Resource generation creates the PHP/React application screens by default. Add `--with-filament` only when you also need Filament administration screens. Omitting that option, including during `--force` regeneration, preserves existing administration files and their manifest registration.

### Inspect an App in the standard Runtime

`nexia validate ./my-app --runtime-image sha256:<operator-image-id>` snapshots the same allowed source files as development sync, excludes `.env`, credentials and local dependencies, and runs the operator inspection entry point without network or host services. The image must contain the matching SDK/Runtime source. It prints the Runtime revision and the validated Catalog; it does not activate the App. Plain `nexia validate` remains a local metadata/syntax check.
