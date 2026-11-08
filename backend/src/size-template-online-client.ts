import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { chromium, type Page, type Request, type Response } from "playwright"
import { connectOverCdp } from "./cdp-connection.js"
import { setSizeBrowserWriteActive } from "./size-browser-recovery-state.js"
import { fillForm, managementUrl, readDefinition, selectCategory, selectSizeClass,
    testFillSizeTemplate, type SizeTemplateDefinition, type TestFillCommand } from "./size-template-test-fill.js"

type Command = { type?: string; id?: string; taskId?: string; expectedAccount?: string; categoryPath?: string;
    classLabel?: string; cid?: string; templateName?: string; expectedDefinition?: SizeTemplateDefinition;
    parameters?: TestFillCommand["parameters"]; rows?: TestFillCommand["rows"] }
type Result = { type: "online_result"; id: string; ok: boolean; data?: unknown; error?: string }
type SaveEvidence = { clickedAt: string; request?: { observedAt: string; name: string | null; cid: string | null;
    identityMatches: boolean; payloadSha256: string }; response?: { observedAt: string; httpStatus: number;
    result?: string; code?: string; message?: string; reason?: string }; modalClosed?: boolean; error?: string }

const directory = join(process.env.MIAOSHOU_RUNTIME_DIR?.trim() || join(homedir(), ".miaoshou-auto"), "online-size-template")
const matchesAccount = (expected: string, values: { mobile?: string; accountName?: string; email?: string }) =>
    [values.mobile, values.accountName, values.email].some(value => {
        const actual = value?.trim().toLowerCase(), configured = expected.trim().toLowerCase()
        return actual === configured || /^\d{11}$/.test(configured) && actual === `${configured.slice(0, 3)}****${configured.slice(-4)}`
    })

export async function ensureAccount(page: Page, expected: string) {
    let body: { result?: string; mobile?: string; accountName?: string; email?: string } | null = null
    try {
        const response = await page.context().request.get("https://erp.91miaoshou.com/api/auth/account/getAccountInfo", { timeout: 8000 })
        if (response.ok()) body = await response.json()
    } catch { throw new Error("客户端妙手会话核验请求失败") }
    if (!body || body.result !== "success" || !matchesAccount(expected, body))
        throw new Error("客户端妙手会话与业务账号不匹配")
}

async function closeUnsaved(page: Page) {
    const modal = page.locator(".base-item-edit-dialog:visible")
    if (await modal.count().catch(() => 0)) {
        const cancel = modal.getByRole("button", { name: "取消", exact: true })
        if (await cancel.count().catch(() => 0) === 1) await cancel.click({ timeout: 3000 }).catch(() => {})
    }
    await page.close().catch(() => {})
}

async function observe(page: Page, command: Command) {
    await page.goto(managementUrl, { waitUntil: "domcontentloaded", timeout: 30_000 })
    await page.getByRole("button", { name: "创建尺码表模板", exact: true }).click({ timeout: 15_000 })
    await page.locator(".base-item-edit-dialog:visible").waitFor({ state: "visible" })
    await selectCategory(page, command.categoryPath!)
    const sizeClass = await selectSizeClass(page, command.classLabel)
    return { definition: await readDefinition(page), classOptions: sizeClass.options, classLabel: sizeClass.selected }
}

