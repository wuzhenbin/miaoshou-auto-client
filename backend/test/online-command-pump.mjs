import assert from 'node:assert/strict'
import { createOnlineCommandPump } from '../src/online-command-pump.ts'

const queued = Array.from({ length: 5 }, (_, index) => ({ id: String(index), type: 'size_template_create' }))
queued.splice(4, 0, { id: 'browser', type: 'browser_status' })
const active = new Map(), finished = []
let limit = 3, peak = 0
const store = {
    next: () => queued[0] ?? null,
    start(id) { assert.equal(queued.shift()?.id, id); return true },
    finish(result) { finished.push(result.id) },
}
const tick = () => new Promise(resolve => setImmediate(resolve))
const pump = createOnlineCommandPump(store, command => new Promise(resolve => {
    active.set(command.id, () => { active.delete(command.id); resolve({ type: 'online_result', id: command.id, ok: true }) })
    peak = Math.max(peak, active.size)
}), async () => {}, () => true, () => limit)

pump()
await tick()
assert.deepEqual([...active.keys()], ['0', '1', '2'])
assert.equal(peak, 3)
limit = 1
active.get('0')()
await tick()
assert.deepEqual([...active.keys()], ['1', '2'])
active.get('1')()
await tick()
assert.deepEqual([...active.keys()], ['2'])
active.get('2')()
await tick()
assert.deepEqual([...active.keys()], ['3'])
limit = 3
pump()
await tick()
assert.deepEqual([...active.keys()], ['3'])
active.get('3')()
await tick()
assert.deepEqual([...active.keys()], ['browser'])
active.get('browser')()
await tick()
assert.deepEqual([...active.keys()], ['4'])
active.get('4')()
await tick()
assert.deepEqual(finished, ['0', '1', '2', '3', 'browser', '4'])
console.log('PASS online command pump: three size commands, dynamic reduction, exclusive browser command')
