import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { chromium } from 'playwright'
import { clearMiaoshouSession, restoreMiaoshouSession, saveMiaoshouSession } from '../src/browser-session.ts'

async function launch(profile, url) {
    await rm(join(profile, 'DevToolsActivePort'), { force: true })
    const child = spawn(chromium.executablePath(), [
        `--user-data-dir=${profile}`, '--headless=new', '--no-first-run', '--no-default-browser-check',
        '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', url,
    ], { stdio: 'ignore' })
    try {
        let port
        for (let attempt = 0; attempt < 50; attempt++) {
            if (child.exitCode !== null) throw new Error('Chromium exited before CDP was ready')
            try {
                port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0])
                break
            } catch { await delay(100) }
        }
        if (!port) throw new Error('Chromium CDP did not start')
        return { child, browser: await chromium.connectOverCDP(`http://127.0.0.1:${port}`) }
    } catch (error) {
        child.kill()
        throw error
    }
}

test('client restores Miaoshou session cookies after Chromium closes', async () => {
    const profile = await mkdtemp(join(tmpdir(), 'miaoshou-client-session-'))
    const sessionRoot = await mkdtemp(join(tmpdir(), 'miaoshou-client-store-'))
    const url = 'about:blank'
    const cookieUrl = 'https://erp.91miaoshou.com/'
    let running
    try {
        running = await launch(profile, url)
        const context = running.browser.contexts()[0]
        await context.addCookies([{ name: 'login', value: 'session', url: cookieUrl, expires: -1 }])
        await saveMiaoshouSession(sessionRoot, context)
        const saved = await readFile(join(sessionRoot, 'browser-sessions', 'miaoshou.json'), 'utf8')
        assert.equal(saved.includes('session'), false)
        const cdp = await running.browser.newBrowserCDPSession()
        await cdp.send('Browser.close')
        if (running.child.exitCode === null) await once(running.child, 'exit')

        running = await launch(profile, url)
        await restoreMiaoshouSession(sessionRoot, running.browser.contexts()[0])
        const cookies = await running.browser.contexts()[0].cookies(cookieUrl)
        assert.equal(cookies.find(cookie => cookie.name === 'login')?.value, 'session')
        await clearMiaoshouSession(sessionRoot)
        assert.equal(await restoreMiaoshouSession(sessionRoot, running.browser.contexts()[0]), false)
    } finally {
        if (running?.child.exitCode === null) {
            running.child.kill()
            await once(running.child, 'exit')
        }
        await rm(profile, { recursive: true, force: true })
        await rm(sessionRoot, { recursive: true, force: true })
    }
})
