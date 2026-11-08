import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openSizeTemplateManagementPage } from '../src/visible-browsers.ts'
import { managementUrl } from '../src/size-template-test-fill.ts'

test('existing management tab is focused without navigation or another tab', async () => {
    let focused = 0
    const page = {
        url: () => `${managementUrl}?tab=all`,
        bringToFront: async () => { focused++ },
        goto: () => { throw new Error('existing form must not reload') },
    }
    const context = { pages: () => [page], newPage: () => { throw new Error('another tab must not open') } }
    await openSizeTemplateManagementPage(context)
    await openSizeTemplateManagementPage(context)
    assert.equal(focused, 2)
})

test('a new management tab opens without navigating the login tab', async () => {
    const visited = []
    let focused = 0
    const login = { url: () => 'https://erp.91miaoshou.com/', goto: () => { throw new Error('login tab changed') } }
    const page = {
        url: () => 'about:blank',
        goto: async (...args) => { visited.push(args) },
        bringToFront: async () => { focused++ },
    }
    let created = 0
    const context = { pages: () => [login], newPage: async () => { created++; return page } }
    await openSizeTemplateManagementPage(context)
    assert.equal(created, 1)
    assert.deepEqual(visited, [[managementUrl, { waitUntil: 'commit', timeout: 60_000 }]])
    assert.equal(focused, 1)
})

test('failed navigation closes only the new tab', async () => {
    let closed = 0
    const context = { pages: () => [], newPage: async () => ({
        goto: async () => { throw new Error('navigation failed') },
        close: async () => { closed++ },
    }) }
    await assert.rejects(openSizeTemplateManagementPage(context), /navigation failed/)
    assert.equal(closed, 1)
})
