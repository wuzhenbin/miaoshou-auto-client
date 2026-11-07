import { spawn, spawnSync } from "node:child_process"
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { chromium } from "playwright"
import type { FastifyInstance } from "fastify"
import { setWindowVisibility } from "./browser-inspection.js"

export type BrowserKind = "sizeTemplate" | "shared"
export type BrowserMode = "visible" | "headless" | "unmanaged" | "stopped"
const settings: Record<BrowserKind, { name: string; port: number; profile: string; log: string; startUrl: string }> = {
    sizeTemplate: { name: "妙手尺码表", port: 9223, profile: "miaoshou-headless", log: "miaoshou-browser.log",
        startUrl: "https://erp.91miaoshou.com/pddkj_choice/move_collect/template_management/sizeChart" },
    shared: { name: "通用自动化", port: 9224, profile: "automation-headless", log: "automation-browser.log",
        startUrl: "https://login.1688.com/member/signin.htm" },
}
const opening = new Set<BrowserKind>()

function runtimeRoot() {
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

async function openVisible(kind: BrowserKind) {
    const setting = settings[kind]
    assertLocalCdp(kind)
    const mode = browserMode(kind)
    if (mode === "visible") {
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
            "--no-first-run", "--no-default-browser-check", "--window-size=1440,900",
            "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
            "--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${setting.port}`,
            setting.startUrl,
        ], { detached: true, stdio: ["ignore", fd, fd] })
    } finally { closeSync(fd) }
    let launchError: Error | null = null
    let exited = false
    child.on("error", error => { launchError = error })
    child.on("exit", () => { exited = true })
    child.unref()
    for (let attempt = 0; attempt < 40; attempt++) {
        await delay(200)
        if (launchError) throw launchError
        if (exited) throw new Error(`浏览器启动后退出，请查看日志：${logPath}`)
        const current = browserMode(kind)
        if (current === "visible") return
        if (current !== "stopped") throw new Error(`端口被其他进程占用，请查看日志：${logPath}`)
    }
    throw new Error(`未确认浏览器窗口启动，请查看日志：${logPath}`)
}

function assertLocalCdp(kind: BrowserKind) {
    const configured = kind === "sizeTemplate" ? process.env.SIZE_TEMPLATE_BROWSER_CDP_URL : process.env.AUTOMATION_BROWSER_CDP_URL
    if (configured && new URL(configured).origin !== `http://127.0.0.1:${settings[kind].port}`)
        throw new Error("当前 CDP 指向其他主机或端口，不能操作本机浏览器窗口")
}

export function registerVisibleBrowserRoutes(app: FastifyInstance) {
    for (const action of ["open-visible", "minimize"] as const) app.post<{ Params: { kind: BrowserKind } }>(`/automation-browsers/:kind/${action}`, async (request, reply) => {
        reply.header("Cache-Control", "no-store")
        const kind = request.params.kind
        if (kind !== "sizeTemplate" && kind !== "shared")
            return reply.code(400).send({ error: { message: "浏览器类型无效" } })
        if (request.body !== undefined || Object.keys(request.query as object).length)
            return reply.code(400).send({ error: { message: "请求参数无效" } })
        if (opening.has(kind)) return reply.code(409).send({ error: { message: "浏览器正在启动" } })
        opening.add(kind)
        try {
            if (action === "open-visible") await openVisible(kind)
            else {
                assertLocalCdp(kind)
                if (browserMode(kind) !== "visible") throw new Error("可见浏览器未运行")
                await setWindowVisibility(kind, "minimized")
            }
            return { kind, mode: "visible", message: `${settings[kind].name}浏览器窗口已${action === "open-visible" ? "打开" : "收起"}` }
        } catch (error) {
            const message = error instanceof Error ? error.message : "浏览器启动失败"
            return reply.code(409).send({ error: { message } })
        } finally { opening.delete(kind) }
    })
}
