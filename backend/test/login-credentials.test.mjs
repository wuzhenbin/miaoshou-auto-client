import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildApp } from '../src/app.ts'
import { loadConnectionCredentials, saveConnectionCredentials } from '../src/browser-session.ts'

test('Miaoshou credentials stay encrypted locally and are never returned by the API', async () => {
    const root = await mkdtemp(join(tmpdir(), 'miaoshou-client-credentials-'))
    const previous = process.env.MIAOSHOU_RUNTIME_DIR
    process.env.MIAOSHOU_RUNTIME_DIR = root
    const app = buildApp(async () => 'stopped')
    try {
        const saved = await app.inject({ method: 'PUT', url: '/miaoshou-login/credentials',
            payload: { account: 'account-1', password: 'private-password' } })
        assert.equal(saved.statusCode, 200)
        assert.equal(saved.body.includes('private-password'), false)
        const status = await app.inject({ method: 'GET', url: '/miaoshou-login/status' })
        assert.equal(status.json().configuredAccount, 'account-1')
        assert.equal(status.body.includes('private-password'), false)
        const encrypted = await readFile(join(root, 'browser-sessions', 'miaoshou-credentials.json'), 'utf8')
        assert.equal(encrypted.includes('private-password'), false)
        const removed = await app.inject({ method: 'DELETE', url: '/miaoshou-login/credentials' })
        assert.equal(removed.statusCode, 200)
        const after = await app.inject({ method: 'GET', url: '/miaoshou-login/status' })
        assert.equal(after.json().configuredAccount, null)
    } finally {
        await app.close()
        if (previous === undefined) delete process.env.MIAOSHOU_RUNTIME_DIR
        else process.env.MIAOSHOU_RUNTIME_DIR = previous
        await rm(root, { recursive: true, force: true })
    }
})

test('business connection credentials survive restart without plaintext storage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'miaoshou-client-connection-'))
    try {
        const saved = { origin: 'https://gateway.example', username: 'operator', password: 'private-password' }
        await saveConnectionCredentials(root, saved)
        const encrypted = await readFile(join(root, 'browser-sessions', 'connection-credentials.json'), 'utf8')
        assert.equal(encrypted.includes(saved.password), false)
        assert.deepEqual(await loadConnectionCredentials(root), saved)
    } finally {
        await rm(root, { recursive: true, force: true })
    }
})
