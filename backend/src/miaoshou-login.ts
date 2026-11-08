import { chromium, type Browser, type Page } from "playwright"
import { browserMode, pauseMiaoshouSessionPersistence, resumeMiaoshouSessionPersistence, runtimeRoot } from "./visible-browsers.js"
import { activateSavedMiaoshouCredentials, clearMiaoshouCredentials, clearMiaoshouSession,
    loadMiaoshouCredentials, loadSavedMiaoshouCredentials, rememberCurrentMiaoshouCredentials,
    saveMiaoshouCredentials } from "./browser-session.js"
import { inspectMiaoshouAccount, inspectMiaoshouSession, invalidateMiaoshouAccountInspection, type LoginSession } from "./browser-inspection.js"
import { dismissMiaoshouLoginNotices } from "./miaoshou-dialogs.js"
export { closeMiaoshouWebsiteDialogs, dismissMiaoshouLoginNotices } from "./miaoshou-dialogs.js"
import type { FastifyInstance } from "fastify"
import type { ConnectionManager } from "./connection-manager.js"

type Phase = "idle" | "loading" | "captcha_required" | "submitting" | "logged_in" | "failed" | "unknown"
type LoginStatus = { phase: Phase; account: string | null; message: string; imageVersion: number;
    imageDataUrl: string | null; imageSourceType: "original" | "rendered" | null }
const loginUrl = "https://erp.91miaoshou.com/"
const captchaSelector = ".captcha-field__box img:visible"
let browser: Browser | null = null
let page: Page | null = null
let image: Buffer | null = null
let imageSource = ""
let busy = false
let state: LoginStatus = { phase: "idle", account: null, message: "尚未登录", imageVersion: 0,
    imageDataUrl: null, imageSourceType: null }

function setState(phase: Phase, message: string, account = state.account) {
    state = { ...state, phase, message, account,
        ...(phase === "idle" || phase === "logged_in" || phase === "failed" || phase === "unknown"
            ? { imageDataUrl: null, imageSourceType: null } : {}) }
    return state
}

function matches(expected: string, value: unknown) {
    if (typeof value !== "string") return false
    const actual = value.trim().toLowerCase(), configured = expected.trim().toLowerCase()
    return actual === configured || /^\d{11}$/.test(configured)
        && actual === `${configured.slice(0, 3)}****${configured.slice(-4)}`
}

async function confirmedAccount(expected: string) {
    const info = await inspectMiaoshouAccount()
    return Boolean(info && [info.mobile, info.accountName, info.email].some(value => matches(expected, value)))
}

async function captureCaptcha(force = false) {
    if (!page || page.isClosed()) throw new Error("妙手登录页已关闭")
    const captcha = page.locator(captchaSelector)
    await captcha.waitFor({ state: "visible", timeout: 15000 })
    await page.waitForFunction(() => {
        const img = document.querySelector<HTMLImageElement>(".captcha-field__box img")
        return img?.complete && img.naturalWidth > 0
    }, undefined, { timeout: 15000 })
    const source = await captcha.getAttribute("src") ?? ""
    const current = await captcha.screenshot({ timeout: 10000 })
    if (force || source !== imageSource || !image?.equals(current)) {
        image = current
        imageSource = source
        const original = /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z\d+/=]+$/i.test(source)
        state = { ...state, imageVersion: state.imageVersion + 1,
            imageDataUrl: original ? source : `data:image/png;base64,${current.toString("base64")}`,
            imageSourceType: original ? "original" : "rendered" }
    }
    return state
}

async function waitForCaptchaChange(previousVersion: number) {
    if (!page) throw new Error("妙手登录页已关闭")
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
        await captureCaptcha()
        if (state.imageVersion !== previousVersion) return state
        await page.waitForTimeout(300)
    }
    throw new Error("验证码未更新，请重试")
}

async function attach() {
    if (browser?.isConnected()) return browser
    browser = await chromium.connectOverCDP("http://127.0.0.1:9223", { timeout: 3000 })
    return browser
}

