import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
    plugins: [react()],
    server: { proxy: {
        "/automation-browsers": "http://127.0.0.1:3001",
        "/health": "http://127.0.0.1:3001",
    } },
})
