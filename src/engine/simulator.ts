/**
 * Round-based simulation engine.
 * Orchestrates agents making decisions and interacting on simulated social platforms.
 */

import { Database } from "bun:sqlite"
import type { AgentPersona, SimulatedPost, PlatformType } from "../types.ts"
import type { Simulation } from "../types.ts"
import {
  getSimulation as getSimulationRaw,
  listPersonas,
  updateSimulationStatus,
  updateSimulationRound,
  createAction,
  countActions,
  listPosts,
} from "../db/index.ts"

/** Type-safe wrapper around the loosely-typed db getter. */
function getSimulation(db: Database, id: string): Simulation | null {
  return getSimulationRaw(db, id) as Simulation | null
}
import { decideAction } from "./agent-brain.ts"
import type { AgentContext, AgentDecision } from "./agent-brain.ts"
import * as twitter from "../platforms/twitter.ts"
import * as reddit from "../platforms/reddit.ts"

// ─── Types ──────────────────────────────────────────────────────────────────

interface RunSimulationOptions {
  model?: string
  onRoundComplete?: (round: number, actionsTaken: number) => void
}

interface RoundResult {
  actions_taken: number
}

// ─── Activity Level Probabilities ───────────────────────────────────────────

const ACTIVITY_PROBABILITY: Record<string, number> = {
  very_high: 0.9,
  high: 0.7,
  medium: 0.5,
  low: 0.3,
  very_low: 0.1,
}

// ─── Main Simulation Loop ───────────────────────────────────────────────────

/**
 * Run a full simulation from current_round to max_rounds.
 * Updates the simulation status and round counter as it progresses.
 */
export async function runSimulation(
  db: Database,
  simulationId: string,
  options?: RunSimulationOptions,
): Promise<void> {
  const sim = getSimulation(db, simulationId)
  if (!sim) throw new Error(`Simulation ${simulationId} not found`)

  const config = sim.config
  const maxRounds = config.max_rounds ?? sim.total_rounds ?? 10
  const startRound = sim.current_round + 1

  // Mark as running
  updateSimulationStatus(db, simulationId, "running")

  for (let round = startRound; round <= maxRounds; round++) {
    // Check if simulation was stopped externally
    const current = getSimulation(db, simulationId)
    if (current?.status === "stopped") break

    const result = await runRound(db, simulationId, round, options)

    // Update round counter and total action count
    const totalActions = countActions(db, simulationId)
    updateSimulationRound(db, simulationId, round, totalActions)

    options?.onRoundComplete?.(round, result.actions_taken)
  }

  // Final status
  const finalSim = getSimulation(db, simulationId)
  if (finalSim?.status !== "stopped") {
    updateSimulationStatus(db, simulationId, "completed")
  }
}

// ─── Single Round ───────────────────────────────────────────────────────────

/**
 * Execute one round of the simulation.
 * Gets active agents, has each make a decision, and executes it.
 */
export async function runRound(
  db: Database,
  simulationId: string,
  roundNum: number,
  options?: RunSimulationOptions,
): Promise<RoundResult> {
  const activeAgents = getActiveAgents(db, simulationId, roundNum)
  let actionsTaken = 0

  for (const persona of activeAgents) {
    const context = buildAgentContext(db, simulationId, persona, roundNum)
    const decision = await decideAction(persona, context, { model: options?.model })

    await executeDecision(db, simulationId, persona, decision, roundNum)
    actionsTaken++

    // Update agent memory with what happened
    updateAgentMemory(db, persona, decision, roundNum)
  }

  return { actions_taken: actionsTaken }
}

// ─── Active Agent Selection ─────────────────────────────────────────────────

/**
 * Determine which agents are active this round.
 * Filters by peak hours and applies probability based on activity level.
 */
export function getActiveAgents(
  db: Database,
  simulationId: string,
  roundNum: number,
): AgentPersona[] {
  const allPersonas = listPersonas(db, simulationId) as AgentPersona[]

  // Calculate simulated hour from the simulation config
  const sim = getSimulation(db, simulationId)
  const config = sim?.config
  const hoursPerRound = config?.hours_per_round ?? 1
  const startHour = config?.start_time ? parseInt(config.start_time.split(":")[0], 10) : 8
  const simulatedHour = (startHour + (roundNum - 1) * hoursPerRound) % 24

  return allPersonas.filter((persona) => {
    // Check if current hour is in their peak hours
    const peakHours = persona.activity_config?.peak_hours ?? []
    const isInPeakHours = peakHours.length === 0 || peakHours.includes(simulatedHour)

    if (!isInPeakHours) return false

    // Apply probability based on activity level
    const level = persona.social_metrics?.activity_level ?? "medium"
    const probability = ACTIVITY_PROBABILITY[level] ?? 0.5

    return Math.random() < probability
  })
}

// ─── Context Builder ────────────────────────────────────────────────────────

/**
 * Build the context an agent sees when making a decision.
 * Includes timeline, trending, own posts, and memory.
 */