async function unconfirmedLogin(account: string) {
    const session = await inspectMiaoshouSession()
    if (session.state === "not_logged_in")
        return setState("failed", "妙手登录状态未保持，请重新登录", account)
    return setState("unknown", "妙手登录状态待确认，请检查网页", account)
}

export async function isVerifiedMiaoshouPage(target: Page, verifyAccount: () => Promise<boolean>) {
    return new URL(target.url()).origin === new URL(loginUrl).origin
        && await verifyAccount().catch(() => false)
}

async function finishLogin(account: string) {
    if (!page) throw new Error("妙手登录页已关闭")
    if (!await confirmedAccount(account).catch(() => false)) return await unconfirmedLogin(account)
    if (!await isVerifiedMiaoshouPage(page, () => confirmedAccount(account)))
        return await unconfirmedLogin(account)
    try { await dismissMiaoshouLoginNotices(page) }
    catch (error) {
        return setState("failed", `妙手已登录，但通知弹窗关闭失败：${(error as Error).message}`, account)
    }
    if (!await isVerifiedMiaoshouPage(page, () => confirmedAccount(account)))
        return await unconfirmedLogin(account)
    return setState("logged_in", "妙手已登录", account)
}

async function start() {
    if (busy) throw new Error("妙手登录正在进行")
    if (browserMode("sizeTemplate") !== "headless") throw new Error("请先启动妙手无头浏览器")
    const credentials = await loadMiaoshouCredentials(runtimeRoot())
    if (!credentials) throw new Error("请先保存妙手登录账号和密码")
    busy = true
    image = null
    imageSource = ""
    setState("loading", "正在打开妙手登录页", credentials.account)
    try {
        const attached = await attach()
        const context = attached.contexts()[0]
        if (!context) throw new Error("妙手浏览器缺少默认会话")
        page = context.pages().find(candidate => candidate.url().startsWith("https://erp.91miaoshou.com"))
            ?? context.pages()[0] ?? await context.newPage()
        await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 30000 })
        const existingAccount = await inspectMiaoshouAccount()
        if (existingAccount && [existingAccount.mobile, existingAccount.accountName, existingAccount.email]
            .some(value => matches(credentials.account, value))) return await finishLogin(credentials.account)
        const loginPage = page.locator('input[type="password"]')
        try { await loginPage.waitFor({ state: "visible", timeout: 15000 }) }
        catch {
            const account = await inspectMiaoshouAccount()
            if (account) {
                if ([account.mobile, account.accountName, account.email]
                    .some(value => matches(credentials.account, value)))
                    return await finishLogin(credentials.account)
                return setState("failed", "浏览器已登录其他妙手账号，请先退出该账号", credentials.account)
            }
            return setState("failed", "妙手登录页未加载完成，请重试", credentials.account)
        }
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
        const previousVersion = state.imageVersion
        await page.locator(captchaSelector).click({ timeout: 10000 })
        return await waitForCaptchaChange(previousVersion)
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
        const shownVersion = state.imageVersion
        await captureCaptcha()
        if (shownVersion !== state.imageVersion) {
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
        invalidateMiaoshouAccountInspection()
        for (let attempt = 0; attempt < 30; attempt++) {
            if (await confirmedAccount(credentials.account).catch(() => false))
                return await finishLogin(credentials.account)
            await page.waitForTimeout(500)
        }
        return setState("failed", "登录结果无法确认，请检查妙手账号", credentials.account)
    } catch {
        return setState("failed", "登录提交失败，请重新开始", credentials.account)
    } finally { busy = false }
}

async function refreshAfterFailure() {
    if (!page) return
    const previousVersion = state.imageVersion
    await captureCaptcha()
    if (previousVersion === state.imageVersion) {
        await page.locator(captchaSelector).click({ timeout: 10000 })
        await waitForCaptchaChange(previousVersion)
    }
}

