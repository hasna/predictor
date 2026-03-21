/**
 * Top-level orchestrator — ties together persona generation, simulation, pattern
 * detection, and report generation into a single prediction pipeline.
 */

import { Database } from "bun:sqlite"
import type { SimulationConfig, PlatformType, PredictionReport, Simulation } from "../types.ts"
import {
  createSimulation,
  getSimulation,
  listSimulations as dbListSimulations,
  updateSimulationStatus,
  listPersonas,
  countActions,
} from "../db/index.ts"
import { generatePersonas } from "../personas/generator.ts"
import { runSimulation } from "./simulator.ts"
import { detectPatterns } from "./patterns.ts"
import { generateReport } from "../reports/generator.ts"

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: SimulationConfig = {
  max_rounds: 40,
  agents_per_round: 10,
  platforms: ["twitter"] as PlatformType[],
  time_zone: "UTC",
  start_time: "08:00",
  hours_per_round: 1,
  model: "gpt-4.1-mini",
  temperature: 0.7,
}

// ─── Graph Entity Reader ──────────────────────────────────────────────────────

interface GraphNode {
  id: string
  name: string
  labels: string[]
  summary: string
  attributes: Record<string, unknown>
}

interface GraphEdge {
  id: string
  name: string
  fact: string
  source_node_id: string
  target_node_id: string
}

function readGraphEntities(
  graphDb: Database,
  graphId: string,
): Array<{ node: GraphNode; edges: GraphEdge[] }> {
  const rawNodes = graphDb
    .query("SELECT * FROM graph_nodes WHERE graph_id = ?")
    .all(graphId) as Record<string, unknown>[]

  const rawEdges = graphDb
    .query("SELECT * FROM graph_edges WHERE graph_id = ?")
    .all(graphId) as Record<string, unknown>[]

  // Parse JSON fields
  const nodes: GraphNode[] = rawNodes.map((row) => ({
    id: row.id as string,
    name: row.name as string,
    labels: JSON.parse((row.labels as string) ?? "[]"),
    summary: (row.summary as string) ?? "",
    attributes: JSON.parse((row.attributes as string) ?? "{}"),
  }))

  const edges: GraphEdge[] = rawEdges.map((row) => ({
    id: row.id as string,
    name: (row.name as string) ?? "",
    fact: (row.fact as string) ?? "",
    source_node_id: row.source_node_id as string,
    target_node_id: row.target_node_id as string,
  }))

  // Build edge lookup by node ID
  const edgesByNode = new Map<string, GraphEdge[]>()
  for (const edge of edges) {
    if (!edgesByNode.has(edge.source_node_id)) edgesByNode.set(edge.source_node_id, [])
    if (!edgesByNode.has(edge.target_node_id)) edgesByNode.set(edge.target_node_id, [])
    edgesByNode.get(edge.source_node_id)!.push(edge)
    edgesByNode.get(edge.target_node_id)!.push(edge)
  }

  return nodes.map((node) => ({
    node,
    edges: edgesByNode.get(node.id) ?? [],
  }))
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Create a new prediction/simulation record with default config merged with overrides.
 * Returns the simulation ID.
 */
export function createPrediction(
  db: Database,
  opts: {
    name: string
    graph_id: string
    config?: Partial<SimulationConfig>
  },
): string {
  const config: SimulationConfig = { ...DEFAULT_CONFIG, ...opts.config }

  const id = createSimulation(db, {
    graph_id: opts.graph_id,
    name: opts.name,
    config: config as unknown as Record<string, unknown>,
    total_rounds: config.max_rounds,
  })

  return id
}

/**
 * Run the full prediction pipeline:
 * 1. Set status to 'running'
 * 2. Read graph entities from researcher DB
 * 3. Generate agent personas from entities
 * 4. Run all simulation rounds
 * 5. Detect patterns after final round
 * 6. Generate prediction report
 * 7. Set status to 'completed'
 */
export async function startPrediction(
  db: Database,
  simulationId: string,
  opts?: {
    graph_db?: Database
    onRound?: (round: number, actions: number) => void
  },
): Promise<PredictionReport> {
  const sim = getSimulation(db, simulationId) as Record<string, unknown> | null
  if (!sim) throw new Error(`Simulation ${simulationId} not found`)

  const config = sim.config as SimulationConfig
  const graphId = sim.graph_id as string

  try {
    // 1. Set status to running
    updateSimulationStatus(db, simulationId, "running")

    // 2. Read graph entities from researcher DB (or same DB if not provided)
    const graphDb = opts?.graph_db ?? db
    const entities = readGraphEntities(graphDb, graphId)

    if (entities.length === 0) {
      throw new Error(`No graph entities found for graph_id ${graphId}`)
    }

    // 3. Generate agent personas
    await generatePersonas(db, simulationId, entities, {
      model: config.model,
      platforms: config.platforms,
    })

    // 4. Run the simulation
    await runSimulation(db, simulationId, {
      model: config.model,
      onRoundComplete: (round, actionsTaken) => {
        opts?.onRound?.(round, actionsTaken)
      },
    })

    // 5. Detect patterns for the final round
    const finalSim = getSimulation(db, simulationId) as Record<string, unknown> | null
    const finalRound = (finalSim?.current_round as number) ?? config.max_rounds
    await detectPatterns(db, simulationId, finalRound)

    // 6. Generate the prediction report
    const report = await generateReport(db, simulationId)

    // 7. Set status to completed
    updateSimulationStatus(db, simulationId, "completed")

    return report
  } catch (err) {
    updateSimulationStatus(db, simulationId, "failed")
    throw err
  }
}

/**
 * Stop a running simulation.
 */
export function stopPrediction(db: Database, simulationId: string): void {
  const sim = getSimulation(db, simulationId) as Record<string, unknown> | null
  if (!sim) throw new Error(`Simulation ${simulationId} not found`)
  updateSimulationStatus(db, simulationId, "stopped")
}

/**
 * Get the current status and statistics of a simulation.
 */
export function getPredictionStatus(
  db: Database,
  simulationId: string,
): {
  id: string
  name: string
  status: string
  current_round: number
  total_rounds: number
  agent_count: number
  action_count: number
  cost_total: number
} {
  const sim = getSimulation(db, simulationId) as Record<string, unknown> | null
  if (!sim) throw new Error(`Simulation ${simulationId} not found`)

  return {
    id: sim.id as string,
    name: sim.name as string,
    status: sim.status as string,
    current_round: sim.current_round as number,
    total_rounds: (sim.config as SimulationConfig).max_rounds ?? (sim.total_rounds as number),
    agent_count: sim.agent_count as number,
    action_count: sim.action_count as number,
    cost_total: sim.cost_total as number,
  }
}

/**
 * List all simulations, most recent first.
 */
export function listPredictions(db: Database): Simulation[] {
  return dbListSimulations(db) as Simulation[]
}
