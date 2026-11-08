import { useEffect, useState } from "react"
import { Alert, Button, Input, Tag } from "antd"
import { Cpu, Edit2, Play, RefreshCw } from "react-feather"

type BrowserState = "running" | "stopped" | "unknown"
type BrowserKind = "sizeTemplate" | "shared"
type BrowserMode = "visible" | "headless" | "unmanaged" | "stopped"
type WindowState = "open" | "minimized" | "unknown"
type LoginState = "logged_in" | "not_logged_in" | "unknown"
type BrowserInspection = { window: WindowState; session: { state: LoginState; account: string | null } }
type BrowserStatus = { sizeTemplate: BrowserState; shared: BrowserState; modes: Record<BrowserKind, BrowserMode>;
    inspections: Record<BrowserKind, BrowserInspection>; checkedAt: string }
type ConnectionState = "credentials_required" | "login_required" | "unsupported_account" | "connecting"
    | "online" | "offline" | "unauthorized" | "unavailable" | "queue_conflict"
type ConnectionStatus = { state: ConnectionState; account: string | null; credentialsSet: boolean; local?: boolean }
type MiaoshouLogin = { phase: "idle" | "loading" | "captcha_required" | "submitting" | "logged_in" | "failed" | "unknown";
    account: string | null; message: string }
type AlibabaLogin = { phase: "idle" | "opening" | "waiting_scan" | "scanned" | "verification_required" | "signed_in" | "expired" | "failed";
    message: string; qrAvailable: boolean; smsRetryAfterSeconds: number }

const labels: Record<BrowserState, { text: string; color: string }> = {
    running: { text: "已启动", color: "success" },
    stopped: { text: "未启动", color: "default" },
    unknown: { text: "待确认", color: "warning" },
}
const connectionLabels: Record<ConnectionState, { text: string; color: string }> = {
    credentials_required: { text: "未连接", color: "default" },
    login_required: { text: "等待妙手登录", color: "warning" },
    unsupported_account: { text: "账号未接入", color: "error" },
    connecting: { text: "连接中", color: "processing" },
    online: { text: "在线", color: "success" },
    offline: { text: "离线", color: "warning" },
    unauthorized: { text: "入口认证失败", color: "error" },
    unavailable: { text: "连接失败", color: "error" },
    queue_conflict: { text: "待处理命令未确认", color: "error" },
}

