import { chromium, type Browser, type Page } from "playwright"
import { browserMode, runtimeRoot } from "./visible-browsers.js"
import { clearMiaoshouCredentials, loadMiaoshouCredentials, saveMiaoshouCredentials } from "./browser-session.js"
import type { FastifyInstance } from "fastify"

type Phase = "idle" | "loading" | "captcha_required" | "submitting" | "logged_in" | "failed"
type LoginStatus = { phase: Phase; account: string | null; message: string; imageVersion: number }
const managementUrl = "https://erp.91miaoshou.com/pddkj_choice/move_collect/template_management/sizeChart"
const captchaSelector = ".captcha-field__box img:visible"
let browser: Browser | null = null
let page: Page | null = null
let image: Buffer | null = null
let busy = false
let state: LoginStatus = { phase: "idle", account: null, message: "尚未登录", imageVersion: 0 }

function setState(phase: Phase, message: string, account = state.account) {
    state = { ...state, phase, message, account }
    return state
}

function matches(expected: string, value: unknown) {
    if (typeof value !== "string") return false
    const actual = value.trim().toLowerCase(), configured = expected.trim().toLowerCase()
    return actual === configured || /^\d{11}$/.test(configured)
        && actual === `${configured.slice(0, 3)}****${configured.slice(-4)}`
}

async function confirmedAccount(expected: string) {
    const response = await page!.context().request.get("https://erp.91miaoshou.com/api/auth/account/getAccountInfo", { timeout: 5000 })
    if (!response.ok()) return false
    const info = await response.json() as Record<string, unknown>
    return info.result === "success" && [info.mobile, info.accountName, info.email].some(value => matches(expected, value))
}

async function captureCaptcha(force = false) {
    if (!page || page.isClosed()) throw new Error("妙手登录页已关闭")
    const captcha = page.locator(captchaSelector)
    await captcha.waitFor({ state: "visible", timeout: 15000 })
    await page.waitForFunction(() => {
        const img = document.querySelector<HTMLImageElement>(".captcha-field__box img")
        return img?.complete && img.naturalWidth > 0
    }, undefined, { timeout: 15000 })
    const current = await captcha.screenshot({ timeout: 10000 })
    if (force || !image?.equals(current)) {
        image = current
        state = { ...state, imageVersion: state.imageVersion + 1 }
    }
    return state
}

async function waitForCaptchaChange(previous: Buffer | null) {
    if (!page) throw new Error("妙手登录页已关闭")
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
        await captureCaptcha()
        if (image && (!previous || !image.equals(previous))) return state
        await page.waitForTimeout(300)
    }
    throw new Error("验证码未更新，请重试")
}

async function attach() {
    if (browser?.isConnected()) return browser
    browser = await chromium.connectOverCDP("http://127.0.0.1:9223", { timeout: 3000 })
    return browser
}

async function start() {
    if (busy) throw new Error("妙手登录正在进行")
    if (browserMode("sizeTemplate") !== "headless") throw new Error("请先启动妙手无头浏览器")
    const credentials = await loadMiaoshouCredentials(runtimeRoot())
    if (!credentials) throw new Error("请先保存妙手登录账号和密码")
    busy = true
    setState("loading", "正在打开妙手登录页", credentials.account)
    try {
        const attached = await attach()
        const context = attached.contexts()[0]
        if (!context) throw new Error("妙手浏览器缺少默认会话")
        page = context.pages().find(candidate => candidate.url().startsWith("https://erp.91miaoshou.com"))
            ?? context.pages()[0] ?? await context.newPage()
        await page.goto(managementUrl, { waitUntil: "domcontentloaded", timeout: 30000 })
        if (await confirmedAccount(credentials.account)) return setState("logged_in", "妙手已登录", credentials.account)
        if (await page.locator('input[type="password"]').count() === 0)
            return setState("failed", "浏览器已登录其他妙手账号，请先退出该账号", credentials.account)
        const loginPage = page.locator('input[type="password"]')
        await loginPage.waitFor({ state: "visible", timeout: 15000 })
        await page.getByPlaceholder("手机号/子账号/邮箱", { exact: true }).fill(credentials.account)
        await page.getByPlaceholder("密码", { exact: true }).fill(credentials.password)
        await captureCaptcha(true)
        return setState("captcha_required", "请输入图片中的四位验证码", credentials.account)
    } catch {
        return setState("failed", "妙手登录页无法准备，请检查浏览器与网络")
    } finally { busy = false }
}

async function refreshCaptcha() {
    if (busy || state.phase !== "captcha_required" || !page) throw new Error("当前没有可刷新的验证码")
    busy = true
    try {
        const previous = image
        await page.locator(captchaSelector).click({ timeout: 10000 })
        return await waitForCaptchaChange(previous)
    } finally { busy = false }
}

