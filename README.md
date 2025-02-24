# pglint: PostgreSQL Schema Lint for VS Code

I tried other PostgreSQL extensions, and none of them were able to lint a `.sql` schema file against a live PostgreSQL server and highlight the first error where it occurs in the schema, so I wrote this one.

## Features

Lints a PostgreSQL `.sql` schema file (with language ID `sql` or `postgres`) and highlights the erroneous statement and, in most cases, the actual keyword of the error.

This requires connection to a (local recommended) PostgreSQL server with `CREATE DATABASE` privileges. Each lint cycle, `pglint` creates the temporary database, runs each statement in the active file, catches an error if it occurs, and `finally` drops the temporary database. This all happens very quickly in my testing.

### How it works

1. Split the active `.sql` schema file into individual statements, removing extraneous comments and whitespace between statements.
2. Connect to a configured (local recommended) PostgreSQL server as a user with `CREATE DATABASE` privileges.
3. `CREATE` a temporary `DATABASE` and connect to that database as the same user.
4. Loop through the statements from the active file, running each one on the temporary database.
5. If an error occurs, `catch` the error and add diagnostics to the active file:
    - Look for the quoted "word" or `position` in the error in the statement, and highlight it as an `error`.
    - If the specific position or word was found, highlight the entire statement as a `warning`; otherwise, highlight the entire statement as an `error`.
    - Tag the error with the specific error message from Postgres.
    - Highlight the remainder of the file as `unnecessary` or "unreachable" code.
6. Whether or not an error occurred, `DROP` the temporary `DATABASE`.

Describe specific features of your extension including screenshots of your extension in action. Image paths are relative to this README file.

For example if there is an image subfolder under your extension project workspace:

\!\[feature X\]\(images/feature-x.png\)

> Tip: Many popular extensions utilize animations. This is an excellent way to show off your extension! We recommend short, focused animations that are easy to follow.

## Requirements

- Access to a PostgreSQL server with `CREATE DATABASE` privileges.

- This extension depends on the npm package `pg`. It is a "Pure JavaScript ... Non-blocking PostgreSQL client for Node.js." For more info, see it on <a target="_blank" href="https://github.com/brianc/node-postgres">GitHub</a>.

## Extension Settings

This extension contributes the following settings:

* `pglint.databaseUrl` **(required)**: PostgreSQL Server URL on which to create temporary databases for linting. This extension will display a warning if activated without this setting present.

* `pglint.lintOnSave`: Automatically lint Postgres SQL files on save. Default: `true`

* `pglint.clearOnChange`: Clear diagnostics when the document is changed. Default: `true`

* `pglint.languageIds`: Language IDs of PostgreSQL schemas to lint. Default: `["sql", "postgres"]`

## Extension Commands

This extension contributes the following commands:

* `pglint.lint`: Lint the PostgreSQL schema in the active file.

## Known Issues

This extension currently requires a complete, self-contained schema file that should run on a clean database to work. I may add `-- include`-like functionality later.

## Release Notes

### 1.0.0

Initial release.
