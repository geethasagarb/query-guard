// The state Query Guard keeps for one session.
// The pane and the band read it to draw the report.

/** One table a held command touches, with its row count when it could be read. */
export type RowCount = { table: string; rows: number }

/** A Bash call Query Guard is holding until the person answers it. */
export type HeldCall = {
  /** The tool_use_id of the held Bash call. */
  id: string
  command: string
  /** The database client or tool the command runs: sqlite3, psql, dbt, ... */
  client: string
  /** Why it was held, one line per rule that matched. */
  reasons: string[]
  /** What it would destroy or touch, one line per effect. */
  effects: string[]
  /** The tables, schemas, databases or dbt selections it targets. */
  targets: string[]
  /** The SQLite database file, for sqlite3 commands that name one. */
  database?: string
  /** Current row counts, read with SELECT COUNT(*) from local SQLite files only. */
  rowCounts: RowCount[]
}

declare module 'claude-code' {
  interface PluginState {
    'query-guard': {
      /** Held calls, oldest first; the first one is the one on screen. */
      pending: HeldCall[]
      /** How many calls were held this session. */
      held: number
      /** Where the report is drawn: the pane, or above the prompt when no pane fits. */
      where: 'pane' | 'band'
    }
  }
}
