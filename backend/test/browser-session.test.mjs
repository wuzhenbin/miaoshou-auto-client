import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { chromium } from 'playwright'

test('Chromium restores session cookies after a normal restart', async () => {
    const profile = await mkdtemp(join(tmpdir(), 'miaoshou-client-session-'))
    const server = createServer((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'text/plain' })
        response.end('ok')
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert(address && typeof address !== 'string')
    const url = `http://127.0.0.1:${address.port}/`
    try {
        const first = await chromium.launchPersistentContext(profile, {
            headless: true, channel: 'chromium', args: ['--restore-last-session'],
        })
        try {
            await first.addCookies([{ name: 'login', value: 'session', url, expires: -1 }])
            await first.pages()[0]?.goto(url)
        } finally { await first.close() }

        const second = await chromium.launchPersistentContext(profile, {
            headless: true, channel: 'chromium', args: ['--restore-last-session'],
        })
        try {
            const cookies = await second.cookies(url)
            assert.equal(cookies.find(cookie => cookie.name === 'login')?.value, 'session')
        } finally { await second.close() }
    } finally {
        server.close()
        await rm(profile, { recursive: true, force: true })
    }
})
