import WebSocket from "ws"
import { inspectMiaoshouAccount } from "./browser-inspection.js"
import { testFillSizeTemplate, type TestFillCommand } from "./size-template-test-fill.js"
import { executeOnlineSizeTemplateCommand } from "./size-template-online-client.js"
import { executeOnlineBrowserCommand } from "./online-browser-operations.js"
import { onlineCommandStore, type StoredCommand } from "./online-command-store.js"
import { createOnlineCommandPump } from "./online-command-pump.js"

const clientId = onlineCommandStore.clientId
const heartbeatMs = 10_000
const reconnectMs = 30_000
const ackTimeoutMs = 25_000

export type OnlineConnectionState = "online" | "offline" | "unauthorized" | "unavailable"
export type OnlineClientOptions = { base: string; basicUsername: string; basicPassword: string;
    onStatus: (state: OnlineConnectionState) => void }

export class OnlineCommandQueueConflictError extends Error {}

export function startOnlineClient({ base, basicUsername, basicPassword, onStatus }: OnlineClientOptions) {
    const target = new URL("auth/online-client/heartbeat", `${base.replace(/\/+$/, "")}/`)
    const resultTarget = new URL("auth/online-client/result", `${base.replace(/\/+$/, "")}/`)
    const websocketTarget = new URL("auth/online-client/ws", `${base.replace(/\/+$/, "")}/`)
    if (!onlineCommandStore.bindTarget(target.origin + target.pathname))
        throw new OnlineCommandQueueConflictError("在线命令队列仍有未确认业务命令，不能切换业务后端地址")
    websocketTarget.protocol = target.protocol === "https:" ? "wss:" : "ws:"
    if (!["http:", "https:"].includes(target.protocol)) throw new Error("业务后端地址必须使用 HTTP 或 HTTPS")
    const headers: Record<string, string> = { "Content-Type": "application/json",
        Authorization: `Basic ${Buffer.from(`${basicUsername}:${basicPassword}`).toString("base64")}` }
    let stopped = false
    let busy = false
    let socket: WebSocket | null = null
    let lastAckAt = 0
    let nextWebSocketAttempt = 0
    let testing = false
    let accountReady = false
    let sizeTemplateConcurrency = 0
    let deliveringResults = false
    const warnedOrphans = new Set<string>()
    const deliverResults = async () => {
        if (stopped || deliveringResults) return
        deliveringResults = true
        try {
            const account = await inspectMiaoshouAccount()
            if (stopped || !account || !onlineCommandStore.bindAccount(account)) return
            for (const result of onlineCommandStore.results()) {
                if (stopped) return
                const kind = onlineCommandStore.kind(result.id)
                const delivery = { ...result, commandKind: kind }
                try {
                const response = await fetch(resultTarget, { method: "POST", headers,
                    body: JSON.stringify({ clientId, account, result: delivery }), signal: AbortSignal.timeout(8000) })
                    if (!response.ok) throw new Error(`HTTP ${response.status}`)
                    const receipt = await response.json() as { received?: unknown }
                    if (receipt.received === true) onlineCommandStore.ack(result.id)
                    else if (receipt.received === false) {
                        if (!onlineCommandStore.archiveOrphanedRead(result.id) && !warnedOrphans.has(result.id)) {
                            warnedOrphans.add(result.id)
                            console.warn(`在线业务命令 ${result.id} 的服务端请求已失效，结果保留待对账`)
                        }
                    }
                } catch {
                    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(delivery))
                }
            }
        } finally { deliveringResults = false }
    }
    const pumpCommands = createOnlineCommandPump(onlineCommandStore,
        message => message.type?.startsWith("browser_")
            ? executeOnlineBrowserCommand(message) : executeOnlineSizeTemplateCommand(message),
        deliverResults, () => !stopped && accountReady, () => sizeTemplateConcurrency)
    const executeCommand = (message: StoredCommand) => {
        if (stopped) return
        if (onlineCommandStore.receive(message)) {
            pumpCommands()
            void deliverResults()
        }
    }
    const connect = () => {
        if (stopped || socket || Date.now() < nextWebSocketAttempt) return
        nextWebSocketAttempt = Date.now() + reconnectMs
        const connection = new WebSocket(websocketTarget, { headers, handshakeTimeout: 5000 })
        socket = connection
        connection.on("open", () => { lastAckAt = Date.now(); void heartbeat() })
        connection.on("message", raw => {
            if (stopped) return
            try {
                const message = JSON.parse(raw.toString()) as { online?: unknown; type?: string; sizeTemplateConcurrency?: unknown }
                if (typeof message.online === "boolean") {
                    lastAckAt = Date.now()
                    onStatus(message.online ? "online" : "offline")
                    sizeTemplateConcurrency = message.online && Number.isSafeInteger(message.sizeTemplateConcurrency)
                        && Number(message.sizeTemplateConcurrency) >= 1 && Number(message.sizeTemplateConcurrency) <= 10
                        ? Number(message.sizeTemplateConcurrency) : 0
                    pumpCommands()
                }
                if (message.type === "result_ack" && typeof (message as { id?: unknown }).id === "string")
                    onlineCommandStore.ack((message as { id: string }).id)
                if (message.type === "test_fill" && !testing) {
                    testing = true
                    void testFillSizeTemplate(message as TestFillCommand).then(result => {
                        if (connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify(result))
                    }).finally(() => { testing = false })
                }
                executeCommand(message)
            } catch { /* An invalid acknowledgement will eventually trigger HTTP fallback. */ }
        })
        connection.on("error", () => { onStatus("unavailable") })
        connection.on("close", () => {
            if (socket === connection) socket = null
            sizeTemplateConcurrency = 0
            if (!stopped) void heartbeat()
        })
    }
    const heartbeat = async () => {
        if (stopped || busy) return
        busy = true
        try {
            connect()
            const account = await inspectMiaoshouAccount()
            accountReady = Boolean(account && onlineCommandStore.bindAccount(account))
            if (!accountReady && account)
                console.warn("在线命令队列仍有未确认命令，当前妙手账号与队列绑定账号不一致")
            if (accountReady) pumpCommands()
            if (!accountReady && account) return
            const body = JSON.stringify({ clientId, account, commandAcks: onlineCommandStore.commandAcks() })
            if (socket?.readyState === WebSocket.OPEN && Date.now() - lastAckAt < ackTimeoutMs) {
                socket.send(body)
                void deliverResults()
                return
            }
            if (socket?.readyState === WebSocket.OPEN) socket.terminate()
            const response = await fetch(target, { method: "POST", headers, body, signal: AbortSignal.timeout(8000) })
            if (!response.ok) {
                onStatus(response.status === 401 ? "unauthorized" : "unavailable")
                console.warn(`在线客户端 HTTP 报到失败：HTTP ${response.status}`)
            }
            else {
                const received = await response.json() as { command?: StoredCommand; commands?: StoredCommand[]; sizeTemplateConcurrency?: number }
                onStatus((received as { online?: boolean }).online ? "online" : "offline")
                sizeTemplateConcurrency = Number.isSafeInteger(received.sizeTemplateConcurrency)
                    && received.sizeTemplateConcurrency! >= 1 && received.sizeTemplateConcurrency! <= 10
                    ? received.sizeTemplateConcurrency! : 0
                for (const command of received.commands ?? (received.command ? [received.command] : [])) executeCommand(command)
                void deliverResults()
            }
        } catch (error) { onStatus("unavailable"); console.warn("在线客户端报到失败", error) }
        finally { busy = false }
    }
    const timer = setInterval(() => void heartbeat(), heartbeatMs)
    timer.unref()
    pumpCommands()
    void heartbeat()
    return () => { stopped = true; clearInterval(timer); socket?.terminate() }
}
