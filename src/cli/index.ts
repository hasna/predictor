#!/usr/bin/env bun

/**
 * predictor CLI — swarm intelligence prediction engine.
 * Create simulations, run multi-agent social media predictions,
 * interview agents, and generate reports.
 */

import { Command } from "commander"
import {
  initDb,
  getDefaultDbPath,
  getSimulation,
  listActions,
  listPersonas,
  listPatterns,
  countActions,
  getReport,
} from "../db/index.ts"
import {
  createPrediction,
  startPrediction,
  stopPrediction,
  getPredictionStatus,
  listPredictions,
} from "../engine/orchestrator.ts"
import { detectPatterns } from "../engine/patterns.ts"
import { interviewAgent } from "../reports/interview.ts"
import type { SimulationConfig, PlatformType, Simulation } from "../types.ts"

const program = new Command()

program
  .name("predictor")
  .description("Swarm intelligence prediction engine — multi-agent social media simulation")
  .version("0.0.1")
  .option("--json", "Output as JSON")
  .option("--db <path>", "Database path (default: ~/.predictor/predictor.db)")

function isJson(): boolean {
  return program.opts().json === true
}

function getDb() {
  const opts = program.opts()
  return initDb(opts.db)
}

function output(data: unknown, formatted?: () => void): void {
  if (isJson()) {
    console.log(JSON.stringify(data, null, 2))
  } else if (formatted) {
    formatted()
  }
}

// ─── Create ─────────────────────────────────────────────────────────────────

program
  .command("create")
  .argument("<name>", "Simulation name")
  .requiredOption("--graph <id>", "Knowledge graph ID from researcher")
  .option("--rounds <n>", "Max rounds", "40")
  .option("--platforms <list>", "Comma-separated platforms (twitter,reddit,forum)", "twitter")
  .option("--model <model>", "LLM model for agent decisions", "gpt-4.1-mini")
  .option("--temperature <n>", "LLM temperature", "0.7")
  .option("--agents-per-round <n>", "Agents per round", "10")
  .option("--hours-per-round <n>", "Simulated hours per round", "1")
  .description("Create a new prediction simulation")
  .action((name, opts) => {
    const db = getDb()
    try {
      const platforms = opts.platforms.split(",").map((p: string) => p.trim()) as PlatformType[]
      const config: Partial<SimulationConfig> = {
        max_rounds: parseInt(opts.rounds, 10),
        platforms,
        model: opts.model,
        temperature: parseFloat(opts.temperature),
        agents_per_round: parseInt(opts.agentsPerRound, 10),
        hours_per_round: parseInt(opts.hoursPerRound, 10),
      }

      const id = createPrediction(db, { name, graph_id: opts.graph, config })

      output({ id, name, graph_id: opts.graph, config }, () => {
        console.log(`Created simulation: ${name} (${id})`)
        console.log(`  Graph: ${opts.graph}`)
        console.log(`  Rounds: ${opts.rounds}`)
        console.log(`  Platforms: ${platforms.join(", ")}`)
        console.log(`  Model: ${opts.model}`)
        console.log(`\nRun it: predictor simulate ${id}`)
      })
    } finally {
      db.close()
    }
  })

// ─── Simulate ────────────────────────────────────────────────────────────────

