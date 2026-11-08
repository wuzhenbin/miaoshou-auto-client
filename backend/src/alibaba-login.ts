import { chromium, type Browser, type Frame, type Page } from "playwright"
import { connectOverCdp } from "./cdp-connection.js"
import type { FastifyInstance } from "fastify"
import { browserMode } from "./visible-browsers.js"

type Phase = "idle" | "opening" | "waiting_scan" | "scanned" | "verification_required" | "signed_in" | "expired" | "failed"
type LoginStatus = { phase: Phase; message: string; qrAvailable: boolean; smsRetryAfterSeconds: number }
const loginUrl = "https://login.1688.com/member/signin.htm"
let browser: Browser | null = null
let page: Page | null = null
let opening = false
let smsBusy = false
let smsRequestedAt = 0

function result(phase: Phase, message: string, qrAvailable = false): LoginStatus {
    return { phase, message, qrAvailable, smsRetryAfterSeconds: phase === "verification_required"
        ? Math.max(0, Math.ceil((smsRequestedAt + 60000 - Date.now()) / 1000)) : 0 }
}

async function status(): Promise<LoginStatus> {
    if (opening) return result("opening", "正在打开扫码登录页")
    if (!page || page.isClosed() || !browser?.isConnected()) return result("idle", "尚未开始扫码登录")
    try {
        const url = new URL(page.url())
        if (url.hostname === "login.taobao.com" && url.pathname.includes("/login_unusual.htm"))
            return result("verification_required", "需要短信身份验证")
        if (url.hostname === "login.taobao.com" || url.hostname === "login.1688.com") {
            const text = await page.locator("body").innerText({ timeout: 3000 })
            if (/二维码(?:已失效|已过期)|二维码失效/.test(text)) return result("expired", "二维码已过期，请刷新")
            if (/扫码成功|请在手机上确认登录/.test(text)) return result("scanned", "已扫码，请在手机上确认")
            const qrAvailable = await page.locator("#qrcode-img canvas").isVisible().catch(() => false)
            return result("waiting_scan", qrAvailable ? "请用 1688 或淘宝 App 扫码" : "正在加载二维码", qrAvailable)
        }
        if ((url.hostname === "1688.com" || url.hostname.endsWith(".1688.com"))
            && !url.pathname.includes("_____tmd_____") && !url.pathname.includes("/punish"))
            return result("signed_in", "1688 已登录")
        return result("failed", "登录状态无法确认，请刷新二维码")
    } catch { return result("failed", "扫码页面状态暂不可读") }
}

async function start() {
    if (opening) return status()
    if (browserMode("shared") !== "headless") throw new Error("请先启动通用无头浏览器")
    opening = true
    try {
        await page?.close().catch(() => {})
        if (!browser?.isConnected()) browser = await connectOverCdp("http://127.0.0.1:9224")
        const context = browser.contexts()[0]
        if (!context) throw new Error("通用浏览器缺少默认会话")
        page = await context.newPage()
        await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 30000 })
        if (new URL(page.url()).hostname === "login.taobao.com")
            await page.locator("#qrcode-img canvas").waitFor({ state: "visible", timeout: 15000 })
        smsRequestedAt = 0
    } finally { opening = false }
    return status()
}

function verificationFrame(): Frame {
    if (!page || page.isClosed() || !page.url().includes("/login_unusual.htm"))
        throw new Error("当前未处于短信身份验证页")
    const frame = page.frames().find(candidate => {
        try { const url = new URL(candidate.url()); return url.hostname === "passport.taobao.com" && url.pathname === "/iv/identity_verify.htm" }
        catch { return false }
    })
    if (!frame) throw new Error("短信验证表单尚未加载")
    return frame
}

async function requestSms() {
    if (smsBusy) throw new Error("身份验证操作进行中")
    if (Date.now() < smsRequestedAt + 60000) throw new Error("请稍后再获取短信验证码")
    smsBusy = true
    try {
        await verificationFrame().locator("#J_GetCode").click({ timeout: 5000 })
        smsRequestedAt = Date.now()
        return status()
    } finally { smsBusy = false }
}

async function submitSms(code: string) {
    if (!/^\d{4,8}$/.test(code)) throw new Error("请输入有效的短信验证码")
    if (smsBusy) throw new Error("身份验证操作进行中")
    smsBusy = true
    try {
        const frame = verificationFrame()
        await frame.locator("#J_Phone_Checkcode").fill(code, { timeout: 5000 })
        await frame.locator("#submitBtn").click({ timeout: 5000 })
        await page?.waitForURL(url => !url.pathname.includes("/login_unusual.htm"), { timeout: 8000 }).catch(() => {})
        const current = await status()
        if (current.phase === "verification_required") throw new Error("身份验证未完成，请检查验证码")
        return current
    } finally { smsBusy = false }
}

export function registerAlibabaLoginRoutes(app: FastifyInstance) {
    app.get("/alibaba-login/status", async (_request, reply) => {
        reply.header("Cache-Control", "no-store")
        return status()
    })
    app.post("/alibaba-login/start", async (_request, reply) => {
        try { return await start() }
        catch (error) { return reply.code(409).send({ error: { message: (error as Error).message } }) }
    })
    app.get("/alibaba-login/qr", async (_request, reply) => {
        reply.header("Cache-Control", "no-store")
        if ((await status()).phase !== "waiting_scan" || !page) return reply.code(404).send()
        try { return reply.type("image/png").send(await page.locator("#qrcode-img").screenshot({ timeout: 5000 })) }
        catch { return reply.code(503).send() }
    })
    app.post("/alibaba-login/sms/request", async (_request, reply) => {
        try { return await requestSms() }
        catch (error) { return reply.code(409).send({ error: { message: (error as Error).message } }) }
    })
    app.post<{ Body: { code?: unknown } }>("/alibaba-login/sms/verify", async (request, reply) => {
        try { return await submitSms(String(request.body?.code ?? "")) }
        catch (error) { return reply.code(409).send({ error: { message: (error as Error).message } }) }
    })
    app.addHook("onClose", async () => { await browser?.close().catch(() => {}); browser = null; page = null })
}
