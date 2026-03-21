/**
 * Agent persona generator — converts graph entities into detailed simulation agents.
 * Uses @hasna/researcher/graph for entity data and LLM for persona generation.
 */

import { Database } from "bun:sqlite"
import OpenAI from "openai"
import type { AgentPersona, PersonalityProfile, SocialMetrics, ActivityConfig, PlatformType } from "../types.ts"
import { createPersona } from "../db/index.ts"

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

export function setPersonaClient(client: OpenAI): void {
  _client = client
}

interface GraphNode {
  id: string
  name: string
  labels: string[]
  summary: string
  attributes: Record<string, unknown>
}

interface GraphEdge {
  name: string
  fact: string
  source_node_id: string
  target_node_id: string
}

const PERSONA_SYSTEM_PROMPT = `You are an expert at creating detailed character profiles for social media simulation agents.

Given an entity description (extracted from a document), generate a realistic persona for how this entity would behave on social media.

Return valid JSON with this exact schema:
{
  "personality": {
    "mbti": "ENTJ",
    "traits": ["ambitious", "strategic", "outspoken"],
    "stance": {"topic1": "supportive", "topic2": "critical"},
    "interests": ["technology", "business"],
    "communication_style": "formal and authoritative",
    "emotional_tendency": "measured but passionate about innovation"
  },
  "social_metrics": {
    "followers": 50000,
    "following": 500,
    "influence_score": 0.85,
    "activity_level": "high"
  },
  "activity_config": {
    "posting_frequency": 3,
    "peak_hours": [9, 12, 17, 20],
    "preferred_platforms": ["twitter"],
    "response_probability": 0.6
  }
}

Rules:
- MBTI should match the entity's known behavior
- Followers/influence should reflect real-world prominence
- Activity level: very_low (<1/day), low (1-2), medium (3-5), high (6-10), very_high (>10)
- posting_frequency = average posts per day
- peak_hours = hours of day (0-23) when most active
- response_probability = 0.0-1.0 chance of responding to mentions
- Stance topics should relate to the document context
- Be realistic — a CEO posts differently than a journalist or activist`

export async function generatePersonas(
  db: Database,
  simulationId: string,
  entities: Array<{ node: GraphNode; edges: GraphEdge[] }>,
  options?: {
    model?: string
    platforms?: PlatformType[]
  },
): Promise<AgentPersona[]> {
  const model = options?.model ?? DEFAULT_MODEL
  const client = getClient()
  const personas: AgentPersona[] = []

  for (const { node, edges } of entities) {
    // Skip non-person/org entities that wouldn't post on social media
    const isAgent = node.labels.some((l) =>
      ["person", "organization", "media", "influencer", "journalist", "politician"].includes(l.toLowerCase()),
    )
    if (!isAgent && node.labels.length > 0) continue

    // Build context for LLM
    const edgeContext = edges
      .slice(0, 10)
      .map((e) => `- ${e.name}: ${e.fact}`)
      .join("\n")

    const userPrompt = `Entity: ${node.name}
Type: ${node.labels.join(", ")}
Summary: ${node.summary}
${edgeContext ? `\nRelationships:\n${edgeContext}` : ""}
${options?.platforms ? `\nTarget platforms: ${options.platforms.join(", ")}` : ""}`

    try {
      const response = await client.chat.completions.create({
        model,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: PERSONA_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.7,
        max_tokens: 1024,
      })

      const content = response.choices[0]?.message?.content
      if (!content) continue

      const parsed = JSON.parse(content)
      const personality: PersonalityProfile = {
        mbti: parsed.personality?.mbti ?? "INTJ",
        traits: parsed.personality?.traits ?? [],
        stance: parsed.personality?.stance ?? {},
        interests: parsed.personality?.interests ?? [],
        communication_style: parsed.personality?.communication_style ?? "neutral",
        emotional_tendency: parsed.personality?.emotional_tendency ?? "balanced",
      }
      const social_metrics: SocialMetrics = {
        followers: parsed.social_metrics?.followers ?? 100,
        following: parsed.social_metrics?.following ?? 50,
        influence_score: parsed.social_metrics?.influence_score ?? 0.5,
        activity_level: parsed.social_metrics?.activity_level ?? "medium",
      }
      const activity_config: ActivityConfig = {
        posting_frequency: parsed.activity_config?.posting_frequency ?? 2,
        peak_hours: parsed.activity_config?.peak_hours ?? [9, 12, 18],
        preferred_platforms: parsed.activity_config?.preferred_platforms ?? options?.platforms ?? ["twitter"],
        response_probability: parsed.activity_config?.response_probability ?? 0.5,
      }

      const id = createPersona(db, {
        simulation_id: simulationId,
        node_id: node.id,
        name: node.name,
        personality,
        social_metrics,
        activity_config,
        memory: [],
      })

      personas.push({
        id,
        simulation_id: simulationId,
        node_id: node.id,
        name: node.name,
        personality,
        social_metrics,
        activity_config,
        memory: [],
        created_at: new Date().toISOString(),
      })
    } catch {
      // Skip entities that fail persona generation
      continue
    }
  }

  // Update simulation agent count
  db.run("UPDATE simulations SET agent_count = ?, updated_at = datetime('now') WHERE id = ?", [
    personas.length,
    simulationId,
  ])

  return personas
}

export function generatePersonaFromTemplate(
  name: string,
  labels: string[],
  summary: string,
  edgeCount: number,
): Omit<AgentPersona, "id" | "simulation_id" | "node_id" | "created_at"> {
  const isPerson = labels.some((l) => l.toLowerCase() === "person")
  const isOrg = labels.some((l) => l.toLowerCase() === "organization")
  const influence = Math.min(1, edgeCount / 20)

  return {
    name,
    personality: {
      mbti: isPerson ? "ENTJ" : "ISTJ",
      traits: isPerson ? ["articulate", "opinionated"] : ["institutional", "measured"],
      stance: {},
      interests: [],
      communication_style: isOrg ? "formal corporate" : "personal and direct",
      emotional_tendency: isOrg ? "neutral" : "engaged",
    },
    social_metrics: {
      followers: Math.round(100 + edgeCount * 500),
      following: Math.round(50 + edgeCount * 20),
      influence_score: Math.round(influence * 100) / 100,
      activity_level: edgeCount > 10 ? "high" : edgeCount > 5 ? "medium" : "low",
    },
    activity_config: {
      posting_frequency: edgeCount > 10 ? 5 : edgeCount > 5 ? 3 : 1,
      peak_hours: [9, 12, 17, 20],
      preferred_platforms: ["twitter"],
      response_probability: isPerson ? 0.6 : 0.3,
    },
    memory: [],
  }
}
