import { chromium, type Page } from "playwright"
import { connectOverCdp } from "./cdp-connection.js"
import { closeMiaoshouWebsiteDialogs } from "./miaoshou-dialogs.js"

export type TestFillCommand = { type: "test_fill"; id: string; taskId: string; categoryPath: string;
    expectedAccount: string;
    templateName: string; parameters: { id: string; label: string }[];
    rows: { targetSize: string; values: { parameter: string; value: number; position?: "single" | "flat" | "stretched" }[] }[];
    classLabel?: string; expectedDefinition?: SizeTemplateDefinition }
export type TestFillResult = { type: "test_fill_result"; id: string; ok: boolean; stage: string; message?: string;
    category?: string; filledRows?: number; filledValues?: number; cancelled?: boolean }
export type SizeTemplateDefinition = { candidates: { id: string; label: string; checked: boolean; disabled: boolean }[];
    candidateSizes: string[]; allowRange: boolean }

export const managementUrl = "https://erp.91miaoshou.com/pddkj_choice/move_collect/template_management/sizeChart"
const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, "")
const parameterName = (value: string) => normalize(value).replace(/[（(](?:cm|厘米|mm|毫米|in|inch|英寸)[）)]/g, "")
const matchesAccount = (expected: string, values: { mobile?: string; accountName?: string; email?: string }) =>
    [values.mobile, values.accountName, values.email].some(value => {
        const actual = value?.trim().toLowerCase()
        const configured = expected.trim().toLowerCase()
        return actual === configured || /^\d{11}$/.test(configured) && actual === `${configured.slice(0, 3)}****${configured.slice(-4)}`
    })

export async function selectCategory(page: Page, path: string) {
    const modal = page.locator(".base-item-edit-dialog:visible")
    const input = modal.locator(".category-selector input:visible")
    await input.click()
    const dropdown = page.locator(".jx-cascader__dropdown:visible")
    await dropdown.waitFor({ state: "visible" })
    const parts = path.split(/\s*\/\s*/).map(value => value.trim())
    if (parts.length < 2 || parts.some(value => !value)) throw new Error("任务类目路径无效")
    for (const [index, part] of parts.entries()) {
        const menu = dropdown.locator(".jx-cascader-menu").nth(index)
        await menu.locator(".jx-cascader-node").first().waitFor({ state: "visible" })
        const labels = (await menu.locator(".jx-cascader-node__label").allTextContents()).map(value => value.trim())
        const exact = labels.map((value, position) => ({ value, position })).filter(item => item.value === part)
        const matches = exact.length ? exact : labels.map((value, position) => ({ value, position })).filter(item =>
            index < parts.length - 1 && item.value.includes(part))
        if (matches.length !== 1) throw new Error(`类目第 ${index + 1} 级未唯一匹配：${part}`)
        await menu.locator(".jx-cascader-node").nth(matches[0]!.position).click()
        if (index < parts.length - 1)
            await dropdown.locator(".jx-cascader-menu").nth(index + 1).locator(".jx-cascader-node").first().waitFor({ state: "visible" })
    }
    await dropdown.waitFor({ state: "hidden" })
    const category = await input.inputValue()
    if (!category.includes(parts.at(-1)!)) throw new Error("类目选择后回显不一致")
    await modal.getByRole("group", { name: /尺码参数/ }).locator("label.jx-checkbox").first()
        .waitFor({ state: "visible", timeout: 30_000 })
    await modal.locator(".size-chart-table .pro-virtual-table").waitFor({ state: "visible", timeout: 30_000 })
    return category
}

export async function selectSizeClass(page: Page, expected?: string) {
    const modal = page.locator(".base-item-edit-dialog:visible")
    const select = modal.locator(".jx-select").filter({ has: page.locator("[role=combobox]") })
    if (await select.count() !== 1) return { selected: null, options: [] as string[] }
    const selected = (await select.locator(".jx-select__placeholder").innerText()).trim()
    await select.locator(".jx-select__wrapper").click()
    const listId = await select.locator("[role=combobox]").getAttribute("aria-controls")
    if (!listId || !/^[A-Za-z0-9_-]+$/.test(listId)) throw new Error("尺码分类列表无效")
    const list = page.locator(`[id="${listId}"]`)
    await list.waitFor({ state: "visible" })
    const options = list.getByRole("option")
    const labels = (await options.allTextContents()).map(value => value.trim())
    if (!labels.length || new Set(labels).size !== labels.length) throw new Error("尺码分类候选无效")
    if (expected && !labels.includes(expected)) throw new Error("准备阶段的尺码分类已改变")
    if (expected && selected !== expected) {
        const metadata = page.waitForResponse(response =>
            new URL(response.url()).pathname === "/api/platform/pddkj_choice/move/size_template/getSizChartsMeta", { timeout: 30_000 })
        await options.nth(labels.indexOf(expected)).click()
        const response = await metadata
        if (!response.ok() || (await response.json() as { result?: string }).result !== "success")
            throw new Error("尺码分类切换失败")
    } else await select.locator(".jx-select__wrapper").click()
    await list.waitFor({ state: "hidden" })
    return { selected: expected ?? selected, options: labels }
}

