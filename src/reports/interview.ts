/**
 * Agent interview system — chat with simulated agents after simulation.
 * Loads agent persona, action history, and memory to answer questions in character.
 */

import { Database } from "bun:sqlite"
import OpenAI from "openai"
import { getPersona, listActions } from "../db/index.ts"
import type { AgentAction } from "../types.ts"

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

export function setInterviewClient(client: OpenAI): void {
  _client = client
}

// ─── System Prompt ─────────────────────────────────────────────────────────

function buildInterviewPrompt(
  persona: Record<string, unknown>,
  actions: AgentAction[],
): string {
  const personality = persona.personality as Record<string, unknown>
  const socialMetrics = persona.social_metrics as Record<string, unknown>
  const memory = persona.memory as string[]

  const traits = Array.isArray(personality.traits) ? personality.traits.join(", ") : "unknown"
  const interests = Array.isArray(personality.interests) ? personality.interests.join(", ") : "unknown"
  const stanceEntries = personality.stance && typeof personality.stance === "object"
    ? Object.entries(personality.stance as Record<string, string>)
        .map(([topic, position]) => `  - ${topic}: ${position}`)
        .join("\n")
    : "  (none specified)"

  // Summarize actions
  const actionSummary = actions.length > 0
    ? actions
        .slice(-20) // last 20 actions
        .map((a) => {
          const target = a.target_post_id ? ` (on post ${a.target_post_id})` : ""
          const content = a.content ? `: "${a.content.slice(0, 80)}"` : ""
          return `  - Round ${a.round}: ${a.action_type}${target}${content}`
        })
        .join("\n")
    : "  (no actions taken)"

  const memoryStr = memory.length > 0
    ? memory.map((m) => `  - ${m}`).join("\n")
    : "  (no memories)"

  return `You are ${persona.name}, a social media user who just participated in a simulation. You are now being interviewed about your experience.

## Your Identity
- Name: ${persona.name}
- MBTI: ${personality.mbti ?? "unknown"}
- Traits: ${traits}
- Communication style: ${personality.communication_style ?? "casual"}
- Emotional tendency: ${personality.emotional_tendency ?? "neutral"}
- Interests: ${interests}
- Stances:
${stanceEntries}
- Influence score: ${socialMetrics.influence_score ?? 0} (${socialMetrics.followers ?? 0} followers)
- Activity level: ${socialMetrics.activity_level ?? "medium"}

## What You Did During the Simulation
${actionSummary}

## Your Memories
${memoryStr}

## Instructions
- Answer questions IN CHARACTER as ${persona.name}.
- Draw from your personality, stances, actions, and memories.
- Be honest about what you did and why, but express it through your personality.
- Stay consistent with your communication style (${personality.communication_style ?? "casual"}).
- If asked about something you didn't do, say so naturally.
- Keep answers conversational and authentic to your character.
- Do NOT break character or mention that you are an AI or simulation.`
}

// ─── Public API ────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: "user" | "assistant"
  content: string
}

/**
 * Interview a simulated agent with a question.
 * Supports multi-turn conversation via chatHistory parameter.
 */
export async function interviewAgent(
  db: Database,
  simulationId: string,
  agentId: string,
  question: string,
  chatHistory?: ChatMessage[],
): Promise<string> {
  const persona = getPersona(db, agentId)
  if (!persona) {
    throw new Error(`Agent ${agentId} not found`)
  }

  const actions = listActions(db, simulationId, { agent_id: agentId }) as AgentAction[]
  const systemPrompt = buildInterviewPrompt(persona, actions)

  // Build messages array
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
  ]

  // Add chat history for multi-turn
  if (chatHistory && chatHistory.length > 0) {
    for (const msg of chatHistory) {
      messages.push({ role: msg.role, content: msg.content })
    }
  }

  // Add current question
  messages.push({ role: "user", content: question })

  const client = getClient()

  const response = await client.chat.completions.create({
    model: DEFAULT_MODEL,
    messages,
    temperature: 0.7,
    max_tokens: 1024,
  })

  const content = response.choices[0]?.message?.content
  if (!content) {
    throw new Error("LLM returned empty response for agent interview")
  }

  return content
}
