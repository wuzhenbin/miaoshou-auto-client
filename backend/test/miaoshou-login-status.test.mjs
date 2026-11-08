import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildApp } from '../src/app.ts'

test('Miaoshou login status follows the verified browser session', async () => {
    let session = { state: 'unknown', account: null }
    const app = buildApp(async () => 'stopped', undefined, async () => session)
    try {
        const initiallyUnknown = await app.inject({ method: 'GET', url: '/miaoshou-login/status' })
        assert.equal(initiallyUnknown.json().phase, 'unknown')

        session = { state: 'not_logged_in', account: null }
        const initiallySignedOut = await app.inject({ method: 'GET', url: '/miaoshou-login/status' })
        assert.equal(initiallySignedOut.json().phase, 'idle')

        session = { state: 'logged_in', account: '185****3210' }
        const loggedIn = await app.inject({ method: 'GET', url: '/miaoshou-login/status' })
        assert.equal(loggedIn.json().phase, 'logged_in')
        assert.equal(loggedIn.json().account, '185****3210')

        session = { state: 'unknown', account: null }
        const unknown = await app.inject({ method: 'GET', url: '/miaoshou-login/status' })
        assert.equal(unknown.json().phase, 'unknown')

        session = { state: 'not_logged_in', account: null }
        const signedOut = await app.inject({ method: 'GET', url: '/miaoshou-login/status' })
        assert.equal(signedOut.json().phase, 'idle')
        assert.equal(signedOut.json().account, null)
    } finally { await app.close() }
})
