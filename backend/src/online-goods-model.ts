import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Page } from "playwright"

const directory = join(process.env.MIAOSHOU_RUNTIME_DIR?.trim() || join(homedir(), ".miaoshou-auto"), "online-goods-model")

export async function createGoodsModelOnce(page: Page, id: string, input: Record<string, unknown>) {
    if (typeof input.shopId !== "string" || !/^[1-9]\d*$/.test(input.shopId) || input.modelType !== 0
        || typeof input.modelName !== "string" || !input.modelName.trim())
        throw new Error("模特创建计划无效")
    await page.goto("https://erp.91miaoshou.com/pddkj_choice/collect_box/items", { waitUntil: "domcontentloaded", timeout: 20_000 })
    if (new URL(page.url()).hostname !== "erp.91miaoshou.com" || /login/i.test(page.url()))
        throw new Error("妙手网页会话未登录")
    const moduleUrl = await page.evaluate(async () => {
        const entry = [...document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')]
            .find(script => /\/index-[\w-]+\.js$/.test(new URL(script.src).pathname))?.src
        if (!entry || !/^https:\/\/erp-static-c[1-4]\.chengji-inc\.com\/assets\/[0-9]+\/[\w-]+\.js$/.test(entry))
            throw new Error("无法确认妙手网页入口")
        const source = await fetch(entry).then(response => response.text())
        const paths = [...new Set([...source.matchAll(/assets\/[0-9]+\/collect_box-[\w-]+\.js/g)].map(match => match[0]))]
        if (!paths.length || paths.length > 80) throw new Error("妙手模特模块索引已变化")
        const candidates: string[] = []
        for (let index = 0; index < paths.length; index += 6) {
            const batch = await Promise.all(paths.slice(index, index + 6).map(async path => {
                const url = new URL("/" + path, entry).href
                if (!/^https:\/\/erp-static-c[1-4]\.chengji-inc\.com\/assets\/[0-9]+\/[\w-]+\.js$/.test(url))
                    throw new Error("妙手模特模块来源无效")
                const text = await fetch(url).then(response => response.text())
                return text.includes('/move/collect_box/addModelInfo`') ? url : null
            }))
            candidates.push(...batch.filter((url): url is string => !!url))
        }
        if (candidates.length !== 1) throw new Error("妙手模特创建模块已变化")
        return candidates[0]!
    })
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const file = join(directory, `${id}.json`)
    if (existsSync(file)) throw new Error("本次模特创建尝试已有记录，禁止再次提交")
    writeFileSync(file, JSON.stringify({ id, shopId: input.shopId, modelName: input.modelName,
        attemptedAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 })
    return page.evaluate(async ({ moduleUrl, input }) => {
        const module = await import(/* @vite-ignore */ moduleUrl)
        const creators = Object.values(module).filter((fn): fn is (...args: unknown[]) => Promise<unknown> =>
            typeof fn === "function" && fn.toString().includes('/move/collect_box/addModelInfo`') &&
            /method:\s*[`'"]POST[`'"]/.test(fn.toString()))
        if (creators.length !== 1) throw new Error("妙手模特创建函数已变化")
        try {
            const response = await creators[0]!("pddkjChoice", input) as { result?: unknown; reason?: unknown }
            return { success: response?.result === "success", rejected: response?.result === "fail",
                reason: typeof response?.reason === "string" ? response.reason.slice(0, 300) : undefined }
        } catch (error) {
            const value = error as { result?: unknown; reason?: unknown }
            return { success: false, rejected: value?.result === "fail",
                reason: typeof value?.reason === "string" ? value.reason.slice(0, 300) : undefined }
        }
    }, { moduleUrl, input })
}