export function buildAgentContext(
  db: Database,
  simulationId: string,
  persona: AgentPersona,
  round: number,
): AgentContext {
  const sim = getSimulation(db, simulationId)
  const config = sim?.config
  const hoursPerRound = config?.hours_per_round ?? 1
  const startHour = config?.start_time ? parseInt(config.start_time.split(":")[0], 10) : 8
  const simulatedHour = (startHour + (round - 1) * hoursPerRound) % 24

  // Determine preferred platform
  const preferredPlatform = persona.activity_config?.preferred_platforms?.[0] ?? "twitter"

  // Get timeline based on platform
  let timeline: SimulatedPost[]
  let trending: SimulatedPost[]

  if (preferredPlatform === "reddit") {
    timeline = reddit.getFrontPage(db, simulationId, round, 20)
    // Reddit doesn't have a separate trending — use same feed sorted differently
    trending = reddit.getFrontPage(db, simulationId, round, 10)
  } else {
    timeline = twitter.getTimeline(db, simulationId, persona.id, round, 20)
    trending = twitter.getTrending(db, simulationId, round, 10)
  }

  // Get agent's own recent posts
  const recentOwnPosts = listPosts(db, simulationId, {
    author_id: persona.id,
  }) as SimulatedPost[]
  // Take only last 5
  const ownPostsSlice = recentOwnPosts.slice(-5)

  // Agent memory
  const memory = Array.isArray(persona.memory) ? persona.memory : []

  return {
    round,
    simulated_hour: simulatedHour,
    timeline,
    trending,
    recent_own_posts: ownPostsSlice,
    memory,
  }
}

// ─── Decision Executor ──────────────────────────────────────────────────────

/**
 * Execute an agent's decision on the appropriate platform.
 * Records the action in the database.
 */
export async function executeDecision(
  db: Database,
  simulationId: string,
  persona: AgentPersona,
  decision: AgentDecision,
  round: number,
): Promise<void> {
  const preferredPlatform: PlatformType = persona.activity_config?.preferred_platforms?.[0] ?? "twitter"

  switch (decision.action_type) {
    case "create_post": {
      const content = decision.content ?? ""
      if (preferredPlatform === "reddit") {
        reddit.submitPost(db, simulationId, persona.id, content, round)
      } else {
        twitter.tweet(db, simulationId, persona.id, content, round)
      }
      break
    }

    case "like_post": {
      if (decision.target_post_id) {
        twitter.like(db, decision.target_post_id)
      }
      break
    }

    case "repost": {
      if (decision.target_post_id) {
        twitter.repost(db, simulationId, persona.id, decision.target_post_id, round)
      }
      break
    }

    case "quote_post": {
      if (decision.target_post_id && decision.content) {
        twitter.quoteTweet(db, simulationId, persona.id, decision.target_post_id, decision.content, round)
      }
      break
    }

    case "reply": {
      if (decision.target_post_id && decision.content) {
        twitter.reply(db, simulationId, persona.id, decision.target_post_id, decision.content, round)
      }
      break
    }

    case "create_comment": {
      if (decision.target_post_id && decision.content) {
        reddit.comment(db, simulationId, persona.id, decision.target_post_id, decision.content, round)
      }
      break
    }

    case "upvote": {
      if (decision.target_post_id) {
        reddit.upvote(db, decision.target_post_id)
      }
      break
    }

    case "downvote": {
      if (decision.target_post_id) {
        reddit.downvote(db, decision.target_post_id)
      }
      break
    }

    case "follow":
    case "do_nothing":
    default:
      // No platform action needed
      break
  }

  // Record the action in the database
  createAction(db, {
    simulation_id: simulationId,
    agent_id: persona.id,
    round,
    platform: preferredPlatform,
    action_type: decision.action_type,
    content: decision.content ?? "",
    target_post_id: decision.target_post_id,
    reasoning: decision.reasoning,
  })
}

// ─── Memory Update ──────────────────────────────────────────────────────────

/**
 * Update an agent's memory array with a summary of what they did this round.
 */
function updateAgentMemory(
  db: Database,
  persona: AgentPersona,
  decision: AgentDecision,
  round: number,
): void {
  let memoryEntry: string

  switch (decision.action_type) {
    case "create_post":
      memoryEntry = `Round ${round}: Posted "${decision.content?.slice(0, 60)}${(decision.content?.length ?? 0) > 60 ? "..." : ""}"`
      break
    case "like_post":
      memoryEntry = `Round ${round}: Liked post ${decision.target_post_id}`
      break
    case "repost":
      memoryEntry = `Round ${round}: Reposted ${decision.target_post_id}`
      break
    case "quote_post":
      memoryEntry = `Round ${round}: Quote-posted ${decision.target_post_id} with commentary`
      break
    case "reply":
    case "create_comment":
      memoryEntry = `Round ${round}: Replied to ${decision.target_post_id}: "${decision.content?.slice(0, 40)}..."`
      break
    case "upvote":
      memoryEntry = `Round ${round}: Upvoted post ${decision.target_post_id}`
      break
    case "downvote":
      memoryEntry = `Round ${round}: Downvoted post ${decision.target_post_id}`
      break
    default:
      memoryEntry = `Round ${round}: Did nothing — ${decision.reasoning.slice(0, 60)}`
      break
  }

  // Keep memory bounded to last 20 entries
  const currentMemory = Array.isArray(persona.memory) ? [...persona.memory] : []
  currentMemory.push(memoryEntry)
  const trimmedMemory = currentMemory.slice(-20)

  // Persist to database
  db.run("UPDATE agent_personas SET memory = ? WHERE id = ?", [JSON.stringify(trimmedMemory), persona.id])

  // Update in-memory reference so subsequent rounds in the same process see it
  persona.memory = trimmedMemory
}
