# Nexia Project

## Connected project

- Project name: {{ projectName }}
- Project ID: `{{ projectId }}`
- Platform: {{ endpoint }}

## Workspace

- Each App is an independent Git repository in an immediate child folder.
  Do not nest projects. Read each App's AGENTS.md, nexia.json and docs.
- Preserve unrelated changes, App identities, bindings and sandbox data.
- Use installed public CLI/SDK packages. Do not clone, mount or modify Core,
  Sandbox, CLI, SDK source or runtime images for ordinary App work.

## Commands

- Run `nexia connect {{ projectId }}` at this project root. For an alternate
  platform, set `NEXIA_ENDPOINT` to the origin above before connection.
  Browser approval belongs to the developer; never read/copy credentials.
- `nexia login` renews this project's authentication without changing bindings.
- `nexia create app` creates an App here. Omitted settings are prompted; options
  skip their questions. Install dependencies inside the App using
  `composer install --no-scripts` and `npm install`.
- `nexia make resource`, `nexia make page`, `nexia check`, `nexia db migrate`,
  `nexia db seed` and `nexia submit --tag <tag>` work from an App or subdirectory.
  From this project use `--app <folder-or-key>` or the target selection prompt.
- `nexia check` from this root checks all Apps. `nexia dev` watches the entire
  project from either root or App directories; `--app` selects just one.
  New Apps join automatically. Keep dev running in a separate terminal.
- `nexia status`, `nexia db status`, and `nexia submit status <id>` report
  connection, database operation, and submission state respectively.
- For automation use `--no-interactive` and explicit required values; `--yes`
  accepts the final mutation confirmation. Neither bypasses authorization.

## Delivery and safety

- Use public SDK contracts. Keep secrets and PHP outside public/. Never commit
  .nexia/ bindings or credentials. Generation does not grant business access.
- Grant test permissions in Console, then verify create/read/edit/save/reopen
  and refresh. Local preview, source checks and queued operations are not proof
  of runtime success. Ctrl+C stops local watching without deleting data.
- Submit an existing pushed Git tag only when requested. Submission, review,
  publication and customer installation are distinct. On response loss, reuse
  the printed request ID; do not reset data to resolve a pending operation.
- Do not commit, push, submit, reset or send messages without authorization.
  Prepare sanitized reports for developer review before sending them to
  https://github.com/nexia-cloud-os/developer-support/issues.
