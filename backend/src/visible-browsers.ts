import { spawn, spawnSync } from "node:child_process"
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { chromium } from "playwright"
import type { FastifyInstance } from "fastify"
import { inspectBrowser, setWindowVisibility } from "./browser-inspection.js"
import { clearMiaoshouSession, restoreMiaoshouSession, saveMiaoshouSession } from "./browser-session.js"

export type BrowserKind = "sizeTemplate" | "shared"
export type BrowserMode = "visible" | "headless" | "unmanaged" | "stopped"
const settings: Record<BrowserKind, { name: string; port: number; profile: string; log: string; startUrl: string }> = {
    sizeTemplate: { name: "妙手尺码表", port: 9223, profile: "miaoshou-headless", log: "miaoshou-browser.log",
        startUrl: "https://erp.91miaoshou.com/pddkj_choice/move_collect/template_management/sizeChart" },
    shared: { name: "通用自动化", port: 9224, profile: "automation-headless", log: "automation-browser.log",
        startUrl: "https://login.1688.com/member/signin.htm" },
}
const opening = new Set<BrowserKind>()
const ownedBrowsers = new Set<number>()
let savingSession = false
let sessionPersistencePaused = false

export async function pauseMiaoshouSessionPersistence() {
    sessionPersistencePaused = true
    for (let attempt = 0; savingSession && attempt < 100; attempt++) await delay(50)
    if (savingSession) {
        sessionPersistencePaused = false
        throw new Error("妙手会话正在保存，请稍后重试退出")
    }
}

export function resumeMiaoshouSessionPersistence() { sessionPersistencePaused = false }

export function runtimeRoot() {
    const root = process.env.MIAOSHOU_RUNTIME_DIR?.trim() || join(homedir(), ".miaoshou-auto")
    if (!isAbsolute(root)) throw new Error("运行数据目录必须为绝对路径")
    return root
}

function listener(port: number) {
    if (process.platform === "win32") {
        const result = spawnSync("netstat.exe", ["-ano", "-p", "TCP"], { encoding: "utf8", timeout: 3000 })
        if (result.error || result.status !== 0) throw new Error("无法检查浏览器端口占用")
        return [...new Set(result.stdout.split(/\r?\n/).map(line => {
            const columns = line.trim().split(/\s+/)
            return columns[0] === "TCP" && columns[1]?.endsWith(`:${port}`) && columns[3] === "LISTENING"
                ? columns[4] : null
        }).filter((pid): pid is string => Boolean(pid && /^\d+$/.test(pid))))]
    }
    const result = spawnSync("lsof", ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8", timeout: 3000 })
    if (result.error) throw new Error("无法检查浏览器端口占用")
    return result.status === 0 ? [...new Set(result.stdout.trim().split(/\s+/).filter(Boolean))] : []
}

export function browserMode(kind: BrowserKind): BrowserMode {
    const setting = settings[kind]
    const pids = listener(setting.port)
    if (!pids.length) return "stopped"
    if (pids.length !== 1) return "unmanaged"
    const result = process.platform === "win32"
        ? spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
            `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pids[0]}').CommandLine`], { encoding: "utf8", timeout: 3000 })
        : spawnSync("ps", ["-ww", "-p", pids[0]!, "-o", "command="], { encoding: "utf8", timeout: 3000 })
    if (result.error || result.status !== 0) return "unmanaged"
    const command = result.stdout
    const profile = join(runtimeRoot(), "browser-profiles", setting.profile)
    if (!command.includes(`--user-data-dir=${profile}`)
        || !new RegExp(`(?:^| )--remote-debugging-port=${setting.port}(?: |$)`).test(command.trim())) return "unmanaged"
    return /(?:^| )--headless(?:=\S+)?(?: |$)/.test(command) ? "headless" : "visible"
}