program
  .command("simulate")
  .argument("<id>", "Simulation ID")
  .option("--graph-db <path>", "Path to researcher database (for reading graph entities)")
  .description("Start the full prediction pipeline")
  .action(async (id, opts) => {
    const db = getDb()
    try {
      let graphDb: ReturnType<typeof initDb> | undefined
      if (opts.graphDb) {
        const { Database } = await import("bun:sqlite")
        graphDb = new Database(opts.graphDb, { create: false })
      }

      console.log(`Starting simulation ${id}...`)
      console.log()

      const report = await startPrediction(db, id, {
        graph_db: graphDb,
        onRound: (round, actions) => {
          process.stdout.write(`\r  Round ${round}: ${actions} actions`)
        },
      })

      console.log("\n")

      output(report, () => {
        console.log(`Simulation completed.`)
        console.log(`Confidence: ${(report.confidence * 100).toFixed(0)}%`)
        console.log()
        console.log("Key predictions:")
        for (const [i, pred] of report.key_predictions.entries()) {
          console.log(`  ${i + 1}. ${pred}`)
        }
        console.log()
        console.log(`Methodology: ${report.methodology}`)
        console.log()
        console.log("Sections:")
        for (const section of report.sections) {
          console.log(`  - ${section.title} (${(section.confidence * 100).toFixed(0)}%)`)
        }
        console.log()
        console.log(`Full report: predictor report ${id}`)
      })

      graphDb?.close()
    } catch (err) {
      console.error(`Simulation failed: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    } finally {
      db.close()
    }
  })

// ─── Status ──────────────────────────────────────────────────────────────────

program
  .command("status")
  .argument("<id>", "Simulation ID")
  .description("Show simulation progress")
  .action((id) => {
    const db = getDb()
    try {
      const status = getPredictionStatus(db, id)

      output(status, () => {
        const pct = status.total_rounds > 0
          ? ((status.current_round / status.total_rounds) * 100).toFixed(0)
          : "0"

        console.log(`Simulation: ${status.name} (${status.id})`)
        console.log(`  Status: ${status.status}`)
        console.log(`  Progress: ${status.current_round} / ${status.total_rounds} rounds (${pct}%)`)
        console.log(`  Agents: ${status.agent_count}`)
        console.log(`  Actions: ${status.action_count}`)
        console.log(`  Cost: $${status.cost_total.toFixed(4)}`)
      })
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    } finally {
      db.close()
    }
  })

// ─── List ────────────────────────────────────────────────────────────────────

program
  .command("list")
  .description("List all simulations")
  .action(() => {
    const db = getDb()
    try {
      const sims = listPredictions(db)

      output(sims, () => {
        if (sims.length === 0) {
          console.log("No simulations. Create one with: predictor create <name> --graph <id>")
          return
        }

        console.log(`${sims.length} simulation(s):\n`)
        for (const s of sims) {
          const maxRounds = s.config?.max_rounds ?? s.total_rounds
          console.log(`  ${s.id}  ${s.name}`)
          console.log(`    [${s.status}] round ${s.current_round}/${maxRounds} | ${s.agent_count} agents | ${s.action_count} actions | $${s.cost_total.toFixed(4)}`)
        }
      })
    } finally {
      db.close()
    }
  })

// ─── Report ──────────────────────────────────────────────────────────────────

program
  .command("report")
  .argument("<id>", "Simulation ID")
  .description("Show prediction report")
  .action((id) => {
    const db = getDb()
    try {
      const report = getReport(db, id)

      if (!report) {
        console.error(`No report found for simulation ${id}. Run 'predictor simulate ${id}' first.`)
        process.exit(1)
      }

      const rpt = report as Record<string, unknown>
      output(rpt, () => {
        const sections = rpt.sections as Array<{ title: string; content: string; evidence: string[]; confidence: number }>
        const predictions = rpt.key_predictions as string[]

        console.log(`${"=".repeat(60)}`)
        console.log(`PREDICTION REPORT`)
        console.log(`${"=".repeat(60)}`)
        console.log()
        console.log(`Overall confidence: ${((rpt.confidence as number) * 100).toFixed(0)}%`)
        console.log(`Methodology: ${rpt.methodology}`)
        console.log()

        console.log(`KEY PREDICTIONS`)
        console.log(`${"─".repeat(40)}`)
        for (const [i, pred] of predictions.entries()) {
          console.log(`  ${i + 1}. ${pred}`)
        }
        console.log()

        for (const section of sections) {
          console.log(`${"─".repeat(60)}`)
          console.log(`${section.title} (${(section.confidence * 100).toFixed(0)}% confidence)`)
          console.log(`${"─".repeat(60)}`)
          console.log(section.content)
          if (section.evidence.length > 0) {
            console.log()
            console.log("Evidence:")
            for (const e of section.evidence) {
              console.log(`  - ${e}`)
            }
          }
          console.log()
        }
      })
    } finally {
      db.close()
    }
  })

// ─── Interview ───────────────────────────────────────────────────────────────

program
  .command("interview")
  .argument("<id>", "Simulation ID")
  .argument("<agent>", "Agent name or ID")
  .argument("<question>", "Question to ask the agent")
  .description("Interview a simulated agent about their behavior")
  .action(async (id, agentNameOrId, question) => {
    const db = getDb()
    try {
      // Resolve agent — try by ID first, then by name
      let agentId = agentNameOrId
      const personas = listPersonas(db, id) as Array<Record<string, unknown>>
      const byName = personas.find(
        (p) => (p.name as string).toLowerCase() === agentNameOrId.toLowerCase(),
      )
      if (byName) {
        agentId = byName.id as string
      } else {
        const byId = personas.find((p) => p.id === agentNameOrId)
        if (!byId) {
          console.error(`Agent not found: ${agentNameOrId}`)
          console.error("Available agents:")
          for (const p of personas) {
            console.error(`  ${p.id} — ${p.name}`)
          }
          process.exit(1)
        }
      }

      const answer = await interviewAgent(db, id, agentId, question)

      output({ agent_id: agentId, question, answer }, () => {
        const agent = personas.find((p) => p.id === agentId)
        const name = agent ? (agent.name as string) : agentId
        console.log(`[${name}]:`)
        console.log(answer)
      })
    } catch (err) {
      console.error(`Interview error: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    } finally {
      db.close()
    }
  })

// ─── Actions ─────────────────────────────────────────────────────────────────

program
  .command("actions")
  .argument("<id>", "Simulation ID")
  .option("--round <n>", "Filter by round")
  .option("--agent <id>", "Filter by agent ID")
  .option("--type <type>", "Filter by action type")
  .option("--limit <n>", "Max results", "50")
  .description("Search agent actions")
  .action((id, opts) => {
    const db = getDb()
    try {
      const actions = listActions(db, id, {
        round: opts.round ? parseInt(opts.round, 10) : undefined,
        agent_id: opts.agent,
        action_type: opts.type,
      }) as Record<string, unknown>[]

      const limit = parseInt(opts.limit, 10)
      const limited = actions.slice(0, limit)

      output(limited, () => {
        if (limited.length === 0) {
          console.log("No actions found matching the filters.")
          return
        }

        console.log(`${limited.length} action(s)${actions.length > limit ? ` (showing ${limit} of ${actions.length})` : ""}:\n`)
        for (const a of limited) {
          const content = (a.content as string) ? `"${(a.content as string).slice(0, 60)}"` : ""
          const target = (a.target_post_id as string) ? ` -> ${a.target_post_id}` : ""
          console.log(`  [R${a.round}] ${a.agent_id} | ${a.action_type}${target}`)
          if (content) console.log(`    ${content}`)
          if (a.reasoning) console.log(`    Reason: ${(a.reasoning as string).slice(0, 80)}`)
        }
      })
    } finally {
      db.close()
    }
  })

// ─── Patterns ────────────────────────────────────────────────────────────────

program
  .command("patterns")
  .argument("<id>", "Simulation ID")
  .description("Show detected emergent patterns")
  .action((id) => {
    const db = getDb()
    try {
      const patterns = listPatterns(db, id) as Array<Record<string, unknown>>

      output(patterns, () => {
        if (patterns.length === 0) {
          console.log("No patterns detected yet.")
          return
        }

        console.log(`${patterns.length} pattern(s):\n`)
        for (const p of patterns) {
          const agents = (p.involved_agents as string[]) ?? []
          console.log(`  [Round ${p.first_seen_round}] ${(p.type as string).toUpperCase()} (intensity: ${((p.intensity as number) * 100).toFixed(0)}%)`)
          console.log(`    ${p.description}`)
          if (agents.length > 0) {
            console.log(`    Agents: ${agents.slice(0, 5).join(", ")}${agents.length > 5 ? ` +${agents.length - 5} more` : ""}`)
          }
          console.log()
        }
      })
    } finally {
      db.close()
    }
  })

// ─── Stop ────────────────────────────────────────────────────────────────────

program
  .command("stop")
  .argument("<id>", "Simulation ID")
  .description("Stop a running simulation")
  .action((id) => {
    const db = getDb()
    try {
      stopPrediction(db, id)
      output({ id, status: "stopped" }, () => {
        console.log(`Simulation ${id} stopped.`)
      })
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    } finally {
      db.close()
    }
  })

program.parse()
