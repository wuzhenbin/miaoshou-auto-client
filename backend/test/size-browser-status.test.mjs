import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readSizeBrowserState } from '../src/online-browser-operations.ts'

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
    assert.equal(await readSizeBrowserState(connect), 'waiting_login')
    context.request.get = async () => { throw new Error('network unavailable') }
    assert.equal(await readSizeBrowserState(connect), 'unknown')
})
