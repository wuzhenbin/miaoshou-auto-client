import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'miaoshou-local-direct-'))
try {
    const run = (values, expectedStatus, expectedText) => {
        const env = { ...process.env, MIAOSHOU_RUNTIME_DIR: root,
            CLIENT_LOCAL_MIAOSHOU_ACCOUNT: '18534043210', ...values }
        delete env.CLIENT_GATEWAY_ORIGIN
        if (values.CLIENT_GATEWAY_ORIGIN) env.CLIENT_GATEWAY_ORIGIN = values.CLIENT_GATEWAY_ORIGIN
        const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
            'try { await import("./src/connection-manager.ts"); console.log("accepted") } catch (error) { console.error(error.message); process.exitCode = 1 }'],
        { cwd: join(import.meta.dirname, '..'), env, encoding: 'utf8', timeout: 10_000 })
        assert.equal(result.status, expectedStatus, result.stderr)
        assert.match(expectedStatus ? result.stderr : result.stdout, expectedText)
    }
    run({ CLIENT_LOCAL_BUSINESS_API: 'http://127.0.0.1:3000/' }, 0, /accepted/)
    run({ CLIENT_LOCAL_BUSINESS_API: 'https://example.com/' }, 1, /仅允许开发环境的本机 HTTP/)
    run({ CLIENT_LOCAL_BUSINESS_API: 'http://127.0.0.1:3000/', NODE_ENV: 'production' }, 1, /仅允许开发环境的本机 HTTP/)
    run({ CLIENT_LOCAL_BUSINESS_API: 'http://127.0.0.1:3000/', CLIENT_GATEWAY_ORIGIN: 'https://example.com' }, 1, /不能同时配置公网业务网关/)
    run({ CLIENT_LOCAL_BUSINESS_API: 'http://127.0.0.1:3000/', CLIENT_LOCAL_MIAOSHOU_ACCOUNT: '' }, 1, /必须配置 CLIENT_LOCAL_MIAOSHOU_ACCOUNT/)
    console.log('PASS local-only connection configuration rejects unsafe targets')
} finally { rmSync(root, { recursive: true, force: true }) }
