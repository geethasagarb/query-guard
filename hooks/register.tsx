// The hooks Claude Code loads for Query Guard.
// The Bash hook holds a flagged command until you press Proceed or Cancel.
// The pane, the band above the prompt, and the status line show what it holds.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { HeldCall, RowCount } from '../types'
import { analyze, refusal } from './rules'
import type { Finding } from './rules'

const PANE = 'query-guard'
const POLL = ['sleep', '0.25']

const pending = atom({ plugin: 'query-guard', key: 'pending' } as const, [])
const held = atom({ plugin: 'query-guard', key: 'held' } as const, 0)
const where = atom({ plugin: 'query-guard', key: 'where' } as const, 'pane')

type Decision = 'proceed' | 'cancel'

// The person's answers, by tool_use_id. A module variable on purpose: the
// waiting hook reads it between `$` calls, and every `$.state.get` of one
// dispatch reads the moment the dispatch began.
const decisions = new Map<string, Decision>()

const statusText = (count: number) => `🛡 Query Guard · ${count} held this session`

// A table name SQLite can be asked about: plain identifiers and one dot.
const COUNTABLE = /^[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?$/

async function rowCounts($: EngineInterface, finding: Finding): Promise<RowCount[]> {
  const file = finding.sqliteFile
  if (file === undefined) return []
  const tables = [...new Set(finding.hits.filter(h => h.isTable).map(h => h.target))]
  if (tables.length === 0) return []

  const exists = await $.process.run(['test', '-f', file]).catch(() => undefined)
  if (exists?.exitCode !== 0) return []

  const counts: RowCount[] = []
  for (const table of tables) {
    if (!COUNTABLE.test(table)) continue
    const quoted = table
      .split('.')
      .map(part => `"${part}"`)
      .join('.')
    const ran = await $.process
      .run(['sqlite3', '-readonly', '-batch', '-noheader', file, `SELECT COUNT(*) FROM ${quoted};`], {
        timeoutMs: 5_000,
      })
      .catch(() => undefined)
    const rows = Number(ran?.stdout.trim())
    if (ran?.exitCode === 0 && Number.isInteger(rows)) counts.push({ table, rows })
  }
  return counts
}

async function decide($: EngineInterface, id: string, decision: Decision) {
  decisions.set(id, decision)
  await update($, pending, list => list.filter(call => call.id !== id))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    $.ui.status(statusText(await read($, held)))
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const finding = analyze(e.command)
    if (finding === null) return next(e)

    const call: HeldCall = {
      id: e.tool_use_id,
      command: e.command,
      client: finding.client,
      reasons: finding.hits.map(h => h.reason),
      effects: finding.hits.map(h => h.effect),
      targets: [...new Set(finding.hits.map(h => h.target))],
      database: finding.sqliteFile,
      rowCounts: await rowCounts($, finding),
    }

    decisions.delete(call.id)
    await update($, pending, list => [...list, call])
    const count = await update($, held, n => n + 1)
    $.ui.status(statusText(count))

    const opened = await $.ui
      .open({ id: PANE, title: 'Query Guard', focus: true })
      .catch(() => ({ isPlaced: false }))
    await update($, where, () => (opened.isPlaced ? 'pane' : 'band'))
    if (!opened.isPlaced) {
      // Too narrow for a pane: the report is drawn above the prompt instead;
      // close the waiting pane so it does not also appear on a resize.
      await $.ui.close({ id: PANE }).catch(() => undefined)
    }

    let decision = decisions.get(call.id)
    while (decision === undefined) {
      if (next.signal.aborted) {
        await decide($, call.id, 'cancel')
        break
      }
      await $.process.run(POLL).catch(() => undefined)
      decision = decisions.get(call.id)
    }
    decisions.delete(call.id)

    if ((await read($, pending)).length === 0) {
      await $.ui.close({ id: PANE }).catch(() => undefined)
    }

    if (decision === 'proceed') return next(e)
    return { deny: refusal(call.command, call.effects, call.rowCounts) }
  }).catch(($, e, next) =>
    next.called
      ? next(e)
      : { deny: 'Query Guard could not finish checking this database command, so it was not run. Ask the user to run it themselves or retry.' },
  )

  on('ui.close', { id: PANE }, async ($, e, next) => {
    // Closing the pane by hand while a call is held cancels that call.
    if (e.origin.kind === 'person') {
      for (const call of await read($, pending)) await decide($, call.id, 'cancel')
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const list = await read($, pending)
    return report($, e, list, e.props.bodyColumns)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, pending)
    if (list.length === 0 || (await read($, where)) !== 'band') return next(e)
    return report($, e, list, e.props.bodyColumns)
  })
}

function report(
  $: EngineInterface,
  e: Parameters<EngineInterface['ui']['resolve']>[0],
  list: readonly HeldCall[],
  columns: number,
) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const call = list[0]
  if (call === undefined) {
    return (
      <Box>
        <Text dimColor>Nothing held. Query Guard is watching SQL and dbt commands.</Text>
      </Box>
    )
  }
  const counts = new Map(call.rowCounts.map(c => [c.table, c.rows]))
  const width = Math.max(20, columns)

  return (
    <Box flexDirection="column" width={width}>
      <Text bold color="red">
        🛡 Query Guard held a {call.client} command
      </Text>
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>Command</Text>
        <Text wrap="wrap">{call.command}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>Why it was flagged</Text>
        {call.reasons.map(reason => (
          <Text wrap="wrap">• {reason}</Text>
        ))}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>Target{call.targets.length > 1 ? 's' : ''}</Text>
        {call.targets.map(target => (
          <Text wrap="wrap">
            {target}
            {counts.has(target) ? (
              <Text color="yellow"> · {counts.get(target)?.toLocaleString('en-US')} rows now</Text>
            ) : (
              ''
            )}
          </Text>
        ))}
        {call.database !== undefined && <Text dimColor>in {call.database}</Text>}
      </Box>
      <Box marginTop={1} gap={2}>
        <Button key="proceed" hotkey="1" label="Proceed" onPress={() => decide($, call.id, 'proceed')} />
        <Button key="cancel" hotkey="2" label="Cancel" variant="primary" onPress={() => decide($, call.id, 'cancel')} />
      </Box>
      {list.length > 1 && <Text dimColor>{list.length - 1} more held after this one</Text>}
    </Box>
  )
}
