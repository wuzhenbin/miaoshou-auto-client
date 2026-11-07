import { chromium, type Browser, type Page } from "playwright"
import { ensureAccount } from "./size-template-online-client.js"
import { createGoodsModelOnce } from "./online-goods-model.js"
import { browserMode } from "./visible-browsers.js"

type Command = { type?: string; id?: string; taskId?: string; expectedAccount?: string;
    url?: string; detailId?: string; shopId?: string; mode?: "shop" | "site"; input?: Record<string, unknown> }
type Result = { type: "online_result"; id: string; ok: boolean; data?: unknown; error?: string }
const itemsUrl = "https://erp.91miaoshou.com/pddkj_choice/collect_box/items"

function allowed1688Url(value: string) {
    const url = new URL(value)
    return url.protocol === "https:" && !url.username && !url.password && (
        url.hostname === "detail.1688.com" && /^\/offer\/\d{1,20}\.html$/.test(url.pathname)
        || ["itemcdn.tmall.com", "desc.alicdn.com"].includes(url.hostname))
}

async function read1688(page: Page, url: string) {
    if (!allowed1688Url(url)) throw new Error("1688 浏览器读取地址不在允许范围")
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 })
    const checkRedirect = () => {
        const final = new URL(page.url())
        if (["login.taobao.com", "login.1688.com"].includes(final.hostname))
            throw new Error("1688 浏览器访问被跳转至登录页")
        if (final.pathname.includes("_____tmd_____") || final.pathname.includes("/punish"))
            throw new Error("1688 浏览器访问触发验证页")
    }
    checkRedirect()
    if (!response?.ok()) throw new Error(`浏览器请求失败（HTTP ${response?.status() ?? "unknown"}）`)
    let body = await response.text().catch(() => page.content())
    if (url.startsWith("https://detail.1688.com/offer/") && !body.includes('"detailUrl"')) {
        const currentUrl = page.url()
        await page.waitForURL(next => next.href !== currentUrl, { timeout: 2500 }).catch(() => {})
        checkRedirect()
        body = await page.content()
    }
    if (Buffer.byteLength(body) > 5 * 1024 * 1024) throw new Error("1688 浏览器页面超过传输上限")
    return { body }
}

