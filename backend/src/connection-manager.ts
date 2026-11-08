import { inspectMiaoshouAccount } from "./browser-inspection.js"
import { OnlineCommandQueueConflictError, startOnlineClient, type OnlineConnectionState } from "./online-client.js"
import { loadConnectionCredentials, saveConnectionCredentials } from "./browser-session.js"
import { runtimeRoot } from "./visible-browsers.js"
import { onlineCommandStore } from "./online-command-store.js"

const gatewayOrigin = process.env.CLIENT_GATEWAY_ORIGIN?.trim() || "https://103.112.1.161"
const localBusinessApi = (() => {
    const input = process.env.CLIENT_LOCAL_BUSINESS_API?.trim()
    if (!input) return null
    let url: URL
    try { url = new URL(input) }
    catch { throw new Error("CLIENT_LOCAL_BUSINESS_API 必须是本机 HTTP 根地址") }
    if (process.env.NODE_ENV === "production" || url.protocol !== "http:"
        || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
        || url.username || url.password || url.search || url.hash || url.pathname !== "/")
        throw new Error("CLIENT_LOCAL_BUSINESS_API 仅允许开发环境的本机 HTTP 根地址")
    if (process.env.CLIENT_GATEWAY_ORIGIN?.trim())
        throw new Error("本地直连不能同时配置公网业务网关")
    return url.origin + "/"
})()
const localExpectedAccount = localBusinessApi ? process.env.CLIENT_LOCAL_MIAOSHOU_ACCOUNT?.trim() : null
if (localBusinessApi && !localExpectedAccount) throw new Error("本地直连必须配置 CLIENT_LOCAL_MIAOSHOU_ACCOUNT")
const matchesLocalAccount = (account: { mobile?: string; accountName?: string; email?: string }) => {
    const expected = localExpectedAccount!.toLowerCase()
    return [account.mobile, account.accountName, account.email].some(value => {
        const actual = value?.trim().toLowerCase()
        return actual === expected || /^\d{11}$/.test(expected)
            && actual === `${expected.slice(0, 3)}****${expected.slice(-4)}`
    })
}

export type ConnectionStatus = {
    state: "credentials_required" | "login_required" | "unsupported_account" | "connecting"
        | "online" | "offline" | "unauthorized" | "unavailable" | "queue_conflict"
    account: string | null
    credentialsSet: boolean
    local: boolean
}

export function createConnectionManager() {
    let credentials: { username: string; password: string } | null = null
    let stopOnlineClient: (() => void) | null = null
    let activeRoute: string | null = null
    let generation = 0
    let checking = false
    let pausedForLogout = false
    let status: Omit<ConnectionStatus, "local"> = localBusinessApi
        ? { state: "login_required", account: null, credentialsSet: true }
        : { state: "credentials_required", account: null, credentialsSet: false }

    const stop = () => {
        generation++
        stopOnlineClient?.()
        stopOnlineClient = null
        activeRoute = null
    }
    const check = async () => {
        if (checking || pausedForLogout || (!localBusinessApi && !credentials)) return
        checking = true
        try {
            const account = await inspectMiaoshouAccount()
            if (pausedForLogout) return
            if (!account) {
                stop()
                status = { state: "login_required", account: null, credentialsSet: true }
                return
            }
            if (localBusinessApi && !matchesLocalAccount(account)) {
                stop()
                status = { state: "unsupported_account", account: null, credentialsSet: true }
                return
            }
            const currentGeneration = generation
            let route: string | null = localBusinessApi ? "local" : null
            if (!localBusinessApi) {
                try {
                    const response = await fetch(`${gatewayOrigin}/admin/online-client-route`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json",
                            Authorization: `Basic ${Buffer.from(`${credentials!.username}:${credentials!.password}`).toString("base64")}` },
                        body: JSON.stringify(account), signal: AbortSignal.timeout(8000),
                    })
                    if (generation !== currentGeneration) return
                    if (response.status === 401) {
                        stop()
                        status = { state: "unauthorized", account: null, credentialsSet: true }
                        return
                    }
                    if (response.status === 404) {
                        stop()
                        status = { state: "unsupported_account", account: null, credentialsSet: true }
                        return
                    }
                    if (!response.ok) throw Error(`HTTP ${response.status}`)
                    const data = await response.json() as { route?: unknown }
                    if (typeof data.route !== "string" || !/^account-[a-z0-9-]+$/.test(data.route)) throw Error("invalid route")
                    route = data.route
                } catch {
                    if (generation === currentGeneration) {
                        stop()
                        status = { state: "unavailable", account: null, credentialsSet: true }
                    }
                    return
                }
            }
            if (!route) {
                stop()
                status = { state: "unsupported_account", account: null, credentialsSet: true }
                return
            }
            if (pausedForLogout) return
            if (route === activeRoute) return
            stop()
            const connectingGeneration = generation
            status = { state: "connecting", account: route, credentialsSet: true }
            try {
                stopOnlineClient = startOnlineClient({
                    base: localBusinessApi ?? `${gatewayOrigin}/${route}/api/`,
                    ...(localBusinessApi ? {} : { basicUsername: credentials!.username, basicPassword: credentials!.password }),
                    onStatus: (state: OnlineConnectionState) => {
                        if (generation === connectingGeneration)
                            status = { state, account: route, credentialsSet: true }
                    },
                })
                activeRoute = route
            } catch (error) {
                console.warn("在线客户端连接启动失败", error)
                status = { state: error instanceof OnlineCommandQueueConflictError ? "queue_conflict" : "unavailable",
                    account: route, credentialsSet: true }
            }
        } finally { checking = false }
    }
    const timer = setInterval(() => void check(), 3000)
    timer.unref()
    const ready = localBusinessApi ? Promise.resolve().then(() => { void check() }) : loadConnectionCredentials(runtimeRoot()).then(saved => {
        if (!saved || saved.origin !== gatewayOrigin) return
        credentials = { username: saved.username, password: saved.password }
        status = { state: "login_required", account: null, credentialsSet: true }
        void check()
    }).catch(() => { console.warn("本机业务连接凭证无法读取，请在页面重新输入") })
    return {
        ready,
        status: (): ConnectionStatus => ({ ...status, local: Boolean(localBusinessApi) }),
        pauseForLogout() {
            pausedForLogout = true
            stop()
            if (onlineCommandStore.hasBlockingCommands()) {
                pausedForLogout = false
                status = { state: "connecting", account: null, credentialsSet: Boolean(localBusinessApi || credentials) }
                void check()
                return false
            }
            status = { state: "login_required", account: null, credentialsSet: Boolean(localBusinessApi || credentials) }
            return true
        },
        resumeAfterLogout() { pausedForLogout = false; void check() },
        async setCredentials(username: string, password: string) {
            if (localBusinessApi) throw new Error("本地直连不使用入口 Basic 凭证")
            await ready
            await saveConnectionCredentials(runtimeRoot(), { origin: gatewayOrigin, username, password })
            stop()
            credentials = { username, password }
            status = { state: "login_required", account: null, credentialsSet: true }
            void check()
            return status
        },
        close() { clearInterval(timer); stop(); credentials = null },
    }
}

export type ConnectionManager = ReturnType<typeof createConnectionManager>
