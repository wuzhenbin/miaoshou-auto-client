import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

test('account and target switches archive completed status results but preserve business commands', async () => {
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
        assert.equal(store.hasBlockingCommands(), false)
        assert.equal(store.bindAccount({ mobile: '10987654321' }), true)
        assert.deepEqual(store.results(), [])

        const nextStatusId = randomUUID()
        assert.equal(store.receive({ type: 'browser_size_status', id: nextStatusId }), true)
        assert.equal(store.start(nextStatusId), true)
        store.finish({ type: 'online_result', id: nextStatusId, ok: true })

        const businessId = randomUUID()
        assert.equal(store.receive({ type: 'size_template_create', id: businessId }), true)
        assert.equal(store.hasBlockingCommands(), true)
        assert.equal(store.bindTarget(newTarget), false)
        assert.deepEqual(store.results().map(result => result.id), [nextStatusId])
        assert.equal(store.archiveOrphanedRead(businessId), false)

        const db = new DatabaseSync(join(root, 'online-client', 'commands.sqlite'))
        try {
            assert.equal(db.prepare("SELECT value FROM metadata WHERE key='backend_target'").get().value, oldTarget)
            assert.equal(db.prepare('SELECT reason FROM superseded_status_commands WHERE id=?').get(statusId).reason,
                'account_switch')
            assert.equal(db.prepare('SELECT state FROM commands WHERE id=?').get(businessId).state, 'queued')
            db.prepare('DELETE FROM commands WHERE id=?').run(businessId)
            assert.equal(store.bindTarget(newTarget), true)
            assert.equal(db.prepare('SELECT state FROM commands WHERE id=?').get(nextStatusId), undefined)
            assert.deepEqual({ ...db.prepare('SELECT kind,previous_target,previous_account,reason,result FROM superseded_status_commands WHERE id=?')
                .get(nextStatusId) }, { kind: 'browser_size_status', previous_target: oldTarget,
                    previous_account: '10987654321', reason: 'target_switch',
                    result: JSON.stringify({ type: 'online_result', id: nextStatusId, ok: true }) })
            assert.deepEqual(store.results(), [])
            assert.equal(store.bindTarget(newTarget), true)

            const readId = randomUUID()
            assert.equal(store.receive({ type: 'size_template_observe', id: readId }), true)
            assert.equal(store.start(readId), true)
            store.finish({ type: 'online_result', id: readId, ok: true })
            assert.equal(store.archiveOrphanedRead(readId), true)
            assert.equal(db.prepare('SELECT kind FROM orphaned_read_results WHERE id=?').get(readId).kind,
                'size_template_observe')
            assert.deepEqual(store.results(), [])
        } finally { db.close() }
    } finally {
        if (previous === undefined) delete process.env.MIAOSHOU_RUNTIME_DIR
        else process.env.MIAOSHOU_RUNTIME_DIR = previous
        rmSync(root, { recursive: true, force: true })
    }
})