async function readMiaoshouDetail(page: Page, detailId: string, shopId: string, mode: "shop" | "site") {
    if (!/^[1-9]\d*$/.test(detailId) || !/^[1-9]\d*$/.test(shopId))
        throw new Error("商品或店铺编号无效")
    await page.goto(itemsUrl, { waitUntil: "domcontentloaded", timeout: 20_000 })
    if (new URL(page.url()).origin !== new URL(itemsUrl).origin || /login/i.test(page.url()))
        throw new Error("妙手网页会话未登录")
    return page.evaluate(async ({ detailId, shopId, mode }) => {
        const script = [...document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')]
            .find(script => /\/index-[\w-]+\.js$/.test(new URL(script.src).pathname))
        if (!script || !/^https:\/\/erp-static-c[1-4]\.chengji-inc\.com\//.test(script.src))
            throw new Error("妙手网页入口无法确认")
        const module = await import(/* @vite-ignore */ script.src)
        const readers = Object.values(module).filter((fn): fn is (...args: unknown[]) => Promise<unknown> =>
            typeof fn === "function" && fn.toString().includes(mode === "site" ? 'getSiteCollectItemInfo`' : 'getShopCollectItemInfo`') &&
            /method:\s*[`'"]POST[`'"]/.test(fn.toString()))
        if (readers.length !== 1) throw new Error("妙手网页详情读取函数已变化")
        return readers[0]!("pddkjChoice", { detailId: Number(detailId), ...(mode === "shop" ? { shopId: Number(shopId) } : {}) })
    }, { detailId, shopId, mode })
}

async function connect(port: number) {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 3000 })
    const context = browser.contexts()[0]
    if (!context) { await browser.close(); throw new Error("浏览器缺少默认会话") }
    return { browser, context }
}

async function readSizeBrowserState() {
    let browser: Browser | undefined
    try {
        const attached = await connect(9223)
        browser = attached.browser
        const pages = attached.context.pages()
        if (!pages.length) return "disconnected"
        if (pages.every(page => page.url() === "about:blank")) return "idle"
        let waitingLogin = false
        for (const page of pages) {
            const url = new URL(page.url())
            if (url.hostname !== "erp.91miaoshou.com") continue
            if (/\/login(?:\/|$)/.test(url.pathname) || await page.locator('input[type="password"]').first().isVisible())
                waitingLogin = true
        }
        const target = pages.find(page => {
            const url = new URL(page.url())
            return url.hostname === "erp.91miaoshou.com"
                && url.pathname === "/pddkj_choice/move_collect/template_management/sizeChart"
        })
        if (target && await target.getByRole("button", { name: "创建尺码表模板", exact: true }).isVisible())
            return waitingLogin ? "unknown" : "ready"
        return waitingLogin ? "waiting_login" : "unknown"
    } catch { return "disconnected" }
    finally { await browser?.close().catch(() => {}) }
}

export async function executeOnlineBrowserCommand(command: Command): Promise<Result> {
    const id = command.id ?? ""
    if (!/^[0-9a-f-]{36}$/i.test(id)
        || !(/^[0-9a-f-]{36}$/i.test(command.taskId ?? "")
            || command.type === "browser_goods_model_create" && /^goods-model-[0-9a-f]{64}$/.test(command.taskId ?? ""))
        || !["browser_1688_read", "browser_miaoshou_detail", "browser_goods_model_create", "browser_status", "browser_size_status"].includes(command.type ?? ""))
        return { type: "online_result", id, ok: false, error: "浏览器命令格式无效" }
    if (command.type === "browser_size_status")
        return { type: "online_result", id, ok: true, data: { state: await readSizeBrowserState(), checkedAt: new Date().toISOString() } }
    if (command.type === "browser_status") {
        try {
            const state = (kind: "sizeTemplate" | "shared") => {
                const mode = browserMode(kind)
                return mode === "visible" || mode === "headless" ? "running"
                    : mode === "stopped" ? "stopped" : "unknown"
            }
            return { type: "online_result", id, ok: true,
                data: { sizeTemplate: state("sizeTemplate"), shared: state("shared"), checkedAt: new Date().toISOString() } }
        } catch { return { type: "online_result", id, ok: false, error: "本机浏览器状态读取失败" } }
    }
    let browser: Browser | undefined
    let page: Page | undefined
    try {
        const attached = await connect(command.type === "browser_1688_read" ? 9224 : 9223)
        browser = attached.browser
        page = await attached.context.newPage()
        let data: unknown
        if (command.type === "browser_1688_read") {
            if (!command.url) throw new Error("1688 浏览器读取地址缺失")
            data = await read1688(page, command.url)
        } else {
            if (!command.expectedAccount || !command.detailId || !command.shopId
                || !["shop", "site"].includes(command.mode ?? "")) {
                if (command.type !== "browser_goods_model_create" || !command.expectedAccount || !command.input)
                    throw new Error("妙手浏览器命令不完整")
            }
            await ensureAccount(page, command.expectedAccount)
            data = command.type === "browser_goods_model_create"
                ? await createGoodsModelOnce(page, id, command.input!)
                : await readMiaoshouDetail(page, command.detailId!, command.shopId!, command.mode!)
        }
        return { type: "online_result", id, ok: true, data }
    } catch (error) {
        return { type: "online_result", id, ok: false,
            error: error instanceof Error ? error.message.split("\n")[0] : "客户端浏览器操作失败" }
    } finally {
        await page?.close().catch(() => {})
        await browser?.close().catch(() => {})
    }
}
