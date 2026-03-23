/**
 * SQLite database layer for predictor.
 * Uses bun:sqlite native API.
 */

import { Database } from "bun:sqlite"
import { existsSync, mkdirSync, cpSync } from "fs"
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.ts"

let _db: Database | null = null

export function getDb(dbPath?: string): Database {
  if (_db) return _db
  const path = dbPath ?? getDefaultDbPath()
  _db = new Database(path, { create: true })
  _db.run("PRAGMA journal_mode = WAL")
  _db.run("PRAGMA foreign_keys = ON")
  _db.run("PRAGMA busy_timeout = 5000")
  return _db
}

export function getDefaultDbPath(): string {
  // Support env var overrides
  const envPath = process.env.HASNA_PREDICTOR_DB_PATH ?? process.env.PREDICTOR_DB_PATH
  if (envPath) return envPath

  const home = process.env.HOME ?? process.env.USERPROFILE ?? "."
  const newDir = `${home}/.hasna/predictor`
  const oldDir = `${home}/.predictor`

  // Auto-migrate from old location if new dir doesn't exist yet
  if (!existsSync(newDir) && existsSync(oldDir)) {
    try {
      mkdirSync(`${home}/.hasna`, { recursive: true })
      cpSync(oldDir, newDir, { recursive: true })
    } catch {
      // Fall through to create new dir
    }
  }

  // Ensure directory exists
  try {
    mkdirSync(newDir, { recursive: true })
  } catch {
    // already exists
  }
  return `${newDir}/predictor.db`
}

export function initDb(dbPath?: string): Database {
  const db = getDb(dbPath)

  // Check if schema is already applied
  const hasVersionTable = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
    .get()

  if (hasVersionTable) {
    const row = db.query("SELECT MAX(version) as version FROM schema_version").get() as {
      version: number | null
    } | null
    if (row?.version && row.version >= SCHEMA_VERSION) {
      return db
    }
  }

  // Apply schema
  db.exec(SCHEMA_SQL)

  // Record version
  db.run("INSERT INTO schema_version (version) VALUES (?)", [SCHEMA_VERSION])

  return db
}

export function closeDb(): void {
  if (_db) {
    _db.close()
    _db = null
  }
}

// ─── Simulation queries ─────────────────────────────────────────────────────

export function createSimulation(
  db: Database,
  data: {
    graph_id: string
    name: string
    description?: string
    project_id?: string
    config?: Record<string, unknown>
    total_rounds?: number
    agent_count?: number
  },
): string {
  const id = crypto.randomUUID().slice(0, 16)
  db.run(
    `INSERT INTO simulations (id, project_id, graph_id, name, description, config, total_rounds, agent_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      data.project_id ?? null,
      data.graph_id,
      data.name,
      data.description ?? "",
      JSON.stringify(data.config ?? {}),
      data.total_rounds ?? 0,
      data.agent_count ?? 0,
    ],
  )
  return id
}

export function getSimulation(db: Database, id: string) {
  const row = db.query("SELECT * FROM simulations WHERE id = ?").get(id) as Record<string, unknown> | null
  if (!row) return null
  return { ...row, config: JSON.parse(row.config as string) }
}

export function listSimulations(db: Database, status?: string) {
  let rows: Record<string, unknown>[]
  if (status) {
    rows = db
      .query("SELECT * FROM simulations WHERE status = ? ORDER BY created_at DESC")
      .all(status) as Record<string, unknown>[]
  } else {
    rows = db.query("SELECT * FROM simulations ORDER BY created_at DESC").all() as Record<string, unknown>[]
  }
  return rows.map((row) => ({ ...row, config: JSON.parse(row.config as string) }))
}

export function updateSimulationStatus(db: Database, id: string, status: string) {
  db.run("UPDATE simulations SET status = ?, updated_at = datetime('now') WHERE id = ?", [status, id])
}

export function updateSimulationRound(
  db: Database,
  id: string,
  round: number,
  actionCount?: number,
  costTotal?: number,
) {
  const sets = ["current_round = ?", "updated_at = datetime('now')"]
  const params: (string | number)[] = [round]

  if (actionCount !== undefined) {
    sets.push("action_count = ?")
    params.push(actionCount)
  }
  if (costTotal !== undefined) {
    sets.push("cost_total = ?")
    params.push(costTotal)
  }

  params.push(id)
  db.run(`UPDATE simulations SET ${sets.join(", ")} WHERE id = ?`, params)
}

export function deleteSimulation(db: Database, id: string): boolean {
  const result = db.run("DELETE FROM simulations WHERE id = ?", [id])
  return result.changes > 0
}

// ─── Persona queries ────────────────────────────────────────────────────────

export function createPersona(
  db: Database,
  data: {
    simulation_id: string
    node_id: string
    name: string
    personality?: Record<string, unknown>
    social_metrics?: Record<string, unknown>
    activity_config?: Record<string, unknown>
    memory?: string[]
  },
): string {
  const id = crypto.randomUUID().slice(0, 16)
  db.run(
    `INSERT INTO agent_personas (id, simulation_id, node_id, name, personality, social_metrics, activity_config, memory)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      data.simulation_id,
      data.node_id,
      data.name,
      JSON.stringify(data.personality ?? {}),
      JSON.stringify(data.social_metrics ?? {}),
      JSON.stringify(data.activity_config ?? {}),
      JSON.stringify(data.memory ?? []),
    ],
  )
  return id
}

