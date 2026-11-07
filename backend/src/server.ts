import "dotenv/config"
import { buildApp } from "./app.js"
import { startOnlineClient } from "./online-client.js"

const host = process.env.HOST?.trim() || "127.0.0.1"
const port = Number(process.env.PORT || 3001)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid TCP port")

const app = buildApp()
const stopOnlineClient = startOnlineClient()
app.addHook("onClose", async () => { stopOnlineClient() })
app.listen({ host, port }).catch(error => {
    console.error(error)
    process.exitCode = 1
})
