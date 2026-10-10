# Query Guard

Query Guard is a Claude Code mod. It stops risky database commands and asks you before they run.

![Query Guard holding a DELETE without a WHERE clause](docs/demo.gif)

<sub>Demo GIF coming soon.</sub>

I built this because one bad `DELETE` can wipe a table. I let Claude run database commands for me, and I wanted a pause before the ones I can't undo.

## Why it exists

Coding agents run shell commands. Database clients are shell commands too. Claude can type `DELETE FROM customers` and forget the `WHERE`. It can also point `psql` at the wrong host. Either mistake can destroy data in a second.

Claude Code already shows you each command before it runs. But a long command is easy to skim. After many approvals, you stop reading closely.

Query Guard reads each database command first. If the command looks destructive, Query Guard holds it. If it points at production, Query Guard holds it too. Then it shows you the target and the current row count. The command waits until you choose.

## What it catches

Query Guard checks Bash commands that run `sqlite3`, `psql`, `mysql`, `snowsql`, the `databricks` CLI, or `dbt`.

| Rule | Example that Query Guard holds |
| --- | --- |
| `DROP TABLE`, `DROP DATABASE`, `DROP SCHEMA` | `psql -c "DROP TABLE users"` |
| `TRUNCATE` | `snowsql -q "TRUNCATE TABLE orders"` |
| `DELETE` without `WHERE` | `sqlite3 demo.db "DELETE FROM customers"` |
| `UPDATE` without `WHERE` | `mysql -e "UPDATE users SET active = 0"` |
| `ALTER TABLE … DROP COLUMN` | `psql -c "ALTER TABLE users DROP COLUMN email"` |
| dbt `--full-refresh` (`run`, `build`, `seed`) | `dbt run --full-refresh -s fct_sales` |
| A `prod` or `production` host or connection, even for safe SQL | `psql -h prod-db.internal -c "SELECT 1"` |

The production rule looks at where the command connects. It checks hosts, URLs, and connection strings. It also checks Snowflake accounts and connections, Databricks profiles, and dbt `--target` and `--profile`. It reads variables like `PGHOST` and `DATABASE_URL` as well.

The rule matches `prod` as a whole word. So it holds `prod-db` and `db.production.example.com`. It lets `products-db` through. It never checks table names, so `SELECT * FROM products` runs as normal.

Some `WHERE` clauses don't count. Query Guard ignores a `WHERE` inside a SQL comment. It ignores a `WHERE` in a later statement. It also ignores one that comes after the shell string ends.

Everything else runs without a pause. That includes `SELECT`, `INSERT`, `DELETE … WHERE`, and a plain `dbt run`.

## How it works

Query Guard is a [Claude Code mod](https://code.claude.com/docs/en/plugins). A mod is a TypeScript hooks module that Claude Code loads as a plugin.

1. **It hooks the Bash tool.** A `tool.call` hook sees every Bash command before it runs. Commands without a database client pass straight through.
2. **It checks the rules.** The rules live in [`hooks/rules.ts`](hooks/rules.ts). Each rule is a plain function over the command text. The tests check each one on its own.
3. **It holds the command and asks.** On a match, the hook does not pass the command on, so it doesn't run. The hook opens a pane. The pane shows the command, the reason, and the target. **Proceed** (hotkey `1`) runs the command unchanged. **Cancel** (hotkey `2`) refuses it. Claude then reads what the command would have destroyed. Query Guard also tells Claude not to retry or work around it. Closing the pane counts as Cancel.
4. **It falls back to a band.** Claude Code opens a pane on its own only when the terminal is wide enough. On a narrow terminal, Query Guard shows the same report and buttons above the prompt.
5. **It counts rows without writing.** For a SQLite file on your machine, Query Guard runs `sqlite3 -readonly … "SELECT COUNT(*) FROM <table>"`. You see how many rows are at stake. Query Guard never writes to the database. It never connects to a remote database to count.

A status line keeps a tally: `🛡 Query Guard · 2 held this session`.

## Install

Run these at a Claude Code prompt:

```
/plugin marketplace add geethasagarb/query-guard
/plugin install query-guard@query-guard
/reload-plugins
```

### Try it with the demo database

```sh
git clone https://github.com/geethasagarb/query-guard.git
cd query-guard
python3 demo/seed_demo_db.py        # creates demo.db: 1,000 fake customers
claude
```

Then ask Claude to do these steps:

1. `Run: sqlite3 demo.db "SELECT COUNT(*) FROM customers"`. It runs as normal and prints `1000`.
2. `Run: sqlite3 demo.db "DELETE FROM customers"`. Query Guard holds it and shows `customers · 1,000 rows now`. Press `2` to cancel.
3. Ask for the count again. It still prints `1000`.

## Limitations

Query Guard is a safety net. It is not a permission system.

It reads only the text of the command that Claude passes to Bash. If that text hides the SQL or the connection, Query Guard misses it. These get past it:

- Scripts and programs, such as `python reset_db.py`, `./cleanup.sh`, or `make reset`.
- SQL in files, such as `psql -f drop.sql` or `sqlite3 demo.db < reset.sql`.
- Shell aliases, functions, `eval`, and commands that `$(…)` or variables build at runtime.
- Connection settings it can't see, such as `~/.pgpass`, `~/.my.cnf`, a `.env` file, or a dbt `profiles.yml` whose default target is production.
- Database access through MCP tools or any tool other than Bash.

The rules match patterns, so they will sometimes be wrong. Query Guard can flag a command that only mentions SQL. This happened to me while I wrote this README. Claude ran a Python script through Bash to update a docs file. The script's text included `sqlite3 demo.db "DELETE FROM customers"` as plain text. Query Guard held the script, even though it never touched a database. I pressed Proceed, and it ran.

It can also miss things. Some risky commands will slip through. Row counts work only for local SQLite files. Query Guard resolves their paths from the session's working directory.

For hard blocks, use Claude Code's [permission rules](https://code.claude.com/docs/en/settings). For example, add a `deny` rule on `Bash(psql:*)`. On the database side, use read-only roles, separate production credentials, and backups. Treat Query Guard as one extra pause before a step you can't undo.

## Running the tests

```sh
claude plugin validate .
claude plugin test .
```

`validate` reads the manifest, the marketplace file, and the hooks module. It reads them the same way Claude Code does when it loads the plugin.

`test` runs two files:

- [`tests/rules.test.ts`](tests/rules.test.ts) checks every rule. It also checks what each rule should let through.
- [`tests/guard.test.tsx`](tests/guard.test.tsx) runs the full flow against the engine. Query Guard holds a command and draws the pane with the row count. Then the tests check Proceed, Cancel, and the narrow-terminal band.

## Project layout

```
.claude-plugin/
  plugin.json         the plugin manifest
  marketplace.json    makes this repo installable as a marketplace
hooks/
  hooks.json          points Claude Code at the hooks module
  register.tsx        the tool.call guard, pane, band, and status line
  rules.ts            the detection rules, as plain functions
types/index.d.ts      the session state the pane draws from
tests/                rule tests and end-to-end tests
demo/seed_demo_db.py  creates the demo database
docs/                 the demo GIF
```

## Credits

I built Query Guard with [Claude Code](https://claude.com/claude-code) mods.

Author: **Geetha Sagar Bonthu**. MIT licensed.
