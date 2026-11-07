import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildApp } from '../src/app.ts'
import { activateSavedMiaoshouCredentials, clearMiaoshouCredentials, loadConnectionCredentials,
    loadMiaoshouCredentials, loadSavedMiaoshouCredentials, saveConnectionCredentials,
    saveMiaoshouCredentials } from '../src/browser-session.ts'

test('Miaoshou credentials stay encrypted locally and are never returned by the API', async () => {
    const root = await mkdtemp(join(tmpdir(), 'miaoshou-client-credentials-'))
    const previous = process.env.MIAOSHOU_RUNTIME_DIR
    process.env.MIAOSHOU_RUNTIME_DIR = root
    const app = buildApp(async () => 'stopped')
    try {
        const crossSiteSave = await app.inject({ method: 'PUT', url: '/miaoshou-login/credentials',
            headers: { origin: 'https://example.com' }, payload: { account: 'account-1', password: 'private-password' } })
        assert.equal(crossSiteSave.statusCode, 403)
        const crossSiteSelect = await app.inject({ method: 'POST', url: '/miaoshou-login/credentials/select',
            headers: { origin: 'https://example.com' }, payload: { account: 'account-1' } })
        assert.equal(crossSiteSelect.statusCode, 403)
        const saved = await app.inject({ method: 'PUT', url: '/miaoshou-login/credentials',
            payload: { account: 'account-1', password: 'private-password' } })
        assert.equal(saved.statusCode, 200)
        assert.equal(saved.body.includes('private-password'), false)
        const status = await app.inject({ method: 'GET', url: '/miaoshou-login/status' })
        assert.equal(status.json().configuredAccount, 'account-1')
        assert.deepEqual(status.json().savedAccounts, ['account-1'])
        assert.equal(status.body.includes('private-password'), false)
        const encrypted = await readFile(join(root, 'browser-sessions', 'miaoshou-credentials.json'), 'utf8')
        assert.equal(encrypted.includes('private-password'), false)
        const vault = await readFile(join(root, 'browser-sessions', 'miaoshou-accounts.json'), 'utf8')
        assert.equal(vault.includes('private-password'), false)
        assert.equal(vault.includes('account-1'), false)
        await app.inject({ method: 'PUT', url: '/miaoshou-login/credentials',
            payload: { account: 'account-2', password: 'another-password' } })
        const selected = await app.inject({ method: 'POST', url: '/miaoshou-login/credentials/select',
            payload: { account: 'account-1' } })
        assert.equal(selected.statusCode, 200)
        const after = await app.inject({ method: 'GET', url: '/miaoshou-login/status' })
        assert.equal(after.json().configuredAccount, 'account-1')
        assert.deepEqual(after.json().savedAccounts, ['account-1', 'account-2'])
    } finally {
        await app.close()
        if (previous === undefined) delete process.env.MIAOSHOU_RUNTIME_DIR
        else process.env.MIAOSHOU_RUNTIME_DIR = previous
        await rm(root, { recursive: true, force: true })
    }
})

test('saved Miaoshou accounts remain available after the active account is cleared', async () => {
    const root = await mkdtemp(join(tmpdir(), 'miaoshou-client-accounts-'))
    try {
        await saveMiaoshouCredentials(root, { account: 'account-1', password: 'first-password' })
        await saveMiaoshouCredentials(root, { account: 'account-2', password: 'second-password' })
        await saveMiaoshouCredentials(root, { account: 'account-1', password: 'updated-password' })
        await clearMiaoshouCredentials(root)
        assert.equal(await loadMiaoshouCredentials(root), null)
        assert.deepEqual((await loadSavedMiaoshouCredentials(root)).map(item => item.account), ['account-1', 'account-2'])
        assert.equal(await activateSavedMiaoshouCredentials(root, 'account-1'), true)
        assert.deepEqual(await loadMiaoshouCredentials(root), { account: 'account-1', password: 'updated-password' })
    } finally { await rm(root, { recursive: true, force: true }) }
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

test('logout does not erase credentials when the Miaoshou browser is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'miaoshou-client-logout-'))
    const previous = process.env.MIAOSHOU_RUNTIME_DIR
    process.env.MIAOSHOU_RUNTIME_DIR = root
    const app = buildApp(async () => 'stopped')
    try {
        await app.inject({ method: 'PUT', url: '/miaoshou-login/credentials',
            payload: { account: 'account-1', password: 'private-password' } })
        const crossSite = await app.inject({ method: 'POST', url: '/miaoshou-login/logout',
            headers: { origin: 'https://example.com' } })
        assert.equal(crossSite.statusCode, 403)
        const logout = await app.inject({ method: 'POST', url: '/miaoshou-login/logout' })
        assert.equal(logout.statusCode, 409)
        const status = await app.inject({ method: 'GET', url: '/miaoshou-login/status' })
        assert.equal(status.json().configuredAccount, 'account-1')
    } finally {
        await app.close()
        if (previous === undefined) delete process.env.MIAOSHOU_RUNTIME_DIR
        else process.env.MIAOSHOU_RUNTIME_DIR = previous
        await rm(root, { recursive: true, force: true })
    }
})
