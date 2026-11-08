import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'

const mode = process.argv[2]
if (mode) {
    const { onlineCommandStore: store } = await import('../src/online-command-store.ts')
    const id = process.env.TEST_COMMAND_ID, taskId = process.env.TEST_TASK_ID
    if (mode === 'prepare') {
        assert.equal(store.receive({ type: 'size_template_create', id, taskId }), true)
        assert.equal(store.start(id), true)
        store.markSizeFilling(id)
        if (process.env.TEST_BOUNDARY === 'true') store.markSizeSubmissionBoundary(id)
    } else if (mode === 'crash-after-boundary') {
        assert.equal(store.receive({ type: 'size_template_create', id, taskId }), true)
        assert.equal(store.start(id), true)
        store.markSizeFilling(id)
        store.markSizeSubmissionBoundary(id)
        process.kill(process.pid, 'SIGKILL')
    } else if (mode === 'recover') {
        const result = store.results().find(item => item.id === id)
        assert.equal(result?.data?.saveOutcome, process.env.TEST_BOUNDARY === 'true' ? 'uncertain' : 'not_submitted')
        assert.equal(result?.data?.saveStarted, process.env.TEST_BOUNDARY === 'true')
        assert.equal(store.next(), null)
        if (process.env.TEST_BOUNDARY === 'true') {
            assert.equal(store.receive({ type: 'size_template_create', id, taskId }), true)
            assert.equal(store.next(), null, 'same command ID cannot replay after unknown save')
            assert.equal(store.results().find(item => item.id === id)?.data?.saveOutcome, 'uncertain')
        }
    } else if (mode === 'legacy') {
        assert.equal(store.results().length, 1)
        assert.equal(store.results()[0].data.saveOutcome, process.env.TEST_BOUNDARY === 'true' ? 'uncertain' : 'not_submitted')
        assert.equal(store.next(), null)
    }
} else {
    for (const boundary of [false, true]) {
        const root = mkdtempSync(join(tmpdir(), 'size-progress-restart-'))
        try {
            const id = randomUUID(), taskId = randomUUID()
            const env = { ...process.env, MIAOSHOU_RUNTIME_DIR: root, TEST_COMMAND_ID: id,
                TEST_TASK_ID: taskId, TEST_BOUNDARY: String(boundary) }
            const run = (action) => {
                const result = spawnSync(process.execPath, ['--import', 'tsx', process.argv[1], action],
                    { cwd: join(import.meta.dirname, '..'), env, encoding: 'utf8' })
                assert.equal(result.status, 0, result.stderr)
            }
            run('prepare')
            const db = new DatabaseSync(join(root, 'online-client', 'commands.sqlite'))
            try {
                let row = db.prepare('SELECT stage,received_at,filling_at,submission_boundary_at FROM commands WHERE id=?').get(id)
                assert.equal(row.stage, boundary ? 'save_boundary' : 'filling')
                assert.ok(row.received_at && row.filling_at)
                assert.equal(Boolean(row.submission_boundary_at), boundary)
                // Simulate a database written before the new stage columns existed; the old
                // submission boundary remains authoritative across migration and restart.
                const legacy = join(root, 'legacy')
                mkdirSync(join(legacy, 'online-client'), { recursive: true })
                const old = new DatabaseSync(join(legacy, 'online-client', 'commands.sqlite'))
                try {
                    old.exec(`CREATE TABLE commands (id TEXT PRIMARY KEY,kind TEXT NOT NULL,payload TEXT NOT NULL,
                        state TEXT NOT NULL,result TEXT,received_at TEXT NOT NULL,updated_at TEXT NOT NULL,
                        submission_boundary_at TEXT,save_evidence TEXT);
                        CREATE TABLE metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);`)
                    const legacyId = randomUUID()
                    old.prepare(`INSERT INTO commands(id,kind,payload,state,received_at,updated_at,submission_boundary_at)
                        VALUES(?, 'size_template_create', ?, 'running', ?, ?, ?)`).run(legacyId,
                        JSON.stringify({ type: 'size_template_create', id: legacyId, taskId }),
                        row.received_at, row.filling_at, boundary ? row.submission_boundary_at : null)
                } finally { old.close() }
                const legacyRun = spawnSync(process.execPath, ['--import', 'tsx', process.argv[1], 'legacy'],
                    { cwd: join(import.meta.dirname, '..'), env: { ...env, MIAOSHOU_RUNTIME_DIR: legacy }, encoding: 'utf8' })
                assert.equal(legacyRun.status, 0, legacyRun.stderr)
                const migrated = new DatabaseSync(join(legacy, 'online-client', 'commands.sqlite'))
                try {
                    assert.equal(migrated.prepare('SELECT stage FROM commands').get().stage, 'result')
                    assert.equal(Boolean(migrated.prepare('SELECT submission_boundary_at FROM commands').get().submission_boundary_at), boundary)
                } finally { migrated.close() }
                row = db.prepare('SELECT stage FROM commands WHERE id=?').get(id)
                assert.equal(row.stage, boundary ? 'save_boundary' : 'filling')
            } finally { db.close() }
            run('recover')
            const reopened = new DatabaseSync(join(root, 'online-client', 'commands.sqlite'))
            try {
                const row = reopened.prepare('SELECT stage,result_at,submission_boundary_at FROM commands WHERE id=?').get(id)
                assert.equal(row.stage, 'result')
                assert.ok(row.result_at)
                assert.equal(Boolean(row.submission_boundary_at), boundary)
            } finally { reopened.close() }
        } finally { rmSync(root, { recursive: true, force: true }) }
    }
    const crashedRoot = mkdtempSync(join(tmpdir(), 'size-crash-boundary-'))
    try {
        const id = randomUUID(), taskId = randomUUID()
        const env = { ...process.env, MIAOSHOU_RUNTIME_DIR: crashedRoot,
            TEST_COMMAND_ID: id, TEST_TASK_ID: taskId, TEST_BOUNDARY: 'true' }
        const crash = spawnSync(process.execPath, ['--import', 'tsx', process.argv[1], 'crash-after-boundary'],
            { cwd: join(import.meta.dirname, '..'), env, encoding: 'utf8' })
        assert.equal(crash.signal, 'SIGKILL', crash.stderr)
        const recovery = spawnSync(process.execPath, ['--import', 'tsx', process.argv[1], 'recover'],
            { cwd: join(import.meta.dirname, '..'), env, encoding: 'utf8' })
        assert.equal(recovery.status, 0, recovery.stderr)
        const db = new DatabaseSync(join(crashedRoot, 'online-client', 'commands.sqlite'))
        try {
            const row = db.prepare('SELECT state,submission_boundary_at,result FROM commands WHERE id=?').get(id)
            assert.equal(row.state, 'uncertain')
            assert.ok(row.submission_boundary_at)
            assert.equal(JSON.parse(row.result).data.saveOutcome, 'uncertain')
        } finally { db.close() }
    } finally { rmSync(crashedRoot, { recursive: true, force: true }) }
    const preBoundaryRoot = mkdtempSync(join(tmpdir(), 'size-legacy-write-'))
    try {
        mkdirSync(join(preBoundaryRoot, 'online-client'), { recursive: true })
        const old = new DatabaseSync(join(preBoundaryRoot, 'online-client', 'commands.sqlite'))
        try {
            old.exec(`CREATE TABLE commands (id TEXT PRIMARY KEY,kind TEXT NOT NULL,payload TEXT NOT NULL,
                state TEXT NOT NULL,result TEXT,received_at TEXT NOT NULL,updated_at TEXT NOT NULL);
                CREATE TABLE metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);`)
            const id = randomUUID(), taskId = randomUUID(), now = new Date().toISOString()
            old.prepare(`INSERT INTO commands(id,kind,payload,state,received_at,updated_at)
                VALUES(?, 'size_template_create', ?, 'running', ?, ?)`).run(id,
                JSON.stringify({ type: 'size_template_create', id, taskId }), now, now)
        } finally { old.close() }
        const result = spawnSync(process.execPath, ['--import', 'tsx', process.argv[1], 'legacy'],
            { cwd: join(import.meta.dirname, '..'), env: { ...process.env, MIAOSHOU_RUNTIME_DIR: preBoundaryRoot,
                TEST_BOUNDARY: 'true' }, encoding: 'utf8' })
        assert.equal(result.status, 0, result.stderr)
        const migrated = new DatabaseSync(join(preBoundaryRoot, 'online-client', 'commands.sqlite'))
        try { assert.ok(migrated.prepare('SELECT submission_boundary_at FROM commands').get().submission_boundary_at) }
        finally { migrated.close() }
    } finally { rmSync(preBoundaryRoot, { recursive: true, force: true }) }
    console.log('PASS size progress restart: before/after boundary, SIGKILL recovery, legacy unknown')
}
