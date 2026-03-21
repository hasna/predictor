/**
 * Twitter-like platform simulator.
 * Provides tweet, like, repost, reply, quote tweet, timeline, and trending functionality.
 */

import { Database } from "bun:sqlite"
import { createPost, getPost, listPosts, updatePostEngagement, getTopPosts } from "../db/index.ts"
import type { SimulatedPost } from "../types.ts"

const PLATFORM = "twitter" as const

// ─── Core Actions ──────────────────────────────────────────────────────────

/** Create a new tweet. Returns the post id. */
export function tweet(
  db: Database,
  simId: string,
  agentId: string,
  content: string,
  round: number,
): string {
  return createPost(db, {
    simulation_id: simId,
    platform: PLATFORM,
    author_id: agentId,
    content,
    round,
  })
}

/** Like a post. Increments the likes counter. */
export function like(db: Database, postId: string): void {
  updatePostEngagement(db, postId, "likes", 1)
}

/** Repost (retweet) a post. Creates a new post with "RT: " prefix and links to original. */
export function repost(
  db: Database,
  simId: string,
  agentId: string,
  postId: string,
  round: number,
): string {
  const original = getPost(db, postId) as SimulatedPost | null
  const originalContent = original?.content ?? ""
  const newId = createPost(db, {
    simulation_id: simId,
    platform: PLATFORM,
    author_id: agentId,
    content: `RT: ${originalContent}`,
    parent_id: postId,
    round,
  })
  updatePostEngagement(db, postId, "reposts", 1)
  return newId
}

/** Reply to a post. Creates a new post with parent_id and increments parent's replies count. */
export function reply(
  db: Database,
  simId: string,
  agentId: string,
  postId: string,
  content: string,
  round: number,
): string {
  const replyId = createPost(db, {
    simulation_id: simId,
    platform: PLATFORM,
    author_id: agentId,
    content,
    parent_id: postId,
    round,
  })
  updatePostEngagement(db, postId, "replies", 1)
  return replyId
}

/** Quote tweet. Creates a new post with the quote content, linking to the original. */
export function quoteTweet(
  db: Database,
  simId: string,
  agentId: string,
  postId: string,
  content: string,
  round: number,
): string {
  const original = getPost(db, postId) as SimulatedPost | null
  const originalContent = original?.content ?? ""
  const quoteContent = `${content}\n\nQT @${original?.author_id ?? "unknown"}: ${originalContent}`
  const newId = createPost(db, {
    simulation_id: simId,
    platform: PLATFORM,
    author_id: agentId,
    content: quoteContent,
    parent_id: postId,
    round,
  })
  updatePostEngagement(db, postId, "reposts", 1)
  return newId
}

// ─── Feed Queries ──────────────────────────────────────────────────────────

/**
 * Get a timeline for an agent.
 * Shows: recent posts from the current round, top engaged posts from
 * the current and previous rounds. Sorted by recency + engagement score.
 */
export function getTimeline(
  db: Database,
  simId: string,
  _agentId: string,
  round: number,
  limit: number = 20,
): SimulatedPost[] {
  // Fetch recent posts from current round + top posts from previous rounds
  const rows = db
    .query(
      `SELECT * FROM simulated_posts
       WHERE simulation_id = ? AND platform = ? AND round >= ? AND parent_id IS NULL
       ORDER BY
         CASE WHEN round = ? THEN 0 ELSE 1 END,
         (likes + reposts + replies) DESC,
         created_at DESC
       LIMIT ?`,
    )
    .all(simId, PLATFORM, Math.max(0, round - 2), round, limit) as SimulatedPost[]
  return rows
}

/**
 * Get trending posts across all agents in recent rounds.
 * Most engaged posts sorted by total engagement score.
 */
export function getTrending(
  db: Database,
  simId: string,
  round: number,
  limit: number = 10,
): SimulatedPost[] {
  const rows = db
    .query(
      `SELECT * FROM simulated_posts
       WHERE simulation_id = ? AND platform = ? AND round >= ? AND parent_id IS NULL
       ORDER BY (likes + reposts + replies) DESC
       LIMIT ?`,
    )
    .all(simId, PLATFORM, Math.max(0, round - 3), limit) as SimulatedPost[]
  return rows
}

/** Get all posts by a specific agent. */
export function getAgentPosts(
  db: Database,
  simId: string,
  agentId: string,
): SimulatedPost[] {
  return listPosts(db, simId, { author_id: agentId, platform: PLATFORM }) as SimulatedPost[]
}
