import { Database as BunDatabase } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { Global } from "../global"
import { Log } from "../util/log"
import { Hash } from "../util/hash"
import path from "path"
import { createHash } from "crypto"
import { existsSync, mkdirSync, readdirSync, copyFileSync, readFileSync } from "fs"
import { Installation } from "../installation"
import { Flag } from "../flag/flag"

declare const OPENCODE_MIGRATIONS: { sql: string; timestamp: number; name: string }[] | undefined

export namespace SplitMigration {
  const log = Log.create({ service: "split-migration" })

  function channel() {
    const ch = Installation.CHANNEL
    if (["latest", "beta"].includes(ch) || Flag.OPENCODE_DISABLE_CHANNEL_DB) return "latest"
    return ch.replace(/[^a-zA-Z0-9._-]/g, "-")
  }

  function channelDir() {
    return path.join(Global.Path.data, channel())
  }

  function ensureChannelDir() {
    const dir = channelDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return dir
  }

  function mainDbPath() {
    const ch = channel()
    if (ch === "latest") return path.join(Global.Path.data, "aether.db")
    return path.join(Global.Path.data, `aether-${ch}.db`)
  }

  function cronDbPath() {
    return path.join(ensureChannelDir(), `aether-cron.db`)
  }

  function projectDbPath(projectId: string) {
    return path.join(ensureChannelDir(), `aether-${projectId}.db`)
  }

  export function needsMigration(): boolean {
    const dir = channelDir()
    if (existsSync(dir)) {
      const files = readdirSync(dir).filter((f) => /\.db$/i.test(f))
      if (files.length > 0) return false
    }
    const main = mainDbPath()
    if (main === ":memory:") return false
    if (!existsSync(main)) return false
    const sqlite = new BunDatabase(main)
    try {
      const hasProjectTable = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project'")
        .get()
      if (!hasProjectTable) return false
      const hasSessions = sqlite.prepare("SELECT count(*) as cnt FROM session").get() as { cnt: number } | null
      if (!hasSessions || hasSessions.cnt === 0) {
        sqlite.close()
        return false
      }
      const hasProjectRows = sqlite.prepare("SELECT count(*) as cnt FROM project").get() as { cnt: number } | null
      if (!hasProjectRows || hasProjectRows.cnt === 0) {
        sqlite.close()
        return false
      }
      sqlite.close()
      return true
    } catch {
      sqlite.close()
      return false
    }
  }

  function norm(input: string) {
    return path.resolve(input).replace(/\\/g, "/").toLowerCase()
  }

  function initDb(filePath: string, sql: string[]) {
    mkdirSync(path.dirname(filePath), { recursive: true })
    const sqlite = new BunDatabase(filePath)
    sqlite.exec("PRAGMA journal_mode = WAL")
    sqlite.exec("PRAGMA synchronous = NORMAL")
    sqlite.exec("PRAGMA busy_timeout = 5000")
    sqlite.exec("PRAGMA cache_size = -64000")
    sqlite.exec("PRAGMA foreign_keys = OFF")
    for (const s of sql) sqlite.exec(s)
    return sqlite
  }

  const projectTableSQL = `
    CREATE TABLE IF NOT EXISTS project (
      id TEXT PRIMARY KEY,
      worktree TEXT NOT NULL,
      vcs TEXT,
      name TEXT,
      icon_url TEXT,
      icon_color TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_initialized INTEGER,
      sandboxes TEXT NOT NULL,
      commands TEXT
    );
  `

  const sessionTableSQL = `
    CREATE TABLE IF NOT EXISTS session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      workspace_id TEXT,
      parent_id TEXT,
      tree_id TEXT,
      fork_index INTEGER,
      fork_parent_session_id TEXT,
      fork_after_user_message_id TEXT,
      slug TEXT NOT NULL,
      directory TEXT NOT NULL,
      title TEXT NOT NULL,
      version TEXT NOT NULL,
      share_url TEXT,
      summary_additions INTEGER,
      summary_deletions INTEGER,
      summary_files INTEGER,
      summary_diffs TEXT,
      revert TEXT,
      permission TEXT,
      reading_mode TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_compacting INTEGER,
      time_archived INTEGER
    );
    CREATE INDEX IF NOT EXISTS session_project_idx ON session(project_id);
    CREATE INDEX IF NOT EXISTS session_workspace_idx ON session(workspace_id);
    CREATE INDEX IF NOT EXISTS session_parent_idx ON session(parent_id);
    CREATE INDEX IF NOT EXISTS session_tree_idx ON session(tree_id);
    CREATE INDEX IF NOT EXISTS session_fork_parent_idx ON session(fork_parent_session_id);
    CREATE INDEX IF NOT EXISTS session_fork_after_user_message_idx ON session(fork_after_user_message_id);
  `

