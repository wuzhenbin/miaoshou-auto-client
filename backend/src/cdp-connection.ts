import { chromium, type Browser } from "playwright"
import { setTimeout as delay } from "node:timers/promises"

const configuredTimeout = Number(process.env.CDP_CONNECT_TIMEOUT_MS)
const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout >= 3000
    ? Math.min(configuredTimeout, 60_000) : 15_000

/** Chromium can accept the WebSocket before its first CDP response is ready. */
export async function connectOverCdp(url: string): Promise<Browser> {
    let lastError: unknown
    for (let attempt = 0; attempt < 2; attempt++) {
        try { return await chromium.connectOverCDP(url, { timeout: timeoutMs }) }
        catch (error) {
            lastError = error
            if (attempt === 0) await delay(250)
        }
    }
    throw lastError
}

