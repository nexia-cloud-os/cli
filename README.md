# Nexia Developer Kit

Experimental `@amuzcorp/nexia-cli` alpha package for Node.js 22 or newer. It contains
plain ESM JavaScript and requires no transpilation.

Install the experimental alpha from npm:

```sh
npm install -g @amuzcorp/nexia-cli@alpha
nexia init my-app
nexia dev my-app
```

This release provides local preview only. It does not connect an app to Core,
authenticate a developer, or deploy an app. The workspace commands below also support development from source.

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

Open the printed loopback URL and edit `my-app/public/index.html`. Saving public
files triggers a browser refresh where recursive file watching is supported.
Stop the server with Ctrl+C. If the port is busy, choose `--port 4311`.
Restart the preview after changing screen routes in `nexia.json`.

`init` requires a new directory and never replaces existing files. Parent
directories must already exist. A filesystem failure can leave a partially
created directory; inspect it and choose a new target before retrying.

The preview serves only the `public/` tree, refuses hidden paths and escaping
symlinks, binds to `127.0.0.1`, and rejects other Host/origin values. Do not put
secrets in public assets. It runs no project commands and provides no API proxy,
tenant access, authentication, React bundling, Functions runtime, or deployment.
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
response. Discovery proves only that the host advertises the protocol. The Core
foundation currently advertises remote capabilities as unavailable. `login`,
`projects`, and `deploy` exit with a prerequisite message and never create fake
remote state or ask for tokens.

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
state. No command creates that binding yet. There are no mutation tools.

The minimal adapter supports MCP protocol `2024-11-05`, initialization, ping,
tool listing/calls, and newline-delimited JSON-RPC. It has no remote transport,
resources, prompts, subscriptions, or authentication support. Client
interoperability remains to be verified during finalization.

## Validation and release

Run focused tests with `npm test --workspace @amuzcorp/nexia-cli` from the
development workspace, or `npm test` from this package after installing its
dependencies. The tests exercise local preview, CLI commands, MCP, and setup
dry-run. They never install or upgrade host PHP/Composer. Public releases use
the `alpha` dist-tag. `UNLICENSED` metadata reserves rights; npm availability
does not grant an open-source license. Publication requires explicit release
authorization and npm organization access.