export function getPersona(db: Database, id: string) {
  const row = db.query("SELECT * FROM agent_personas WHERE id = ?").get(id) as Record<string, unknown> | null
  if (!row) return null
  return {
    ...row,
    personality: JSON.parse(row.personality as string),
    social_metrics: JSON.parse(row.social_metrics as string),
    activity_config: JSON.parse(row.activity_config as string),
    memory: JSON.parse(row.memory as string),
  }
}

export function listPersonas(db: Database, simulationId: string) {
  const rows = db
    .query("SELECT * FROM agent_personas WHERE simulation_id = ? ORDER BY created_at ASC")
    .all(simulationId) as Record<string, unknown>[]
  return rows.map((row) => ({
    ...row,
    personality: JSON.parse(row.personality as string),
    social_metrics: JSON.parse(row.social_metrics as string),
    activity_config: JSON.parse(row.activity_config as string),
    memory: JSON.parse(row.memory as string),
  }))
}

export function deletePersonas(db: Database, simulationId: string): boolean {
  const result = db.run("DELETE FROM agent_personas WHERE simulation_id = ?", [simulationId])
  return result.changes > 0
}

// ─── Action queries ─────────────────────────────────────────────────────────

export function createAction(
  db: Database,
  data: {
    simulation_id: string
    agent_id: string
    round: number
    platform: string
    action_type: string
    content?: string
    target_post_id?: string
    target_agent_id?: string
    reasoning?: string
  },
): string {
  const id = crypto.randomUUID().slice(0, 16)
  db.run(
    `INSERT INTO agent_actions (id, simulation_id, agent_id, round, platform, action_type, content, target_post_id, target_agent_id, reasoning)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      data.simulation_id,
      data.agent_id,
      data.round,
      data.platform,
      data.action_type,
      data.content ?? "",
      data.target_post_id ?? null,
      data.target_agent_id ?? null,
      data.reasoning ?? "",
    ],
  )
  return id
}

export function listActions(
  db: Database,
  simulationId: string,
  opts?: { round?: number; agent_id?: string; action_type?: string },
) {
  let sql = "SELECT * FROM agent_actions WHERE simulation_id = ?"
  const params: (string | number)[] = [simulationId]

  if (opts?.round !== undefined) {
    sql += " AND round = ?"
    params.push(opts.round)
  }
  if (opts?.agent_id) {
    sql += " AND agent_id = ?"
    params.push(opts.agent_id)
  }
  if (opts?.action_type) {
    sql += " AND action_type = ?"
    params.push(opts.action_type)
  }

  sql += " ORDER BY round ASC, created_at ASC"
  return db.query(sql).all(...params)
}

export function countActions(db: Database, simulationId: string): number {
  const row = db
    .query("SELECT COUNT(*) as count FROM agent_actions WHERE simulation_id = ?")
    .get(simulationId) as { count: number } | null
  return row?.count ?? 0
}

// ─── Post queries ───────────────────────────────────────────────────────────

export function createPost(
  db: Database,
  data: {
    simulation_id: string
    platform: string
    author_id: string
    content?: string
    parent_id?: string
    round: number
  },
): string {
  const id = crypto.randomUUID().slice(0, 16)
  db.run(
    `INSERT INTO simulated_posts (id, simulation_id, platform, author_id, content, parent_id, round)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      data.simulation_id,
      data.platform,
      data.author_id,
      data.content ?? "",
      data.parent_id ?? null,
      data.round,
    ],
  )
  return id
}