export async function readDefinition(page: Page): Promise<SizeTemplateDefinition> {
    const modal = page.locator(".base-item-edit-dialog:visible")
    const candidates = await modal.getByRole("group", { name: /尺码参数/ }).locator("label.jx-checkbox").evaluateAll(labels => labels.map(label => {
        const input = label.querySelector<HTMLInputElement>('input[type="checkbox"]')
        return { id: input?.value ?? "", label: label.querySelector(".jx-checkbox__label")?.textContent?.trim() ?? "",
            checked: input?.checked ?? false, disabled: input?.disabled ?? false }
    }))
    if (!candidates.length || candidates.some(item => !item.id || !item.label)) throw new Error("官方参数为空或无效")
    const table = modal.locator(".size-chart-table .pro-virtual-table")
    await table.waitFor({ state: "visible" })
    const headers = await table.locator(".pro-virtual-table__header-cell").allTextContents()
    const sizeColumn = headers.findIndex(value => normalize(value) === "尺码")
    if (sizeColumn < 0) throw new Error("尺码列缺失")
    const scroller = table.locator(".pro-virtual-table__body")
    const active = table.locator('.vue-recycle-scroller__item-view:not([style*="-9999"]) .pro-virtual-table__row')
    const previous = await scroller.evaluate(element => ({ top: element.scrollTop, left: element.scrollLeft,
        height: element.clientHeight, total: element.scrollHeight }))
    if (!previous.height) throw new Error("尺码候选列表高度异常")
    const found = new Map<number, string>()
    try {
        for (let top = 0; top < previous.total; top += Math.max(50, previous.height / 2)) {
            await scroller.evaluate(async (element, position) => {
                element.scrollTop = position
                await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
            }, top)
            const batch = await active.evaluateAll((rows, index) => rows.map(row => ({
                name: row.querySelectorAll(".pro-virtual-table__row-cell")[index]?.textContent?.trim() ?? "",
                top: new DOMMatrix(getComputedStyle(row.parentElement!).transform).m42,
            })), sizeColumn)
            for (const item of batch) if (item.top >= 0) found.set(item.top, item.name)
        }
    } finally { await scroller.evaluate((element, position) => {
        element.scrollTop = position.top; element.scrollLeft = position.left
    }, previous) }
    const candidateSizes = [...found].sort((left, right) => left[0] - right[0]).map(item => item[1])
    if (!candidateSizes.length || candidateSizes.some(value => !value) || new Set(candidateSizes).size !== candidateSizes.length)
        throw new Error("官方尺码候选为空或重复")
    return { candidates, candidateSizes, allowRange: await table.locator(".pro-virtual-table__header-cell .check-header").count() > 0 }
}

