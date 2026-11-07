import { useEffect, useState } from "react"
import { Alert, Button, Tag } from "antd"
import { Maximize2, Minimize2, RefreshCw } from "react-feather"

type BrowserState = "running" | "stopped" | "unknown"
type BrowserKind = "sizeTemplate" | "shared"
type BrowserMode = "visible" | "headless" | "unmanaged" | "stopped"
type WindowState = "open" | "minimized" | "unknown"
type LoginState = "logged_in" | "not_logged_in" | "unknown"
type BrowserInspection = { window: WindowState; session: { state: LoginState; account: string | null } }
type BrowserStatus = { sizeTemplate: BrowserState; shared: BrowserState; modes: Record<BrowserKind, BrowserMode>;
    inspections: Record<BrowserKind, BrowserInspection>; checkedAt: string }

const labels: Record<BrowserState, { text: string; color: string }> = {
    running: { text: "已启动", color: "success" },
    stopped: { text: "未启动", color: "default" },
    unknown: { text: "待确认", color: "warning" },
}

export function App() {
    const [status, setStatus] = useState<BrowserStatus | null>(null)
    const [error, setError] = useState("")
    const [revision, setRevision] = useState(0)
    const [opening, setOpening] = useState<BrowserKind | null>(null)
    const [actionError, setActionError] = useState("")
    useEffect(() => {
        const controller = new AbortController()
        let timer: ReturnType<typeof setTimeout>
        const refresh = async () => {
            try {
                const response = await fetch("/automation-browsers/status", { cache: "no-store", signal: controller.signal })
                if (!response.ok) throw new Error("浏览器状态读取失败")
                const data = await response.json() as BrowserStatus
                if (![data.sizeTemplate, data.shared].every(value => Object.hasOwn(labels, value))
                    || ![data.modes?.sizeTemplate, data.modes?.shared].every(value => ["visible", "headless", "unmanaged", "stopped"].includes(value))
                    || ![data.inspections?.sizeTemplate, data.inspections?.shared].every(value => value
                        && ["open", "minimized", "unknown"].includes(value.window)
                        && ["logged_in", "not_logged_in", "unknown"].includes(value.session?.state))
                    || data.inspections.sizeTemplate.session.state === "logged_in"
                        && !data.inspections.sizeTemplate.session.account?.trim()
                    || !Number.isFinite(Date.parse(data.checkedAt)))
                    throw new Error("浏览器状态响应异常")
                setStatus(data)
                setError("")
            } catch (cause) {
                if (!controller.signal.aborted) {
                    setStatus(null)
                    setError(cause instanceof Error ? cause.message : "浏览器状态读取失败")
                }
            } finally {
                if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), 3000)
            }
        }
        void refresh()
        return () => { controller.abort(); clearTimeout(timer) }
    }, [revision])
    const stateTag = (value?: BrowserState) => <Tag color={value ? labels[value].color : error ? "warning" : "processing"}>
        {value ? labels[value].text : error ? "待确认" : "读取中"}
    </Tag>
    const changeWindow = async (kind: BrowserKind, action: "open-visible" | "minimize") => {
        setOpening(kind)
        setActionError("")
        try {
            const response = await fetch(`/automation-browsers/${kind}/${action}`, { method: "POST" })
            const result = await response.json() as { error?: { message?: string } }
            if (!response.ok) throw new Error(result.error?.message ?? "浏览器窗口打开失败")
            setRevision(value => value + 1)
        } catch (cause) { setActionError(cause instanceof Error ? cause.message : "浏览器窗口打开失败") }
        finally { setOpening(null) }
    }
    const browserRow = (kind: BrowserKind, name: string) => {
        const mode = status?.modes[kind]
        const inspection = status?.inspections[kind]
        const session = inspection?.session
        const isOpen = mode === "visible" && inspection?.window === "open"
        const action = isOpen ? "minimize" : "open-visible"
        const sessionLabel = mode !== "visible" || status?.[kind] !== "running" ? "未检查"
            : session?.state === "logged_in" ? kind === "sizeTemplate" ? `已登录：${session.account}` : "已登录"
            : session?.state === "not_logged_in" ? "未登录" : "登录待确认"
        return <div className="browser-row" key={kind}>
            <strong>{name}</strong>{stateTag(status?.[kind])}
            <span className="session-state" title={sessionLabel}>{sessionLabel}</span>
            <Button loading={opening === kind} disabled={opening !== null || !mode || mode === "headless" || mode === "unmanaged"}
                icon={isOpen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
                onClick={() => void changeWindow(kind, action)}>{isOpen ? "收起" : "打开"}</Button>
            {mode === "headless" && <span className="browser-note">无头实例运行中，请先在任务空闲后关闭</span>}
            {mode === "unmanaged" && <span className="browser-note">端口由其他进程占用</span>}
        </div>
    }
    return <main className="workspace">
        <header><div><span className="eyebrow">本机客户端</span><h1>自动化浏览器</h1></div>
            <Button icon={<RefreshCw size={15} />} onClick={() => setRevision(value => value + 1)} title="刷新浏览器状态" aria-label="刷新浏览器状态" />
        </header>
        <section aria-label="浏览器运行状态">
            <div className="section-title"><h2>浏览器运行状态</h2><span>{status ? `检查于 ${new Date(status.checkedAt).toLocaleTimeString("zh-CN", { hour12: false })}` : ""}</span></div>
            {browserRow("sizeTemplate", "妙手尺码表")}
            {browserRow("shared", "通用自动化")}
            {error && <Alert type="warning" showIcon title={error} description="当前启动状态待确认。" />}
            {actionError && <Alert type="error" showIcon title={actionError} />}
        </section>
    </main>
}
