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

export function startOnlineClient() {
    const base = process.env.BUSINESS_BACKEND_URL?.trim() || "http://127.0.0.1:3000/"
    const target = new URL("auth/online-client/heartbeat", `${base.replace(/\/+$/, "")}/`)
    const resultTarget = new URL("auth/online-client/result", `${base.replace(/\/+$/, "")}/`)
    const websocketTarget = new URL("auth/online-client/ws", `${base.replace(/\/+$/, "")}/`)
    if (!onlineCommandStore.bindTarget(target.origin + target.pathname))
        throw new Error("在线命令队列仍有未确认命令，不能切换业务后端地址")
    websocketTarget.protocol = target.protocol === "https:" ? "wss:" : "ws:"
    const basicUser = process.env.BUSINESS_BACKEND_BASIC_USERNAME?.trim()
    const basicPassword = process.env.BUSINESS_BACKEND_BASIC_PASSWORD
    if ((basicUser || basicPassword) && (!basicUser || !basicPassword)) throw new Error("公网入口 Basic 认证配置不完整")
    if (!["http:", "https:"].includes(target.protocol)) throw new Error("业务后端地址必须使用 HTTP 或 HTTPS")
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (basicUser && basicPassword) headers.Authorization = `Basic ${Buffer.from(`${basicUser}:${basicPassword}`).toString("base64")}`
    let stopped = false
    let busy = false
    let socket: WebSocket | null = null
    let lastAckAt = 0
    let nextWebSocketAttempt = 0
    let testing = false
    let accountReady = false
    let sizeTemplateConcurrency = 0
    const deliverResults = async () => {
        const account = await inspectMiaoshouAccount()
        if (!account || !onlineCommandStore.bindAccount(account)) return
        for (const result of onlineCommandStore.results()) {
            if (socket?.readyState === WebSocket.OPEN) { socket.send(JSON.stringify(result)); continue }
            try {
                const response = await fetch(resultTarget, { method: "POST", headers,
                    body: JSON.stringify({ clientId, account, result }), signal: AbortSignal.timeout(8000) })
                if (response.ok && (await response.json() as { received?: boolean }).received)
                    onlineCommandStore.ack(result.id)
            } catch { /* Retry delivery on the next heartbeat; never rerun the browser command. */ }
        }
    }
    const pumpCommands = createOnlineCommandPump(onlineCommandStore,
        message => message.type?.startsWith("browser_")
            ? executeOnlineBrowserCommand(message) : executeOnlineSizeTemplateCommand(message),
        deliverResults, () => !stopped && accountReady, () => sizeTemplateConcurrency)
    const executeCommand = (message: StoredCommand) => {
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
            try {
                const message = JSON.parse(raw.toString()) as { online?: unknown; type?: string; sizeTemplateConcurrency?: unknown }
                if (typeof message.online === "boolean") {
                    lastAckAt = Date.now()
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
        connection.on("error", () => {})
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
            if (!response.ok) console.warn(`在线客户端 HTTP 报到失败：HTTP ${response.status}`)
            else {
                const received = await response.json() as { command?: StoredCommand; commands?: StoredCommand[]; sizeTemplateConcurrency?: number }
                sizeTemplateConcurrency = Number.isSafeInteger(received.sizeTemplateConcurrency)
                    && received.sizeTemplateConcurrency! >= 1 && received.sizeTemplateConcurrency! <= 10
                    ? received.sizeTemplateConcurrency! : 0
                for (const command of received.commands ?? (received.command ? [received.command] : [])) executeCommand(command)
                void deliverResults()
            }
        } catch (error) { console.warn("在线客户端报到失败", error) }
        finally { busy = false }
    }
    const timer = setInterval(() => void heartbeat(), heartbeatMs)
    timer.unref()
    pumpCommands()
    void heartbeat()
    return () => { stopped = true; clearInterval(timer); socket?.terminate() }
}
