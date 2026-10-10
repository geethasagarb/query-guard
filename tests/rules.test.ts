import { describe, expect, test } from 'claude-code/testing'

import { analyze, isProdName, refusal, sqliteFile } from '../hooks/rules'

const rules = (command: string) => analyze(command)?.hits.map(h => h.rule) ?? []
const targets = (command: string) => analyze(command)?.hits.map(h => h.target) ?? []

describe('which commands are read', () => {
  test('ignores commands that run no database client', () => {
    expect(analyze('echo "DROP TABLE users"')).toBeNull()
    expect(analyze('grep -r "DELETE FROM users" src/')).toBeNull()
  })

  test('lets safe SQL through on every client', () => {
    expect(analyze('sqlite3 app.db "SELECT * FROM users"')).toBeNull()
    expect(analyze('psql -h localhost -c "SELECT count(*) FROM orders"')).toBeNull()
    expect(analyze("mysql -e 'INSERT INTO t VALUES (1)'")).toBeNull()
    expect(analyze('snowsql -q "SELECT 1"')).toBeNull()
    expect(analyze('databricks sql query "SELECT 1"')).toBeNull()
    expect(analyze('dbt run --select orders')).toBeNull()
  })
})

describe('DROP', () => {
  test('DROP TABLE', () => {
    expect(rules('sqlite3 app.db "DROP TABLE users"')).toEqual(['drop-table'])
    expect(targets('psql -c "drop table if exists public.users"')).toEqual(['public.users'])
  })

  test('DROP DATABASE', () => {
    expect(rules("mysql -e 'DROP DATABASE shop'")).toEqual(['drop-database'])
  })

  test('DROP SCHEMA', () => {
    expect(rules('snowsql -q "DROP SCHEMA analytics CASCADE"')).toEqual(['drop-schema'])
    expect(targets('snowsql -q "DROP SCHEMA analytics CASCADE"')).toEqual(['analytics'])
  })

  test('DROP VIEW and DROP INDEX are not held', () => {
    expect(analyze('psql -c "DROP VIEW v_orders"')).toBeNull()
    expect(analyze('psql -c "DROP INDEX idx_orders"')).toBeNull()
  })
})

describe('TRUNCATE', () => {
  test('with and without TABLE', () => {
    expect(rules('psql -c "TRUNCATE TABLE orders"')).toEqual(['truncate'])
    expect(targets("databricks sql query 'truncate sales.orders'")).toEqual(['sales.orders'])
  })
})

describe('DELETE without WHERE', () => {
  test('held without WHERE', () => {
    expect(rules('sqlite3 app.db "DELETE FROM users"')).toEqual(['delete-without-where'])
    expect(rules('sqlite3 app.db "DELETE FROM users;"')).toEqual(['delete-without-where'])
  })

  test('passes with WHERE', () => {
    expect(analyze('sqlite3 app.db "DELETE FROM users WHERE id = 3"')).toBeNull()
    expect(analyze("psql -c \"DELETE FROM users WHERE name = 'x'\"")).toBeNull()
  })

  test('a WHERE in a later statement does not cover an earlier DELETE', () => {
    expect(rules('sqlite3 app.db "DELETE FROM users; SELECT * FROM t WHERE id = 1"')).toEqual([
      'delete-without-where',
    ])
  })

  test('a WHERE inside a comment does not count', () => {
    expect(rules('sqlite3 app.db "DELETE FROM users /* WHERE id = 1 */"')).toEqual(['delete-without-where'])
  })

  test('a WHERE after the shell string ends does not count', () => {
    expect(rules('sqlite3 app.db "DELETE FROM users" && echo WHERE')).toEqual(['delete-without-where'])
  })
})

describe('UPDATE without WHERE', () => {
  test('held without WHERE', () => {
    expect(rules("mysql -e 'UPDATE users SET active = 0'")).toEqual(['update-without-where'])
  })

  test('passes with WHERE', () => {
    expect(analyze("mysql -e 'UPDATE users SET active = 0 WHERE id = 9'")).toBeNull()
  })
})

