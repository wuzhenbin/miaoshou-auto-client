import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'

const root = dirname(fileURLToPath(import.meta.url))
const config = join(homedir(), '.miaoshou-auto', 'client-runtime', 'client.env')
const port = 3001
const url = `http://127.0.0.1:${port}/`

function portAvailable() {
    return new Promise((done, reject) => {
        const probe = createServer()
        probe.once('error', reject)
        probe.listen(port, '127.0.0.1', () => probe.close(done))
    })
}

function openConfig() {
    const result = spawnSync('notepad.exe', [config], { stdio: 'inherit' })
    if (result.error) throw new Error(`无法打开配置文件：${result.error.message}`)
}

async function main() {
    if (!existsSync(config)) {
        mkdirSync(dirname(config), { recursive: true, mode: 0o700 })
        writeFileSync(config, '# 填写对应账号的业务 API 地址，然后重新双击 start.cmd\nBUSINESS_BACKEND_URL=\n# BUSINESS_BACKEND_BASIC_USERNAME=\n# BUSINESS_BACKEND_BASIC_PASSWORD=\n', { mode: 0o600 })
        console.log(`首次运行：请编辑 ${config}，填写 BUSINESS_BACKEND_URL 后重新启动。`)
        openConfig()
        return
    }
    process.loadEnvFile(config)
    const backendUrl = process.env.BUSINESS_BACKEND_URL?.trim()
    if (!backendUrl || !/^https?:\/\//.test(backendUrl)) {
        console.log(`请在 ${config} 填写有效的 BUSINESS_BACKEND_URL 后重新启动。`)
        openConfig()
        return
    }
    await portAvailable()
    const server = spawn(join(root, 'runtime', 'node.exe'), [join(root, 'backend', 'dist', 'server.js')], {
        cwd: join(root, 'backend'), stdio: 'inherit', env: { ...process.env,
            HOST: '127.0.0.1', PORT: String(port), DOTENV_CONFIG_PATH: config,
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