  const messageTableSQL = `
    CREATE TABLE IF NOT EXISTS message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS message_session_time_created_id_idx ON message(session_id, time_created, id);
  `

  const partTableSQL = `
    CREATE TABLE IF NOT EXISTS part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS part_message_id_id_idx ON part(message_id, id);
    CREATE INDEX IF NOT EXISTS part_session_idx ON part(session_id);
  `

  const todoTableSQL = `
    CREATE TABLE IF NOT EXISTS todo (
      session_id TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL,
      priority TEXT NOT NULL,
      position INTEGER NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      PRIMARY KEY (session_id, position)
    );
    CREATE INDEX IF NOT EXISTS todo_session_idx ON todo(session_id);
  `

  const permissionTableSQL = `
    CREATE TABLE IF NOT EXISTS permission (
      project_id TEXT PRIMARY KEY,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `

  const sessionShareTableSQL = `
    CREATE TABLE IF NOT EXISTS session_share (
      session_id TEXT PRIMARY KEY,
      id TEXT NOT NULL,
      secret TEXT NOT NULL,
      url TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    );
  `

  const workspaceTableSQL = `
    CREATE TABLE IF NOT EXISTS workspace (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      branch TEXT,
      name TEXT,
      directory TEXT,
      extra TEXT,
      project_id TEXT NOT NULL
    );
  `

  const cronTableSQL = `
    CREATE TABLE IF NOT EXISTS cron_job_state (
      job_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL,
      next_run_at INTEGER,
      last_run_at INTEGER,
      last_status TEXT,
      running INTEGER NOT NULL DEFAULT 0,
      start_at INTEGER,
      definition_snapshot TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS cron_job_state_next_run_idx ON cron_job_state(next_run_at);

    CREATE TABLE IF NOT EXISTS cron_run (
      run_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      output_summary TEXT,
      mode TEXT NOT NULL,
      project_id TEXT,
      session_id TEXT,
      created_session_id TEXT,
      payload_snapshot TEXT NOT NULL,
      trigger_reason TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS cron_run_job_started_idx ON cron_run(job_id, started_at);
  `

  const globalProjectMapSQL = `
    CREATE TABLE IF NOT EXISTS global_project_map (
      directory TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    );
  `

