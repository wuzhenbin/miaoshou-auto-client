import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repo = fileURLToPath(new URL("../", import.meta.url))
const sha256 = data => createHash("sha256").update(data).digest("hex")

function run(command, args) {
    const result = spawnSync(command, args, {
        cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"],
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} 失败（退出码 ${result.status}）`)
    return result.stdout.trim()
}

function assertRelativePath(path) {
    if (typeof path !== "string" || !path || path.includes("\\") || path.startsWith("/")
        || path.split("/").some(part => !part || part === "." || part === "..")) {
        throw new Error(`部署文件路径不合法：${path}`)
    }
}

async function collect(directory) {
    const base = await lstat(directory)
    if (!base.isDirectory() || base.isSymbolicLink()) throw new Error(`产物目录无效：${directory}`)
    const manifest = JSON.parse(await readFile(join(directory, "deployment-manifest.json"), "utf8"))
    if (manifest.schemaVersion !== "miaoshou-deployment-v1" || !Array.isArray(manifest.files)) {
        throw new Error("打包校验清单无效，请先在源项目执行 npm run package:client")
    }
    const files = []
    const names = new Set()
    for (const record of manifest.files) {
        const relative = record?.path
        assertRelativePath(relative)
        if (names.has(relative) || !/^[a-f0-9]{64}$/.test(record.sha256)
            || !Number.isSafeInteger(record.size) || record.size < 0) throw new Error(`部署清单记录无效：${relative}`)
        names.add(relative)
        const path = join(directory, relative)
        const info = await lstat(path)
        if (info.isSymbolicLink()) throw new Error(`产物不允许符号链接：${relative}`)
        if (!info.isFile()) throw new Error(`部署清单路径不是普通文件：${relative}`)
        const data = await readFile(path)
        files.push({ relative, data, mode: 0o644 })
    }
    return files
}

async function verify(directory, files) {
    const data = await readFile(join(directory, "deployment-manifest.json"))
    const manifest = JSON.parse(data)
    if (manifest.schemaVersion !== "miaoshou-deployment-v1" || !Array.isArray(manifest.files)) throw new Error("打包校验清单无效")
    const records = new Map(manifest.files.map(record => [record.path, record]))
    if (records.size !== manifest.files.length || records.size !== files.length) throw new Error("产物文件数量与打包清单不符")
    for (const file of files) {
        const record = records.get(file.relative)
        if (!record || record.size !== file.data.length || record.sha256 !== sha256(file.data)) throw new Error(`产物校验失败：${file.relative}`)
        if (/^backend\/(?:dist\/.+\.js|poc\/.+\.mjs)$/.test(file.relative) && record.obfuscated !== true) throw new Error(`后端代码缺少混淆记录：${file.relative}`)
        if (/\.(?:js|mjs|css)$/.test(file.relative) && /(?:sourceMappingURL\s*=|sourceURL\s*=)/.test(file.data.toString("utf8"))) throw new Error(`产物含源码映射引用：${file.relative}`)
    }
    return manifest
}

async function sync(source) {
    const targetRoot = await realpath(repo)
    if (await realpath(run("git", ["rev-parse", "--show-toplevel"])) !== targetRoot) throw new Error("客户端仓库目录必须是 Git 仓库根目录")
    const files = await collect(source)
    const manifest = await verify(source, files)
    const packageFile = files.find(file => file.relative === "package.json")
    const packageRecord = manifest.files.find(record => record.path === "package.json")
    const releasePackage = JSON.parse(packageFile.data)
    releasePackage.scripts.sync = "node scripts/sync-client.mjs"
    packageFile.data = Buffer.from(JSON.stringify(releasePackage, null, 2) + "\n")
    packageRecord.size = packageFile.data.length
    packageRecord.sha256 = sha256(packageFile.data)
    const manifestData = Buffer.from(JSON.stringify(manifest, null, 2) + "\n")
    const staging = await mkdtemp(join(dirname(repo), ".miaoshou-client-sync-"))
    try {
        const syncTool = await readFile(join(repo, "scripts/sync-client.mjs"))
        const all = [...files, { relative: "deployment-manifest.json", data: manifestData, mode: 0o644 }]
        if (!files.some(file => file.relative === "scripts/sync-client.mjs")) {
            all.push({ relative: "scripts/sync-client.mjs", data: syncTool, mode: 0o644 })
        }
        for (const file of all) {
            const path = join(staging, file.relative)
            await mkdir(dirname(path), { recursive: true })
            await writeFile(path, file.data, { mode: file.mode })
        }
        for (const entry of await readdir(repo)) {
            if (entry !== ".git") await rm(join(repo, entry), { recursive: true, force: true })
        }
        for (const entry of await readdir(staging)) await rename(join(staging, entry), join(repo, entry))
    } finally {
        await rm(staging, { recursive: true, force: true })
    }
    const branch = run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"])
    if (!branch) throw new Error("客户端仓库需要检出可推送的本地分支")
    run("git", ["remote", "get-url", "origin"])
    run("git", ["add", "-A", "--", "."])
    const changed = spawnSync("git", ["diff", "--cached", "--quiet", "--", "."], { cwd: repo, stdio: "ignore" })
    if (changed.error) throw changed.error
    if (changed.status === 1) run("git", ["commit", "-m", `Publish client build ${sha256(manifestData).slice(0, 12)}`])
    else if (changed.status !== 0) throw new Error(`检查发布变更失败（退出码 ${changed.status}）`)
    run("git", ["push", "-u", "origin", `HEAD:${branch}`])
    console.log(`客户端产物已同步并推送：${branch} ${run("git", ["rev-parse", "--short", "HEAD"])}`)
}

const args = process.argv.slice(2)
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--source")) throw new Error("用法：npm run sync -- [--source <项目根目录、dist 或 native-windows 产物目录>]")
const sourceArg = args[1] ?? "../miaoshou-auto/dist"
const requested = resolve(repo, sourceArg)
const sourceCandidates = sourceArg === "dist"
    ? [join(requested, "native-windows"), requested]
    : sourceArg.endsWith("/dist")
        ? [join(requested, "native-windows"), requested]
        : [requested, join(requested, "dist", "native-windows"), join(requested, "dist")]
let source
for (const candidate of sourceCandidates) {
    try { await lstat(join(candidate, "deployment-manifest.json")); source = candidate; break }
    catch (error) { if (error.code !== "ENOENT") throw error }
}
if (!source) throw new Error(`找不到客户端部署产物清单，请传入项目根目录、dist 或具体产物目录：${sourceArg}`)
await sync(source)
