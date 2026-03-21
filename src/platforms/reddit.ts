/**
 * Reddit-like platform simulator.
 * Provides post submission, threaded comments, upvote/downvote, front page, and thread views.
 */

import { Database } from "bun:sqlite"
import { createPost, getPost, listPosts, updatePostEngagement } from "../db/index.ts"
import type { SimulatedPost } from "../types.ts"

const PLATFORM = "reddit" as const

// ─── Core Actions ──────────────────────────────────────────────────────────

/** Submit a new top-level post. Returns the post id. */
export function submitPost(
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

/**
 * Add a comment to a post or reply to another comment (threaded).
 * If parentCommentId is provided, the comment is nested under that comment.
 * Otherwise, it is a direct comment on the post.
 * Increments the parent's replies count.
 */
export function comment(
  db: Database,
  simId: string,
  agentId: string,
  postId: string,
  content: string,
  round: number,
  parentCommentId?: string,
): string {
  const parentId = parentCommentId ?? postId
  const commentId = createPost(db, {
    simulation_id: simId,
    platform: PLATFORM,
    author_id: agentId,
    content,
    parent_id: parentId,
    round,
  })
  updatePostEngagement(db, parentId, "replies", 1)
  return commentId
}

/** Upvote a post or comment. Increments likes (used as upvote counter). */
export function upvote(db: Database, postId: string): void {
  updatePostEngagement(db, postId, "likes", 1)
}

/** Downvote a post or comment. Increments reposts field (reused as downvote counter for reddit). */
export function downvote(db: Database, postId: string): void {
  updatePostEngagement(db, postId, "reposts", 1)
}

/**
 * Calculate the score of a post: upvotes - downvotes.
 * Uses likes as upvotes and reposts as downvotes.
 */
export function getScore(post: SimulatedPost): number {
  return post.likes - post.reposts
}

// ─── Feed Queries ──────────────────────────────────────────────────────────

/**
 * Get the front page: top-level posts (parent_id IS NULL) sorted by score descending.
 */
export function getFrontPage(
  db: Database,
  simId: string,
  round: number,
  limit: number = 25,
): SimulatedPost[] {
  const rows = db
    .query(
      `SELECT * FROM simulated_posts
       WHERE simulation_id = ? AND platform = ? AND round <= ? AND parent_id IS NULL
       ORDER BY (likes - reposts) DESC, created_at DESC
       LIMIT ?`,
    )
    .all(simId, PLATFORM, round, limit) as SimulatedPost[]
  return rows
}

/**
 * Get a full thread: the root post and all its comments (direct and nested).
 * Comments are returned in creation order for easy tree reconstruction.
 */
export function getThread(
  db: Database,
  simId: string,
  postId: string,
): { post: SimulatedPost; comments: SimulatedPost[] } {
  const post = getPost(db, postId) as SimulatedPost
  // Fetch all comments that belong to this thread (direct children + nested).
  // Uses a recursive CTE to walk the comment tree.
  const comments = db
    .query(
      `WITH RECURSIVE thread(id) AS (
         SELECT id FROM simulated_posts WHERE parent_id = ? AND simulation_id = ? AND platform = ?
         UNION ALL
         SELECT sp.id FROM simulated_posts sp
         JOIN thread t ON sp.parent_id = t.id
         WHERE sp.simulation_id = ? AND sp.platform = ?
       )
       SELECT sp.* FROM simulated_posts sp
       JOIN thread t ON sp.id = t.id
       ORDER BY sp.created_at ASC`,
    )
    .all(postId, simId, PLATFORM, simId, PLATFORM) as SimulatedPost[]
  return { post, comments }
}
