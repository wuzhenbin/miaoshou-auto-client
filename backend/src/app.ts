import Fastify from "fastify"
import fastifyStatic from "@fastify/static"
import { resolve } from "node:path"
import { browserMode, registerVisibleBrowserRoutes, type BrowserKind, type BrowserMode } from "./visible-browsers.js"
import { inspectBrowser, type BrowserInspection, type LoginSession } from "./browser-inspection.js"
import { registerMiaoshouLoginRoutes } from "./miaoshou-login.js"
import { registerAlibabaLoginRoutes } from "./alibaba-login.js"
import type { ConnectionManager } from "./connection-manager.js"

type BrowserState = "running" | "stopped" | "unknown"
type BrowserStatus = { sizeTemplate: BrowserState; shared: BrowserState; modes: Record<BrowserKind, BrowserMode>;
    inspections: Record<BrowserKind, BrowserInspection>; checkedAt: string }
type Probe = (url: string, token?: string) => Promise<BrowserState>

const probeBrowser: Probe = async (url, token) => {
    try {
        const response = await fetch(new URL("/json/version", url), {
            headers: token ? { "X-Miaoshou-CDP-Token": token } : undefined,
            signal: AbortSignal.timeout(1500),
        })
        if (!response.ok) return "unknown"
        const version = await response.json() as { Browser?: unknown; webSocketDebuggerUrl?: unknown }
        return typeof version.Browser === "string" && typeof version.webSocketDebuggerUrl === "string"
            ? "running" : "unknown"
    } catch (error) {
        return error instanceof Error && error.name === "TimeoutError" ? "unknown" : "stopped"
    }
}

export function buildApp(probe: Probe = probeBrowser, connection?: ConnectionManager,
    inspectMiaoshouLogin?: () => Promise<LoginSession>) {
    const app = Fastify()
    const frontendDist = process.env.CLIENT_FRONTEND_DIST?.trim()
    app.addHook("onRequest", async (request, reply) => {
        if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return
        const origin = request.headers.origin
        const port = frontendDist ? process.env.PORT || "3001" : "5175"
        const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`])
        if (origin && !allowedOrigins.has(origin) || request.headers["sec-fetch-site"] === "cross-site")
            return reply.code(403).send({ error: { message: "跨站请求已拒绝" } })
    })
    registerVisibleBrowserRoutes(app)
    registerMiaoshouLoginRoutes(app, inspectMiaoshouLogin, connection)
    registerAlibabaLoginRoutes(app)
    app.get("/health", async () => ({ status: "ok" }))
    if (connection) {
        app.get("/connection", async (_request, reply) => {
            reply.header("Cache-Control", "no-store")
            return connection.status()
        })
        app.post<{ Body: { username?: unknown; password?: unknown } }>("/connection", { bodyLimit: 2048 }, async (request, reply) => {
            const { username, password } = request.body ?? {}
            if (typeof username !== "string" || !username.trim() || username.length > 128 || username.includes(":")
                || typeof password !== "string" || !password || password.length > 512)
                return reply.code(400).send({ error: { message: "请输入有效的 Basic 用户名和密码" } })
            reply.header("Cache-Control", "no-store")
            return connection.setCredentials(username.trim(), password)
        })
    }
    app.get("/automation-browsers/status", async (_request, reply): Promise<BrowserStatus> => {
        reply.header("Cache-Control", "no-store")
        const [sizeTemplate, shared] = await Promise.all([
            probe(process.env.SIZE_TEMPLATE_BROWSER_CDP_URL?.trim() || "http://127.0.0.1:9223", process.env.SIZE_TEMPLATE_BROWSER_CDP_TOKEN),
            probe(process.env.AUTOMATION_BROWSER_CDP_URL?.trim() || "http://127.0.0.1:9224", process.env.AUTOMATION_BROWSER_CDP_TOKEN),
        ])
        const modes = { sizeTemplate: browserMode("sizeTemplate"), shared: browserMode("shared") }
        const unavailable: BrowserInspection = { window: "unknown", session: { state: "unknown", account: null } }
        const [sizeInspection, sharedInspection] = await Promise.all([
            ["visible", "headless"].includes(modes.sizeTemplate) && sizeTemplate === "running" ? inspectBrowser("sizeTemplate") : unavailable,
            ["visible", "headless"].includes(modes.shared) && shared === "running" ? inspectBrowser("shared") : unavailable,
        ])
        return { sizeTemplate, shared, modes, inspections: { sizeTemplate: sizeInspection, shared: sharedInspection }, checkedAt: new Date().toISOString() }
    })
    if (frontendDist) void app.register(fastifyStatic, { root: resolve(frontendDist), prefix: "/" })
    return app
}
