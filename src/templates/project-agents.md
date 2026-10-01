# Nexia Project

## Connected project

- Project name: {{ projectName }}
- Project ID: `{{ projectId }}`
- Platform: {{ endpoint }}

## Workspace

- This folder connects to one Nexia project. Each App lives in an immediate
  child folder and owns its own Git repository. Do not nest projects.
- Read each App's AGENTS.md, nexia.json and docs before changing that App.
  Preserve existing source, local changes, App identities and sandbox data.
- Work on Apps using the installed public CLI and SDK. Do not clone, copy,
  mount or modify Core, Sandbox, CLI or SDK repositories or runtime images.

## Commands

- Run `nexia link-project {{ projectId }}` here to connect this project.
  For an alternate platform, configure the platform origin above with
  `nexia config endpoint <origin>` before connecting.
  The developer approves login in the browser. Never request tokens or
  passwords in chat, or read or copy CLI credentials.
- Create an App here with `nexia init my-app --vendor acme --family other --name MyApp`, choosing your own vendor and a new folder. Install its
  dependencies inside that App: `composer install --no-scripts` and `npm install`.
- Run `nexia dev` here to watch all Apps on one port. Keep it running in one
  terminal and use another for commands. Newly added Apps join automatically.
- Run `nexia make:resource`, `nexia make:page`, `nexia validate` and
  `nexia deploy --version <version>` inside the selected App. From this folder,
  use `--app <folder-or-key>` with validate, sync and deploy.
- Open the printed workspace URL and verify the actual App workflow: create,
  read, edit, save, reopen, and live refresh. A local preview grants no data
  authority; request the required test permissions in Console.

## Delivery and safety

- Use public SDK contracts and advertised capabilities only. Keep secrets and
  server code outside public/. Never commit .nexia/ bindings or credentials.
- Stop development with Ctrl+C. Do not reset databases or remove sandbox data
  without explicit authorization. Each developer uses their own sandbox.
- Validate the affected App before submission. `nexia deploy` submits an
  immutable version for review; it does not publish or install it for customers.
- Commit, push and submit only when requested. Prepare sanitized reports for
  developer review before sending them to
  https://github.com/nexia-cloud-os/developer-support/issues.