export function App() {
    const [status, setStatus] = useState<BrowserStatus | null>(null)
    const [error, setError] = useState("")
    const [revision, setRevision] = useState(0)
    const [opening, setOpening] = useState<BrowserKind | null>(null)
    const [actionError, setActionError] = useState("")
    const [connection, setConnection] = useState<ConnectionStatus | null>(null)
    const [connectionError, setConnectionError] = useState("")
    const [username, setUsername] = useState("")
    const [password, setPassword] = useState("")
    const [editingCredentials, setEditingCredentials] = useState(false)
    const [submittingCredentials, setSubmittingCredentials] = useState(false)
    const [miaoshouLogin, setMiaoshouLogin] = useState<MiaoshouLogin | null>(null)
    const [alibabaLogin, setAlibabaLogin] = useState<AlibabaLogin | null>(null)
    const [smsCode, setSmsCode] = useState("")
    const [qrVersion, setQrVersion] = useState(0)
    const [loginBusy, setLoginBusy] = useState(false)
    const [loginError, setLoginError] = useState("")
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
    useEffect(() => {
        const controller = new AbortController()
        let timer: ReturnType<typeof setTimeout>
        const refresh = async () => {
            try {
                const response = await fetch("/connection", { cache: "no-store", signal: controller.signal })
                if (!response.ok) throw new Error("连接状态读取失败")
                setConnection(await response.json() as ConnectionStatus)
                setConnectionError("")
            } catch (cause) {
                if (!controller.signal.aborted) setConnectionError(cause instanceof Error ? cause.message : "连接状态读取失败")
            } finally {
                if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), 3000)
            }
        }
        void refresh()
        return () => { controller.abort(); clearTimeout(timer) }
    }, [])
    useEffect(() => {
        const controller = new AbortController()
        let timer: ReturnType<typeof setTimeout>
        const refresh = async () => {
            try {
                const [miaoshou, alibaba] = await Promise.all([
                    fetch("/miaoshou-login/status", { cache: "no-store", signal: controller.signal }),
                    fetch("/alibaba-login/status", { cache: "no-store", signal: controller.signal }),
                ])
                if (!miaoshou.ok || !alibaba.ok) throw new Error("登录状态读取失败")
                const nextMiaoshou = await miaoshou.json() as MiaoshouLogin
                const nextAlibaba = await alibaba.json() as AlibabaLogin
                if (!controller.signal.aborted) {
                    setMiaoshouLogin(nextMiaoshou)
                    setAlibabaLogin(nextAlibaba)
                    if (nextAlibaba.phase === "waiting_scan" && nextAlibaba.qrAvailable) setQrVersion(value => value + 1)
                }
            } catch { /* Browser status remains available while a login page is loading. */ }
            finally { if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), 3000) }
        }
        void refresh()
        return () => { controller.abort(); clearTimeout(timer) }
    }, [])
    const postLogin = async (url: string, body?: object, method = "POST") => {
        const response = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : undefined,
            body: body ? JSON.stringify(body) : undefined })
        const raw = await response.text()
        if (!raw) throw new Error(response.status === 404
            ? "登录接口不可用，请重启客户端并确认打开的是本机客户端页面"
            : `登录接口返回空响应（HTTP ${response.status}）`)
        const result = JSON.parse(raw) as { error?: { message?: string } }
        if (!response.ok) throw new Error(result.error?.message ?? "登录操作失败")
        return result
    }
    const loginAction = async (action: () => Promise<void>) => {
        setLoginBusy(true)
        setLoginError("")
        try { await action() }
        catch (cause) { setLoginError(cause instanceof Error ? cause.message : "登录操作失败") }
        finally { setLoginBusy(false) }
    }
    const submitCredentials = async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        setSubmittingCredentials(true)
        setConnectionError("")
        try {
            const response = await fetch("/connection", { method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ username, password }) })
            const result = await response.json() as ConnectionStatus & { error?: { message?: string } }
            if (!response.ok) throw new Error(result.error?.message ?? "入口认证信息提交失败")
            setConnection(result)
            setPassword("")
            setEditingCredentials(false)
        } catch (cause) { setConnectionError(cause instanceof Error ? cause.message : "入口认证信息提交失败") }
        finally { setSubmittingCredentials(false) }
    }
    const changeWindow = async (kind: BrowserKind) => {
        setOpening(kind)
        setActionError("")
        try {
            const action = kind === "sizeTemplate" ? "open-visible" : "start-headless"
            const response = await fetch(`/automation-browsers/${kind}/${action}`, { method: "POST" })
            const result = await response.json() as { error?: { message?: string } }
            if (!response.ok) throw new Error(result.error?.message ?? "浏览器窗口打开失败")
            setRevision(value => value + 1)
            if (kind === "shared") setAlibabaLogin(await postLogin("/alibaba-login/start") as AlibabaLogin)
        } catch (cause) { setActionError(cause instanceof Error ? cause.message : "浏览器窗口打开失败") }
        finally { setOpening(null) }
    }
    const browserHeading = (kind: BrowserKind, name: string) => {
        const mode = status?.modes[kind]
        return <div className="browser-panel-heading">
            <div><span className="browser-kicker">{kind === "sizeTemplate" ? "CDP 9223" : "CDP 9224"}</span><h3>{name}</h3></div>
            {mode === "stopped" && <Button type="primary" loading={opening === kind} disabled={opening !== null}
                icon={<Play size={15} />} onClick={() => void changeWindow(kind)}>启动</Button>}
            {mode === "headless" && (kind === "sizeTemplate"
                ? <span className="browser-note">无头实例运行中，请在任务空闲后关闭再启动可见窗口</span>
                : <span className="browser-running"><span className="status-dot" />运行中</span>)}
            {mode === "visible" && (kind === "sizeTemplate"
                ? <Button icon={<Play size={15} />} loading={opening === kind} disabled={opening !== null}
                    onClick={() => void changeWindow(kind)}>打开窗口</Button>
                : <span className="browser-note">可见实例运行中，请先在任务空闲后关闭</span>)}
            {mode === "unmanaged" && <span className="browser-note">端口由其他进程占用</span>}
        </div>
    }
    return <main className="workspace">
        <header><div className="header-brand">
            <span className="brand-mark" aria-hidden="true"><Cpu size={21} strokeWidth={1.9} /></span>
            <div><span className="eyebrow">妙手自动化 / 本机客户端</span><h1>自动化工作台</h1></div>
        </div>
            <div className="header-actions">
                <span className={`header-connection ${connection?.state === "online" ? "is-online" : ""}`}>
                    <span className="status-dot" />{connection ? connectionLabels[connection.state].text : "状态读取中"}
                </span>
                <Button icon={<RefreshCw size={15} />} onClick={() => setRevision(value => value + 1)} title="刷新浏览器状态" aria-label="刷新浏览器状态" />
            </div>
        </header>
        <section aria-label="业务连接">
            <div className="section-title"><h2>业务连接</h2></div>
            <div className="connection-row">
                <Tag color={connection ? connectionLabels[connection.state].color : "processing"}>
                    {connection ? connectionLabels[connection.state].text : "读取中"}
                </Tag>
                <span>{connection?.local ? "本机直连 · 妙手账号按本机配置核验"
                    : connection?.account ? `妙手账号 ${connection.account.replace("account-", "")}` : ""}</span>
                {connection?.credentialsSet && !connection.local && !editingCredentials &&
                    <Button icon={<Edit2 size={15} />} title="更改入口认证" aria-label="更改入口认证"
                        onClick={() => setEditingCredentials(true)} />}
            </div>
            {!connection?.local && (!connection?.credentialsSet || editingCredentials) &&
                <form className="credentials-form" onSubmit={event => void submitCredentials(event)}>
                    <label>Basic 用户名<Input value={username} onChange={event => setUsername(event.target.value)}
                        autoComplete="username" maxLength={128} required /></label>
                    <label>Basic 密码<Input.Password value={password} onChange={event => setPassword(event.target.value)}
                        autoComplete="current-password" maxLength={512} required /></label>
                    <Button type="primary" htmlType="submit" loading={submittingCredentials}>连接</Button>
                </form>}
            {connectionError && <Alert type="error" showIcon title={connectionError} />}
        </section>
        <section aria-label="浏览器实例">
            <div className="section-title"><h2>浏览器实例</h2><span>{status ? `更新于 ${new Date(status.checkedAt).toLocaleTimeString("zh-CN", { hour12: false })}` : ""}</span></div>
            {error && <Alert type="warning" showIcon title={error} description="当前启动状态待确认。" />}
            {actionError && <Alert type="error" showIcon title={actionError} />}
            {loginError && <Alert type="error" showIcon title={loginError} />}
            <div className="browser-panels">
            <article className="browser-panel" aria-label="妙手尺码表">
            {browserHeading("sizeTemplate", "妙手尺码表")}
            <div className="connection-row">
                <Tag color={miaoshouLogin?.phase === "logged_in" ? "success" : "warning"}>
                    {miaoshouLogin?.phase === "logged_in" ? "已登录" : miaoshouLogin?.phase === "unknown" ? "待确认" : "未登录"}
                </Tag>
                <span>{miaoshouLogin?.phase === "logged_in" ? `妙手账号 ${miaoshouLogin.account}`
                    : status?.modes.sizeTemplate === "stopped" ? "请启动妙手浏览器"
                    : miaoshouLogin?.phase === "unknown" ? "妙手登录状态待确认"
                    : "请在妙手浏览器窗口登录"}</span>
            </div>
            </article>
            <article className="browser-panel" aria-label="通用自动化">
            {browserHeading("shared", "通用自动化")}
            <div className="connection-row"><Tag color={alibabaLogin?.phase === "signed_in" ? "success" : "warning"}>
                {alibabaLogin?.phase === "signed_in" ? "已登录" : alibabaLogin?.phase === "verification_required" ? "待验证" : "未登录"}
            </Tag><span>{alibabaLogin?.message ?? "读取中"}</span>
                <Button icon={<RefreshCw size={15} />} disabled={status?.modes.shared !== "headless" || loginBusy}
                    onClick={() => void loginAction(async () => setAlibabaLogin(await postLogin("/alibaba-login/start") as AlibabaLogin))}
                    title="刷新 1688 二维码">刷新</Button></div>
            {alibabaLogin?.phase === "waiting_scan" && alibabaLogin.qrAvailable &&
                <img className="qr-image" src={`/alibaba-login/qr?v=${qrVersion}`} alt="1688 登录二维码" />}
            {alibabaLogin?.phase === "verification_required" && <div className="login-actions">
                <Button disabled={loginBusy || alibabaLogin.smsRetryAfterSeconds > 0} onClick={() => void loginAction(async () =>
                    setAlibabaLogin(await postLogin("/alibaba-login/sms/request") as AlibabaLogin))}>
                    {alibabaLogin.smsRetryAfterSeconds > 0 ? `${alibabaLogin.smsRetryAfterSeconds} 秒后重发` : "获取短信验证码"}</Button>
                <form className="challenge-form" onSubmit={event => {
                    event.preventDefault()
                    void loginAction(async () => {
                        setAlibabaLogin(await postLogin("/alibaba-login/sms/verify", { code: smsCode }) as AlibabaLogin)
                        setSmsCode("")
                    })
                }}><label>短信验证码<Input value={smsCode} onChange={event => setSmsCode(event.target.value.replace(/\D/g, ""))}
                    inputMode="numeric" maxLength={8} required /></label><Button type="primary" htmlType="submit" loading={loginBusy}>确认</Button></form>
            </div>}
            </article>
            </div>
        </section>
    </main>
}
