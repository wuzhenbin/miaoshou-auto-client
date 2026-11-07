import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

test('target switch archives only completed status results and preserves business commands', async () => {
    const root = mkdtempSync(join(tmpdir(), 'miaoshou-command-store-'))
    const previous = process.env.MIAOSHOU_RUNTIME_DIR
    process.env.MIAOSHOU_RUNTIME_DIR = root
    try {
        const { onlineCommandStore: store } = await import('../src/online-command-store.ts')
        const oldTarget = 'http://127.0.0.1:3000/auth/online-client/heartbeat'
        const newTarget = 'https://example.com/account-1/api/auth/online-client/heartbeat'
        assert.equal(store.bindTarget(oldTarget), true)
        assert.equal(store.bindAccount({ mobile: '12345678901' }), true)
        const statusId = randomUUID()
        assert.equal(store.receive({ type: 'browser_size_status', id: statusId }), true)
        assert.equal(store.start(statusId), true)
        store.finish({ type: 'online_result', id: statusId, ok: true, data: { status: 'ready' } })
        assert.equal(store.bindAccount({ mobile: '10987654321' }), false)

        const businessId = randomUUID()
        assert.equal(store.receive({ type: 'size_template_create', id: businessId }), true)
        assert.equal(store.bindTarget(newTarget), false)
        assert.deepEqual(store.results().map(result => result.id), [statusId])

        const db = new DatabaseSync(join(root, 'online-client', 'commands.sqlite'))
        try {
            assert.equal(db.prepare("SELECT value FROM metadata WHERE key='backend_target'").get().value, oldTarget)
            assert.equal(db.prepare('SELECT COUNT(*) AS count FROM superseded_status_commands').get().count, 0)
            assert.equal(db.prepare('SELECT state FROM commands WHERE id=?').get(businessId).state, 'queued')
            db.prepare('DELETE FROM commands WHERE id=?').run(businessId)
            assert.equal(store.bindTarget(newTarget), true)
            assert.equal(db.prepare('SELECT state FROM commands WHERE id=?').get(statusId), undefined)
            assert.deepEqual({ ...db.prepare('SELECT kind,previous_target,result FROM superseded_status_commands WHERE id=?')
                .get(statusId) }, { kind: 'browser_size_status', previous_target: oldTarget,
                    result: JSON.stringify({ type: 'online_result', id: statusId, ok: true, data: { status: 'ready' } }) })
            assert.deepEqual(store.results(), [])
            assert.equal(store.bindTarget(newTarget), true)
        } finally { db.close() }
    } finally {
        if (previous === undefined) delete process.env.MIAOSHOU_RUNTIME_DIR
        else process.env.MIAOSHOU_RUNTIME_DIR = previous
        rmSync(root, { recursive: true, force: true })
    }
})
