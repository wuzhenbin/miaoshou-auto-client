import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'

const clientDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const backendDir = join(clientDir, 'backend')
const frontendDir = join(clientDir, 'frontside')
const runtimeDir = join(homedir(), '.miaoshou-auto', 'client-runtime')
const npmCliCandidates = [
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
]
const npmCli = npmCliCandidates.find(existsSync)

function npm(args, cwd) {
    const command = npmCli ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const result = spawnSync(command, npmCli ? [npmCli, ...args] : args, { cwd, stdio: 'inherit',
        shell: !npmCli && process.platform === 'win32',
        env: { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH || ''}` } })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`npm ${args.join(' ')} 失败 (${result.status})`)
}

function installDependencies(directory) {
    const lock = readFileSync(join(directory, 'package-lock.json'))
    const hash = createHash('sha256').update(lock).digest('hex')
    const stamp = join(runtimeDir, `${directory === backendDir ? 'backend' : 'frontside'}-lock.sha256`)
    if (existsSync(join(directory, 'node_modules')) && existsSync(stamp) && readFileSync(stamp, 'utf8') === hash) return
    npm(['ci'], directory)
    writeFileSync(stamp, hash)
}

function assertPortAvailable(port) {
    return new Promise((done, reject) => {
        const probe = createServer()
        probe.once('error', reject)
        probe.listen(port, '127.0.0.1', () => probe.close(done))
    })
}

async function main() {
    mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })
    installDependencies(backendDir)
    installDependencies(frontendDir)
    const { chromium } = await import(pathToFileURL(join(backendDir, 'node_modules', 'playwright', 'index.mjs')).href)
    if (!existsSync(chromium.executablePath())) npm(['run', 'browser:install'], backendDir)
    npm(['run', 'build'], backendDir)
    npm(['run', 'build'], frontendDir)

    const port = Number(process.env.CLIENT_PORT || 3001)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('CLIENT_PORT 必须是有效端口')
    const url = `http://127.0.0.1:${port}/`
    await assertPortAvailable(port)
    const server = spawn(process.execPath, ['dist/server.js'], {
        cwd: backendDir,
        stdio: 'inherit',
        env: { ...process.env, HOST: '127.0.0.1', PORT: String(port),
            CLIENT_FRONTEND_DIST: join(frontendDir, 'dist') },
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
        if (!ready) throw new Error('本机服务未启动；请检查 3001 端口及上方错误。')
        console.log(`客户端已启动：${url}`)
        if (!process.argv.includes('--no-open')) {
            const opener = process.platform === 'win32' ? 'explorer.exe' : 'open'
            spawn(opener, [url], { detached: true, stdio: 'ignore' }).unref()
        }
        await new Promise((done, reject) => {
            server.once('error', reject)
            server.once('exit', code => stopping || code === 0 ? done() : reject(new Error(`客户端退出 (${code})`)))
        })
    } finally { stop() }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
