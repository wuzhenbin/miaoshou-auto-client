import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
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
        || path.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) {
        throw new Error(`部署文件路径不合法：${path}`)
    }
}

const runtimeFiles = new Set([
    "package.json", "README.md", "run-client.cmd", "run-client.sh", "install-client.cmd", "install-client.ps1", "uninstall-client.cmd", "uninstall-client.ps1", "uninstall-client.sh",
    "install-client.sh", "install-client-user.sh", "install-client.mjs", "install-client.command", "install-client-mac.sh",
    "backend/package.json", "backend/package-lock.json",
    "backend/README.md", "backend/.env.example", "backend/config/product-editor.jsonc",
    "backend/config/category-index.json",
    ...["browser-process", "browser-close", "browser-open",
        "size-template-browser-smoke", "size-template-browser-login", "size-template-browser-prepare"]
        .map(name => `backend/poc/${name}.mjs`),
])

function isBackendJavaScript(path) {
    return /^backend\/(?:dist\/.+\.js|poc\/.+\.mjs)$/.test(path)
}

function assertArtifactPath(path) {
    if (path.split("/").some(part => !part || part === "." || part === "..") || path.includes("\\")) {
        throw new Error(`部署文件路径不合法：${path}`)
    }
    const allowed = runtimeFiles.has(path)
        || /^backend\/dist\/(?:[a-z0-9-]+\/)*[a-z0-9-]+\.js$/.test(path)
        || /^backend\/migrations\/\d{4}_[a-z0-9_]+\.sql$/.test(path)
        || /^frontside\/(?:index\.html|favicon\.ico|icon\.jpg|logo(?:-mark)?\.(?:png|svg))$/.test(path)
        || /^frontside\/assets\/[A-Za-z0-9_./-]+\.(?:js|css|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|mp4|webm)$/.test(path)
    if (!allowed) throw new Error(`文件不在部署白名单中：${path}`)
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
        assertArtifactPath(relative)
        if (names.has(relative) || !/^[a-f0-9]{64}$/.test(record.sha256)
            || !Number.isSafeInteger(record.size) || record.size < 0) throw new Error(`部署清单记录无效：${relative}`)
        names.add(relative)
        const path = join(directory, relative)
        const info = await lstat(path)
        if (info.isSymbolicLink()) throw new Error(`产物不允许符号链接：${relative}`)
        if (!info.isFile()) throw new Error(`部署清单路径不是普通文件：${relative}`)
        const data = await readFile(path)
        files.push({ relative, data, mode: relative === "install-client.command" ? 0o755 : 0o644 })
    }
    for (const required of ["package.json", "run-client.cmd", "install-client.ps1", "frontside/index.html", "backend/dist/server.js"]) {
        if (!names.has(required)) throw new Error(`WSL2 客户端产物缺少 ${required}`)
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
        if (isBackendJavaScript(file.relative) && record.obfuscated !== true) throw new Error(`后端代码缺少混淆记录：${file.relative}`)
        if (/\.(?:js|mjs|css)$/.test(file.relative) && /(?:sourceMappingURL\s*=|sourceURL\s*=)/.test(file.data.toString("utf8"))) throw new Error(`产物含源码映射引用：${file.relative}`)
    }
    return manifest
}

async function sync(source) {
    const targetRoot = await realpath(repo)
    if (await realpath(run("git", ["rev-parse", "--show-toplevel"])) !== targetRoot) throw new Error("客户端仓库目录必须是 Git 仓库根目录")
    if (run("git", ["diff", "--cached", "--name-only"])) throw new Error("请先提交产物仓库已暂存的改动")
    const branch = run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"])
    run("git", ["remote", "get-url", "origin"])
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
        const previous = JSON.parse(await readFile(join(repo, "deployment-manifest.json"), "utf8"))
        const nextPaths = new Set(all.map(file => file.relative))
        for (const { path } of previous.files) {
            assertRelativePath(path)
            assertArtifactPath(path)
            if (!nextPaths.has(path)) await rm(join(repo, path), { force: true })
        }
        for (const file of all) {
            const destination = join(repo, file.relative)
            await mkdir(dirname(destination), { recursive: true })
            await rename(join(staging, file.relative), destination)
        }
        run("git", ["add", "-A", "--", ...new Set([...previous.files.map(file => file.path), ...nextPaths, ".gitattributes"])])
    } finally {
        await rm(staging, { recursive: true, force: true })
    }
    const changed = spawnSync("git", ["diff", "--cached", "--quiet", "--", "."], { cwd: repo, stdio: "ignore" })
    if (changed.error) throw changed.error
    if (changed.status === 1) run("git", ["commit", "-m", `Publish client build ${sha256(manifestData).slice(0, 12)}`])
    else if (changed.status !== 0) throw new Error(`检查发布变更失败（退出码 ${changed.status}）`)
    run("git", ["push", "-u", "origin", `HEAD:${branch}`])
    console.log(`客户端产物已同步并推送：${branch} ${run("git", ["rev-parse", "--short", "HEAD"])}`)
}

const args = process.argv.slice(2)
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--source")) throw new Error("用法：npm run sync -- [--source <项目根目录、dist 或 dist/wsl2 产物目录>]")
const sourceArg = args[1] ?? "../miaoshou-auto/dist"
const requested = resolve(repo, sourceArg)

async function hasManifest(directory) {
    try {
        const info = await lstat(join(directory, "deployment-manifest.json"))
        return info.isFile()
    } catch (error) {
        if (error.code !== "ENOENT") throw error
        return false
    }
}

async function findSource(directory) {
    const directCandidates = ["wsl2", "wsl"]
    if (["wsl2", "wsl"].includes(basename(directory))) return await hasManifest(directory) ? directory : undefined
    for (const relative of directCandidates) {
        const candidate = relative ? join(directory, relative) : directory
        if (await hasManifest(candidate)) return candidate
    }

    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) }
    catch (error) {
        if (error.code === "ENOENT") return undefined
        throw error
    }
    const versionDirectories = entries
        .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
        .map(entry => entry.name)
        .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
    for (const version of versionDirectories) {
        for (const target of directCandidates) {
            const candidate = join(directory, version, target)
            if (await hasManifest(candidate)) return candidate
        }
    }
    return undefined
}

const sourceRoots = sourceArg === "dist" || sourceArg.endsWith("/dist")
    ? [requested]
    : [join(requested, "dist"), requested]
let source
for (const root of sourceRoots) {
    source = await findSource(root)
    if (source) break
}
if (!source) throw new Error(`找不到 WSL 客户端部署产物清单，请传入项目根目录、dist 或 dist/wsl2 产物目录：${sourceArg}`)
await sync(source)
