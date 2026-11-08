const activeWrites = new Set<symbol>()

export function acquireSizeBrowserWrite(): () => void {
    const token = Symbol("size-browser-write")
    activeWrites.add(token)
    return () => { activeWrites.delete(token) }
}

export function isSizeBrowserWriteActive() {
    return activeWrites.size > 0
}
