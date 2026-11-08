import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chromium } from 'playwright'
import { closeMiaoshouWebsiteDialogs, dismissMiaoshouLoginNotices,
    isVerifiedMiaoshouPage } from '../src/miaoshou-login.ts'

test('confirms the account without requiring the management page', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
        const page = await browser.newPage()
        const loginUrl = 'https://erp.91miaoshou.com/'
        await page.route(loginUrl, route => route.fulfill({ body: '<main>妙手首页</main>' }))
        await page.goto(loginUrl)
        assert.equal(await isVerifiedMiaoshouPage(page, async () => true), true)
        assert.equal(await isVerifiedMiaoshouPage(page, async () => false), false)
        await page.setContent('<input type="password">')
        assert.equal(await isVerifiedMiaoshouPage(page, async () => true), true)
        await page.goto('about:blank')
        assert.equal(await isVerifiedMiaoshouPage(page, async () => true), false)
    } finally { await browser.close() }
})

test('dismisses a delayed notice without requiring a management button', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
        const page = await browser.newPage()
        await page.setContent(`<main></main><script>
            setTimeout(() => {
                document.querySelector('main').insertAdjacentHTML('beforeend',
                    '<div class="jx-dialog"><h2>通知</h2><button class="jx-dialog__headerbtn">关闭</button></div>')
            }, 1200)
            document.addEventListener('click', event => event.target.closest('.jx-dialog')?.remove())
        </script>`)
        await dismissMiaoshouLoginNotices(page, 2000)
        assert.equal(await page.locator('.jx-dialog:visible').count(), 0)
    } finally { await browser.close() }
})

test('dismisses website notices while preserving the size-template form', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
        const page = await browser.newPage()
        await page.setContent(`
            <div class="jx-dialog" id="template"><h2>创建尺码表模板</h2><button class="jx-dialog__headerbtn">关闭</button></div>
            <div class="jx-dialog" id="notice-1"><h2>通知</h2><button class="jx-dialog__headerbtn">关闭</button></div>
            <div class="jx-dialog" id="notice-2"><h2>公告</h2><button>取消</button></div>
            <script>document.addEventListener('click', event => event.target.closest('.jx-dialog')?.remove())</script>
        `)
        await closeMiaoshouWebsiteDialogs(page)
        assert.equal(await page.locator('.jx-dialog:visible').count(), 1)
        assert.equal(await page.locator('#template').count(), 1)
    } finally { await browser.close() }
})

test('dismisses nested renewal reminder only through its close control', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
        const page = await browser.newPage()
        await page.setContent(`<div class="jx-dialog" id="overlay"><div role="dialog" class="jx-overlay-dialog">
            <h2>付费版本即将到期提醒</h2><button class="jx-dialog__headerbtn" aria-label="关闭此对话框"></button>
            <button>我要续费</button><button>不再提醒</button></div></div>
            <div class="base-item-edit-dialog" id="template"><h2>创建尺码表模板</h2><button>保存</button></div>
            <script>document.addEventListener('click', event => {
                if (event.target.closest('.jx-dialog__headerbtn')) document.querySelector('#overlay').remove()
                else if (event.target.closest('button')) document.body.dataset.unsafe = 'clicked'
            })</script>`)
        await closeMiaoshouWebsiteDialogs(page)
        assert.equal(await page.locator('#overlay').count(), 0)
        assert.equal(await page.locator('#template').count(), 1)
        assert.equal(await page.locator('body').getAttribute('data-unsafe'), null)
    } finally { await browser.close() }
})

test('stops when a notice has no unique safe close action', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
        const page = await browser.newPage()
        await page.setContent('<div class="jx-dialog"><button>关闭</button><button>取消</button></div>')
        await assert.rejects(closeMiaoshouWebsiteDialogs(page), /没有唯一可用/)
        assert.equal(await page.locator('.jx-dialog:visible').count(), 1)
    } finally { await browser.close() }
})
