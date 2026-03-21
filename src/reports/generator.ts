/**
 * Prediction report generator.
 * Uses LLM with structured JSON output to produce analysis reports
 * from simulation data — patterns, engagement, agent activity.
 */

import { Database } from "bun:sqlite"
import OpenAI from "openai"
import {
  getSimulation,
  listActions,
  listPosts,
  getTopPosts,
  listPatterns,
  listPersonas,
  createReport,
} from "../db/index.ts"
import type { PredictionReport, ReportSection, SimulatedPost, EmergentPattern } from "../types.ts"

// ─── OpenAI Client ─────────────────────────────────────────────────────────

const DEFAULT_MODEL = "gpt-4.1-mini"

let _client: OpenAI | null = null

function getClient(): OpenAI {
  if (_client) return _client
  _client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY ?? process.env.LLM_API_KEY,
    baseURL: process.env.LLM_BASE_URL,
  })
  return _client
}

export function setReportClient(client: OpenAI): void {
  _client = client
}

// ─── Data Gathering ────────────────────────────────────────────────────────

interface SimulationSummary {
  name: string
  description: string
  status: string
  total_rounds: number
  current_round: number
  agent_count: number
  action_count: number
  cost_total: number
  agent_names: string[]
  total_posts: number
  total_likes: number
  total_reposts: number
  total_replies: number
  top_posts: { author: string; content: string; likes: number; reposts: number; replies: number }[]
  patterns: { type: string; description: string; intensity: number; round: number }[]
  action_breakdown: Record<string, number>
  posts_per_round: Record<number, number>
}

function gatherSimulationData(db: Database, simulationId: string): SimulationSummary | null {
  const sim = getSimulation(db, simulationId)
  if (!sim) return null

  const personas = listPersonas(db, simulationId)
  const actions = listActions(db, simulationId) as { action_type: string }[]
  const posts = listPosts(db, simulationId) as SimulatedPost[]
  const topPosts = getTopPosts(db, simulationId, undefined, 5) as SimulatedPost[]
  const patterns = listPatterns(db, simulationId) as EmergentPattern[]

  // Action breakdown
  const actionBreakdown: Record<string, number> = {}
  for (const action of actions) {
    actionBreakdown[action.action_type] = (actionBreakdown[action.action_type] ?? 0) + 1
  }

  // Posts per round
  const postsPerRound: Record<number, number> = {}
  for (const post of posts) {
    postsPerRound[post.round] = (postsPerRound[post.round] ?? 0) + 1
  }

  // Engagement totals
  const totalLikes = posts.reduce((s, p) => s + p.likes, 0)
  const totalReposts = posts.reduce((s, p) => s + p.reposts, 0)
  const totalReplies = posts.reduce((s, p) => s + p.replies, 0)

  return {
    name: sim.name as string,
    description: sim.description as string,
    status: sim.status as string,
    total_rounds: sim.total_rounds as number,
    current_round: sim.current_round as number,
    agent_count: sim.agent_count as number,
    action_count: sim.action_count as number,
    cost_total: sim.cost_total as number,
    agent_names: personas.map((p) => p.name as string),
    total_posts: posts.length,
    total_likes: totalLikes,
    total_reposts: totalReposts,
    total_replies: totalReplies,
    top_posts: topPosts.map((p) => ({
      author: p.author_id,
      content: p.content,
      likes: p.likes,
      reposts: p.reposts,
      replies: p.replies,
    })),
    patterns: patterns.map((p) => ({
      type: p.type as string,
      description: p.description as string,
      intensity: p.intensity as number,
      round: p.first_seen_round as number,
    })),
    action_breakdown: actionBreakdown,
    posts_per_round: postsPerRound,
  }
}

// ─── LLM Report Generation ────────────────────────────────────────────────

