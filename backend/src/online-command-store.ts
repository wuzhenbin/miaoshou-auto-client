import { randomUUID } from "node:crypto"
import { chmodSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

export type StoredCommand = { type?: string; id?: string; [key: string]: unknown }
export type StoredResult = { type: "online_result"; id: string; ok: boolean; data?: unknown; error?: string }
const root = join(process.env.MIAOSHOU_RUNTIME_DIR?.trim() || join(homedir(), ".miaoshou-auto"), "online-client")
mkdirSync(root, { recursive: true, mode: 0o700 })
const path = join(root, "commands.sqlite")
const db = new DatabaseSync(path)
chmodSync(path, 0o600)
db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS commands (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('queued','running','completed','uncertain','acked')),
        result TEXT, received_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS superseded_status_commands (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL,
        result TEXT NOT NULL, previous_target TEXT NOT NULL,
        received_at TEXT NOT NULL, completed_at TEXT NOT NULL, superseded_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orphaned_read_results (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, result TEXT NOT NULL,
        backend_target TEXT, miaoshou_account TEXT,
        received_at TEXT NOT NULL, completed_at TEXT NOT NULL, archived_at TEXT NOT NULL
    );`)
const archiveColumns = new Set((db.prepare("PRAGMA table_info(superseded_status_commands)").all() as { name: string }[])
    .map(column => column.name))
if (!archiveColumns.has("previous_account")) db.exec("ALTER TABLE superseded_status_commands ADD COLUMN previous_account TEXT")
if (!archiveColumns.has("reason")) db.exec("ALTER TABLE superseded_status_commands ADD COLUMN reason TEXT NOT NULL DEFAULT 'target_switch'")
const commandColumns = new Set((db.prepare("PRAGMA table_info(commands)").all() as { name: string }[])
    .map(column => column.name))
if (!commandColumns.has("submission_boundary_at")) {
    // Existing running creates predate the explicit boundary and may already have clicked.
    db.exec(`BEGIN IMMEDIATE;
        ALTER TABLE commands ADD COLUMN submission_boundary_at TEXT;
        UPDATE commands SET submission_boundary_at=updated_at
            WHERE kind='size_template_create' AND state='running';
        COMMIT;`)
}
if (!commandColumns.has("save_evidence")) db.exec("ALTER TABLE commands ADD COLUMN save_evidence TEXT")
if (!commandColumns.has("stage")) db.exec("ALTER TABLE commands ADD COLUMN stage TEXT")
if (!commandColumns.has("filling_at")) db.exec("ALTER TABLE commands ADD COLUMN filling_at TEXT")
if (!commandColumns.has("result_at")) db.exec("ALTER TABLE commands ADD COLUMN result_at TEXT")
if (!commandColumns.has("progress_reported_stage")) db.exec("ALTER TABLE commands ADD COLUMN progress_reported_stage TEXT")
// Legacy rows must never masquerade as newly observed stages.
db.exec(`UPDATE commands SET stage=CASE
    WHEN state IN ('completed','uncertain','acked') THEN 'result'
    WHEN submission_boundary_at IS NOT NULL THEN 'save_boundary'
    WHEN state='running' THEN 'filling' ELSE 'received' END
    WHERE kind='size_template_create' AND stage IS NULL`)
db.exec(`UPDATE commands SET progress_reported_stage=CASE
    WHEN submission_boundary_at IS NOT NULL OR state IN ('completed','uncertain','acked') THEN 'save_boundary'
    WHEN state='running' THEN 'filling' ELSE 'received' END
    WHERE kind='size_template_create' AND progress_reported_stage IS NULL AND received_at <> updated_at
        AND result_at IS NULL AND filling_at IS NULL`)

db.exec("DELETE FROM commands WHERE state='acked' AND kind IN ('browser_status','browser_size_status')")

const getMeta = db.prepare("SELECT value FROM metadata WHERE key=?")
const setMeta = db.prepare("INSERT INTO metadata(key,value) VALUES(?,?)")
const clientId = (getMeta.get("client_id") as { value: string } | undefined)?.value ?? randomUUID()
if (!getMeta.get("client_id")) setMeta.run("client_id", clientId)
const readWrites = db.prepare("SELECT id,kind,submission_boundary_at,save_evidence FROM commands WHERE state='running'")
const recoverRead = db.prepare("UPDATE commands SET state='queued',updated_at=? WHERE id=?")
const recoverWrite = db.prepare("UPDATE commands SET state='uncertain',result=?,updated_at=?,stage='result',result_at=? WHERE id=?")
for (const row of readWrites.all() as { id: string; kind: string; submission_boundary_at: string | null;
    save_evidence: string | null }[]) {
    const now = new Date().toISOString()
    if (row.kind === "size_template_create") {
        const submitted = row.submission_boundary_at !== null
        recoverWrite.run(JSON.stringify({ type: "online_result", id: row.id, ok: false,
            data: { saveStarted: submitted, saveOutcome: submitted ? "uncertain" : "not_submitted",
                ...(row.save_evidence ? { evidence: JSON.parse(row.save_evidence) as unknown } : {}) },
            error: submitted ? "客户端保存边界后重启，网页写入结果待只读核对" : "客户端保存边界前重启，未提交保存" }), now, now, row.id)
    } else if (row.kind === "browser_goods_model_create")
        recoverWrite.run(JSON.stringify({ type: "online_result", id: row.id, ok: false,
            data: { saveStarted: true }, error: "客户端执行期间重启，网页写入结果待只读核对" }), now, now, row.id)
    else recoverRead.run(now, row.id)
}

const insert = db.prepare("INSERT OR IGNORE INTO commands(id,kind,payload,state,received_at,updated_at,stage) VALUES(?,?,?,'queued',?,?,?)")
const select = db.prepare("SELECT payload,state,result FROM commands WHERE id=?")
const selectKind = db.prepare("SELECT kind,payload FROM commands WHERE id=?")
const next = db.prepare("SELECT payload FROM commands WHERE state='queued' ORDER BY received_at,id LIMIT 1")
const start = db.prepare("UPDATE commands SET state='running',updated_at=? WHERE id=? AND state='queued'")
const finish = db.prepare("UPDATE commands SET state='completed',result=?,updated_at=?,stage=CASE WHEN kind='size_template_create' THEN 'result' ELSE stage END,result_at=CASE WHEN kind='size_template_create' THEN ? ELSE result_at END WHERE id=? AND state='running'")
const markFilling = db.prepare(`UPDATE commands SET stage='filling',filling_at=?,updated_at=? WHERE id=?
    AND kind='size_template_create' AND state='running' AND stage='received'`)
const progressRows = db.prepare(`SELECT id,payload,received_at,filling_at,submission_boundary_at,progress_reported_stage
    FROM commands WHERE kind='size_template_create' AND state <> 'acked' ORDER BY received_at,id`)
const markReported = db.prepare(`UPDATE commands SET progress_reported_stage=? WHERE id=?
    AND kind='size_template_create' AND COALESCE(progress_reported_stage,'')=COALESCE(?,'')`)
const markBoundary = db.prepare(`UPDATE commands SET submission_boundary_at=?,updated_at=?,stage='save_boundary'
    WHERE id=? AND kind='size_template_create' AND state='running' AND submission_boundary_at IS NULL`)
const persistEvidence = db.prepare(`UPDATE commands SET save_evidence=?,updated_at=?
    WHERE id=? AND kind='size_template_create' AND state='running' AND submission_boundary_at IS NOT NULL`)
const sizeWriteState = db.prepare("SELECT submission_boundary_at,save_evidence FROM commands WHERE id=? AND kind='size_template_create'")
const pending = db.prepare("SELECT result FROM commands WHERE state IN ('completed','uncertain') ORDER BY updated_at,id LIMIT ? OFFSET ?")
const pendingCount = db.prepare("SELECT COUNT(*) AS count FROM commands WHERE state IN ('completed','uncertain')")
const outstanding = db.prepare("SELECT id FROM commands WHERE state <> 'acked' ORDER BY received_at DESC LIMIT 100")
const unackedCount = db.prepare("SELECT COUNT(*) AS count FROM commands WHERE state <> 'acked'")
const blockingCount = db.prepare(`SELECT COUNT(*) AS count FROM commands WHERE state <> 'acked'
    AND NOT (state='completed' AND kind IN ('browser_status','browser_size_status'))`)
const archiveStatus = db.prepare(`INSERT INTO superseded_status_commands
    (id,kind,payload,result,previous_target,previous_account,reason,received_at,completed_at,superseded_at)
    SELECT id,kind,payload,result,?,?,?,received_at,updated_at,? FROM commands
    WHERE state='completed' AND kind IN ('browser_status','browser_size_status')`)
const removeSupersededStatus = db.prepare(`DELETE FROM commands
    WHERE state='completed' AND kind IN ('browser_status','browser_size_status')`)
const archiveOrphanedRead = db.prepare(`INSERT INTO orphaned_read_results
    (id,kind,payload,result,backend_target,miaoshou_account,received_at,completed_at,archived_at)
    SELECT id,kind,payload,result,
        (SELECT value FROM metadata WHERE key='backend_target'),
        (SELECT value FROM metadata WHERE key='miaoshou_account'),received_at,updated_at,?
    FROM commands WHERE id=? AND state='completed' AND kind IN
        ('browser_status','browser_size_status','browser_1688_read','browser_miaoshou_detail',
         'size_template_observe','size_template_preview')`)
const removeOrphanedRead = db.prepare("DELETE FROM commands WHERE id=? AND state='completed'")
const upsertMeta = db.prepare("INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
const ack = db.prepare("UPDATE commands SET state='acked',updated_at=? WHERE id=? AND state IN ('completed','uncertain')")
const deleteAckedStatus = db.prepare("DELETE FROM commands WHERE id=? AND state='acked' AND kind IN ('browser_status','browser_size_status')")
let resultOffset = 0

function bind(key: string, value: string): boolean {
    const previous = (getMeta.get(key) as { value: string } | undefined)?.value
    if (previous === value) return true
    db.exec("BEGIN IMMEDIATE")
    try {
        if (previous && (unackedCount.get() as { count: number }).count > 0) {
            if ((blockingCount.get() as { count: number }).count > 0) {
                db.exec("ROLLBACK")
                return false
            }
            const target = key === "backend_target" ? previous
                : (getMeta.get("backend_target") as { value: string } | undefined)?.value
            const account = key === "miaoshou_account" ? previous
                : (getMeta.get("miaoshou_account") as { value: string } | undefined)?.value
            archiveStatus.run(target ?? "", account ?? null,
                key === "backend_target" ? "target_switch" : "account_switch", new Date().toISOString())
            removeSupersededStatus.run()
        }
        upsertMeta.run(key, value)
        db.exec("COMMIT")
        return true
    } catch (error) {
        db.exec("ROLLBACK")
        throw error
    }
}

export const onlineCommandStore = {
    clientId,
    progress(): { commandId: string; taskId: string; stage: "received" | "filling" | "save_boundary"; occurredAt: string } | null {
        for (const row of progressRows.all() as { id: string; payload: string; received_at: string;
            filling_at: string | null; submission_boundary_at: string | null; progress_reported_stage: string | null }[]) {
            const stages = [["received", row.received_at], ["filling", row.filling_at],
                ["save_boundary", row.submission_boundary_at]] as const
            const index = stages.findIndex(([stage]) => stage === row.progress_reported_stage)
            const next = stages[index + 1]
            if (!next || !next[1]) continue
            const taskId = (JSON.parse(row.payload) as StoredCommand).taskId
            if (typeof taskId !== "string" || !/^[0-9a-f-]{36}$/i.test(taskId)) continue
            return { commandId: row.id, taskId, stage: next[0], occurredAt: next[1] }
        }
        return null
    },
    ackProgress(id: string, stage: "received" | "filling" | "save_boundary") {
        const previous = stage === "received" ? null : stage === "filling" ? "received" : "filling"
        return markReported.run(stage, id, previous).changes === 1
    },
    markSizeFilling(id: string) {
        const now = new Date().toISOString()
        if (markFilling.run(now, now, id).changes !== 1) throw new Error("尺码填表阶段状态冲突，禁止继续")
    },
    hasBlockingCommands() { return (blockingCount.get() as { count: number }).count > 0 },
    bindTarget(target: string) { return bind("backend_target", target) },
    bindAccount(account: { mobile?: string; accountName?: string; email?: string }) {
        const identity = [account.mobile, account.accountName, account.email]
            .find(value => typeof value === "string" && value.trim())?.trim().toLowerCase()
        return Boolean(identity && bind("miaoshou_account", identity))
    },
    receive(command: StoredCommand) {
        if (!command.id || !/^[0-9a-f-]{36}$/i.test(command.id) || !command.type
            || !/^(size_template_|browser_)/.test(command.type)) return false
        const payload = JSON.stringify(command)
        if (Buffer.byteLength(payload) > 5 * 1024 * 1024) return false
        const now = new Date().toISOString()
        insert.run(command.id, command.type, payload, now, now, command.type === "size_template_create" ? "received" : null)
        const current = select.get(command.id) as { payload: string } | undefined
        return current?.payload === payload
    },
    kind(id: string): string | null { return (selectKind.get(id) as { kind: string } | undefined)?.kind ?? null },
    taskId(id: string): string | null {
        const row = selectKind.get(id) as { payload: string } | undefined
        if (!row) return null
        const taskId = (JSON.parse(row.payload) as StoredCommand).taskId
        return typeof taskId === "string" ? taskId : null
    },
    archiveOrphanedRead(id: string) {
        db.exec("BEGIN IMMEDIATE")
        try {
            const archived = archiveOrphanedRead.run(new Date().toISOString(), id).changes === 1
            if (archived) removeOrphanedRead.run(id)
            db.exec("COMMIT")
            return archived
        } catch (error) {
            db.exec("ROLLBACK")
            throw error
        }
    },
    next(): StoredCommand | null {
        const row = next.get() as { payload: string } | undefined
        return row ? JSON.parse(row.payload) as StoredCommand : null
    },
    start(id: string) { return start.run(new Date().toISOString(), id).changes === 1 },
    markSizeSubmissionBoundary(id: string) {
        const now = new Date().toISOString()
        if (markBoundary.run(now, now, id).changes !== 1) throw new Error("尺码保存边界状态冲突，禁止点击")
    },
    saveSizeEvidence(id: string, evidence: unknown) {
        if (persistEvidence.run(JSON.stringify(evidence), new Date().toISOString(), id).changes !== 1)
            throw new Error("尺码保存证据状态冲突")
    },
    sizeSubmissionState(id: string): { saveStarted: boolean; saveOutcome: "not_submitted" | "uncertain";
        evidence?: unknown } {
        // Fail closed on unreadable/corrupt state: never claim that a click was impossible.
        try {
            const row = sizeWriteState.get(id) as { submission_boundary_at: string | null;
                save_evidence: string | null } | undefined
            if (!row) return { saveStarted: true, saveOutcome: "uncertain" }
            const saveStarted = row.submission_boundary_at !== null
            return { saveStarted, saveOutcome: saveStarted ? "uncertain" : "not_submitted",
                ...(row.save_evidence ? { evidence: JSON.parse(row.save_evidence) as unknown } : {}) }
        } catch { return { saveStarted: true, saveOutcome: "uncertain" } }
    },
    finish(result: StoredResult) {
        const now = new Date().toISOString()
        if (finish.run(JSON.stringify(result), now, now, result.id).changes !== 1)
            throw new Error("在线命令结果状态冲突")
    },
    results(limit = 100): StoredResult[] {
        const count = (pendingCount.get() as { count: number }).count
        if (!count) { resultOffset = 0; return [] }
        if (resultOffset >= count) resultOffset = 0
        const rows = pending.all(limit, resultOffset) as { result: string }[]
        resultOffset = (resultOffset + rows.length) % count
        return rows.map(row => JSON.parse(row.result) as StoredResult)
    },
    commandAcks(): string[] { return (outstanding.all() as { id: string }[]).map(row => row.id) },
    ack(id: string) {
        if (ack.run(new Date().toISOString(), id).changes) deleteAckedStatus.run(id)
    },
}
