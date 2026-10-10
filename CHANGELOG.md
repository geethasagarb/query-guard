# Changelog

All notable changes to Query Guard are listed here.

## Unreleased

## v0.1.0 (2026-10-10)

First release.

- Holds risky SQL and dbt commands run through Bash: `DROP`, `TRUNCATE`, `DELETE`/`UPDATE` without `WHERE`, `ALTER TABLE … DROP COLUMN`, and dbt `--full-refresh`.
- Holds any command that targets a `prod` or `production` host, connection, profile, or target.
- Supports `sqlite3`, `psql`, `mysql`, `snowsql`, the `databricks` CLI, and `dbt`.
- Shows the target and a read-only row count for local SQLite files.
- Proceed / Cancel pane, with a band fallback on narrow terminals.
- Status line tally of held commands.
- Contributor docs, issue templates, a PR template, and a roadmap.
