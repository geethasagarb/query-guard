# Contributing

Thanks for helping with Query Guard. Bug reports, rule ideas, and fixes are all welcome.

## Set up

You need [Claude Code](https://code.claude.com/docs/en/setup) and Python 3 (only for the demo database).

```sh
git clone https://github.com/geethasagarb/query-guard.git
cd query-guard
python3 demo/seed_demo_db.py   # optional: creates demo.db for trying it by hand
```

To try your changes in a real session, start `claude` in the repo and run `/reload-plugins` after each edit.

## Validate and test

```sh
claude plugin validate .
claude plugin test .
```

Both must pass before you open a PR.

Rules live in [`hooks/rules.ts`](hooks/rules.ts) as plain functions. If you change a rule, add tests to [`tests/rules.test.ts`](tests/rules.test.ts) for what it should catch **and** what it should let through.

## Open a PR

1. Fork the repo and make a branch.
2. Keep the change small and focused.
3. Run validate and tests.
4. Add a line to [`CHANGELOG.md`](CHANGELOG.md) under "Unreleased".
5. Open the PR and fill in the template.

Not sure about an idea? Open an issue first. Issues labeled **good first issue** are a nice place to start.
