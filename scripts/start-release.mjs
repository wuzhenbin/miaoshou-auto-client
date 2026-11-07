import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'

const root = dirname(fileURLToPath(import.meta.url))
const port = 3001
const url = `http://127.0.0.1:${port}/`

function portAvailable() {
    return new Promise((done, reject) => {
        const probe = createServer()
        probe.once('error', reject)
        probe.listen(port, '127.0.0.1', () => probe.close(done))
    })
}

async function main() {
    await portAvailable()
    const server = spawn(join(root, 'runtime', 'node.exe'), [join(root, 'backend', 'dist', 'server.js')], {
        cwd: join(root, 'backend'), stdio: 'inherit', env: { ...process.env,
            HOST: '127.0.0.1', PORT: String(port),
            CLIENT_FRONTEND_DIST: join(root, 'frontside'), PLAYWRIGHT_BROWSERS_PATH: '0' },
    })
    let stopping = false
    const stop = () => { stopping = true; if (!server.killed) server.kill() }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
    try {
        let ready = false
        for (let attempt = 0; attempt < 50; attempt++) {
            if (server.exitCode !== null) break
            try {
                const response = await fetch(`${url}health`, { signal: AbortSignal.timeout(500) })
                if (response.ok) { ready = true; break }
            } catch { /* The service may still be starting. */ }
            await new Promise(done => setTimeout(done, 200))
        }
        if (!ready) throw new Error('客户端未启动，请检查 3001 端口和上方错误。')
        console.log(`客户端已启动：${url}`)
        spawn('explorer.exe', [url], { detached: true, stdio: 'ignore' }).unref()
        await new Promise((done, reject) => {
            server.once('error', reject)
            server.once('exit', code => stopping || code === 0 ? done() : reject(new Error(`客户端退出 (${code})`)))
        })
    } finally { stop() }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
