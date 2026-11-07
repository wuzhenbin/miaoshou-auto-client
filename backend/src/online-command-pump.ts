import type { StoredCommand, StoredResult } from "./online-command-store.js"

type CommandStore = {
    next(): StoredCommand | null
    start(id: string): boolean
    finish(result: StoredResult): void
}

export function createOnlineCommandPump(store: CommandStore,
    execute: (command: StoredCommand) => Promise<StoredResult>,
    deliver: () => Promise<void>, ready: () => boolean, limit: () => number) {
    let activeSizes = 0
    let activeOther = false
    return function pump() {
        if (!ready()) return
        while (!activeOther && activeSizes < limit()) {
            const command = store.next()
            if (!command?.id || !command.type) return
            const size = command.type.startsWith("size_template_")
            if (!size && activeSizes > 0) return
            if (!store.start(command.id)) return
            if (size) activeSizes++
            else activeOther = true
            void Promise.resolve().then(() => execute(command)).catch(error => ({
                type: "online_result" as const, id: command.id!, ok: false,
                data: { saveStarted: ["size_template_create", "browser_goods_model_create"].includes(command.type!) },
                error: error instanceof Error ? error.message.split("\n")[0] : "客户端命令异常",
            })).then(result => {
                store.finish(result)
                void deliver().catch(() => {})
            }).catch(error => {
                console.warn("在线命令结果持久化失败", error)
            }).finally(() => {
                if (size) activeSizes--
                else activeOther = false
                pump()
            })
            if (!size) return
        }
    }
}
