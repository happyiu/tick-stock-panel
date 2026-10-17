import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// 缠论算法测试已迁到 backend/tests/test_chanlun.py；这里验证前端契约与投影。
const run = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run',
  'src/lib/chanlunQuery.test.ts', 'src/lib/kline-chart-chanlun.test.ts'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'inherit',
})
process.exit(run.status ?? 1)
