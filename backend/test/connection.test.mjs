import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildApp } from '../src/app.ts'

test('local connection endpoint accepts Basic credentials without returning the password', async () => {
    let received = null
    const status = { state: 'credentials_required', account: null, credentialsSet: false }
    const connection = {
        status: () => status,
        setCredentials: (username, password) => {
            received = { username, password }
            return { state: 'login_required', account: null, credentialsSet: true }
        },
    }
    const app = buildApp(async () => 'stopped', connection)
    try {
        const invalid = await app.inject({ method: 'POST', url: '/connection', payload: { username: 'user', password: '' } })
        assert.equal(invalid.statusCode, 400)
        const crossSite = await app.inject({ method: 'POST', url: '/connection',
            headers: { origin: 'https://example.com' }, payload: { username: 'user', password: 'secret' } })
        assert.equal(crossSite.statusCode, 403)
        const saved = await app.inject({ method: 'POST', url: '/connection',
            headers: { origin: 'http://127.0.0.1:5175' }, payload: { username: ' user ', password: 'secret' } })
        assert.equal(saved.statusCode, 200)
        assert.deepEqual(received, { username: 'user', password: 'secret' })
        assert.equal(saved.json().credentialsSet, true)
        assert.equal(saved.body.includes('secret'), false)
        const localhost = await app.inject({ method: 'POST', url: '/connection',
            headers: { origin: 'http://localhost:5175' }, payload: { username: 'user', password: 'secret' } })
        assert.equal(localhost.statusCode, 200)
        const otherPort = await app.inject({ method: 'POST', url: '/connection',
            headers: { origin: 'http://localhost:5176' }, payload: { username: 'user', password: 'secret' } })
        assert.equal(otherPort.statusCode, 403)
    } finally { await app.close() }
})

test('packaged client accepts localhost on its own port only', async () => {
    const previous = process.env.CLIENT_FRONTEND_DIST
    process.env.CLIENT_FRONTEND_DIST = '/tmp/miaoshou-client-frontend-test'
    const connection = { status: () => ({ state: 'credentials_required', account: null, credentialsSet: false }),
        setCredentials: () => ({ state: 'login_required', account: null, credentialsSet: true }) }
    const app = buildApp(async () => 'stopped', connection)
    try {
        for (const origin of ['http://localhost:3001', 'http://127.0.0.1:3001']) {
            const response = await app.inject({ method: 'POST', url: '/connection',
                headers: { origin }, payload: { username: 'user', password: 'secret' } })
            assert.equal(response.statusCode, 200)
        }
        const crossSite = await app.inject({ method: 'POST', url: '/connection',
            headers: { origin: 'https://example.com' }, payload: { username: 'user', password: 'secret' } })
        assert.equal(crossSite.statusCode, 403)
    } finally {
        await app.close()
        if (previous === undefined) delete process.env.CLIENT_FRONTEND_DIST
        else process.env.CLIENT_FRONTEND_DIST = previous
    }
})
