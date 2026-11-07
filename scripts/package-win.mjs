import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const clientDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const backendDir = join(clientDir, 'backend')
const frontendDir = join(clientDir, 'frontside')
const nodeVersion = '22.19.0'
const packageName = 'miaoshou-client-win-x64'
const releaseDir = join(clientDir, 'release')

function run(command, args, options = {}) {
    console.log(`> ${basename(command)} ${args.join(' ')}`)
    execFileSync(command, args, { stdio: 'inherit', ...options })
}

async function download(url, path) {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`下载失败 (${response.status}): ${url}`)
    writeFileSync(path, Buffer.from(await response.arrayBuffer()))
}

function sha256(path) {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function filesUnder(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const path = join(dir, entry.name)
        return entry.isDirectory() ? filesUnder(path) : entry.isFile() ? [path] : []
    })
}

async function main() {
    const work = mkdtempSync(join(tmpdir(), 'miaoshou-win-package-'))
    const stage = join(work, packageName)
    try {
        const backendStage = join(stage, 'backend')
        const runtimeStage = join(stage, 'runtime')
        mkdirSync(backendStage, { recursive: true })
        mkdirSync(runtimeStage, { recursive: true })

        run(process.execPath, [join(backendDir, 'node_modules', 'typescript', 'bin', 'tsc'),
            '--project', join(backendDir, 'tsconfig.json'), '--outDir', join(backendStage, 'dist')])
        run('npm', ['run', 'build'], { cwd: frontendDir })
        cpSync(join(frontendDir, 'dist'), join(stage, 'frontside'), { recursive: true })
        cpSync(join(backendDir, 'package.json'), join(backendStage, 'package.json'))
        cpSync(join(backendDir, 'package-lock.json'), join(backendStage, 'package-lock.json'))
        run('npm', ['ci', '--omit=dev', '--ignore-scripts'], { cwd: backendStage })

        const nodeArchiveName = `node-v${nodeVersion}-win-x64.zip`
        const nodeArchive = join(work, nodeArchiveName)
        const nodeBase = `https://nodejs.org/dist/v${nodeVersion}`
        const hashList = join(work, 'SHASUMS256.txt')
        await download(`${nodeBase}/SHASUMS256.txt`, hashList)
        await download(`${nodeBase}/${nodeArchiveName}`, nodeArchive)
        const expected = readFileSync(hashList, 'utf8').split(/\r?\n/)
            .map(line => line.trim().split(/\s+/)).find(parts => parts[1] === nodeArchiveName)?.[0]
        if (!expected || sha256(nodeArchive) !== expected) throw new Error('Windows Node 下载校验失败')
        run('unzip', ['-q', '-j', nodeArchive, `node-v${nodeVersion}-win-x64/node.exe`,
            `node-v${nodeVersion}-win-x64/LICENSE`, '-d', runtimeStage])

        const browserEnv = { ...process.env, PLAYWRIGHT_HOST_PLATFORM_OVERRIDE: 'win64', PLAYWRIGHT_BROWSERS_PATH: '0' }
        run(process.execPath, [join(backendStage, 'node_modules', 'playwright', 'cli.js'),
            'install', 'chromium', '--no-shell'], { cwd: backendStage, env: browserEnv })
        const browserPath = join(backendStage, 'node_modules', 'playwright-core', '.local-browsers',
            'chromium-1248', 'chrome-win64', 'chrome.exe')
        if (!existsSync(browserPath)) throw new Error('Windows Chromium 可执行文件缺失')

        cpSync(join(clientDir, 'scripts', 'start-release.mjs'), join(stage, 'launcher.mjs'))
        writeFileSync(join(stage, 'start.cmd'), readFileSync(join(clientDir, 'scripts', 'start-release.cmd'), 'utf8').replace(/\r?\n/g, '\r\n'))
        cpSync(join(clientDir, 'scripts', 'release-readme.txt'), join(stage, 'README.txt'))
        const forbidden = ['backend/src/', 'frontside/src/', '.ts', '.tsx', '.map']
        const firstParty = filesUnder(stage).map(path => relative(stage, path).replaceAll('\\', '/'))
            .filter(path => !path.startsWith('backend/node_modules/'))
        if (firstParty.some(path => forbidden.some(part => path.includes(part))))
            throw new Error('发布包包含第一方源码或 source map')
        const manifest = filesUnder(stage).map(path => `${sha256(path)}  ${relative(stage, path).replaceAll('\\', '/')}`)
        writeFileSync(join(stage, 'SHA256SUMS.txt'), `${manifest.sort().join('\n')}\n`)

        mkdirSync(releaseDir, { recursive: true })
        const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
        const archive = join(releaseDir, `${packageName}-${timestamp}.zip`)
        run('zip', ['-q', '-r', archive, packageName], { cwd: work })
        writeFileSync(`${archive}.sha256`, `${sha256(archive)}  ${basename(archive)}\n`)
        console.log(`Windows 发布包：${archive}`)
        console.log(`SHA-256：${sha256(archive)}`)
    } finally { rmSync(work, { recursive: true, force: true }) }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