export async function fillForm(page: Page, command: TestFillCommand) {
    await page.goto(managementUrl, { waitUntil: "domcontentloaded", timeout: 20_000 })
    await page.locator(".jx-overlay-dialog.service-expiring-dialog:visible")
        .waitFor({ state: "visible", timeout: 1500 }).catch(() => {})
    await closeMiaoshouWebsiteDialogs(page)
    const create = page.getByRole("button", { name: "创建尺码表模板", exact: true })
    try { await create.click({ timeout: 5000 }) }
    catch (error) {
        if (!(error instanceof Error) || error.name !== "TimeoutError" ||
            !await page.locator(".jx-overlay-dialog.service-expiring-dialog:visible").count()) throw error
        await closeMiaoshouWebsiteDialogs(page)
        await create.click({ timeout: 10000 })
    }
    const modal = page.locator(".base-item-edit-dialog:visible").filter({
        has: page.getByRole("heading", { name: "创建尺码表模板", exact: true }),
    })
    await modal.waitFor({ state: "visible" })
    const name = modal.getByLabel("模板名称", { exact: true })
    await name.fill(command.templateName)
    if (await name.inputValue() !== command.templateName) throw new Error("模板名回显不一致")
    const category = await selectCategory(page, command.categoryPath)
    if (command.classLabel) await selectSizeClass(page, command.classLabel)
    if (command.expectedDefinition && JSON.stringify(await readDefinition(page)) !== JSON.stringify(command.expectedDefinition))
        throw new Error("官方尺码参数或候选已变化，停止填写")
    const group = modal.getByRole("group", { name: /尺码参数/ })
    await group.waitFor({ state: "visible" })
    const desired = new Set(command.parameters.map(item => item.id))
    const labels = group.locator("label.jx-checkbox")
    const available = await labels.evaluateAll(elements => elements.map(element => {
        const input = element.querySelector<HTMLInputElement>('input[type="checkbox"]')
        return { id: input?.value ?? "", checked: input?.checked ?? false, disabled: input?.disabled ?? false }
    }))
    for (const item of available.filter(item => item.checked && !desired.has(item.id))) {
        if (item.disabled) throw new Error(`官方必选参数不在填写计划中：${item.id}`)
        const label = labels.filter({ has: page.locator(`input[type="checkbox"][value="${item.id}"]`) })
        await label.click()
        if (await label.locator('input[type="checkbox"]').isChecked()) throw new Error(`默认参数取消失败：${item.id}`)
    }
    for (const parameter of command.parameters) {
        const label = group.locator("label.jx-checkbox").filter({
            has: page.locator(`input[type="checkbox"][value="${parameter.id}"]`),
        })
        if (await label.count() !== 1 || normalize(await label.locator(".jx-checkbox__label").innerText()) !== normalize(parameter.label))
            throw new Error(`官方参数不匹配：${parameter.label}`)
        const checkbox = label.locator('input[type="checkbox"]')
        if (!await checkbox.isChecked()) await label.click()
        if (!await checkbox.isChecked()) throw new Error(`参数勾选失败：${parameter.label}`)
    }
    const table = modal.locator(".size-chart-table .pro-virtual-table")
    await table.waitFor({ state: "visible" })
    const headers = await table.locator(".pro-virtual-table__header-cell").evaluateAll(cells => cells.map(cell =>
        cell.querySelector(".table-header-wrapper > div > span")?.textContent?.trim() ?? cell.textContent?.trim() ?? ""))
    const sizeColumn = headers.findIndex(value => normalize(value) === "尺码")
    if (sizeColumn < 0) throw new Error("尺码列缺失")
    const columns = new Map(command.parameters.map(parameter => {
        const matches = headers.flatMap((header, index) => parameterName(header) === parameterName(parameter.label) ? [index] : [])
        if (matches.length !== 1) throw new Error(`测量列未唯一匹配：${parameter.label}`)
        return [parameter.label, matches[0]!] as const
    }))
    const ranges = new Set(command.rows.flatMap(row => row.values.filter(value => value.position && value.position !== "single")
        .map(value => value.parameter)))
    for (const [parameter, column] of columns) {
        const label = table.locator(".pro-virtual-table__header-cell").nth(column).locator("label.check-header")
        if (!await label.count()) {
            if (ranges.has(parameter)) throw new Error(`官方参数不支持平拉量：${parameter}`)
            continue
        }
        const checkbox = label.locator('input[type="checkbox"]')
        if (await checkbox.isChecked() !== ranges.has(parameter)) await label.click()
        if (await checkbox.isChecked() !== ranges.has(parameter)) throw new Error(`平拉量模式未确认：${parameter}`)
    }
    let filledRows = 0, filledValues = 0
    const scroller = table.locator(".pro-virtual-table__body")
    const allLabel = table.locator(".pro-virtual-table__header-cell.is-selection-column label.jx-checkbox")
    const allInput = allLabel.locator('input[type="checkbox"]')
    if (await allInput.evaluate((input: HTMLInputElement) => input.indeterminate)) await allLabel.click()
    if (await allInput.isChecked()) await allLabel.click()
    for (const item of command.rows) {
        const scrollHeight = await scroller.evaluate(element => element.scrollHeight)
        let matched = false
        const row = table.locator('.vue-recycle-scroller__item-view:not([style*="-9999"]) .pro-virtual-table__row:visible').filter({
            has: page.locator(`.pro-virtual-table__row-cell:nth-child(${sizeColumn + 1})`).filter({ hasText: new RegExp(`^\\s*${item.targetSize.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i") }),
        })
        for (let top = 0; top < scrollHeight && !matched; top += 150) {
            await scroller.evaluate(async (element, position) => {
                element.scrollTop = position
                await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
            }, top)
            matched = await row.count() === 1
        }
        if (!matched) throw new Error(`官方尺码候选不存在：${item.targetSize}`)
        await row.waitFor({ state: "visible", timeout: 5000 })
        if (await row.count() !== 1) throw new Error(`尺码行未唯一匹配：${item.targetSize}`)
        const label = row.locator(".is-selection-column label.jx-checkbox")
        const checked = label.locator('input[type="checkbox"]')
        if (!await checked.isChecked()) await label.click()
        if (!await checked.isChecked()) throw new Error(`尺码未勾选：${item.targetSize}`)
        for (const value of item.values) {
            const column = columns.get(value.parameter)
            if (column === undefined || !Number.isFinite(value.value)) throw new Error(`测量计划无效：${value.parameter}`)
            const inputs = row.locator(".pro-virtual-table__row-cell").nth(column).locator("input.jx-input__inner")
            if (await inputs.count() !== (ranges.has(value.parameter) ? 2 : 1))
                throw new Error(`测量输入框数量不匹配：${value.parameter}`)
            const input = inputs.nth(value.position === "stretched" ? 1 : 0)
            await input.fill(String(value.value))
            await input.blur()
            if (Number(await input.inputValue()) !== value.value) throw new Error(`测量回显不一致：${item.targetSize} ${value.parameter}`)
            filledValues++
        }
        filledRows++
    }
    const selected = new Map<number, string>()
    const height = await scroller.evaluate(element => element.clientHeight)
    const total = await scroller.evaluate(element => element.scrollHeight)
    for (let top = 0; top < total; top += Math.max(50, height / 2)) {
        await scroller.evaluate(async (element, position) => {
            element.scrollTop = position
            await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        }, top)
        const batch = await table.locator('.vue-recycle-scroller__item-view:not([style*="-9999"]) .pro-virtual-table__row')
            .evaluateAll((rows, index) => rows.map(row => ({
                name: row.querySelectorAll(".pro-virtual-table__row-cell")[index]?.textContent?.trim() ?? "",
                top: new DOMMatrix(getComputedStyle(row.parentElement!).transform).m42,
                checked: row.querySelector<HTMLInputElement>('.is-selection-column input[type="checkbox"]')?.checked ?? false,
            })), sizeColumn)
        for (const item of batch) if (item.top >= 0 && item.checked) selected.set(item.top, item.name)
    }
    const actualSizes = [...selected.values()].sort()
    if (JSON.stringify(actualSizes) !== JSON.stringify(command.rows.map(row => row.targetSize).sort()))
        throw new Error("最终选中尺码与计划不一致")
    return { category, filledRows, filledValues }
}

export async function testFillSizeTemplate(command: TestFillCommand): Promise<TestFillResult> {
    let stage = "connecting", cancelled = false, values: { category: string; filledRows: number; filledValues: number } | undefined
    let message: string | undefined
    let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined
    let page: Page | undefined
    try {
        browser = await connectOverCdp("http://127.0.0.1:9223")
        const context = browser.contexts()[0]
        if (!context) throw new Error("妙手浏览器没有默认会话")
        let info: { result?: string; mobile?: string; accountName?: string; email?: string } | null = null
        try {
            const account = await context.request.get("https://erp.91miaoshou.com/api/auth/account/getAccountInfo", { timeout: 8000 })
            if (account.ok()) info = await account.json()
        } catch { throw new Error("妙手会话核验请求失败") }
        if (!info || info.result !== "success" || !matchesAccount(command.expectedAccount, info))
            throw new Error("妙手会话账号与任务后端不匹配")
        page = await context.newPage()
        stage = "filling"
        values = await fillForm(page, command)
        stage = "filled"
    } catch (error) { message = error instanceof Error ? error.message : String(error) }
    finally {
        if (page && !page.isClosed()) {
            const modal = page.locator(".base-item-edit-dialog:visible")
            if (await modal.count().catch(() => 0)) {
                const cancel = modal.getByRole("button", { name: "取消", exact: true })
                if (await cancel.count().catch(() => 0) === 1) {
                    await cancel.click({ timeout: 3000 }).catch(() => {})
                    cancelled = await modal.waitFor({ state: "hidden", timeout: 3000 }).then(() => true).catch(() => false)
                }
            }
            await page.close().catch(() => {})
        }
        await browser?.close().catch(() => {})
    }
    return { type: "test_fill_result", id: command.id, ok: stage === "filled" && cancelled, stage,
        ...(message ? { message } : {}), ...(values ?? {}), cancelled }
}
