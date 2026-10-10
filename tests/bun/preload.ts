// Under Bun, map 'claude-code/testing' to bun:test so the rule tests run
// without Claude Code. `claude plugin test` doesn't load this file.
import { plugin } from 'bun'
import * as bunTest from 'bun:test'

plugin({
  name: 'claude-code-testing',
  setup(build) {
    build.module('claude-code/testing', () => ({ exports: bunTest, loader: 'object' }))
  },
})
