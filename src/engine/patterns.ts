/**
 * Emergent pattern detection for simulation analysis.
 * Runs after each simulation round to detect information cascades,
 * viral content, opinion shifts, polarization, and consensus.
 *
 * Uses simple keyword/statistical analysis — no LLM calls.
 */

import { Database } from "bun:sqlite"
import { createPattern, listPosts, listActions, listPersonas } from "../db/index.ts"
import type { EmergentPattern, SimulatedPost, AgentAction } from "../types.ts"

// ─── Sentiment Word Lists ──────────────────────────────────────────────────

const POSITIVE_WORDS = new Set([
  "good", "great", "amazing", "love", "like", "agree", "support", "excellent",
  "wonderful", "fantastic", "happy", "positive", "best", "better", "awesome",
  "brilliant", "yes", "right", "true", "helpful", "hope", "beautiful",
  "progress", "improve", "success", "win", "benefit", "thank", "appreciate",
  "excited", "impressive", "perfect", "outstanding", "excellent", "favor",
])

const NEGATIVE_WORDS = new Set([
  "bad", "terrible", "hate", "dislike", "disagree", "oppose", "awful",
  "horrible", "worst", "worse", "angry", "negative", "wrong", "false",
  "harmful", "fear", "ugly", "decline", "fail", "failure", "lose", "damage",
  "sad", "disappointed", "frustrating", "annoying", "ridiculous", "stupid",
  "dangerous", "threat", "crisis", "problem", "concern", "worry", "against",
])

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Extract meaningful words from text (lowercase, 3+ chars, no stop words). */
function extractKeywords(text: string): string[] {
  const stopWords = new Set([
    "the", "and", "for", "are", "but", "not", "you", "all", "can", "had",
    "her", "was", "one", "our", "out", "has", "have", "been", "will", "this",
    "that", "with", "they", "from", "what", "which", "when", "make", "just",
    "its", "about", "into", "than", "them", "then", "some", "could", "would",
    "there", "their", "also", "more", "very", "much", "being", "does",
  ])
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !stopWords.has(w))
}

/** Compute simple sentiment score from text. Returns value in [-1, 1]. */
function sentimentScore(text: string): number {
  const words = text.toLowerCase().split(/\s+/)
  let pos = 0
  let neg = 0
  for (const w of words) {
    if (POSITIVE_WORDS.has(w)) pos++
    if (NEGATIVE_WORDS.has(w)) neg++
  }
  const total = pos + neg
  if (total === 0) return 0
  return (pos - neg) / total
}

// ─── Pattern Detectors ─────────────────────────────────────────────────────

/**
 * Information cascade: same keywords appearing in 3+ agents' posts within 2 rounds.
 */
function detectCascades(
  posts: SimulatedPost[],
  round: number,
  totalAgents: number,
): Omit<EmergentPattern, "id" | "created_at">[] {
  // Posts from the last 2 rounds
  const recentPosts = posts.filter((p) => p.round >= round - 1 && p.round <= round)
  if (recentPosts.length < 3) return []

  // keyword -> set of author IDs
  const keywordAgents = new Map<string, Set<string>>()
  for (const post of recentPosts) {
    const keywords = extractKeywords(post.content)
    for (const kw of keywords) {
      if (!keywordAgents.has(kw)) keywordAgents.set(kw, new Set())
      keywordAgents.get(kw)!.add(post.author_id)
    }
  }

  const patterns: Omit<EmergentPattern, "id" | "created_at">[] = []
  for (const [keyword, agents] of keywordAgents) {
    if (agents.size >= 3) {
      const agentList = [...agents]
      const intensity = totalAgents > 0 ? agentList.length / totalAgents : 0
      patterns.push({
        simulation_id: recentPosts[0].simulation_id,
        type: "cascade",
        description: `Information cascade around "${keyword}" — ${agentList.length} agents discussing in rounds ${round - 1}-${round}`,
        involved_agents: agentList,
        first_seen_round: round,
        intensity: Math.min(1, intensity),
      })
    }
  }

  // Deduplicate: keep the cascade with the most agents per overlapping group
  patterns.sort((a, b) => b.involved_agents.length - a.involved_agents.length)
  return patterns.slice(0, 5) // cap at 5 cascades per round
}

/**
 * Viral content: any post with engagement > 2x average.
 */
