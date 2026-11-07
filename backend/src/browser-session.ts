import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { BrowserContext } from "playwright"

type StoredCookie = Awaited<ReturnType<BrowserContext["cookies"]>>[number]
export type MiaoshouCredentials = { account: string; password: string }
export type ConnectionCredentials = { origin: string; username: string; password: string }
const cookieUrl = "https://erp.91miaoshou.com"
const sessionDir = "browser-sessions"
let lastSavedCookies = ""

function isMiaoshouSessionCookie(cookie: StoredCookie) {
    const host = cookie.domain.replace(/^\./, "").toLowerCase()
    return cookie.expires === -1 && (host === "91miaoshou.com" || host.endsWith(".91miaoshou.com"))
}

async function sessionKey(directory: string, create: boolean) {
    const path = join(directory, "key")
    try { return await readFile(path) }
    catch (error) {
        if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        const key = randomBytes(32)
        try { await writeFile(path, key, { flag: "wx", mode: 0o600 }); return key }
        catch (writeError) {
            if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError
            return readFile(path)
        }
    }
}

export async function saveMiaoshouSession(root: string, context: BrowserContext) {
    const cookies = (await context.cookies(cookieUrl)).filter(isMiaoshouSessionCookie)
    if (!cookies.length) return
    const serialized = JSON.stringify(cookies)
    if (serialized === lastSavedCookies) return
    const directory = join(root, sessionDir)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const key = await sessionKey(directory, true)
    if (key.length !== 32) throw new Error("浏览器会话密钥无效")
    const iv = randomBytes(12)
    const cipher = createCipheriv("aes-256-gcm", key, iv)
    const data = Buffer.concat([cipher.update(serialized), cipher.final()])
    const payload = JSON.stringify({ iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") })
    const pending = join(directory, "miaoshou.json.tmp")
    await writeFile(pending, payload, { mode: 0o600 })
    await rename(pending, join(directory, "miaoshou.json"))
    lastSavedCookies = serialized
}

export async function restoreMiaoshouSession(root: string, context: BrowserContext) {
    const directory = join(root, sessionDir)
    try {
        const existing = await context.cookies(cookieUrl)
        if (existing.some(cookie => cookie.name === "autoLoginToken" && isMiaoshouSessionCookie(cookie))) return false
        const key = await sessionKey(directory, false)
        if (key.length !== 32) return false
        const payload = JSON.parse(await readFile(join(directory, "miaoshou.json"), "utf8")) as Record<string, string>
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"))
        decipher.setAuthTag(Buffer.from(payload.tag, "base64"))
        const cookies = JSON.parse(Buffer.concat([decipher.update(Buffer.from(payload.data, "base64")), decipher.final()]).toString()) as StoredCookie[]
        const valid = cookies.filter(isMiaoshouSessionCookie)
        if (!valid.length) return false
        await context.addCookies(valid)
        return true
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
        throw error
    }
}

export async function clearMiaoshouSession(root: string) {
    lastSavedCookies = ""
    await unlink(join(root, sessionDir, "miaoshou.json")).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    })
}

export async function saveMiaoshouCredentials(root: string, credentials: MiaoshouCredentials) {
    const directory = join(root, sessionDir)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const key = await sessionKey(directory, true)
    if (key.length !== 32) throw new Error("浏览器会话密钥无效")
    const iv = randomBytes(12)
    const cipher = createCipheriv("aes-256-gcm", key, iv)
    const data = Buffer.concat([cipher.update(JSON.stringify(credentials)), cipher.final()])
    const pending = join(directory, "miaoshou-credentials.json.tmp")
    await writeFile(pending, JSON.stringify({ iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"),
        data: data.toString("base64") }), { mode: 0o600 })
    await rename(pending, join(directory, "miaoshou-credentials.json"))
}

export async function loadMiaoshouCredentials(root: string): Promise<MiaoshouCredentials | null> {
    const directory = join(root, sessionDir)
    try {
        const key = await sessionKey(directory, false)
        if (key.length !== 32) throw new Error("妙手凭证密钥无效")
        const payload = JSON.parse(await readFile(join(directory, "miaoshou-credentials.json"), "utf8")) as Record<string, string>
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"))
        decipher.setAuthTag(Buffer.from(payload.tag, "base64"))
        const value = JSON.parse(Buffer.concat([decipher.update(Buffer.from(payload.data, "base64")), decipher.final()]).toString()) as MiaoshouCredentials
        if (typeof value.account !== "string" || typeof value.password !== "string") throw new Error("妙手凭证无效")
        return value
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
        throw error
    }
}

export async function clearMiaoshouCredentials(root: string) {
    await unlink(join(root, sessionDir, "miaoshou-credentials.json")).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    })
}

export async function saveConnectionCredentials(root: string, credentials: ConnectionCredentials) {
    const directory = join(root, sessionDir)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const key = await sessionKey(directory, true)
    if (key.length !== 32) throw new Error("业务连接凭证密钥无效")
    const iv = randomBytes(12)
    const cipher = createCipheriv("aes-256-gcm", key, iv)
    const data = Buffer.concat([cipher.update(JSON.stringify(credentials)), cipher.final()])
    const pending = join(directory, "connection-credentials.json.tmp")
    await writeFile(pending, JSON.stringify({ iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"),
        data: data.toString("base64") }), { mode: 0o600 })
    await rename(pending, join(directory, "connection-credentials.json"))
}

export async function loadConnectionCredentials(root: string): Promise<ConnectionCredentials | null> {
    const directory = join(root, sessionDir)
    try {
        const key = await sessionKey(directory, false)
        if (key.length !== 32) throw new Error("业务连接凭证密钥无效")
        const payload = JSON.parse(await readFile(join(directory, "connection-credentials.json"), "utf8")) as Record<string, string>
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"))
        decipher.setAuthTag(Buffer.from(payload.tag, "base64"))
        const value = JSON.parse(Buffer.concat([decipher.update(Buffer.from(payload.data, "base64")), decipher.final()]).toString()) as ConnectionCredentials
        if (typeof value.origin !== "string" || typeof value.username !== "string" || typeof value.password !== "string")
            throw new Error("业务连接凭证无效")
        return value
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
        throw error
    }
}
