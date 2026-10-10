// The detection rules. Each rule reads the text of one Bash command.
// Nothing here calls Claude Code, so the tests can check each rule directly.

export type RuleId =
  | 'drop-table'
  | 'drop-database'
  | 'drop-schema'
  | 'truncate'
  | 'delete-without-where'
  | 'update-without-where'
  | 'drop-column'
  | 'dbt-full-refresh'
  | 'production-target'

export type Hit = {
  rule: RuleId
  /** Why it was held, for the person. */
  reason: string
  /** What it would destroy, for the refusal Claude reads. */
  effect: string
  /** The table, schema, database or dbt selection. */
  target: string
  /** True when the target is a table whose rows can be counted. */
  isTable: boolean
}

export type Finding = {
  client: string
  hits: Hit[]
  /** The SQLite database file a sqlite3 command names, when it names one. */
  sqliteFile?: string
}

const CLIENTS = ['sqlite3', 'psql', 'mysql', 'snowsql', 'databricks', 'dbt'] as const
type Client = (typeof CLIENTS)[number]

// A client invoked as a command word: at the start, after a shell operator,
// after `env VAR=x`, or as a path ending in the name (/usr/bin/psql).
const CLIENT_RE = new RegExp(
  String.raw`(?:^|[\s;&|(\x60$]|/)(${CLIENTS.join('|')})(?=$|[\s;&|)])`,
  'g',
)

// An identifier, optionally schema-qualified and quoted in any dialect.
const NAME = String.raw`(?:[\w$]+|"[^"]+"|\x60[^\x60]+\x60|\[[^\]]+\])(?:\.(?:[\w$]+|"[^"]+"|\x60[^\x60]+\x60|\[[^\]]+\]))*`

/** Which database clients the command runs, in order of appearance. */
export function findClients(command: string): Client[] {
  const found: Client[] = []
  for (const match of command.matchAll(CLIENT_RE)) {
    const client = (match[1] ?? '') as Client
    if (!found.includes(client)) found.push(client)
  }
  return found
}

