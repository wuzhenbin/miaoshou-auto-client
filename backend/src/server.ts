import "dotenv/config"
import { buildApp } from "./app.js"
import { createConnectionManager } from "./connection-manager.js"

const host = process.env.HOST?.trim() || "127.0.0.1"
const port = Number(process.env.PORT || 3001)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid TCP port")

const connection = createConnectionManager()
const app = buildApp(undefined, connection)
app.addHook("onClose", async () => { connection.close() })
let stopping = false
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
    if (stopping) return
    stopping = true
    void app.close().then(() => { process.exitCode = 0 }, error => {
        console.error(error)
        process.exitCode = 1
    })
})
connection.ready.then(() => app.listen({ host, port })).catch(error => {
    console.error(error)
    process.exitCode = 1
})
