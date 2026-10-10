import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PANE_PROPS = {
  title: 'Query Guard',
  isFocused: true,
  bodyColumns: 80,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: true,
  maxRows: 20,
  bodyColumns: 70,
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
} as const

// The kit's environment has timers; the mod's lib (no DOM) does not declare them.
declare const setTimeout: (fn: () => void, ms: number) => unknown

const ran = (stdout = '') => ({ result: { stdout, stderr: '', interrupted: false } })

/**
 * Stands in for the host: the pane is placed (or not), sqlite3 counts 42
 * rows; `opened` settles once the guard opens its pane (the call is held),
 * `closed` once it closes it.
 */
function host(on: On, { isPlaced }: { isPlaced: boolean }) {
  const commands: string[][] = []
  const statuses: (string | undefined)[] = []
  let onOpen = () => {}
  let onClose = () => {}
  const opened = new Promise<void>(resolve => {
    onOpen = resolve
  })
  const closed = new Promise<void>(resolve => {
    onClose = resolve
  })
  on('process.run', async ($, e) => {
    commands.push([...e.argv])
    // The guard waits between polls with `sleep`; take a real moment here too.
    if (e.argv[0] === 'sleep') await new Promise<void>(resolve => setTimeout(() => resolve(), 5))
    const stdout = e.argv[0] === 'sqlite3' ? '42\n' : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.open', async () => {
    onOpen()
    return { value: isPlaced ? { isPlaced: true as const } : { isPlaced: false as const, reason: 'narrow' } }
  })
  on('ui.close', async () => {
    onClose()
    return { value: undefined }
  })
  on('ui.status', async ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  return { commands, statuses, opened, closed }
}

test('a safe command runs without being held', async ($, on) => {
  const { statuses } = host(on, { isPlaced: true })
  on('tool.call', async () => ran('ok'))
  const result = await $.tool.call({ tool: 'Bash', command: 'sqlite3 app.db "SELECT 1"', tool_use_id: 't0' })
  expect(result.deny).toBeUndefined()
  expect(result.isError).toBeUndefined()
  expect(statuses).toHaveLength(0)
})

test('Cancel refuses the call and tells Claude what it would have destroyed', async ($, on) => {
  const { commands, statuses, opened } = host(on, { isPlaced: true })
  let didRun = false
  on('tool.call', async () => {
    didRun = true
    return ran()
  })

  const call = $.tool.call({ tool: 'Bash', command: 'sqlite3 app.db "DROP TABLE users"', tool_use_id: 't1' })
  await opened
  expect(commands).toContainEqual(['sqlite3', '-readonly', '-batch', '-noheader', 'app.db', 'SELECT COUNT(*) FROM "users";'])
  expect(statuses).toContain('🛡 Query Guard · 1 held this session')

  const pane = await $.ui.mount({
    plugin: 'query-guard',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'query-guard',
    props: PANE_PROPS,
  })
  expect(await pane.find({ type: 'Text', text: 'sqlite3 app.db "DROP TABLE users"' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'DROP TABLE users' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /42 rows now/ })).toBeDefined()
  expect((await pane.find({ key: 'proceed' }))?.props.hotkey).toBe('1')
  expect((await pane.find({ key: 'cancel' }))?.props.hotkey).toBe('2')
  await pane.press({ key: 'cancel' })

  const result = await call
  expect(didRun).toBe(false)
  expect(result.deny).toContain('the user cancelled this command')
  expect(result.deny).toContain('dropped table users with all of its rows (42 rows right now)')
  await pane.unmount()
})

test('Proceed runs the call', async ($, on) => {
  const { opened } = host(on, { isPlaced: true })
  let didRun = false
  on('tool.call', async () => {
    didRun = true
    return ran('done')
  })

  const call = $.tool.call({ tool: 'Bash', command: 'dbt run --full-refresh', tool_use_id: 't2' })
  await opened
  const pane = await $.ui.mount({
    plugin: 'query-guard',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'query-guard',
    props: PANE_PROPS,
  })
  await pane.press({ key: 'proceed' })

  const result = await call
  expect(didRun).toBe(true)
  expect(result.deny).toBeUndefined()
  expect(result.isError).toBeUndefined()
  await pane.unmount()
})

test('with no room for a pane the report is drawn above the prompt', async ($, on) => {
  const { closed } = host(on, { isPlaced: false })
  on('tool.call', async () => ran())

  const call = $.tool.call({ tool: 'Bash', command: 'psql -h prod-db -c "SELECT 1"', tool_use_id: 't3' })
  // With no room, the guard closes the unplaced pane and draws the band.
  await closed
  const band = await $.ui.mount({
    plugin: 'query-guard',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: BAND_PROPS,
  })
  expect(await band.find({ type: 'Text', text: /production target: prod-db/ })).toBeDefined()
  await band.press({ key: 'cancel' })

  const result = await call
  expect(result.deny).toContain('run against production (prod-db)')
  await band.unmount()
})
