import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readSizeBrowserState } from '../src/online-browser-operations.ts'
import { invalidateMiaoshouAccountInspection } from '../src/browser-inspection.ts'

test('size browser status repairs an empty managed browser once and verifies login', async () => {
    let connects = 0
    let navigations = 0
    const account = { result: 'success', mobile: '185****3210' }
    const request = { get: async () => ({ status: () => 200, ok: () => true, json: async () => account }) }
    const emptyContext = { pages: () => [], request }
    const repairedPage = { url: () => 'https://erp.91miaoshou.com/', goto: async () => { navigations++ } }
    const repairedContext = { pages: () => [repairedPage], request }
    const browsers = [
        { contexts: () => [emptyContext], close: async () => {} },
        { contexts: () => [repairedContext], close: async () => {} },
    ]
    const connect = async () => ({ browser: browsers[Math.min(connects++, browsers.length - 1)], context: connects === 1 ? emptyContext : repairedContext })

    assert.equal(await readSizeBrowserState(connect, () => true), 'ready')
    assert.equal(navigations, 1)
    assert.equal(connects, 3)
})

test('size browser readiness follows the session without a management page', async () => {
    let account = { result: 'success', mobile: '185****3210' }
    const context = {
        pages: () => [{ url: () => 'https://erp.91miaoshou.com/' }],
        request: { get: async () => ({ status: () => 200, ok: () => true, json: async () => account }) },
    }
    const browser = { contexts: () => [context], close: async () => {} }
    const connect = async () => ({ browser, context })

    assert.equal(await readSizeBrowserState(connect), 'ready')
    account = { result: 'fail' }
    invalidateMiaoshouAccountInspection()
    assert.equal(await readSizeBrowserState(connect), 'waiting_login')
    context.request.get = async () => { throw new Error('network unavailable') }
    invalidateMiaoshouAccountInspection()
    assert.equal(await readSizeBrowserState(connect), 'unknown')
})
