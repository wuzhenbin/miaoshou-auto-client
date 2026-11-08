import assert from 'node:assert/strict'
import { test } from 'node:test'
import { invalidateMiaoshouAccountInspection, readMiaoshouSession } from '../src/browser-inspection.ts'

test('concurrent Miaoshou inspections share one account request', async () => {
    invalidateMiaoshouAccountInspection()
    let calls = 0
    const browser = { contexts: () => [{ request: { get: async () => {
        calls++
        await new Promise(resolve => setTimeout(resolve, 10))
        return { status: () => 200, ok: () => true,
            json: async () => ({ result: 'success', mobile: '185****3210' }) }
    } } }] }
    const sessions = await Promise.all(Array.from({ length: 5 }, () => readMiaoshouSession(browser)))
    assert.equal(calls, 1)
    assert.deepEqual(sessions, Array(5).fill({ state: 'logged_in', account: '185****3210' }))
    assert.equal((await readMiaoshouSession(browser)).state, 'logged_in')
    assert.equal(calls, 1)
})

test('rate limit is unknown while a normal rejected session is signed out', async () => {
    invalidateMiaoshouAccountInspection()
    let reason = '请求太频繁'
    const browser = { contexts: () => [{ request: { get: async () => ({
        status: () => 200, ok: () => true, json: async () => ({ result: 'fail', reason }),
    }) } }] }
    assert.equal((await readMiaoshouSession(browser)).state, 'unknown')
    invalidateMiaoshouAccountInspection()
    reason = '未登录'
    assert.equal((await readMiaoshouSession(browser)).state, 'not_logged_in')
})
