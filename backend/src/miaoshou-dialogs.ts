import type { Page } from "playwright"

// Close website notices only, never a size-template form confirmation.
export async function closeMiaoshouWebsiteDialogs(target: Page) {
    const dialogs = target.locator(".jx-dialog:visible").filter({ hasNot: target.getByRole("heading", {
        name: "创建尺码表模板", exact: true,
    }) })
    for (let closed = 0; await dialogs.count(); closed++) {
        if (closed >= 10) throw new Error("网站弹窗持续出现，停止关闭")
        const dialog = dialogs.last()
        const headerClose = dialog.locator(".jx-dialog__headerbtn:visible")
        const close = await headerClose.count() === 1 ? headerClose
            : dialog.getByRole("button", { name: /^(关闭此对话框|关闭|取消)$/, exact: true })
        if (await close.count() !== 1 || !await close.isEnabled())
            throw new Error("网站弹窗没有唯一可用的关闭或取消按钮")
        const element = await dialog.elementHandle()
        if (!element) continue
        try {
            let clickTimeout: Error | undefined
            try { await close.click({ timeout: 5000, noWaitAfter: true }) }
            catch (error) {
                if (!(error instanceof Error) || error.name !== "TimeoutError") throw error
                clickTimeout = error
            }
            try { await element.waitForElementState("hidden", { timeout: 5000 }) }
            catch (error) { throw clickTimeout ?? error }
        } finally { await element.dispose() }
    }
}

export async function dismissMiaoshouLoginNotices(target: Page, noticeWaitMs = 1000) {
    await target.waitForLoadState("domcontentloaded", { timeout: 15000 })
    await target.locator(".jx-dialog:visible").first()
        .waitFor({ state: "visible", timeout: noticeWaitMs }).catch(() => {})
    await closeMiaoshouWebsiteDialogs(target)
}