function detectViralContent(
  posts: SimulatedPost[],
  round: number,
): Omit<EmergentPattern, "id" | "created_at">[] {
  const roundPosts = posts.filter((p) => p.round <= round)
  if (roundPosts.length === 0) return []

  const engagements = roundPosts.map((p) => p.likes + p.reposts + p.replies)
  const avgEngagement = engagements.reduce((a, b) => a + b, 0) / engagements.length

  if (avgEngagement === 0) return []

  const patterns: Omit<EmergentPattern, "id" | "created_at">[] = []
  for (const post of roundPosts.filter((p) => p.round === round)) {
    const engagement = post.likes + post.reposts + post.replies
    if (engagement > 2 * avgEngagement) {
      const intensity = engagement / avgEngagement
      patterns.push({
        simulation_id: post.simulation_id,
        type: "viral",
        description: `Viral post by agent ${post.author_id}: "${post.content.slice(0, 80)}..." — ${engagement} engagement (${intensity.toFixed(1)}x average)`,
        involved_agents: [post.author_id],
        first_seen_round: round,
        intensity: Math.min(1, intensity / 10), // normalize: 10x = intensity 1.0
      })
    }
  }

  return patterns.slice(0, 3) // cap at 3 viral posts per round
}

/**
 * Opinion shift: compare sentiment of posts in early rounds vs recent rounds.
 */
function detectOpinionShift(
  posts: SimulatedPost[],
  round: number,
): Omit<EmergentPattern, "id" | "created_at">[] {
  if (round < 2) return [] // need at least 2 rounds to compare

  const midpoint = Math.floor(round / 2)
  const earlyPosts = posts.filter((p) => p.round <= midpoint)
  const recentPosts = posts.filter((p) => p.round > midpoint && p.round <= round)

  if (earlyPosts.length === 0 || recentPosts.length === 0) return []

  const earlySentiment = earlyPosts.reduce((sum, p) => sum + sentimentScore(p.content), 0) / earlyPosts.length
  const recentSentiment = recentPosts.reduce((sum, p) => sum + sentimentScore(p.content), 0) / recentPosts.length

  // Shift detected if sentiment crosses zero or changes significantly
  const shift = recentSentiment - earlySentiment
  const directionChange = (earlySentiment > 0 && recentSentiment < 0) || (earlySentiment < 0 && recentSentiment > 0)

  if (!directionChange && Math.abs(shift) < 0.2) return []

  const involvedAgents = [
    ...new Set(recentPosts.map((p) => p.author_id)),
  ]

  const direction = shift > 0 ? "positive" : "negative"
  return [
    {
      simulation_id: posts[0].simulation_id,
      type: "opinion_shift",
      description: `Opinion shifted ${direction} — early sentiment ${earlySentiment.toFixed(2)} -> recent ${recentSentiment.toFixed(2)} (delta: ${shift.toFixed(2)})`,
      involved_agents: involvedAgents,
      first_seen_round: round,
      intensity: Math.min(1, Math.abs(shift)),
    },
  ]
}

/**
 * Polarization: agents clustering into opposing stance groups.
 */
function detectPolarization(
  posts: SimulatedPost[],
  round: number,
): Omit<EmergentPattern, "id" | "created_at">[] {
  const recentPosts = posts.filter((p) => p.round >= round - 1 && p.round <= round)
  if (recentPosts.length < 4) return [] // need enough posts

  // Group agents by sentiment direction
  const agentSentiments = new Map<string, number[]>()
  for (const post of recentPosts) {
    const score = sentimentScore(post.content)
    if (!agentSentiments.has(post.author_id)) agentSentiments.set(post.author_id, [])
    agentSentiments.get(post.author_id)!.push(score)
  }

  // Average sentiment per agent
  const agentAvg = new Map<string, number>()
  for (const [agent, scores] of agentSentiments) {
    agentAvg.set(agent, scores.reduce((a, b) => a + b, 0) / scores.length)
  }

  // Split into positive and negative camps
  const positiveCamp: string[] = []
  const negativeCamp: string[] = []
  const neutralThreshold = 0.1

  for (const [agent, avg] of agentAvg) {
    if (avg > neutralThreshold) positiveCamp.push(agent)
    else if (avg < -neutralThreshold) negativeCamp.push(agent)
  }

  // Polarization requires both camps to have members
  if (positiveCamp.length < 2 || negativeCamp.length < 2) return []

  const totalPolarized = positiveCamp.length + negativeCamp.length
  const smallerCamp = Math.min(positiveCamp.length, negativeCamp.length)
  // Intensity: how evenly split (0.5 = perfectly polarized)
  const evenness = smallerCamp / totalPolarized
  // Scale so 0.5 split maps to intensity 1.0
  const intensity = evenness * 2

  return [
    {
      simulation_id: posts[0].simulation_id,
      type: "polarization",
      description: `Polarization detected — ${positiveCamp.length} positive vs ${negativeCamp.length} negative agents (${(intensity * 100).toFixed(0)}% balanced split)`,
      involved_agents: [...positiveCamp, ...negativeCamp],
      first_seen_round: round,
      intensity: Math.min(1, intensity),
    },
  ]
}

/**
 * Consensus: >70% of active agents expressing similar stance on a topic.
 */