async function submitCaptcha(code: string) {
    if (!/^\d{4}$/.test(code)) throw new Error("请输入四位数字验证码")
    if (busy || state.phase !== "captcha_required" || !page) throw new Error("当前没有待提交的验证码")
    const credentials = await loadMiaoshouCredentials(runtimeRoot())
    if (!credentials || credentials.account !== state.account) throw new Error("妙手登录凭证已变更，请重新开始")
    busy = true
    setState("submitting", "正在验证妙手登录")
    try {
        const shownImage = image
        await captureCaptcha()
        if (!shownImage || !image || !shownImage.equals(image)) {
            return setState("captcha_required", "验证码已更新，请输入新图片", credentials.account)
        }
        await page.getByPlaceholder("请输入验证码", { exact: true }).fill(code)
        const [response] = await Promise.all([
            page.waitForResponse(item => new URL(item.url()).pathname === "/api/auth/account/login"
                && item.request().method() === "POST", { timeout: 30000 }),
            page.getByRole("button", { name: "立即登录", exact: true }).click({ timeout: 15000 }),
        ])
        const result = await response.json().catch(() => null) as { result?: string; reason?: string } | null
        if (result?.result === "fail") {
            if (/(?:图形)?验证码(?:不正确|错误|有误)/.test(result.reason ?? "")) {
                await refreshAfterFailure()
                return setState("captcha_required", "验证码错误，请输入新图片", credentials.account)
            }
            return setState("failed", "妙手拒绝登录，请核对账号和密码", credentials.account)
        }
        for (let attempt = 0; attempt < 30; attempt++) {
            if (await confirmedAccount(credentials.account).catch(() => false))
                return setState("logged_in", "妙手已登录", credentials.account)
            await page.waitForTimeout(500)
        }
        return setState("failed", "登录结果无法确认，请检查妙手账号", credentials.account)
    } catch {
        return setState("failed", "登录提交失败，请重新开始", credentials.account)
    } finally { busy = false }
}

async function refreshAfterFailure() {
    if (!page) return
    const previous = image
    await captureCaptcha()
    if (previous && image && previous.equals(image)) {
        await page.locator(captchaSelector).click({ timeout: 10000 })
        await waitForCaptchaChange(previous)
    }
}

export function registerMiaoshouLoginRoutes(app: FastifyInstance) {
    app.get("/miaoshou-login/status", async (_request, reply) => {
        reply.header("Cache-Control", "no-store")
        if (state.phase === "captcha_required" && !busy) await captureCaptcha().catch(() => {})
        if (state.phase === "logged_in" && state.account && !busy
            && !await confirmedAccount(state.account).catch(() => false)) setState("idle", "妙手登录已失效")
        const credentials = await loadMiaoshouCredentials(runtimeRoot())
        return { ...state, configuredAccount: credentials?.account ?? null }
    })
    app.put<{ Body: { account?: unknown; password?: unknown } }>("/miaoshou-login/credentials", async (request, reply) => {
        const { account, password } = request.body ?? {}
        if (typeof account !== "string" || !account.trim() || account.length > 128
            || typeof password !== "string" || !password || password.length > 256)
            return reply.code(400).send({ error: { message: "请输入有效的妙手账号和密码" } })
        await saveMiaoshouCredentials(runtimeRoot(), { account: account.trim(), password })
        return { configuredAccount: account.trim() }
    })
    app.delete("/miaoshou-login/credentials", async () => {
        await clearMiaoshouCredentials(runtimeRoot())
        return { configuredAccount: null }
    })
    app.post("/miaoshou-login/start", async (_request, reply) => {
        try { return await start() }
        catch (error) { return reply.code(409).send({ error: { message: (error as Error).message } }) }
    })
    app.post<{ Body: { code?: unknown } }>("/miaoshou-login/captcha/submit", async (request, reply) => {
        if (typeof request.body?.code !== "string") return reply.code(400).send({ error: { message: "请输入验证码" } })
        try { return await submitCaptcha(request.body.code) }
        catch (error) { return reply.code(409).send({ error: { message: (error as Error).message } }) }
    })
    app.post("/miaoshou-login/captcha/refresh", async (_request, reply) => {
        try { return await refreshCaptcha() }
        catch (error) { return reply.code(409).send({ error: { message: (error as Error).message } }) }
    })
    app.get("/miaoshou-login/captcha/image", async (_request, reply) => {
        reply.header("Cache-Control", "no-store")
        if (state.phase !== "captcha_required" || !image) return reply.code(404).send()
        return reply.type("image/png").send(image)
    })
    app.addHook("onClose", async () => { await browser?.close().catch(() => {}); browser = null; page = null; image = null })
}
