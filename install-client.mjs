import { createHash, randomBytes } from "node:crypto"
import { createInterface } from "node:readline/promises"
import { stdin, stdout } from "node:process"
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

const hash = data => createHash("sha256").update(data).digest("hex")
const defaultServerUrl = "https://103.112.1.161/"
const required = ["CLIENT_LOGIN_TOKEN", "SERVER_MODEL_READ_TOKEN", "SERVER_MODEL_DATA_KEY",
    "OSS_BUCKET", "OSS_REGION", "OSS_ACCESS_KEY_ID", "OSS_ACCESS_KEY_SECRET"]
const runtimeFiles = new Set(["package.json", "README.md", "run-client.cmd", "run-client.sh", "install-client.cmd", "install-client.ps1",
    "install-client.sh", "install-client-user.sh", "install-client.mjs", "install-client.command", "install-client-mac.sh",
    "backend/package.json", "backend/package-lock.json", "backend/README.md", "backend/.env.example",
    "backend/config/product-editor.jsonc", "backend/config/category-index.json",
    ...["browser-process", "browser-close", "browser-open", "size-template-browser-smoke",
        "size-template-browser-login", "size-template-browser-prepare"].map(name => `backend/poc/${name}.mjs`)])
function allowedPath(path) {
    return runtimeFiles.has(path)
        || /^backend\/dist\/(?:[a-z0-9-]+\/)*[a-z0-9-]+\.js$/.test(path)
        || /^backend\/migrations\/\d{4}_[a-z0-9_]+\.sql$/.test(path)
        || /^frontside\/(?:index\.html|favicon\.ico|icon\.jpg|logo\.(?:png|svg))$/.test(path)
        || /^frontside\/assets\/[A-Za-z0-9_./-]+\.(?:js|css|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|mp4|webm)$/.test(path)
}

async function checkedFiles(directory) {
    const manifestData = await readFile(join(directory, "deployment-manifest.json"))
    const manifest = JSON.parse(manifestData.toString("utf8"))
    if (manifest.schemaVersion !== "miaoshou-deployment-v1" || !Array.isArray(manifest.files)) throw new Error("Invalid release manifest")
    const names = new Set()
    for (const record of manifest.files) {
        if (typeof record.path !== "string" || !allowedPath(record.path)
            || record.path.split("/").some(part => !part || part === "." || part === "..")
            || names.has(record.path) || !/^[a-f0-9]{64}$/.test(record.sha256)
            || !Number.isSafeInteger(record.size) || record.size < 0) throw new Error("Invalid release path or checksum")
        names.add(record.path)
        const path = join(directory, record.path)
        const info = await lstat(path)
        if (!info.isFile() || info.isSymbolicLink() || info.size !== record.size
            || hash(await readFile(path)) !== record.sha256) throw new Error(`Release file failed verification: ${record.path}`)
    }
    return { files: manifest.files, manifestData }
}

async function prepare(source, destination) {
    const { files, manifestData } = await checkedFiles(source)
    try {
        const existing = await lstat(destination)
        if (!existing.isDirectory() || existing.isSymbolicLink()
            || hash((await checkedFiles(destination)).manifestData) !== hash(manifestData)) throw new Error("Existing release differs from verified package")
        return
    } catch (error) { if (error.code !== "ENOENT") throw error }
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    const staging = await mkdtemp(join(dirname(destination), ".client-install-"))
    try {
        for (const record of files) {
            const path = join(staging, record.path)
            await mkdir(dirname(path), { recursive: true })
            await writeFile(path, await readFile(join(source, record.path)), { mode: 0o644 })
        }
        await writeFile(join(staging, "deployment-manifest.json"), manifestData, { mode: 0o644 })
        await checkedFiles(staging)
        await rename(staging, destination)
    } finally { await rm(staging, { recursive: true, force: true }) }
}

function validServerUrl(value) {
    const url = new URL(value.trim())
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/"
        || url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))
        throw new Error("Use the HTTPS management center root URL")
    return url.origin
}

async function configure(path, serverUrlOverride) {
    try { await lstat(path); console.log("Existing private client configuration retained."); return }
    catch (error) { if (error.code !== "ENOENT") throw error }
    const serverUrl = validServerUrl(serverUrlOverride ?? defaultServerUrl)
    const reader = createInterface({ input: stdin, output: stdout })
    let code
    try {
        code = (await reader.question("One-time pairing code: ")).trim()
    } finally { reader.close() }
    if (!/^[A-Za-z0-9_-]{16}$/.test(code)) throw new Error("Invalid pairing code")
    const response = await fetch(`${serverUrl}/api/client/bootstrap/redeem`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }), signal: AbortSignal.timeout(15000),
    })
    const body = await response.json().catch(() => null)
    if (!response.ok) throw new Error(body?.error?.message ?? `Pairing failed (HTTP ${response.status})`)
    const values = body?.config
    if (!values || required.some(name => typeof values[name] !== "string" || !values[name]
        || /[\r\n]/.test(values[name])) || !/^[a-f0-9]{64}$/i.test(values.SERVER_MODEL_DATA_KEY))
        throw new Error("Pairing response is incomplete")
    const dbPassword = randomBytes(24).toString("hex")
    const config = { ACCOUNT_DATABASE_ADMIN_URL: `postgresql://miaoshou_client:${dbPassword}@127.0.0.1:5432/postgres`,
        MIAOSHOU_SERVER_CONFIG_URL: serverUrl, ...Object.fromEntries(required.map(name => [name, values[name]])) }
    const lines = Object.entries(config).map(([name, value]) => `${name}=${JSON.stringify(value)}`).join("\n") + "\n"
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${process.pid}.tmp`
    try { await writeFile(temporary, lines, { mode: 0o600 }); await rename(temporary, path) }
    finally { await rm(temporary, { force: true }) }
    console.log("Client configuration saved locally.")
}

async function databasePassword(path) {
    const source = await readFile(path, "utf8")
    const value = source.match(/^ACCOUNT_DATABASE_ADMIN_URL="([^"]+)"$/m)?.[1]
    const password = value && new URL(value).password
    if (!password || !/^[a-f0-9]{48}$/.test(password)) throw new Error("Invalid local database configuration")
    stdout.write(password)
}

const [action, first, second] = process.argv.slice(2)
if (action === "prepare" && first && second) await prepare(resolve(first), resolve(second))
else if (action === "configure" && first) await configure(resolve(first), second)
else if (action === "db-password" && first) await databasePassword(resolve(first))
else throw new Error("Usage: install-client.mjs prepare <source> <release> | configure <private-env> [server-url] | db-password <private-env>")
