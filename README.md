# Nexia Developer Kit

Experimental `@nexia/cli` alpha package for Node.js 22 or newer. It contains
plain ESM JavaScript and requires no transpilation.

Install the experimental alpha from npm:

```sh
npm install -g @nexia/cli@alpha
# Create a project and prepare its sandbox in the developer console.
nexia login <project-id>
nexia init my-app
nexia dev my-app
```

This alpha supports local preview, browser-approved project connections, and
static app submission for administrator review. It does not execute remote
Functions or install tenant Apps. The alpha.3 development flow requires a ready remote sandbox.

## Install or update PHP and Composer

```sh
node developer-kit/src/cli.js setup --dry-run
node developer-kit/src/cli.js setup
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

## First local app

From the parent development workspace, install workspace dependencies with
`npm install`. The protocol and client dependencies resolve to sibling packages
there. Independent checkouts use the exact alpha versions from npm and their
committed lockfiles.

```sh
node developer-kit/src/cli.js init ./my-app
node developer-kit/src/cli.js validate ./my-app
node developer-kit/src/cli.js dev ./my-app
```

Open the printed **Nexia workspace** URL, enter the project sandbox, and connect
the local app. It opens as a real Nexia work tab alongside the sidebar, settings,
and other workspace features. Edit `my-app/public/index.html`. Saving public
files triggers a browser refresh where recursive file watching is supported.
Stop the server with Ctrl+C. If the port is busy, choose `--port 4311`.
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

## Manifest

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
node developer-kit/src/cli.js doctor --endpoint https://your-nexia-host
# Local development only:
node developer-kit/src/cli.js doctor --endpoint http://127.0.0.1:8000 --allow-insecure-loopback
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
      "command": "node",
      "args": ["/absolute/path/developer-kit/src/cli.js", "mcp", "/absolute/path/my-app"]
    }
  }
}
```

The stdio adapter offers `validate_manifest` and `get_project`, taking no tool
arguments. The project directory is fixed at startup. `get_project` reads an
optional `.nexia/project.json` and returns only `project_id`, `app_id`,
`environment`, and the endpoint origin. It strips endpoint credentials, paths,
and query strings. These fields describe a local binding, never verified remote
state. `init` and `link` create that binding after checking the CLI connection.
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

## Project connection and review (alpha.3)

Create a developer account and project in the Nexia developer console. Prepare
its dedicated workspace before running `dev`; preparing a workspace may take a
few minutes. Configure
an alternate platform with `nexia internal endpoint https://your-platform`, or
`http://developers.nexia.test:8080` for a local instance. Endpoint changes clear
the saved CLI connection. Login does not request your password in the terminal:

```sh
nexia login <project-id>
# Open the displayed URL and approve the displayed code for your project.
nexia init my-app
cd my-app
nexia dev
nexia validate
nexia deploy
```

`init` binds the new directory to the connected project. For an existing app,
use `nexia link` explicitly. `nexia status` shows the server-confirmed connection;
`nexia logout` revokes it. Connections expire after 30 days and can be revoked in
the console. Credentials are stored with owner-only permissions outside the app
in `~/.config/nexia/connection.json` (`NEXIA_CONFIG_HOME` overrides this directory).
Never put that file in source control, an image, or an AI prompt.

Deploy uploads at most 100 static public files and 5 MB. It never runs project
scripts, uploads hidden files, follows public symlinks, or executes server code.
Versions are immutable; retrying identical content is idempotent. Changed content
requires a new manifest version. A successful submission is `pending_review`;
it does not publish an app, grant tenant data access, or install a Composer App.

## Docker-only development

Docker is sufficient; Node.js and the CLI need not be installed on the host:

```sh
docker run --rm --user "$(id -u):$(id -g)" -e npm_config_cache=/tmp/npm -v "${PWD}:/workspace" -w /workspace node:22-bookworm-slim npx --yes --ignore-scripts @nexia/cli@0.1.0-alpha.3 init my-app
cd my-app
# Only when using an alternate platform:
docker compose run --rm dev internal endpoint https://your-developer-platform
docker compose run --rm dev login <project-id>
docker compose run --rm dev link
# Prepare the project workspace in the developer console.
docker compose up --build
# In another terminal, after verifying the app in the Nexia workspace:
docker compose run --rm dev deploy
```

The generated Compose file binds the preview to host loopback, mounts only the
app source, and stores CLI configuration in a dedicated named volume. It uses a
non-root process and never mounts the Docker socket or host credentials.
`NEXIA_PORT=4312 docker compose up --build` selects another local preview port.
The default port is 4310. Local platform DNS is mapped through Docker's host
gateway; use HTTPS for a remote platform. The initialization command uses the
host user ID so newly created files remain owned by the developer.

The generated image installs the exact public npm CLI version on the official
Node.js image, so GHCR credentials are unnecessary. It does not copy app files or
credentials into image layers. The image workflow also tests and builds pull
requests without pushing images; main publishes versioned amd64/arm64 images and
an `alpha` tag to GHCR for users with registry access.

## AI handoff

The project's **Ask AI to build** page supplies scoped copyable instructions,
including platform selection, login, starter creation, preview, and review
submission. The starter's `AGENTS.md` keeps public assets and credentials apart.
The read-only `nexia mcp` adapter can expose manifest validation and non-secret
project metadata to a coding assistant. No AI provider key or billing account is
created by this workflow.

## Developer support

For setup, SDK, CLI, Docker, AI-tool or sandbox problems, search and report at https://github.com/nexia-cloud-os/developer-support/issues. Include package versions, development mode, sanitized reproduction steps and the incident time. Never attach credentials, Core source or customer data. Prepare the report for the developer to review before submission.
