#!/usr/bin/env bun

/**
 * predictor MCP server — exposes prediction tools to AI agents.
 * Provides simulation creation, execution, reporting, agent interviews,
 * and action search over stdio transport.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import {
  initDb,
  getSimulation,
  listActions,
  listPersonas,
  listPatterns,
  countActions,
} from "../db/index.ts"
import { getReport } from "../db/index.ts"
import {
  createPrediction,
  startPrediction,
  stopPrediction,
  getPredictionStatus,
  listPredictions,
} from "../engine/orchestrator.ts"
import { interviewAgent } from "../reports/interview.ts"

const server = new McpServer({
  name: "predictor",
  version: "0.0.1",
})

const db = initDb()

// ─── Tools ───────────────────────────────────────────────────────────────────

server.tool(
  "predictor_create_simulation",
  "Create a new social media prediction simulation",
  {
    name: z.string().describe("Simulation name"),
    graph_id: z.string().describe("Knowledge graph ID from researcher (source of entities)"),
    max_rounds: z.number().optional().describe("Maximum simulation rounds (default: 40)"),
    platforms: z.array(z.enum(["twitter", "reddit", "forum"])).optional().describe("Platforms to simulate (default: ['twitter'])"),
    model: z.string().optional().describe("LLM model for agent decisions (default: gpt-4.1-mini)"),
  },
  async (params) => {
    const config: Record<string, unknown> = {}
    if (params.max_rounds !== undefined) config.max_rounds = params.max_rounds
    if (params.platforms) config.platforms = params.platforms
    if (params.model) config.model = params.model

    const id = createPrediction(db, {
      name: params.name,
      graph_id: params.graph_id,
      config: config as Record<string, unknown>,
    })

    return {
      content: [{
        type: "text" as const,
        text: `Created simulation: ${params.name} (${id})\nGraph: ${params.graph_id}\nRounds: ${params.max_rounds ?? 40}\nPlatforms: ${(params.platforms ?? ["twitter"]).join(", ")}\nModel: ${params.model ?? "gpt-4.1-mini"}\n\nUse predictor_start_simulation to run it.`,
      }],
    }
  },
)

server.tool(
  "predictor_start_simulation",
  "Start a simulation — runs full pipeline: persona generation, rounds, pattern detection, report generation",
  {
    simulation_id: z.string().describe("Simulation ID to start"),
  },
  async (params) => {
    try {
      const report = await startPrediction(db, params.simulation_id, {
        onRound: () => {}, // no-op for MCP, progress is tracked in DB
      })

      const summary = [
        `Simulation completed.`,
        `Confidence: ${(report.confidence * 100).toFixed(0)}%`,
        ``,
        `Key predictions:`,
        ...report.key_predictions.map((p, i) => `  ${i + 1}. ${p}`),
        ``,
        `Methodology: ${report.methodology}`,
        ``,
        `Sections:`,
        ...report.sections.map((s) => `  - ${s.title} (${(s.confidence * 100).toFixed(0)}% confidence)`),
      ]

      return {
        content: [{
          type: "text" as const,
          text: summary.join("\n"),
        }],
      }
    } catch (err) {
      return {
        content: [{
          type: "text" as const,
          text: `Simulation failed: ${err instanceof Error ? err.message : String(err)}`,
        }],
      }
    }
  },
)

server.tool(
  "predictor_stop_simulation",
  "Stop a running simulation",
  {
    simulation_id: z.string().describe("Simulation ID to stop"),
  },
  async (params) => {
    try {
      stopPrediction(db, params.simulation_id)
      return {
        content: [{
          type: "text" as const,
          text: `Simulation ${params.simulation_id} stopped.`,
        }],
      }
    } catch (err) {
      return {
        content: [{
          type: "text" as const,
          text: `Error: ${err instanceof Error ? err.message : String(err)}`,
        }],
      }
    }
  },
)

server.tool(
  "predictor_get_status",
  "Get simulation status including round progress, agent count, and action count",
  {
    simulation_id: z.string().describe("Simulation ID"),
  },
  async (params) => {
    try {
      const status = getPredictionStatus(db, params.simulation_id)
      return {
        content: [{
          type: "text" as const,
          text: [
            `Simulation: ${status.name} (${status.id})`,
            `Status: ${status.status}`,
            `Round: ${status.current_round} / ${status.total_rounds}`,
            `Agents: ${status.agent_count}`,
            `Actions: ${status.action_count}`,
            `Cost: $${status.cost_total.toFixed(4)}`,
          ].join("\n"),
        }],
      }
    } catch (err) {
      return {
        content: [{
          type: "text" as const,
          text: `Error: ${err instanceof Error ? err.message : String(err)}`,
        }],
      }
    }
  },
)

server.tool(
  "predictor_list_simulations",
  "List all prediction simulations",
  {},
  async () => {
    const sims = listPredictions(db)

    if (sims.length === 0) {
      return {
        content: [{
          type: "text" as const,
          text: "No simulations. Use predictor_create_simulation to create one.",
        }],
      }
    }

    const lines = sims.map((s) =>
      `${s.id} | ${s.name} | ${s.status} | round ${s.current_round}/${s.config.max_rounds} | ${s.agent_count} agents | ${s.action_count} actions`,
    )

    return {
      content: [{
        type: "text" as const,
        text: lines.join("\n"),
      }],
    }
  },
)

server.tool(
  "predictor_get_report",
  "Get the prediction report for a completed simulation",
  {
    simulation_id: z.string().describe("Simulation ID"),
  },
  async (params) => {
    const report = getReport(db, params.simulation_id)

    if (!report) {
      return {
        content: [{
          type: "text" as const,
          text: `No report found for simulation ${params.simulation_id}. Run predictor_start_simulation first.`,
        }],
      }
    }

    const rpt = report as Record<string, unknown>
    const sections = (rpt.sections as Array<{ title: string; content: string; evidence: string[]; confidence: number }>)
      .map((s) => {
        const evidence = s.evidence.length > 0 ? `\n  Evidence: ${s.evidence.join("; ")}` : ""
        return `## ${s.title} (${(s.confidence * 100).toFixed(0)}% confidence)\n${s.content}${evidence}`
      })
      .join("\n\n")

    const predictions = (rpt.key_predictions as string[])
      .map((p, i) => `${i + 1}. ${p}`)
      .join("\n")

    return {
      content: [{
        type: "text" as const,
        text: [
          `# Prediction Report`,
          `Overall confidence: ${((rpt.confidence as number) * 100).toFixed(0)}%`,
          `Methodology: ${rpt.methodology}`,
          ``,
          `## Key Predictions`,
          predictions,
          ``,
          sections,
        ].join("\n"),
      }],
    }
  },
)

server.tool(
  "predictor_interview_agent",
  "Interview a simulated agent — ask questions about their behavior and reasoning in character",
  {
    simulation_id: z.string().describe("Simulation ID"),
    agent_id: z.string().describe("Agent persona ID"),
    question: z.string().describe("Question to ask the agent"),
  },
  async (params) => {
    try {
      const answer = await interviewAgent(
        db,
        params.simulation_id,
        params.agent_id,
        params.question,
      )
      return {
        content: [{
          type: "text" as const,
          text: answer,
        }],
      }
    } catch (err) {
      return {
        content: [{
          type: "text" as const,
          text: `Interview error: ${err instanceof Error ? err.message : String(err)}`,
        }],
      }
    }
  },
)

server.tool(
  "predictor_search_actions",
  "Search agent actions in a simulation with optional filters",
  {
    simulation_id: z.string().describe("Simulation ID"),
    round: z.number().optional().describe("Filter by round number"),
    agent_id: z.string().optional().describe("Filter by agent ID"),
    action_type: z.string().optional().describe("Filter by action type (create_post, like_post, reply, etc.)"),
    limit: z.number().optional().describe("Maximum results (default: 50)"),
  },
  async (params) => {
    const actions = listActions(db, params.simulation_id, {
      round: params.round,
      agent_id: params.agent_id,
      action_type: params.action_type,
    }) as Record<string, unknown>[]

    const limited = actions.slice(0, params.limit ?? 50)

    if (limited.length === 0) {
      return {
        content: [{
          type: "text" as const,
          text: "No actions found matching the filters.",
        }],
      }
    }

    const lines = limited.map((a) => {
      const content = (a.content as string) ? `: "${(a.content as string).slice(0, 80)}"` : ""
      const target = (a.target_post_id as string) ? ` -> ${a.target_post_id}` : ""
      return `[R${a.round}] ${a.agent_id} | ${a.action_type}${target}${content}`
    })

    return {
      content: [{
        type: "text" as const,
        text: `${limited.length} action(s)${actions.length > limited.length ? ` (showing ${limited.length} of ${actions.length})` : ""}:\n\n${lines.join("\n")}`,
      }],
    }
  },
)

// ─── Start server ────────────────────────────────────────────────────────────

const transport = new StdioServerTransport()
await server.connect(transport)