/** Strips one layer of quoting from an identifier: "a"."b" -> a.b */
export function cleanName(name: string): string {
  return name.replace(/["\x60[\]]/g, '')
}

// Where one SQL statement ends inside a shell command: a semicolon, or a
// closing quote followed by a shell operator or the end of the command.
function statementEnd(text: string, from: number): number {
  const rest = text.slice(from)
  const match = rest.match(/;|['"]\s*(?:$|\|\||&&|[|;&)>])/)
  return match?.index === undefined ? text.length : from + match.index
}

function sqlHits(command: string): Hit[] {
  const hits: Hit[] = []
  // `--` and `/* */` comments could hide a WHERE or fake one; drop them.
  const sql = command.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')

  for (const m of sql.matchAll(
    new RegExp(String.raw`\bDROP\s+(TABLE|DATABASE|SCHEMA)\s+(?:IF\s+EXISTS\s+)?(${NAME})`, 'gi'),
  )) {
    const kind = (m[1] ?? '').toUpperCase()
    const target = cleanName(m[2] ?? '')
    if (kind === 'TABLE') {
      hits.push({
        rule: 'drop-table',
        reason: `DROP TABLE ${target}`,
        effect: `dropped table ${target} with all of its rows`,
        target,
        isTable: true,
      })
    } else if (kind === 'DATABASE') {
      hits.push({
        rule: 'drop-database',
        reason: `DROP DATABASE ${target}`,
        effect: `dropped database ${target} and every table in it`,
        target,
        isTable: false,
      })
    } else {
      hits.push({
        rule: 'drop-schema',
        reason: `DROP SCHEMA ${target}`,
        effect: `dropped schema ${target} and every object in it`,
        target,
        isTable: false,
      })
    }
  }

  for (const m of sql.matchAll(
    new RegExp(String.raw`\bTRUNCATE\s+(?:TABLE\s+)?(?:ONLY\s+)?(${NAME})`, 'gi'),
  )) {
    const target = cleanName(m[1] ?? '')
    hits.push({
      rule: 'truncate',
      reason: `TRUNCATE ${target}`,
      effect: `removed every row from ${target}`,
      target,
      isTable: true,
    })
  }

  for (const m of sql.matchAll(new RegExp(String.raw`\bDELETE\s+FROM\s+(?:ONLY\s+)?(${NAME})`, 'gi'))) {
    const after = m.index + m[0].length
    const statement = sql.slice(after, statementEnd(sql, after))
    if (/\bWHERE\b/i.test(statement)) continue
    const target = cleanName(m[1] ?? '')
    hits.push({
      rule: 'delete-without-where',
      reason: `DELETE FROM ${target} has no WHERE clause`,
      effect: `deleted every row in ${target}`,
      target,
      isTable: true,
    })
  }

  for (const m of sql.matchAll(new RegExp(String.raw`\bUPDATE\s+(?:ONLY\s+)?(${NAME})\s+SET\b`, 'gi'))) {
    const after = m.index + m[0].length
    const statement = sql.slice(after, statementEnd(sql, after))
    if (/\bWHERE\b/i.test(statement)) continue
    const target = cleanName(m[1] ?? '')
    hits.push({
      rule: 'update-without-where',
      reason: `UPDATE ${target} has no WHERE clause`,
      effect: `overwritten the updated columns in every row of ${target}`,
      target,
      isTable: true,
    })
  }

  for (const m of sql.matchAll(
    new RegExp(
      String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${NAME})\s+[^;]*?\bDROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?(${NAME})`,
      'gi',
    ),
  )) {
    const table = cleanName(m[1] ?? '')
    const column = cleanName(m[2] ?? '')
    hits.push({
      rule: 'drop-column',
      reason: `ALTER TABLE ${table} DROP COLUMN ${column}`,
      effect: `dropped column ${column} from ${table}, with its value in every row`,
      target: table,
      isTable: true,
    })
  }

  return hits
}

function dbtHits(command: string): Hit[] {
  const isRebuild = /\bdbt\s+(?:[^\n;&|]*?\s)?(run|build|seed)\b[^\n;&|]*?--full-refresh\b/.test(command)
  if (!isRebuild) return []
  const selection = command.match(/(?:--select|--models|-s|-m)[\s=]+((?:[^\s-][^\s]*\s*)+)/)
  const target = selection ? (selection[1] ?? '').trim() : 'every model in the project'
  return [
    {
      rule: 'dbt-full-refresh',
      reason: 'dbt --full-refresh drops and rebuilds incremental models',
      effect: `dropped and rebuilt ${target} from scratch, discarding incremental history`,
      target,
      isTable: false,
    },
  ]
}

/** True when a host, URL or connection name says prod or production as a word. */
export function isProdName(value: string): boolean {
  return /(?:^|[^a-z])prod(?:uction)?(?:[^a-z]|$)/i.test(value)
}

/**
 * The parts of a command that name where it connects: URLs, host and
 * account flags, `host=` style connection strings, dbt targets and profiles,
 * and environment variables such as PGHOST or DATABASE_URL.
 */
export function connectionValues(command: string, clients: readonly string[]): string[] {
  const values: string[] = []
  const add = (value: string | undefined) => {
    if (value) values.push(value.replace(/^['"]|['"]$/g, ''))
  }

  for (const m of command.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi)) add(m[0])
  for (const m of command.matchAll(/\bjdbc:[^\s'"]+/gi)) add(m[0])

  const flags = ['--host', '--hostname', '--server-hostname', '--account', '--accountname', '--target', '--profile', '--connection', '--dbname', '--database', '--url']
  const shortFlags = ['-h', '-a', '-t', '-d', '-D']
  if (clients.includes('snowsql')) shortFlags.push('-c')
  if (clients.includes('databricks')) shortFlags.push('-p')
  for (const m of command.matchAll(/(?:^|\s)(--?[A-Za-z-]+)(?:=|\s+)("[^"]*"|'[^']*'|[^\s]+)/g)) {
    const flag = m[1] ?? ''
    if (flags.includes(flag) || shortFlags.includes(flag)) add(m[2])
  }
  // -hprod-db, as mysql takes it.
  for (const m of command.matchAll(/(?:^|\s)-h([^\s=-][^\s]*)/g)) add(m[1])

  for (const m of command.matchAll(
    /\b(host|hostaddr|dbname|service|server|account|[A-Z_]*(?:HOST|URL|URI|ACCOUNT|SERVER|DSN|TARGET|PROFILE|CONNECTION)[A-Z_]*)=("[^"]*"|'[^']*'|[^\s'";]+)/g,
  )) {
    add(m[2])
  }

  return values
}

/** The database file a sqlite3 command opens, when it names one on disk. */
export function sqliteFile(command: string): string | undefined {
  const at = command.search(/(?:^|[\s;&|(/])sqlite3(?=\s)/)
  if (at < 0) return undefined
  const rest = command.slice(at).replace(/^.*?sqlite3/, '')
  const tokens = [...rest.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(m => ({
    text: m[1] ?? m[2] ?? m[3] ?? '',
    isQuoted: m[3] === undefined,
  }))
  const takesValue = ['-cmd', '-init', '-separator', '-newline', '-nullvalue', '-vfs', '-maxsize', '-mmap', '-pagecache', '-lookaside', '-heap', '-zip']
  for (let i = 0; i < tokens.length; i += 1) {
    const { text, isQuoted } = tokens[i] ?? { text: '', isQuoted: false }
    if (!isQuoted && /^[;&|<>]/.test(text)) return undefined
    if (!isQuoted && text.startsWith('-')) {
      if (takesValue.includes(text.replace(/^--/, '-'))) i += 1
      continue
    }
    if (text === ':memory:' || text === '') return undefined
    return text
  }
  return undefined
}

/** Reads a Bash command and answers what Query Guard holds it for, or null. */
export function analyze(command: string): Finding | null {
  const clients = findClients(command)
  if (clients.length === 0) return null

  const hits: Hit[] = [...sqlHits(command)]
  if (clients.includes('dbt')) hits.push(...dbtHits(command))

  const prod = connectionValues(command, clients).filter(isProdName)
  if (prod.length > 0) {
    const where = [...new Set(prod)].join(', ')
    hits.push({
      rule: 'production-target',
      reason: `connects to a production target: ${where}`,
      effect: `run against production (${where})`,
      target: where,
      isTable: false,
    })
  }

  if (hits.length === 0) return null
  const client = clients.find(c => c !== 'dbt' || hits.some(h => h.rule === 'dbt-full-refresh')) ?? clients[0] ?? 'sql'
  return {
    client,
    hits,
    sqliteFile: clients.includes('sqlite3') ? sqliteFile(command) : undefined,
  }
}

/** The text Claude reads when the person cancels a held call. */
export function refusal(command: string, effects: readonly string[], counts: readonly { table: string; rows: number }[]): string {
  const lines = effects.map(effect => {
    const count = counts.find(c => effect.includes(` ${c.table}`))
    return count ? `- ${effect} (${count.rows.toLocaleString('en-US')} rows right now)` : `- ${effect}`
  })
  return [
    'Query Guard: the user cancelled this command. Nothing was run.',
    `Command: ${command}`,
    'Had it run, it would have:',
    ...lines,
    'Do not retry it or work around the guard with a script or alias; ask the user how they want to proceed.',
  ].join('\n')
}