describe('ALTER TABLE ... DROP COLUMN', () => {
  test('held, with the table as target', () => {
    expect(rules('psql -c "ALTER TABLE users DROP COLUMN email"')).toEqual(['drop-column'])
    expect(targets('psql -c "ALTER TABLE users DROP COLUMN IF EXISTS email"')).toEqual(['users'])
  })

  test('ADD COLUMN is not held', () => {
    expect(analyze('psql -c "ALTER TABLE users ADD COLUMN email text"')).toBeNull()
  })
})

describe('dbt --full-refresh', () => {
  test('dbt run --full-refresh is held', () => {
    expect(rules('dbt run --full-refresh')).toEqual(['dbt-full-refresh'])
    expect(targets('dbt run --full-refresh')).toEqual(['every model in the project'])
  })

  test('names the selection', () => {
    expect(targets('dbt run --select orders+ --full-refresh')).toEqual(['orders+'])
    expect(targets('dbt build --full-refresh -s fct_sales')).toEqual(['fct_sales'])
  })

  test('plain dbt run is not held', () => {
    expect(analyze('dbt run')).toBeNull()
    expect(analyze('dbt test --select orders')).toBeNull()
  })
})

describe('production targets', () => {
  test('a prod host is held even for safe SQL', () => {
    expect(rules('psql -h prod-db.internal -c "SELECT 1"')).toEqual(['production-target'])
    expect(rules('mysql -hdb.production.example.com -e "SELECT 1"')).toEqual(['production-target'])
  })

  test('connection strings and URLs', () => {
    expect(rules('psql "host=prod.example.com dbname=app" -c "SELECT 1"')).toEqual(['production-target'])
    expect(rules('psql postgresql://me@db-prod:5432/app -c "SELECT 1"')).toEqual(['production-target'])
    expect(rules('DATABASE_URL=postgres://production-db/app psql -c "SELECT 1"')).toEqual([
      'production-target',
    ])
  })

  test('snowflake accounts, databricks profiles and dbt targets', () => {
    expect(rules('snowsql -a acme-prod -q "SELECT 1"')).toEqual(['production-target'])
    expect(rules('snowsql -c production -q "SELECT 1"')).toEqual(['production-target'])
    expect(rules('databricks --profile prod sql query "SELECT 1"')).toEqual(['production-target'])
    expect(rules('dbt run --target prod')).toEqual(['production-target'])
  })

  test('prod inside a table or word is not a target', () => {
    expect(analyze('psql -h localhost -c "SELECT * FROM products"')).toBeNull()
    expect(analyze('psql -h products-db -c "SELECT 1"')).toBeNull()
    expect(isProdName('reproduce')).toBe(false)
    expect(isProdName('prod1.db')).toBe(true)
  })

  test('destructive SQL on prod reports both', () => {
    expect(rules('psql -h prod-db -c "DROP TABLE users"')).toEqual(['drop-table', 'production-target'])
  })
})

describe('sqlite files and the refusal', () => {
  test('finds the database file past options', () => {
    expect(sqliteFile('sqlite3 -cmd ".mode csv" data/app.db "DROP TABLE t"')).toBe('data/app.db')
    expect(sqliteFile('sqlite3 :memory: "DROP TABLE t"')).toBeUndefined()
    expect(sqliteFile('echo "DROP TABLE t" | sqlite3 app.db')).toBe('app.db')
  })

  test('the refusal says what would have been destroyed', () => {
    const text = refusal('sqlite3 app.db "DROP TABLE users"', ['dropped table users with all of its rows'], [
      { table: 'users', rows: 1234 },
    ])
    expect(text).toContain('cancelled')
    expect(text).toContain('dropped table users with all of its rows (1,234 rows right now)')
    expect(text).toContain('Do not retry')
  })
})