export function getPost(db: Database, id: string) {
  return db.query("SELECT * FROM simulated_posts WHERE id = ?").get(id)
}

export function listPosts(
  db: Database,
  simulationId: string,
  opts?: { round?: number; author_id?: string; platform?: string },
) {
  let sql = "SELECT * FROM simulated_posts WHERE simulation_id = ?"
  const params: (string | number)[] = [simulationId]

  if (opts?.round !== undefined) {
    sql += " AND round = ?"
    params.push(opts.round)
  }
  if (opts?.author_id) {
    sql += " AND author_id = ?"
    params.push(opts.author_id)
  }
  if (opts?.platform) {
    sql += " AND platform = ?"
    params.push(opts.platform)
  }

  sql += " ORDER BY round ASC, created_at ASC"
  return db.query(sql).all(...params)
}

export function updatePostEngagement(
  db: Database,
  postId: string,
  field: "likes" | "reposts" | "replies",
  increment: number,
) {
  db.run(`UPDATE simulated_posts SET ${field} = ${field} + ? WHERE id = ?`, [increment, postId])
}

export function getTopPosts(db: Database, simulationId: string, round?: number, limit?: number) {
  let sql = "SELECT * FROM simulated_posts WHERE simulation_id = ?"
  const params: (string | number)[] = [simulationId]

  if (round !== undefined) {
    sql += " AND round = ?"
    params.push(round)
  }

  sql += " ORDER BY (likes + reposts + replies) DESC LIMIT ?"
  params.push(limit ?? 10)

  return db.query(sql).all(...params)
}

// ─── Pattern queries ────────────────────────────────────────────────────────

export function createPattern(
  db: Database,
  data: {
    simulation_id: string
    type: string
    description?: string
    involved_agents?: string[]
    first_seen_round: number
    intensity?: number
  },
): string {
  const id = crypto.randomUUID().slice(0, 16)
  db.run(
    `INSERT INTO emergent_patterns (id, simulation_id, type, description, involved_agents, first_seen_round, intensity)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      data.simulation_id,
      data.type,
      data.description ?? "",
      JSON.stringify(data.involved_agents ?? []),
      data.first_seen_round,
      data.intensity ?? 0,
    ],
  )
  return id
}

export function listPatterns(db: Database, simulationId: string) {
  const rows = db
    .query("SELECT * FROM emergent_patterns WHERE simulation_id = ? ORDER BY first_seen_round ASC")
    .all(simulationId) as Record<string, unknown>[]
  return rows.map((row) => ({
    ...row,
    involved_agents: JSON.parse(row.involved_agents as string),
  }))
}

export function getPatternsByType(db: Database, simulationId: string, type: string) {
  const rows = db
    .query("SELECT * FROM emergent_patterns WHERE simulation_id = ? AND type = ? ORDER BY first_seen_round ASC")
    .all(simulationId, type) as Record<string, unknown>[]
  return rows.map((row) => ({
    ...row,
    involved_agents: JSON.parse(row.involved_agents as string),
  }))
}

// ─── Report queries ─────────────────────────────────────────────────────────

export function createReport(
  db: Database,
  data: {
    simulation_id: string
    sections?: unknown[]
    confidence?: number
    key_predictions?: string[]
    methodology?: string
  },
): string {
  const id = crypto.randomUUID().slice(0, 16)
  db.run(
    `INSERT INTO prediction_reports (id, simulation_id, sections, confidence, key_predictions, methodology)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      id,
      data.simulation_id,
      JSON.stringify(data.sections ?? []),
      data.confidence ?? 0,
      JSON.stringify(data.key_predictions ?? []),
      data.methodology ?? "",
    ],
  )
  return id
}

export function getReport(db: Database, simulationId: string) {
  const row = db
    .query("SELECT * FROM prediction_reports WHERE simulation_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(simulationId) as Record<string, unknown> | null
  if (!row) return null
  return {
    ...row,
    sections: JSON.parse(row.sections as string),
    key_predictions: JSON.parse(row.key_predictions as string),
  }
}

export function getReportById(db: Database, reportId: string) {
  const row = db
    .query("SELECT * FROM prediction_reports WHERE id = ?")
    .get(reportId) as Record<string, unknown> | null
  if (!row) return null
  return {
    ...row,
    sections: JSON.parse(row.sections as string),
    key_predictions: JSON.parse(row.key_predictions as string),
  }
}