async function saveOnce(page: Page, command: Command): Promise<SaveEvidence> {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const file = join(directory, `${command.id}.json`)
    if (existsSync(file)) throw new Error("本次保存尝试已有本地记录，禁止再次点击")
    const evidence: SaveEvidence = { clickedAt: new Date().toISOString() }
    const write = () => writeFileSync(file, JSON.stringify({ taskId: command.taskId, templateName: command.templateName,
        cid: command.cid, evidence }), { mode: 0o600 })
    writeFileSync(file, JSON.stringify({ taskId: command.taskId, templateName: command.templateName,
        cid: command.cid, evidence, status: "reserved" }), { mode: 0o600, flag: "wx" })
    const requests = new Set<Request>()
    const responses: Promise<void>[] = []
    const onRequest = (request: Request) => {
        if (request.method() !== "POST" || new URL(request.url()).pathname !== "/api/platform/pddkj_choice/move/size_template/addErpSizeTemplate") return
        requests.add(request)
        const raw = request.postData() ?? ""
        let body: Record<string, unknown> = {}
        try { body = request.headers()["content-type"]?.includes("application/json") ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw)) }
        catch { /* A sent request remains an unknown save attempt. */ }
        evidence.request = { observedAt: new Date().toISOString(), name: typeof body.name === "string" ? body.name : null,
            cid: body.cid == null ? null : String(body.cid), identityMatches: requests.size === 1
                && body.name === command.templateName && String(body.cid) === command.cid,
            payloadSha256: createHash("sha256").update(raw).digest("hex") }
        write()
    }
    const onResponse = (response: Response) => {
        if (!requests.has(response.request())) return
        responses.push((async () => {
            evidence.response = { observedAt: new Date().toISOString(), httpStatus: response.status() }
            try {
                const body = await response.json() as Record<string, unknown>
                for (const key of ["result", "code", "message", "reason"] as const)
                    if (typeof body[key] === "string") evidence.response[key] = body[key].slice(0, 1000)
            } catch { /* Preserve HTTP status without arbitrary response content. */ }
            write()
        })())
    }
    page.on("request", onRequest)
    page.on("response", onResponse)
    try {
        await page.locator(".base-item-edit-dialog:visible").getByRole("button", { name: "保存", exact: true }).click({ timeout: 15_000 })
        evidence.modalClosed = await page.locator(".base-item-edit-dialog:visible").waitFor({ state: "hidden", timeout: 15_000 })
            .then(() => true).catch(() => false)
        await Promise.race([Promise.all(responses), new Promise(resolve => setTimeout(resolve, 3000))])
    } catch (error) { evidence.error = error instanceof Error ? error.message : String(error) }
    finally { page.off("request", onRequest); page.off("response", onResponse); write() }
    return evidence
}

export async function executeOnlineSizeTemplateCommand(input: Command): Promise<Result> {
    const id = typeof input.id === "string" ? input.id : ""
    if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[0-9a-f-]{36}$/i.test(input.taskId ?? "")
        || !input.categoryPath || !input.expectedAccount || !["size_template_observe", "size_template_create", "size_template_preview"].includes(input.type ?? ""))
        return { type: "online_result", id, ok: false, error: "客户端命令格式无效" }
    if (input.type === "size_template_preview") {
        if (!input.templateName || !input.parameters?.length || !input.rows?.length)
            return { type: "online_result", id, ok: false, error: "客户端试填计划不完整" }
        const preview = await testFillSizeTemplate(input as TestFillCommand)
        return { type: "online_result", id, ok: preview.ok, data: preview,
            ...(preview.message ? { error: preview.message } : {}) }
    }
    let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined
    let page: Page | undefined
    let saveStarted = false
    const writeCommand = input.type === "size_template_create"
    if (writeCommand) setSizeBrowserWriteActive(true)
    try {
        browser = await connectOverCdp("http://127.0.0.1:9223")
        const context = browser.contexts()[0]
        if (!context) throw new Error("妙手浏览器没有默认会话")
        page = await context.newPage()
        await ensureAccount(page, input.expectedAccount)
        if (input.type === "size_template_observe")
            return { type: "online_result", id, ok: true, data: await observe(page, input) }
        if (!input.cid || !input.templateName || !input.parameters?.length || !input.rows?.length || !input.expectedDefinition)
            throw new Error("在线填表计划不完整")
        const filled = await fillForm(page, input as TestFillCommand)
        await ensureAccount(page, input.expectedAccount)
        saveStarted = true
        const evidence = await saveOnce(page, input)
        return { type: "online_result", id, ok: true, data: { ...filled, evidence } }
    } catch (error) { return { type: "online_result", id, ok: false, data: { saveStarted },
        error: error instanceof Error ? error.message : String(error) } }
    finally {
        if (page && !page.isClosed()) await closeUnsaved(page)
        await browser?.close().catch(() => {})
        if (writeCommand) setSizeBrowserWriteActive(false)
    }
}