function detectConsensus(
  posts: SimulatedPost[],
  round: number,
  totalAgents: number,
): Omit<EmergentPattern, "id" | "created_at">[] {
  const recentPosts = posts.filter((p) => p.round >= round - 1 && p.round <= round)
  if (recentPosts.length < 3) return []

  // Average sentiment per agent
  const agentSentiments = new Map<string, number[]>()
  for (const post of recentPosts) {
    const score = sentimentScore(post.content)
    if (!agentSentiments.has(post.author_id)) agentSentiments.set(post.author_id, [])
    agentSentiments.get(post.author_id)!.push(score)
  }

  let positiveCount = 0
  let negativeCount = 0

  for (const [, scores] of agentSentiments) {
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length
    if (avg > 0.1) positiveCount++
    else if (avg < -0.1) negativeCount++
  }

  const activeAgents = agentSentiments.size
  const referenceCount = Math.max(activeAgents, totalAgents)
  if (referenceCount === 0) return []

  const patterns: Omit<EmergentPattern, "id" | "created_at">[] = []

  // Check if >70% agree on positive
  if (positiveCount / referenceCount > 0.7) {
    const agents = [...agentSentiments.entries()]
      .filter(([, scores]) => scores.reduce((a, b) => a + b, 0) / scores.length > 0.1)
      .map(([id]) => id)
    patterns.push({
      simulation_id: posts[0].simulation_id,
      type: "consensus",
      description: `Positive consensus — ${positiveCount}/${referenceCount} agents (${((positiveCount / referenceCount) * 100).toFixed(0)}%) expressing positive sentiment`,
      involved_agents: agents,
      first_seen_round: round,
      intensity: positiveCount / referenceCount,
    })
  }

  // Check if >70% agree on negative
  if (negativeCount / referenceCount > 0.7) {
    const agents = [...agentSentiments.entries()]
      .filter(([, scores]) => scores.reduce((a, b) => a + b, 0) / scores.length < -0.1)
      .map(([id]) => id)
    patterns.push({
      simulation_id: posts[0].simulation_id,
      type: "consensus",
      description: `Negative consensus — ${negativeCount}/${referenceCount} agents (${((negativeCount / referenceCount) * 100).toFixed(0)}%) expressing negative sentiment`,
      involved_agents: agents,
      first_seen_round: round,
      intensity: negativeCount / referenceCount,
    })
  }

  return patterns
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Analyze engagement statistics for a simulation round.
 */
export function analyzeEngagement(
  db: Database,
  simulationId: string,
  round: number,
): { avg_likes: number; avg_reposts: number; total_posts: number; top_post_id: string | null } {
  const allPosts = listPosts(db, simulationId) as SimulatedPost[]
  const roundPosts = allPosts.filter((p) => p.round === round)

  if (roundPosts.length === 0) {
    return { avg_likes: 0, avg_reposts: 0, total_posts: 0, top_post_id: null }
  }

  const avgLikes = roundPosts.reduce((sum, p) => sum + p.likes, 0) / roundPosts.length
  const avgReposts = roundPosts.reduce((sum, p) => sum + p.reposts, 0) / roundPosts.length

  let topPost = roundPosts[0]
  let topEngagement = topPost.likes + topPost.reposts + topPost.replies
  for (const p of roundPosts) {
    const eng = p.likes + p.reposts + p.replies
    if (eng > topEngagement) {
      topPost = p
      topEngagement = eng
    }
  }

  return {
    avg_likes: avgLikes,
    avg_reposts: avgReposts,
    total_posts: roundPosts.length,
    top_post_id: topPost.id,
  }
}

/**
 * Detect all emergent patterns for a simulation round.
 * Stores detected patterns via createPattern() and returns them.
 */
export async function detectPatterns(
  db: Database,
  simulationId: string,
  round: number,
): Promise<EmergentPattern[]> {
  const allPosts = listPosts(db, simulationId) as SimulatedPost[]
  const personas = listPersonas(db, simulationId)
  const totalAgents = personas.length

  // Run all detectors
  const rawPatterns = [
    ...detectCascades(allPosts, round, totalAgents),
    ...detectViralContent(allPosts, round),
    ...detectOpinionShift(allPosts, round),
    ...detectPolarization(allPosts, round),
    ...detectConsensus(allPosts, round, totalAgents),
  ]

  // Store and collect full patterns
  const patterns: EmergentPattern[] = []
  for (const raw of rawPatterns) {
    const id = createPattern(db, {
      simulation_id: simulationId,
      type: raw.type,
      description: raw.description,
      involved_agents: raw.involved_agents,
      first_seen_round: raw.first_seen_round,
      intensity: raw.intensity,
    })

    patterns.push({
      id,
      simulation_id: simulationId,
      type: raw.type,
      description: raw.description,
      involved_agents: raw.involved_agents,
      first_seen_round: raw.first_seen_round,
      intensity: raw.intensity,
      created_at: new Date().toISOString(),
    })
  }

  return patterns
}
