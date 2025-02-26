# pglint: Live PostgreSQL Schema/Query Linter for VS Code

I tried other PostgreSQL extensions, and none of them were able to lint a `.sql` schema file against a live PostgreSQL server and highlight the first error where it occurs in the schema, so I wrote this one.

## Features

Lints a PostgreSQL `.sql` schema file (with language ID `sql` or `postgres`) and highlights the erroneous statement and, in most cases, the actual keyword of the error.

This requires connection to a (local recommended, **please don't use a production server**) PostgreSQL server with `CREATE DATABASE` privileges. Each lint cycle, `pglint` will:
- Parse the SQL statements in the active `.sql` file, and include any statement(s) from other file(s) in `-- @include` directive(s);
- `CREATE` a temporary `DATABASE` (optionally from a `TEMPLATE` specified in a `-- @template` directive);
- `try` each statement in the active file;
- `catch` an error if it occurs;
- `finally`, `DROP` the temporary database.

This all happens very quickly in my testing.

This extension **does not** syntax highlight or format. It also _should_ not interfere with extensions that do these things, as it instantiates its own `DiagnosticCollection` (as every extension should), so hopefully it will play nice with everyone.

### Directives

**Directives work in standalone line comments only, not block comments.** Currently, they must not be followed by any other comment on the same line.

```
-- @include relative.sql
-- @include ./relative.sql
-- @include ../../grandparent.sql
-- @include /home/tom/apps/project1/common.sql
```

Parses and includes the statements in the `@include`d file as if directly included in the source file at the location of the `@include` directive. Accepts absolute and relative paths. Adds any `Diagnostic`s to editors of both files (_with links!_) so the failed statement can be quickly pinpointed.

```
-- @template mydatabase
```
or
```
-- @template "db""with_w3ird-but-legal-$n@me"
```

Uses the given database or template as the starting point with `CREATE DATABASE vscode_pglint_... TEMPLATE mydatabase`. This allows you to use an existing database as a "fixture" or starting point for the SQL commands in the file, so you don't have to `@include` the whole creation schema. Helps if you have a large initial schema that slows down linting.

**Only one `@template` directive is allowed, and it must be the first _effective_ statement in the file** (other than comments and `@include`s). It **can** be in an `@include`d file, but it must _end up_ as the first "actual" statement, because the temp database is created before any other statements are run. Any subsequent `@template` directive **not matching** the first one will throw an error diagnostic and abort.

The `@template` name must be a valid PostgreSQL name designation. That is, if the `@template` name does not match the regular expression, `/^[a-zA-Z_][a-zA-Z0-9_]+$/`, you must surround it in double quotes (`"`) and escape any double quotes in the name (`""`).

## TODO: Screenshots

For example if there is an image subfolder under your extension project workspace:

\!\[feature X\]\(images/feature-x.png\)

> Tip: Many popular extensions utilize animations. This is an excellent way to show off your extension! We recommend short, focused animations that are easy to follow.

## Requirements

- Access to a PostgreSQL server with `CREATE DATABASE` privileges.

    - **Please do not use a live production server for linting unless you're absolutely sure and really know what you're doing!!** This extension does not intentionally delete any data, **but there are never any guarantees.** The `pglint.terminateTemplateConnections` command and `pglint.autoTerminateTemplateConnections` setting will cause any queries running in a `@template` database to be terminated, and thus potential data loss, if not on a development or test server whose data is dispensable.

    - To test queries on a live database, it's recommended that you `pg_dump` / `pg_restore` it to a local Postgres instance, or use more robust tools suited to the task, as this extension is for **designing queries** rather than executing them on a live database.

- This extension uses the npm package `pg`. It is a "Pure JavaScript ... Non-blocking PostgreSQL client for Node.js." It should not have any client dependencies, but if you're developing SQL for Postgres anyway, your system is likely fine. For more info, see it on <a target="_blank" href="https://github.com/brianc/node-postgres">GitHub</a>.

- Of course, you **can** use Docker or Podman. Just expose it to a port on localhost using `docker compose` or similar. I'm not sure yet if including container "auto-spin-up" functionality would be worthwhile/in-demand/"bloatware"/risky for this extension.

## Extension Settings

This extension contributes the following settings:

* `pglint.databaseUrl` **(required)**: PostgreSQL Server URL on which to create temporary databases for linting. This extension will display a warning if activated without this setting present.

* `pglint.lintOnSave`: Automatically lint Postgres SQL files on save. Default: `true`

* `pglint.clearOnChange`: Clear diagnostics when the document is changed. Default: `false`

* `pglint.warnWholeStatement`: When the keyword or substring of the error is found, add a warning diagnostic to the entire statement to make it easier to spot. Default: `true`

* `pglint.usePlPgsqlCheck`: If the `plpgsql_check` extension is available, use it to perform additional checks on each `CREATE FUNCTION`. Default: `true`

* `pglint.languageIds`: Language IDs of PostgreSQL schemas to lint. Default: `["sql", "postgres"]`

* `pglint.queryStats`: Add query stats as a hint on each statement. Default: `true`. Currently only provides the command, e.g. `CREATE`, `INSERT`, etc., the number of rows affected (if applicable), and the query time in milliseconds (using JavaScript `performance.now()` around the query, as `pg` client does not provide it).

* `pglint.autoTerminateTemplateConnections`: WARNING! Do not use on a production server! Run `pg_terminate_backend` on `datname =` (@template name) each lint cycle. This will kill any active connections (and queries) on the template database so it doesn't block `CREATE DATABASE ... TEMPLATE`. Default: `false`

## Extension Commands

This extension contributes the following commands:

* `pglint.lint`: Lint the PostgreSQL schema in the active file.

* `pglint.terminateTemplateConnections`: Terminate template database connections (run `pg_terminate_backend` on @template). WARNING! This will terminate any active queries on the template database.

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

## Known Issues

## Release Notes

### 1.0.0

Initial release.