async function openBrowser(kind: BrowserKind, headless = false) {
    const setting = settings[kind]
    assertLocalCdp(kind)
    const mode = browserMode(kind)
    if (mode === "headless" && headless) return
    if (mode === "visible" && !headless) {
        await setWindowVisibility(kind, "open")
        return
    }
    if (mode !== "stopped") throw new Error(mode === "headless" ? "无头浏览器仍在运行，请先结束任务并关闭该实例"
        : "浏览器端口已被其他进程占用")
    const executable = chromium.executablePath()
    if (!existsSync(executable)) throw new Error("Chromium 尚未安装，请在客户端仓库的 backend/ 执行 npm run browser:install")
    const root = runtimeRoot()
    const logDir = join(root, "logs")
    mkdirSync(logDir, { recursive: true, mode: 0o700 })
    const logPath = join(logDir, setting.log)
    const fd = openSync(logPath, "a", 0o600)
    let child
    try {
        child = spawn(executable, [
            `--user-data-dir=${join(root, "browser-profiles", setting.profile)}`,
            "--no-first-run", "--no-default-browser-check", ...(kind === "shared" ? ["--restore-last-session"] : []),
            "--window-size=1440,900", ...(headless ? ["--headless=new"] : []),
            "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
            "--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${setting.port}`,
            kind === "sizeTemplate" || headless ? "about:blank" : setting.startUrl,
        ], { detached: true, stdio: ["ignore", fd, fd] })
    } finally { closeSync(fd) }
    let launchError: Error | null = null
    let exited = false
    child.on("error", error => { launchError = error })
    child.on("exit", () => { exited = true; if (child.pid) ownedBrowsers.delete(child.pid) })
    child.unref()
    if (child.pid) ownedBrowsers.add(child.pid)
    for (let attempt = 0; attempt < 40; attempt++) {
        await delay(200)
        if (launchError) throw launchError
        if (exited) throw new Error(`浏览器启动后退出，请查看日志：${logPath}`)
        const current = browserMode(kind)
        if (current === (headless ? "headless" : "visible")) {
            if (kind === "sizeTemplate") {
                const browser = await chromium.connectOverCDP(`http://127.0.0.1:${setting.port}`)
                try {
                    const context = browser.contexts()[0]
                    if (context) {
                        await restoreMiaoshouSession(root, context).catch(() => false)
                        const page = context.pages()[0] ?? await context.newPage()
                        await page.goto(setting.startUrl, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {})
                    }
                } finally { await browser.close() }
            }
            return
        }
        if (current !== "stopped") throw new Error(`端口被其他进程占用，请查看日志：${logPath}`)
    }
    throw new Error(`未确认浏览器窗口启动，请查看日志：${logPath}`)
}

export async function closeOwnedBrowsers() {
    for (const kind of ["sizeTemplate", "shared"] as const) {
        const pids = listener(settings[kind].port)
        if (!pids.some(pid => ownedBrowsers.has(Number(pid)))) continue
        const browser = await chromium.connectOverCDP(`http://127.0.0.1:${settings[kind].port}`, { timeout: 3000 }).catch(() => null)
        if (!browser) continue
        try {
            const cdp = await browser.newBrowserCDPSession()
            await cdp.send("Browser.close")
        } catch { /* The browser may already have exited. */ }
    }
    ownedBrowsers.clear()
}

function assertLocalCdp(kind: BrowserKind) {
    const configured = kind === "sizeTemplate" ? process.env.SIZE_TEMPLATE_BROWSER_CDP_URL : process.env.AUTOMATION_BROWSER_CDP_URL
    if (configured && new URL(configured).origin !== `http://127.0.0.1:${settings[kind].port}`)
        throw new Error("当前 CDP 指向其他主机或端口，不能操作本机浏览器窗口")
}

export function registerVisibleBrowserRoutes(app: FastifyInstance) {
    const sessionTimer = setInterval(() => {
        if (sessionPersistencePaused || savingSession || opening.has("sizeTemplate")) return
        savingSession = true
        void (async () => {
            if (!["visible", "headless"].includes(browserMode("sizeTemplate"))) return
            const inspection = await inspectBrowser("sizeTemplate")
            if (inspection.session.state === "not_logged_in") {
                await clearMiaoshouSession(runtimeRoot())
            } else if (inspection.session.state === "logged_in") {
                const browser = await chromium.connectOverCDP("http://127.0.0.1:9223", { timeout: 3000 })
                try {
                    const context = browser.contexts()[0]
                    if (context) await saveMiaoshouSession(runtimeRoot(), context)
                } finally { await browser.close() }
            }
        })().catch(error => app.log.warn({ error }, "妙手浏览器会话保存失败"))
            .finally(() => { savingSession = false })
    }, 2000)
    sessionTimer.unref()
    app.addHook("onClose", async () => { clearInterval(sessionTimer) })
    app.addHook("onClose", closeOwnedBrowsers)
    for (const action of ["open-visible", "start-headless", "minimize"] as const) app.post<{ Params: { kind: BrowserKind } }>(`/automation-browsers/:kind/${action}`, async (request, reply) => {
        reply.header("Cache-Control", "no-store")
        const kind = request.params.kind
        if (kind !== "sizeTemplate" && kind !== "shared")
            return reply.code(400).send({ error: { message: "浏览器类型无效" } })
        if (request.body !== undefined || Object.keys(request.query as object).length)
            return reply.code(400).send({ error: { message: "请求参数无效" } })
        if (opening.has(kind)) return reply.code(409).send({ error: { message: "浏览器正在启动" } })
        opening.add(kind)
        try {
            if (action === "open-visible" || action === "start-headless") await openBrowser(kind, action === "start-headless")
            else {
                assertLocalCdp(kind)
                if (browserMode(kind) !== "visible") throw new Error("可见浏览器未运行")
                await setWindowVisibility(kind, "minimized")
            }
            return { kind, mode: action === "start-headless" ? "headless" : "visible",
                message: `${settings[kind].name}浏览器${action === "start-headless" ? "已启动" : action === "open-visible" ? "窗口已打开" : "窗口已收起"}` }
        } catch (error) {
            const message = error instanceof Error ? error.message : "浏览器启动失败"
            return reply.code(409).send({ error: { message } })
        } finally { opening.delete(kind) }
    })
}
