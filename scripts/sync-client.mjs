import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repo = fileURLToPath(new URL("../", import.meta.url))
const managed = [".gitattributes", "README.md", "deployment-manifest.json",
    "run-client.cmd", "run-client.sh", "install-client.cmd", "install-client.ps1", "install-client.sh", "install-client-user.sh", "install-client.mjs",
    "install-client.command", "install-client-mac.sh", "frontside", "backend"]
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

async function assertArtifactPath(path) {
    if (["package.json", "README.md", "deployment-manifest.json", "run-client.cmd", "run-client.sh",
        "install-client.cmd", "install-client.ps1", "install-client.sh", "install-client-user.sh", "install-client.mjs",
        "install-client.command", "install-client-mac.sh"].includes(path)) return
    if (/^frontside\/(?:index\.html|favicon\.ico|icon\.jpg|logo(?:-mark)?\.(?:png|svg))$/.test(path)) return
    if (/^frontside\/assets\/[A-Za-z0-9_./-]+\.(?:js|css|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|mp4|webm)$/.test(path)) return
    if (["backend/package.json", "backend/package-lock.json", "backend/README.md", "backend/.env.example", "backend/config/product-editor.jsonc", "backend/config/category-index.json"].includes(path)) return
    if (/^backend\/(?:dist\/(?:[a-z0-9-]+\/)*[a-z0-9-]+\.js|poc\/.+\.mjs|migrations\/\d{4}_[a-z0-9_]+\.sql)$/.test(path)) return
    throw new Error(`文件不在部署白名单中：${path}`)
}

async function collect(directory) {
    const base = await lstat(directory)
    if (!base.isDirectory() || base.isSymbolicLink()) throw new Error(`产物目录无效：${directory}`)
    const files = []
    async function visit(relative) {
        const path = join(directory, relative)
        const info = await lstat(path)
        if (info.isSymbolicLink()) throw new Error(`产物不允许符号链接：${relative}`)
        if (info.isDirectory()) {
            for (const name of (await readdir(path)).sort()) await visit(`${relative}/${name}`)
        } else if (info.isFile()) {
            await assertArtifactPath(relative)
            files.push({ relative, data: await readFile(path), mode: relative === "install-client.command" ? 0o755 : 0o644 })
        } else throw new Error(`不支持的产物类型：${relative}`)
    }
    for (const name of managed.slice(1).filter(name => name !== "deployment-manifest.json")) await visit(name)
    return files
}

async function verify(directory, files) {
    const data = await readFile(join(directory, "deployment-manifest.json"))
    const manifest = JSON.parse(data)
    if (manifest.schemaVersion !== "miaoshou-deployment-v1" || !Array.isArray(manifest.files)) {
        throw new Error("打包校验清单无效，请先在源项目执行 npm run package:client")
    }
    // package.json belongs to this repository's sync tooling and is intentionally
    // preserved instead of being replaced by the deployment artifact.
    const records = new Map(manifest.files.filter(record => record.path !== "package.json").map(record => [record.path, record]))
    if (records.size !== files.length) throw new Error("产物文件数量与打包清单不符")
    for (const file of files) {
        const record = records.get(file.relative)
        if (!record || record.size !== file.data.length || record.sha256 !== sha256(file.data)) throw new Error(`产物校验失败：${file.relative}`)
        if (/^backend\/(?:dist\/.+\.js|poc\/.+\.mjs)$/.test(file.relative) && record.obfuscated !== true) throw new Error(`后端代码缺少混淆记录：${file.relative}`)
        if (/\.(?:js|mjs|css)$/.test(file.relative) && /(?:sourceMappingURL\s*=|sourceURL\s*=)/.test(file.data.toString("utf8"))) throw new Error(`产物含源码映射引用：${file.relative}`)
    }
    return data
}

async function sync(source) {
    const targetRoot = await realpath(repo)
    if (await realpath(run("git", ["rev-parse", "--show-toplevel"])) !== targetRoot) throw new Error("客户端仓库目录必须是 Git 仓库根目录")
    const files = await collect(source)
    const manifestData = await verify(source, files)
    const staging = await mkdtemp(join(dirname(repo), ".miaoshou-client-sync-"))
    try {
        const all = [...files, { relative: "deployment-manifest.json", data: manifestData, mode: 0o644 },
            { relative: ".gitattributes", data: Buffer.from("* -text\n.gitattributes text eol=lf\n"), mode: 0o644 }]
        for (const file of all) {
            const path = join(staging, file.relative)
            await mkdir(dirname(path), { recursive: true })
            await writeFile(path, file.data, { mode: file.mode })
        }
        for (const name of managed) {
            await rm(join(repo, name), { recursive: true, force: true })
            await rename(join(staging, name), join(repo, name))
        }
    } finally {
        await rm(staging, { recursive: true, force: true })
    }
    const branch = run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"])
    if (!branch) throw new Error("客户端仓库需要检出可推送的本地分支")
    run("git", ["remote", "get-url", "origin"])
    run("git", ["add", "-A", "--", ...managed])
    const changed = spawnSync("git", ["diff", "--cached", "--quiet", "--", ...managed], { cwd: repo, stdio: "ignore" })
    if (changed.error) throw changed.error
    if (changed.status === 1) run("git", ["commit", "-m", `Publish client build ${sha256(manifestData).slice(0, 12)}`])
    else if (changed.status !== 0) throw new Error(`检查发布变更失败（退出码 ${changed.status}）`)
    run("git", ["push", "-u", "origin", `HEAD:${branch}`])
    console.log(`客户端产物已同步并推送：${branch} ${run("git", ["rev-parse", "--short", "HEAD"])}`)
}

const args = process.argv.slice(2)
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--source")) throw new Error("用法：npm run sync -- [--source <项目根目录或 dist 路径>]")
const sourceArg = args[1] ?? "../miaoshou-auto"
const source = resolve(repo, sourceArg === "dist" || sourceArg.endsWith("/dist") ? sourceArg : join(sourceArg, "dist"))
await sync(source)