  function markMigrationApplied(sqlite: BunDatabase, hash: string, millis: number, name: string) {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      name TEXT NOT NULL
    )`)
    sqlite
      .prepare("INSERT OR IGNORE INTO __drizzle_migrations (hash, created_at, name) VALUES (?, ?, ?)")
      .run(hash, millis, name)
  }

  const projectDbSchema = [
    projectTableSQL,
    sessionTableSQL,
    messageTableSQL,
    partTableSQL,
    todoTableSQL,
    permissionTableSQL,
    sessionShareTableSQL,
    workspaceTableSQL,
  ]

  export function run(): { projects: number; sessions: number } {
    const main = mainDbPath()
    const backup = main + ".pre-split"
    log.info("starting per-project database split", { main, backup })

    copyFileSync(main, backup)
    log.info("backed up main db", { from: main, to: backup })

    const srcSqlite = new BunDatabase(backup)
    const src = drizzle({ client: srcSqlite })
    srcSqlite.exec("PRAGMA foreign_keys = OFF")

    const projects = srcSqlite.prepare("SELECT * FROM project").all() as any[]
    const sessions = srcSqlite.prepare("SELECT * FROM session").all() as any[]
    const messages = srcSqlite.prepare("SELECT * FROM message").all() as any[]
    const parts = srcSqlite.prepare("SELECT * FROM part").all() as any[]
    const todos = srcSqlite.prepare("SELECT * FROM todo").all() as any[]
    const permissions = srcSqlite.prepare("SELECT * FROM permission").all() as any[]
    const shares = srcSqlite.prepare("SELECT * FROM session_share").all() as any[]
    const workspaces = srcSqlite.prepare("SELECT * FROM workspace").all() as any[]
    const cronJobs = srcSqlite.prepare("SELECT * FROM cron_job_state").all() as any[]
    const cronRuns = srcSqlite.prepare("SELECT * FROM cron_run").all() as any[]

    const sessionByProject = new Map<string, any[]>()
    const globalSessionDirs = new Map<string, any[]>()
    const globalProjectIdMap = new Map<string, string>()

    for (const s of sessions) {
      if (s.project_id === "global") {
        const dir = norm(s.directory)
        const bucket = globalSessionDirs.get(dir) ?? []
        bucket.push(s)
        globalSessionDirs.set(dir, bucket)
      } else {
        const bucket = sessionByProject.get(s.project_id) ?? []
        bucket.push(s)
        sessionByProject.set(s.project_id, bucket)
      }
    }

    for (const [dir, dirSessions] of globalSessionDirs) {
      const newId = Hash.fast(dir).slice(0, 16)
      globalProjectIdMap.set(dir, newId)
      for (const s of dirSessions) {
        s.project_id = newId
      }
      sessionByProject.set(newId, dirSessions)
    }

    const sessionIds = new Set(sessions.map((s) => s.id))
    const messagesBySession = new Map<string, any[]>()
    for (const m of messages) {
      if (!sessionIds.has(m.session_id)) continue
      const bucket = messagesBySession.get(m.session_id) ?? []
      bucket.push(m)
      messagesBySession.set(m.session_id, bucket)
    }

    const partsByMessage = new Map<string, any[]>()
    for (const p of parts) {
      if (!sessionIds.has(p.session_id)) continue
      const bucket = partsByMessage.get(p.message_id) ?? []
      bucket.push(p)
      partsByMessage.set(p.message_id, bucket)
    }

    const todosBySession = new Map<string, any[]>()
    for (const t of todos) {
      if (!sessionIds.has(t.session_id)) continue
      const bucket = todosBySession.get(t.session_id) ?? []
      bucket.push(t)
      todosBySession.set(t.session_id, bucket)
    }

    const sharesBySession = new Map<string, any[]>()
    for (const sh of shares) {
      if (!sessionIds.has(sh.session_id)) continue
      const bucket = sharesBySession.get(sh.session_id) ?? []
      bucket.push(sh)
      sharesBySession.set(sh.session_id, bucket)
    }

    const workspaceByProject = new Map<string, any[]>()
    for (const w of workspaces) {
      const pid = globalProjectIdMap.get(norm(w.project_id)) ?? w.project_id
      const bucket = workspaceByProject.get(pid) ?? []
      bucket.push({ ...w, project_id: pid })
      workspaceByProject.set(pid, bucket)
    }

    const projectById = new Map<string, any>()
    for (const p of projects) {
      const pid = globalProjectIdMap.get(norm(p.id)) ?? p.id
      projectById.set(pid, { ...p, id: pid })
    }

    for (const [dir, newId] of globalProjectIdMap) {
      if (!projectById.has(newId)) {
        projectById.set(newId, {
          id: newId,
          worktree: "/",
          vcs: null,
          name: null,
          icon_url: null,
          icon_color: null,
          time_created: Date.now(),
          time_updated: Date.now(),
          time_initialized: null,
          sandboxes: "[]",
          commands: null,
        })
      }
    }

    const allProjectIds = [...sessionByProject.keys(), ...projectById.keys()]
    const uniqueProjectIds = new Set(allProjectIds)

    let projectCount = 0
    let sessionCount = 0

    for (const projectId of uniqueProjectIds) {
      const pPath = projectDbPath(projectId)
      const pSqlite = initDb(pPath, projectDbSchema)
      const pDb = drizzle({ client: pSqlite })
      pSqlite.exec("BEGIN TRANSACTION")

      const projectRow = projectById.get(projectId)
      if (projectRow) {
        pSqlite
          .prepare(
            "INSERT OR REPLACE INTO project (id, worktree, vcs, name, icon_url, icon_color, time_created, time_updated, time_initialized, sandboxes, commands) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            projectRow.id,
            projectRow.worktree ?? "/",
            projectRow.vcs ?? null,
            projectRow.name ?? null,
            projectRow.icon_url ?? null,
            projectRow.icon_color ?? null,
            projectRow.time_created ?? Date.now(),
            projectRow.time_updated ?? Date.now(),
            projectRow.time_initialized ?? null,
            projectRow.sandboxes ?? "[]",
            projectRow.commands ?? null,
          )
      }

      const projSessions = sessionByProject.get(projectId) ?? []
      for (const s of projSessions) {
        pSqlite
          .prepare(
            "INSERT OR IGNORE INTO session (id, project_id, workspace_id, parent_id, tree_id, fork_index, fork_parent_session_id, fork_after_user_message_id, slug, directory, title, version, share_url, summary_additions, summary_deletions, summary_files, summary_diffs, revert, permission, reading_mode, time_created, time_updated, time_compacting, time_archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            s.id,
            s.project_id,
            s.workspace_id ?? null,
            s.parent_id ?? null,
            s.tree_id ?? null,
            s.fork_index ?? null,
            s.fork_parent_session_id ?? null,
            s.fork_after_user_message_id ?? null,
            s.slug,
            s.directory,
            s.title,
            s.version,
            s.share_url ?? null,
            s.summary_additions ?? null,
            s.summary_deletions ?? null,
            s.summary_files ?? null,
            s.summary_diffs ?? null,
            s.revert ?? null,
            s.permission ?? null,
            s.reading_mode ?? null,
            s.time_created,
            s.time_updated,
            s.time_compacting ?? null,
            s.time_archived ?? null,
          )
        sessionCount++
      }

      for (const s of projSessions) {
        const msgs = messagesBySession.get(s.id) ?? []
        for (const m of msgs) {
          pSqlite
            .prepare(
              "INSERT OR IGNORE INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
            )
            .run(m.id, m.session_id, m.time_created, m.time_updated, m.data)

          const pts = partsByMessage.get(m.id) ?? []
          for (const pt of pts) {
            pSqlite
              .prepare(
                "INSERT OR IGNORE INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
              )
              .run(pt.id, pt.message_id, pt.session_id, pt.time_created, pt.time_updated, pt.data)
          }
        }

        const tds = todosBySession.get(s.id) ?? []
        for (const td of tds) {
          pSqlite
            .prepare(
              "INSERT OR IGNORE INTO todo (session_id, content, status, priority, position, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .run(td.session_id, td.content, td.status, td.priority, td.position, td.time_created, td.time_updated)
        }

        const shs = sharesBySession.get(s.id) ?? []
        for (const sh of shs) {
          pSqlite
            .prepare(
              "INSERT OR IGNORE INTO session_share (session_id, id, secret, url, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)",
            )
            .run(sh.session_id, sh.id, sh.secret, sh.url, sh.time_created, sh.time_updated)
        }
      }

      const permRow = permissions.find((p) => {
        const pid = globalProjectIdMap.get(norm(p.project_id)) ?? p.project_id
        return pid === projectId
      })
      if (permRow) {
        const pid = globalProjectIdMap.get(norm(permRow.project_id)) ?? permRow.project_id
        pSqlite
          .prepare(
            "INSERT OR IGNORE INTO permission (project_id, time_created, time_updated, data) VALUES (?, ?, ?, ?)",
          )
          .run(pid, permRow.time_created, permRow.time_updated, permRow.data)
      }

      const wss = workspaceByProject.get(projectId) ?? []
      for (const ws of wss) {
        pSqlite
          .prepare(
            "INSERT OR IGNORE INTO workspace (id, type, branch, name, directory, extra, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            ws.id,
            ws.type,
            ws.branch ?? null,
            ws.name ?? null,
            ws.directory ?? null,
            ws.extra ?? null,
            ws.project_id,
          )
      }

      pSqlite.exec("COMMIT")
      pSqlite.close()
      projectCount++
    }

    log.info("created project databases", { count: projectCount })

    const migrationMeta = (() => {
      const migrationDir = path.join(import.meta.dirname, "../../migration/20260507071748_per_project_db_split")
      const sqlFile = path.join(migrationDir, "migration.sql")
      if (!existsSync(sqlFile)) return undefined
      const sql = readFileSync(sqlFile, "utf-8")
      const hash = createHash("sha256").update(sql).digest("hex")
      const name = "20260507071748_per_project_db_split"
      const millis = Date.UTC(2026, 4, 7, 7, 17, 48)
      return { hash, name, millis }
    })()

    // Mark the per-project-db-split migration as already applied on all new dbs
    // so that Drizzle's migrate() skips it when attach/CronClient call applyMigrations
    for (const projectId of uniqueProjectIds) {
      const pPath = projectDbPath(projectId)
      const pSqlite = new BunDatabase(pPath)
      markMigrationApplied(pSqlite, migrationMeta!.hash, migrationMeta!.millis, migrationMeta!.name)
      pSqlite.close()
    }
    const cPath = cronDbPath()
    const cSqlite2 = new BunDatabase(cPath)
    markMigrationApplied(cSqlite2, migrationMeta!.hash, migrationMeta!.millis, migrationMeta!.name)
    cSqlite2.close()

    const cSqlite = initDb(cronDbPath(), [cronTableSQL])
    cSqlite.exec("BEGIN TRANSACTION")
    for (const cj of cronJobs) {
      cSqlite
        .prepare(
          "INSERT OR IGNORE INTO cron_job_state (job_id, enabled, next_run_at, last_run_at, last_status, running, start_at, definition_snapshot, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          cj.job_id,
          cj.enabled,
          cj.next_run_at ?? null,
          cj.last_run_at ?? null,
          cj.last_status ?? null,
          cj.running,
          cj.start_at ?? null,
          cj.definition_snapshot,
          cj.updated_at,
        )
    }
    for (const cr of cronRuns) {
      cSqlite
        .prepare(
          "INSERT OR IGNORE INTO cron_run (run_id, job_id, started_at, finished_at, status, output_summary, mode, project_id, session_id, created_session_id, payload_snapshot, trigger_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          cr.run_id,
          cr.job_id,
          cr.started_at,
          cr.finished_at,
          cr.status,
          cr.output_summary ?? null,
          cr.mode,
          cr.project_id ?? null,
          cr.session_id ?? null,
          cr.created_session_id ?? null,
          cr.payload_snapshot,
          cr.trigger_reason,
        )
    }
    cSqlite.exec("COMMIT")
    cSqlite.close()
    log.info("created cron database")

    const destSqlite = new BunDatabase(main)
    destSqlite.exec("PRAGMA foreign_keys = OFF")
    destSqlite.exec("BEGIN TRANSACTION")
    destSqlite.exec(globalProjectMapSQL)
    for (const [dir, newId] of globalProjectIdMap) {
      destSqlite
        .prepare(
          "INSERT OR IGNORE INTO global_project_map (directory, project_id, time_created, time_updated) VALUES (?, ?, ?, ?)",
        )
        .run(dir, newId, Date.now(), Date.now())
    }
    destSqlite.exec("DELETE FROM session")
    destSqlite.exec("DELETE FROM message")
    destSqlite.exec("DELETE FROM part")
    destSqlite.exec("DELETE FROM todo")
    destSqlite.exec("DELETE FROM permission")
    destSqlite.exec("DELETE FROM session_share")
    destSqlite.exec("DELETE FROM workspace")
    destSqlite.exec("DELETE FROM cron_job_state")
    destSqlite.exec("DELETE FROM cron_run")
    destSqlite.exec("DELETE FROM project")
    destSqlite.exec("DROP TABLE IF EXISTS project")
    for (const [dir, newId] of globalProjectIdMap) {
      destSqlite
        .prepare("UPDATE project_recent SET project_id = ? WHERE project_id = 'global' AND directory = ?")
        .run(newId, dir)
    }
    destSqlite.exec("COMMIT")
    markMigrationApplied(destSqlite, migrationMeta!.hash, migrationMeta!.millis, migrationMeta!.name)
    destSqlite.close()

    srcSqlite.close()

    log.info("split migration complete", { projects: projectCount, sessions: sessionCount })
    return { projects: projectCount, sessions: sessionCount }
  }
}
