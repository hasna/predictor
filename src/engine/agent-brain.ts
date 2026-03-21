/**
 * LLM-powered decision-making brain for simulation agents.
 * Each agent evaluates the social media state and decides their next action in character.
 */

import OpenAI from "openai"
import type { AgentPersona, ActionType, SimulatedPost } from "../types.ts"

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AgentContext {
  round: number
  simulated_hour: number
  timeline: SimulatedPost[]
  trending: SimulatedPost[]
  recent_own_posts: SimulatedPost[]
  memory: string[]
}

export interface AgentDecision {
  action_type: ActionType
  content?: string
  target_post_id?: string
  reasoning: string
}

// ─── OpenAI Client ──────────────────────────────────────────────────────────

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

export function setBrainClient(client: OpenAI): void {
  _client = client
}

// ─── Temperature Mapping ────────────────────────────────────────────────────

/** Map personality traits to LLM temperature. Extraverts get higher temp, introverts lower. */
function getTemperature(persona: AgentPersona): number {
  const mbti = persona.personality.mbti.toUpperCase()
  const isExtravert = mbti.startsWith("E")
  const isPerceiving = mbti.endsWith("P")
  const isFeeling = mbti.charAt(2) === "F"

  let temp = 0.7 // baseline

  if (isExtravert) temp += 0.15
  else temp -= 0.1

  if (isPerceiving) temp += 0.05
  if (isFeeling) temp += 0.05

  // Clamp to [0.3, 1.2]
  return Math.max(0.3, Math.min(1.2, temp))
}

// ─── System Prompt Builder ──────────────────────────────────────────────────

function buildSystemPrompt(persona: AgentPersona, context: AgentContext): string {
  const { personality, social_metrics } = persona
  const stanceEntries = Object.entries(personality.stance)
    .map(([topic, position]) => `  - ${topic}: ${position}`)
    .join("\n")

  const timelineStr = context.timeline.length > 0
    ? context.timeline
        .slice(0, 15)
        .map((p) => `  [${p.id}] @${p.author_id}: "${p.content}" (${p.likes}♥ ${p.reposts}↻ ${p.replies}💬)`)
        .join("\n")
    : "  (empty — no posts yet)"

  const trendingStr = context.trending.length > 0
    ? context.trending
        .slice(0, 8)
        .map((p) => `  [${p.id}] @${p.author_id}: "${p.content}" (${p.likes}♥ ${p.reposts}↻ ${p.replies}💬)`)
        .join("\n")
    : "  (nothing trending)"

  const ownPostsStr = context.recent_own_posts.length > 0
    ? context.recent_own_posts
        .slice(0, 5)
        .map((p) => `  [${p.id}] "${p.content}" (${p.likes}♥ ${p.reposts}↻ ${p.replies}💬)`)
        .join("\n")
    : "  (you haven't posted yet)"

  const memoryStr = context.memory.length > 0
    ? context.memory.slice(-10).map((m) => `  - ${m}`).join("\n")
    : "  (no memories yet)"

  return `You are ${persona.name}, a social media user in a simulation.

## Your Identity
- Name: ${persona.name}
- MBTI: ${personality.mbti}
- Traits: ${personality.traits.join(", ")}
- Communication style: ${personality.communication_style}
- Emotional tendency: ${personality.emotional_tendency}
- Interests: ${personality.interests.join(", ")}
${stanceEntries ? `- Stances:\n${stanceEntries}` : ""}
- Influence: ${social_metrics.influence_score} (${social_metrics.followers} followers)
- Activity level: ${social_metrics.activity_level}

## Current State
- Round: ${context.round} | Hour: ${context.simulated_hour}:00

## Your Timeline (recent posts you can see)
${timelineStr}

## Trending Posts
${trendingStr}

## Your Recent Posts
${ownPostsStr}

## Your Memory (recent events)
${memoryStr}

## Instructions
Choose ONE action to take right now. Stay in character — your personality, communication style, interests, and stances should drive your choice.

Available actions:
- create_post: Write a new original post. Provide "content".
- like_post: Like an existing post. Provide "target_post_id".
- repost: Share someone else's post. Provide "target_post_id".
- quote_post: Share with your own commentary. Provide "target_post_id" and "content".
- reply: Reply to a post. Provide "target_post_id" and "content".
- create_comment: Comment on a post (Reddit-style). Provide "target_post_id" and "content".
- upvote: Upvote a post. Provide "target_post_id".
- downvote: Downvote a post. Provide "target_post_id".
- do_nothing: Skip this round (you're not interested or busy).

Rules:
- You can only interact with posts shown in your timeline or trending.
- If the timeline is empty, you should create_post or do_nothing.
- Don't repeat yourself — check your recent posts before creating similar content.
- Your post content should match your communication style (formal, casual, passionate, etc.).
- Keep posts concise and realistic (under 280 chars for Twitter-style).
- Provide a brief reasoning explaining WHY you chose this action (1-2 sentences, in character).

Return valid JSON:
{
  "action_type": "create_post",
  "content": "Your post content here",
  "target_post_id": null,
  "reasoning": "Why you chose this action"
}`
}

// ─── Main Decision Function ─────────────────────────────────────────────────

export async function decideAction(
  persona: AgentPersona,
  context: AgentContext,
  options?: { model?: string },
): Promise<AgentDecision> {
  const client = getClient()
  const model = options?.model ?? DEFAULT_MODEL
  const temperature = getTemperature(persona)

  const systemPrompt = buildSystemPrompt(persona, context)

  try {
    const response = await client.chat.completions.create({
      model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: "What do you do this round? Respond with JSON." },
      ],
      temperature,
      max_tokens: 512,
    })

    const content = response.choices[0]?.message?.content
    if (!content) {
      return {
        action_type: "do_nothing",
        reasoning: "Failed to generate a response — staying quiet this round.",
      }
    }

    const parsed = JSON.parse(content)

    // Validate action_type
    const validActions: ActionType[] = [
      "create_post",
      "like_post",
      "repost",
      "quote_post",
      "reply",
      "follow",
      "create_comment",
      "upvote",
      "downvote",
      "do_nothing",
    ]
    const actionType = validActions.includes(parsed.action_type) ? parsed.action_type : "do_nothing"

    // Validate target_post_id references a real post in the context
    let targetPostId = parsed.target_post_id ?? undefined
    if (targetPostId) {
      const allPosts = [...context.timeline, ...context.trending, ...context.recent_own_posts]
      const exists = allPosts.some((p) => p.id === targetPostId)
      if (!exists) {
        // If the agent referenced a non-existent post, fall back to do_nothing
        return {
          action_type: "do_nothing",
          reasoning: `Wanted to ${actionType} but referenced an invalid post. Skipping.`,
        }
      }
    }

    return {
      action_type: actionType,
      content: parsed.content ?? undefined,
      target_post_id: targetPostId,
      reasoning: parsed.reasoning ?? "No reasoning provided.",
    }
  } catch (err) {
    return {
      action_type: "do_nothing",
      reasoning: `Decision error: ${err instanceof Error ? err.message : "unknown"}. Staying quiet.`,
    }
  }
}