export function registerMiaoshouLoginRoutes(app: FastifyInstance,
    inspectSession: () => Promise<LoginSession> = inspectMiaoshouSession, connection?: ConnectionManager) {
    app.get("/miaoshou-login/status", async (_request, reply) => {
        reply.header("Cache-Control", "no-store")
        if (state.phase === "captcha_required" && !busy) await captureCaptcha().catch(() => {})
        if (!busy) {
            const session = await inspectSession()
            if (session.state === "logged_in" && session.account)
                setState("logged_in", "妙手已登录", session.account)
            else if (browserMode("sizeTemplate") === "visible"
                || state.phase !== "captcha_required" && state.phase !== "failed") {
                if (session.state === "not_logged_in") setState("idle", "妙手未登录", null)
                else setState("unknown", "妙手登录状态待确认", null)
            }
        }
        const credentials = await loadMiaoshouCredentials(runtimeRoot())
        return { ...state, configuredAccount: credentials?.account ?? null,
            savedAccounts: (await loadSavedMiaoshouCredentials(runtimeRoot())).map(item => item.account) }
    })
    app.put<{ Body: { account?: unknown; password?: unknown } }>("/miaoshou-login/credentials", async (request, reply) => {
        const { account, password } = request.body ?? {}
        if (typeof account !== "string" || !account.trim() || account.length > 128
            || typeof password !== "string" || !password || password.length > 256)
            return reply.code(400).send({ error: { message: "请输入有效的妙手账号和密码" } })
        await saveMiaoshouCredentials(runtimeRoot(), { account: account.trim(), password })
        return { configuredAccount: account.trim() }
    })
    app.post<{ Body: { account?: unknown } }>("/miaoshou-login/credentials/select", async (request, reply) => {
        const account = request.body?.account
        if (typeof account !== "string" || !account.trim() || account.length > 128)
            return reply.code(400).send({ error: { message: "请选择已保存的妙手账号" } })
        if (busy || browserMode("sizeTemplate") !== "stopped" && (await inspectSession()).state === "logged_in")
            return reply.code(409).send({ error: { message: "请先退出当前妙手账号，或等待登录状态确认" } })
        if (!await activateSavedMiaoshouCredentials(runtimeRoot(), account))
            return reply.code(404).send({ error: { message: "该妙手账号未保存在本机" } })
        return { configuredAccount: account.trim() }
    })
    app.post("/miaoshou-login/logout", async (_request, reply) => {
        if (busy) return reply.code(409).send({ error: { message: "妙手登录操作正在进行，请稍后退出" } })
        if (connection && !connection.pauseForLogout())
            return reply.code(409).send({ error: { message: "仍有未完成或未确认的命令，请等待任务收尾后退出" } })
        busy = true
        try {
            if (!["headless", "visible"].includes(browserMode("sizeTemplate")))
                throw new Error("妙手浏览器未运行，请先启动浏览器再退出登录")
            await pauseMiaoshouSessionPersistence()
            const attached = await attach()
            const context = attached.contexts()[0]
            if (!context) throw new Error("妙手浏览器缺少默认会话")
            await rememberCurrentMiaoshouCredentials(runtimeRoot())
            await clearMiaoshouSession(runtimeRoot())
            await context.clearCookies()
            const cdp = await context.newCDPSession(context.pages()[0] ?? await context.newPage())
            try { await cdp.send("Storage.clearDataForOrigin", { origin: "https://erp.91miaoshou.com", storageTypes: "all" }) }
            finally { await cdp.detach() }
            invalidateMiaoshouAccountInspection()
            const session = await inspectMiaoshouSession()
            if (session.state !== "not_logged_in")
                throw new Error("妙手退出状态无法确认，请刷新状态后重试")
            await clearMiaoshouCredentials(runtimeRoot())
            image = null
            imageSource = ""
            page = null
            setState("idle", "妙手已退出，请在浏览器窗口登录", null)
            return { ...state, configuredAccount: null,
                savedAccounts: (await loadSavedMiaoshouCredentials(runtimeRoot())).map(item => item.account) }
        } catch (error) {
            return reply.code(409).send({ error: { message: (error as Error).message } })
        } finally {
            resumeMiaoshouSessionPersistence()
            connection?.resumeAfterLogout()
            busy = false
        }
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
