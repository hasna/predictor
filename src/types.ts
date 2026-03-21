/**
 * Core types for the predictor engine.
 */

// ─── Simulation ─────────────────────────────────────────────────────────────

export interface Simulation {
  id: string
  project_id: string | null
  graph_id: string
  name: string
  description: string
  status: "pending" | "running" | "completed" | "failed" | "stopped"
  config: SimulationConfig
  total_rounds: number
  current_round: number
  agent_count: number
  action_count: number
  cost_total: number
  created_at: string
  updated_at: string
}

export interface SimulationConfig {
  max_rounds: number
  agents_per_round: number
  platforms: PlatformType[]
  time_zone: string
  start_time: string
  hours_per_round: number
  model: string
  temperature: number
}

export type PlatformType = "twitter" | "reddit" | "forum"

// ─── Agents (Personas) ─────────────────────────────────────────────────────

export interface AgentPersona {
  id: string
  simulation_id: string
  node_id: string
  name: string
  personality: PersonalityProfile
  social_metrics: SocialMetrics
  activity_config: ActivityConfig
  memory: string[]
  created_at: string
}

export interface PersonalityProfile {
  mbti: string
  traits: string[]
  stance: Record<string, string>
  interests: string[]
  communication_style: string
  emotional_tendency: string
}

export interface SocialMetrics {
  followers: number
  following: number
  influence_score: number
  activity_level: "very_low" | "low" | "medium" | "high" | "very_high"
}

export interface ActivityConfig {
  posting_frequency: number
  peak_hours: number[]
  preferred_platforms: PlatformType[]
  response_probability: number
}

// ─── Actions ────────────────────────────────────────────────────────────────

export type ActionType =
  | "create_post"
  | "like_post"
  | "repost"
  | "quote_post"
  | "reply"
  | "follow"
  | "create_comment"
  | "upvote"
  | "downvote"
  | "do_nothing"

export interface AgentAction {
  id: string
  simulation_id: string
  agent_id: string
  round: number
  platform: PlatformType
  action_type: ActionType
  content: string
  target_post_id: string | null
  target_agent_id: string | null
  reasoning: string
  created_at: string
}

// ─── Posts ──────────────────────────────────────────────────────────────────

export interface SimulatedPost {
  id: string
  simulation_id: string
  platform: PlatformType
  author_id: string
  content: string
  parent_id: string | null
  likes: number
  reposts: number
  replies: number
  round: number
  created_at: string
}

// ─── Reports ────────────────────────────────────────────────────────────────

export interface PredictionReport {
  id: string
  simulation_id: string
  sections: ReportSection[]
  confidence: number
  key_predictions: string[]
  methodology: string
  created_at: string
}

export interface ReportSection {
  title: string
  content: string
  evidence: string[]
  confidence: number
}

// ─── Emergent Patterns ──────────────────────────────────────────────────────

export interface EmergentPattern {
  id: string
  simulation_id: string
  type: "cascade" | "opinion_shift" | "viral" | "polarization" | "consensus"
  description: string
  involved_agents: string[]
  first_seen_round: number
  intensity: number
  created_at: string
}