function buildReportPrompt(summary: SimulationSummary, requirement?: string): string {
  const patternList =
    summary.patterns.length > 0
      ? summary.patterns
          .map((p) => `  - [Round ${p.round}] ${p.type} (intensity ${p.intensity.toFixed(2)}): ${p.description}`)
          .join("\n")
      : "  No patterns detected"

  const topPostList =
    summary.top_posts.length > 0
      ? summary.top_posts
          .map((p) => `  - @${p.author}: "${p.content.slice(0, 100)}" (${p.likes} likes, ${p.reposts} reposts, ${p.replies} replies)`)
          .join("\n")
      : "  No posts yet"

  const actionList = Object.entries(summary.action_breakdown)
    .sort(([, a], [, b]) => b - a)
    .map(([type, count]) => `  - ${type}: ${count}`)
    .join("\n")

  const roundActivity = Object.entries(summary.posts_per_round)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([round, count]) => `  Round ${round}: ${count} posts`)
    .join("\n")

  return `You are an expert social media analyst producing a prediction report from simulation data.

## Simulation: "${summary.name}"
${summary.description}

## Statistics
- Status: ${summary.status}
- Rounds completed: ${summary.current_round} / ${summary.total_rounds}
- Agents: ${summary.agent_count} (${summary.agent_names.join(", ")})
- Total actions: ${summary.action_count}
- Total posts: ${summary.total_posts}
- Total engagement: ${summary.total_likes} likes, ${summary.total_reposts} reposts, ${summary.total_replies} replies

## Action Breakdown
${actionList || "  No actions recorded"}

## Posts Per Round
${roundActivity || "  No round data"}

## Top Posts
${topPostList}

## Detected Patterns
${patternList}

${requirement ? `## Special Requirement\n${requirement}\n` : ""}

## Task
Generate a prediction report with exactly 4 sections. Return valid JSON with this schema:

{
  "overview": {
    "title": "Overview",
    "content": "Summary of what was simulated and key participants",
    "evidence": ["list of supporting data points"],
    "confidence": 0.0 to 1.0
  },
  "key_trends": {
    "title": "Key Trends",
    "content": "What patterns and trends emerged during the simulation",
    "evidence": ["list of supporting data points"],
    "confidence": 0.0 to 1.0
  },
  "predictions": {
    "title": "Predictions",
    "content": "What would happen if the simulation continued — specific predictions",
    "evidence": ["list of supporting data points"],
    "confidence": 0.0 to 1.0
  },
  "risk_factors": {
    "title": "Risk Factors",
    "content": "What could change the outcome or invalidate predictions",
    "evidence": ["list of supporting data points"],
    "confidence": 0.0 to 1.0
  },
  "key_predictions": ["concise prediction 1", "concise prediction 2", "concise prediction 3"],
  "overall_confidence": 0.0 to 1.0,
  "methodology": "Brief description of how predictions were derived"
}

Be specific, data-driven, and cite actual posts, patterns, and stats from the simulation.`
}

interface LLMReportResponse {
  overview: ReportSection
  key_trends: ReportSection
  predictions: ReportSection
  risk_factors: ReportSection
  key_predictions: string[]
  overall_confidence: number
  methodology: string
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Generate a prediction report for a simulation.
 * Gathers all simulation data, calls LLM for analysis, stores the report.
 */
export async function generateReport(
  db: Database,
  simulationId: string,
  requirement?: string,
): Promise<PredictionReport> {
  const summary = gatherSimulationData(db, simulationId)
  if (!summary) {
    throw new Error(`Simulation ${simulationId} not found`)
  }

  const client = getClient()
  const prompt = buildReportPrompt(summary, requirement)

  const response = await client.chat.completions.create({
    model: DEFAULT_MODEL,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: "Generate the prediction report as JSON." },
    ],
    temperature: 0.4,
    max_tokens: 2048,
  })

  const content = response.choices[0]?.message?.content
  if (!content) {
    throw new Error("LLM returned empty response for report generation")
  }

  const parsed: LLMReportResponse = JSON.parse(content)

  // Build sections array
  const sections: ReportSection[] = [
    parsed.overview,
    parsed.key_trends,
    parsed.predictions,
    parsed.risk_factors,
  ].map((s) => ({
    title: s.title ?? "Untitled",
    content: s.content ?? "",
    evidence: Array.isArray(s.evidence) ? s.evidence : [],
    confidence: typeof s.confidence === "number" ? s.confidence : 0.5,
  }))

  const confidence = typeof parsed.overall_confidence === "number" ? parsed.overall_confidence : 0.5
  const keyPredictions = Array.isArray(parsed.key_predictions) ? parsed.key_predictions : []
  const methodology = parsed.methodology ?? "LLM analysis of simulation data"

  // Store report
  const reportId = createReport(db, {
    simulation_id: simulationId,
    sections,
    confidence,
    key_predictions: keyPredictions,
    methodology,
  })

  return {
    id: reportId,
    simulation_id: simulationId,
    sections,
    confidence,
    key_predictions: keyPredictions,
    methodology,
    created_at: new Date().toISOString(),
  }
}
