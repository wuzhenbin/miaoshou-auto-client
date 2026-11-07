import { chromium, type Browser } from "playwright"

export type WindowState = "open" | "minimized" | "unknown"
export type LoginState = "logged_in" | "not_logged_in" | "unknown"
export type LoginSession = { state: LoginState; account: string | null }
export type MiaoshouAccount = { mobile?: string; accountName?: string; email?: string }
export type BrowserInspection = { window: WindowState; session: LoginSession }
type BrowserKind = "sizeTemplate" | "shared"
type WindowBounds = { windowState: string }

const unknownSession: LoginSession = { state: "unknown", account: null }

async function withBrowser<T>(kind: BrowserKind, action: (browser: Browser) => Promise<T>): Promise<T> {
    const port = kind === "sizeTemplate" ? 9223 : 9224
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 3000 })
    try { return await action(browser) }
    finally { await browser.close().catch(() => {}) }
}

async function windowIds(browser: Browser): Promise<number[]> {
    const cdp = await browser.newBrowserCDPSession()
    try {
        const targets = await cdp.send("Target.getTargets") as { targetInfos: { targetId: string; type: string }[] }
        const ids = new Set<number>()
        for (const target of targets.targetInfos.filter(item => item.type === "page")) {
            try {
                const result = await cdp.send("Browser.getWindowForTarget", { targetId: target.targetId }) as { windowId: number }
                ids.add(result.windowId)
            } catch { /* A page may close while the target list is read. */ }
        }
        return [...ids]
    } finally { await cdp.detach().catch(() => {}) }
}

async function readWindow(browser: Browser): Promise<WindowState> {
    const ids = await windowIds(browser)
    if (!ids.length) return "unknown"
    const cdp = await browser.newBrowserCDPSession()
    try {
        const bounds = await Promise.all(ids.map(async windowId =>
            (await cdp.send("Browser.getWindowBounds", { windowId }) as { bounds: WindowBounds }).bounds))
        return bounds.every(item => item.windowState === "minimized") ? "minimized" : "open"
    } finally { await cdp.detach().catch(() => {}) }
}

async function readMiaoshouAccountState(browser: Browser): Promise<{ state: LoginState; account: MiaoshouAccount | null }> {
    const context = browser.contexts()[0]
    if (!context) return { state: "unknown", account: null }
    try {
        const response = await context.request.get("https://erp.91miaoshou.com/api/auth/account/getAccountInfo", { timeout: 4000 })
        if (response.status() === 401 || response.status() === 403) return { state: "not_logged_in", account: null }
        if (!response.ok()) return { state: "unknown", account: null }
        const info = await response.json() as Record<string, unknown>
        if (info.result !== "success") return { state: "not_logged_in", account: null }
        const account = Object.fromEntries(["mobile", "accountName", "email"]
            .filter(key => typeof info[key] === "string" && (info[key] as string).trim())
            .map(key => [key, (info[key] as string).trim()])) as MiaoshouAccount
        return Object.keys(account).length ? { state: "logged_in", account } : { state: "unknown", account: null }
    } catch { return { state: "unknown", account: null } }
}

async function readMiaoshouSession(browser: Browser): Promise<LoginSession> {
    const { state, account: info } = await readMiaoshouAccountState(browser)
    if (info) {
        const account = [info.accountName, info.mobile, info.email]
            .find(value => typeof value === "string" && value.trim())
        return typeof account === "string"
            ? { state: "logged_in", account: account.trim() } : unknownSession
    }
    return { state, account: null }
}

export async function inspectMiaoshouAccount(): Promise<MiaoshouAccount | null> {
    try { return (await withBrowser("sizeTemplate", readMiaoshouAccountState)).account }
    catch { return null }
}

function read1688Session(browser: Browser): LoginSession {
    const pages = browser.contexts()[0]?.pages() ?? []
    let waitingLogin = false
    for (const page of pages) {
        try {
            const url = new URL(page.url())
            if ((url.hostname === "1688.com" || url.hostname.endsWith(".1688.com"))
                && url.hostname !== "login.1688.com" && !url.pathname.includes("_____tmd_____")
                && !url.pathname.includes("/punish")) return { state: "logged_in", account: null }
            if (url.hostname === "login.1688.com" || url.hostname === "login.taobao.com") waitingLogin = true
        } catch { /* Ignore blank and extension pages. */ }
    }
    return waitingLogin ? { state: "not_logged_in", account: null } : unknownSession
}

export async function inspectBrowser(kind: BrowserKind): Promise<BrowserInspection> {
    try {
        return await withBrowser(kind, async browser => {
            const [window, session] = await Promise.all([
                readWindow(browser).catch((): WindowState => "unknown"),
                kind === "sizeTemplate" ? readMiaoshouSession(browser) : Promise.resolve(read1688Session(browser)),
            ])
            return { window, session }
        })
    } catch { return { window: "unknown", session: unknownSession } }
}

export async function setWindowVisibility(kind: BrowserKind, state: "open" | "minimized") {
    await withBrowser(kind, async browser => {
        const ids = await windowIds(browser)
        if (!ids.length) throw new Error("没有可操作的浏览器窗口")
        const cdp = await browser.newBrowserCDPSession()
        try {
            for (const windowId of ids)
                await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: state === "open" ? "normal" : "minimized" } })
        } finally { await cdp.detach().catch(() => {}) }
        if (state === "open") await browser.contexts()[0]?.pages()[0]?.bringToFront().catch(() => {})
    })
}
