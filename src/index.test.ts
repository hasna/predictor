/**
 * Comprehensive tests for @hasna/predictor.
 * Uses in-memory SQLite — no filesystem needed.
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { Database } from "bun:sqlite"
import { SCHEMA_SQL } from "./db/schema.ts"
import {
  createSimulation,
  getSimulation,
  listSimulations,
  updateSimulationStatus,
  updateSimulationRound,
  deleteSimulation,
  createPersona,
  getPersona,
  listPersonas,
  deletePersonas,
  createAction,
  listActions,
  countActions,
  createPost,
  getPost,
  updatePostEngagement,
  getTopPosts,
} from "./db/index.ts"
import {
  tweet,
  like,
  repost,
  reply,
  quoteTweet,
  getTimeline,
  getTrending,
  getAgentPosts,
} from "./platforms/twitter.ts"
import {
  submitPost,
  comment,
  upvote,
  downvote,
  getScore,
  getFrontPage,
  getThread,
} from "./platforms/reddit.ts"
import { analyzeEngagement, detectPatterns } from "./engine/patterns.ts"
import { generatePersonaFromTemplate } from "./personas/generator.ts"
import type { SimulatedPost } from "./types.ts"

// ─── Test helpers ─────────────────────────────────────────────────────────────

function createTestDb(): Database {
  const db = new Database(":memory:")
  db.exec("PRAGMA foreign_keys = ON")
  db.exec("PRAGMA journal_mode = WAL")
  db.exec(SCHEMA_SQL)
  return db
}

/** Create a simulation and return its ID — convenience for tests that need one. */
function seedSimulation(db: Database, overrides?: Record<string, unknown>): string {
  return createSimulation(db, {
    graph_id: "graph-1",
    name: "Test Simulation",
    description: "A test simulation",
    config: { max_rounds: 10, model: "test" },
    total_rounds: 10,
    agent_count: 5,
    ...overrides,
  })
}

/** Create a persona under a simulation and return its ID. */
function seedPersona(db: Database, simId: string, name: string): string {
  return createPersona(db, {
    simulation_id: simId,
    node_id: `node-${name}`,
    name,
    personality: { mbti: "ENTJ", traits: ["bold"], stance: {}, interests: [], communication_style: "direct", emotional_tendency: "engaged" },
    social_metrics: { followers: 1000, following: 200, influence_score: 0.8, activity_level: "high" },
    activity_config: { posting_frequency: 5, peak_hours: [9, 12], preferred_platforms: ["twitter"], response_probability: 0.6 },
    memory: ["test memory"],
  })
}

// ─── 1. Schema Tests ──────────────────────────────────────────────────────────

describe("Schema", () => {
  let db: Database

  beforeEach(() => {
    db = createTestDb()
  })

  test("all 7 tables exist", () => {
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[]
    const names = tables.map((t) => t.name)

    expect(names).toContain("simulations")
    expect(names).toContain("agent_personas")
    expect(names).toContain("agent_actions")
    expect(names).toContain("simulated_posts")
    expect(names).toContain("emergent_patterns")
    expect(names).toContain("prediction_reports")
    expect(names).toContain("schema_version")
  })

  test("simulations table has correct columns", () => {
    const cols = db.query("PRAGMA table_info(simulations)").all() as { name: string }[]
    const colNames = cols.map((c) => c.name)
    expect(colNames).toContain("id")
    expect(colNames).toContain("project_id")
    expect(colNames).toContain("graph_id")
    expect(colNames).toContain("name")
    expect(colNames).toContain("status")
    expect(colNames).toContain("config")
    expect(colNames).toContain("total_rounds")
    expect(colNames).toContain("current_round")
  })

  test("agent_personas table has correct columns", () => {
    const cols = db.query("PRAGMA table_info(agent_personas)").all() as { name: string }[]
    const colNames = cols.map((c) => c.name)
    expect(colNames).toContain("id")
    expect(colNames).toContain("simulation_id")
    expect(colNames).toContain("node_id")
    expect(colNames).toContain("personality")
    expect(colNames).toContain("social_metrics")
    expect(colNames).toContain("activity_config")
    expect(colNames).toContain("memory")
  })

  test("CASCADE delete: deleting simulation removes all child records", () => {
    const simId = seedSimulation(db)
    const personaId = seedPersona(db, simId, "Alice")

    // Create child records referencing the simulation and persona
    createAction(db, {
      simulation_id: simId,
      agent_id: personaId,
      round: 1,
      platform: "twitter",
      action_type: "create_post",
      content: "Hello",
    })
    createPost(db, {
      simulation_id: simId,
      platform: "twitter",
      author_id: personaId,
      content: "Hello world",
      round: 1,
    })
    db.run(
      `INSERT INTO emergent_patterns (id, simulation_id, type, first_seen_round) VALUES ('p1', ?, 'viral', 1)`,
      [simId],
    )
    db.run(
      `INSERT INTO prediction_reports (id, simulation_id) VALUES ('r1', ?)`,
      [simId],
    )

    // Verify records exist
    expect((db.query("SELECT COUNT(*) as c FROM agent_personas").get() as any).c).toBe(1)
    expect((db.query("SELECT COUNT(*) as c FROM agent_actions").get() as any).c).toBe(1)
    expect((db.query("SELECT COUNT(*) as c FROM simulated_posts").get() as any).c).toBe(1)
    expect((db.query("SELECT COUNT(*) as c FROM emergent_patterns").get() as any).c).toBe(1)
    expect((db.query("SELECT COUNT(*) as c FROM prediction_reports").get() as any).c).toBe(1)

    // Delete simulation — CASCADE should wipe everything
    deleteSimulation(db, simId)

    expect((db.query("SELECT COUNT(*) as c FROM simulations").get() as any).c).toBe(0)
    expect((db.query("SELECT COUNT(*) as c FROM agent_personas").get() as any).c).toBe(0)
    expect((db.query("SELECT COUNT(*) as c FROM agent_actions").get() as any).c).toBe(0)
    expect((db.query("SELECT COUNT(*) as c FROM simulated_posts").get() as any).c).toBe(0)
    expect((db.query("SELECT COUNT(*) as c FROM emergent_patterns").get() as any).c).toBe(0)
    expect((db.query("SELECT COUNT(*) as c FROM prediction_reports").get() as any).c).toBe(0)
  })

  test("foreign key constraint prevents orphan records", () => {
    expect(() => {
      db.run(
        `INSERT INTO agent_personas (id, simulation_id, node_id, name) VALUES ('x', 'nonexistent', 'n1', 'Ghost')`,
      )
    }).toThrow()
  })
})

// ─── 2. Simulation CRUD ──────────────────────────────────────────────────────

describe("Simulation CRUD", () => {
  let db: Database

  beforeEach(() => {
    db = createTestDb()
  })

  test("createSimulation returns a string id", () => {
    const id = seedSimulation(db)
    expect(typeof id).toBe("string")
    expect(id.length).toBeGreaterThan(0)
  })

  test("getSimulation parses config JSON", () => {
    const id = seedSimulation(db, { config: { max_rounds: 20, model: "gpt-4" } })
    const sim = getSimulation(db, id)

    expect(sim).not.toBeNull()
    expect(sim!.name).toBe("Test Simulation")
    expect(sim!.config).toEqual({ max_rounds: 20, model: "gpt-4" })
    expect(sim!.status).toBe("pending")
    expect(sim!.total_rounds).toBe(10)
    expect(sim!.graph_id).toBe("graph-1")
  })

  test("listSimulations returns all and filters by status", () => {
    const id1 = seedSimulation(db, { name: "Sim A" })
    const id2 = seedSimulation(db, { name: "Sim B" })
    updateSimulationStatus(db, id2, "running")

    const all = listSimulations(db)
    expect(all.length).toBe(2)

    const running = listSimulations(db, "running")
    expect(running.length).toBe(1)
    expect(running[0].name).toBe("Sim B")

    const pending = listSimulations(db, "pending")
    expect(pending.length).toBe(1)
    expect(pending[0].name).toBe("Sim A")
  })

  test("updateSimulationStatus changes status", () => {
    const id = seedSimulation(db)
    updateSimulationStatus(db, id, "running")
    expect(getSimulation(db, id)!.status).toBe("running")

    updateSimulationStatus(db, id, "completed")
    expect(getSimulation(db, id)!.status).toBe("completed")
  })

  test("updateSimulationRound updates round, actionCount, costTotal", () => {
    const id = seedSimulation(db)
    updateSimulationRound(db, id, 5, 100, 12.5)

    const sim = getSimulation(db, id)
    expect(sim!.current_round).toBe(5)
    expect(sim!.action_count).toBe(100)
    expect(sim!.cost_total).toBe(12.5)
  })

  test("deleteSimulation returns true for existing, false for missing", () => {
    const id = seedSimulation(db)
    expect(deleteSimulation(db, id)).toBe(true)
    expect(getSimulation(db, id)).toBeNull()
    expect(deleteSimulation(db, "nonexistent")).toBe(false)
  })
})

// ─── 3. Persona CRUD ─────────────────────────────────────────────────────────

describe("Persona CRUD", () => {
  let db: Database
  let simId: string

  beforeEach(() => {
    db = createTestDb()
    simId = seedSimulation(db)
  })

  test("createPersona stores full JSON fields", () => {
    const id = createPersona(db, {
      simulation_id: simId,
      node_id: "node-1",
      name: "Alice",
      personality: { mbti: "INFP", traits: ["creative"], stance: { tech: "positive" }, interests: ["art"], communication_style: "warm", emotional_tendency: "empathetic" },
      social_metrics: { followers: 5000, following: 300, influence_score: 0.9, activity_level: "very_high" },
      activity_config: { posting_frequency: 8, peak_hours: [10, 14, 20], preferred_platforms: ["twitter", "reddit"], response_probability: 0.8 },
      memory: ["met Bob", "attended event"],
    })
    expect(typeof id).toBe("string")
    expect(id.length).toBeGreaterThan(0)
  })

  test("getPersona returns parsed JSON fields", () => {
    const id = seedPersona(db, simId, "Bob")
    const persona = getPersona(db, id)

    expect(persona).not.toBeNull()
    expect(persona!.name).toBe("Bob")
    expect(persona!.personality.mbti).toBe("ENTJ")
    expect(persona!.personality.traits).toEqual(["bold"])
    expect(persona!.social_metrics.followers).toBe(1000)
    expect(persona!.social_metrics.activity_level).toBe("high")
    expect(persona!.activity_config.posting_frequency).toBe(5)
    expect(persona!.activity_config.peak_hours).toEqual([9, 12])
    expect(persona!.memory).toEqual(["test memory"])
  })

  test("listPersonas returns all personas for a simulation", () => {
    seedPersona(db, simId, "Alice")
    seedPersona(db, simId, "Bob")
    seedPersona(db, simId, "Charlie")

    const personas = listPersonas(db, simId)
    expect(personas.length).toBe(3)
    expect(personas.map((p: any) => p.name)).toContain("Alice")
    expect(personas.map((p: any) => p.name)).toContain("Bob")
    expect(personas.map((p: any) => p.name)).toContain("Charlie")
  })

  test("deletePersonas removes all personas for a simulation", () => {
    seedPersona(db, simId, "Alice")
    seedPersona(db, simId, "Bob")

    const result = deletePersonas(db, simId)
    expect(result).toBe(true)
    expect(listPersonas(db, simId).length).toBe(0)

    // Second delete returns false (nothing to delete)
    expect(deletePersonas(db, simId)).toBe(false)
  })
})

// ─── 4. Twitter Platform ──────────────────────────────────────────────────────

describe("Twitter Platform", () => {
  let db: Database
  let simId: string
  let agent1: string
  let agent2: string

  beforeEach(() => {
    db = createTestDb()
    simId = seedSimulation(db)
    agent1 = seedPersona(db, simId, "Alice")
    agent2 = seedPersona(db, simId, "Bob")
  })

  test("tweet creates a post", () => {
    const postId = tweet(db, simId, agent1, "Hello Twitter!", 1)
    expect(typeof postId).toBe("string")

    const post = getPost(db, postId) as SimulatedPost
    expect(post.content).toBe("Hello Twitter!")
    expect(post.author_id).toBe(agent1)
    expect(post.platform).toBe("twitter")
    expect(post.round).toBe(1)
    expect(post.likes).toBe(0)
    expect(post.reposts).toBe(0)
    expect(post.replies).toBe(0)
    expect(post.parent_id).toBeNull()
  })

  test("like increments likes count", () => {
    const postId = tweet(db, simId, agent1, "Like me!", 1)
    like(db, postId)
    like(db, postId)
    like(db, postId)

    const post = getPost(db, postId) as SimulatedPost
    expect(post.likes).toBe(3)
  })

  test("repost creates RT post and increments original reposts", () => {
    const originalId = tweet(db, simId, agent1, "Original tweet", 1)
    const rtId = repost(db, simId, agent2, originalId, 1)

    // RT post exists with "RT: " prefix
    const rtPost = getPost(db, rtId) as SimulatedPost
    expect(rtPost.content).toBe("RT: Original tweet")
    expect(rtPost.author_id).toBe(agent2)
    expect(rtPost.parent_id).toBe(originalId)

    // Original has reposts incremented
    const original = getPost(db, originalId) as SimulatedPost
    expect(original.reposts).toBe(1)
  })

  test("reply creates child post and increments parent replies", () => {
    const parentId = tweet(db, simId, agent1, "What do you think?", 1)
    const replyId = reply(db, simId, agent2, parentId, "I agree!", 1)

    const replyPost = getPost(db, replyId) as SimulatedPost
    expect(replyPost.content).toBe("I agree!")
    expect(replyPost.parent_id).toBe(parentId)
    expect(replyPost.author_id).toBe(agent2)

    const parent = getPost(db, parentId) as SimulatedPost
    expect(parent.replies).toBe(1)
  })

  test("getTimeline returns posts sorted by recency + engagement", () => {
    // Create posts in round 1 with varying engagement
    const p1 = tweet(db, simId, agent1, "Low engagement post", 1)
    const p2 = tweet(db, simId, agent2, "High engagement post", 1)
    like(db, p2)
    like(db, p2)
    like(db, p2)
    reply(db, simId, agent1, p2, "Great!", 1)

    const timeline = getTimeline(db, simId, agent1, 1)
    // p2 should appear first (higher engagement)
    expect(timeline.length).toBeGreaterThan(0)
    // Timeline should only include top-level posts (parent_id IS NULL), so the reply is excluded
    const topLevelIds = timeline.filter((p) => p.parent_id === null).map((p) => p.id)
    expect(topLevelIds[0]).toBe(p2)
  })

  test("getTrending returns high-engagement posts", () => {
    const p1 = tweet(db, simId, agent1, "Boring post", 1)
    const p2 = tweet(db, simId, agent2, "Viral post!", 1)
    for (let i = 0; i < 10; i++) like(db, p2)

    const trending = getTrending(db, simId, 1)
    expect(trending.length).toBeGreaterThan(0)
    expect(trending[0].id).toBe(p2)
    expect(trending[0].likes).toBe(10)
  })

  test("getAgentPosts returns only that agent's posts", () => {
    tweet(db, simId, agent1, "Alice post 1", 1)
    tweet(db, simId, agent1, "Alice post 2", 1)
    tweet(db, simId, agent2, "Bob post 1", 1)

    const alicePosts = getAgentPosts(db, simId, agent1)
    expect(alicePosts.length).toBe(2)
    expect(alicePosts.every((p) => p.author_id === agent1)).toBe(true)
  })

  test("quoteTweet creates QT with original content and increments reposts", () => {
    const originalId = tweet(db, simId, agent1, "Original take", 1)
    const qtId = quoteTweet(db, simId, agent2, originalId, "My commentary", 1)

    const qtPost = getPost(db, qtId) as SimulatedPost
    expect(qtPost.content).toContain("My commentary")
    expect(qtPost.content).toContain("QT @")
    expect(qtPost.content).toContain("Original take")
    expect(qtPost.parent_id).toBe(originalId)

    const original = getPost(db, originalId) as SimulatedPost
    expect(original.reposts).toBe(1)
  })
})

// ─── 5. Reddit Platform ──────────────────────────────────────────────────────

describe("Reddit Platform", () => {
  let db: Database
  let simId: string
  let agent1: string
  let agent2: string

  beforeEach(() => {
    db = createTestDb()
    simId = seedSimulation(db)
    agent1 = seedPersona(db, simId, "Poster")
    agent2 = seedPersona(db, simId, "Commenter")
  })

  test("submitPost creates a top-level reddit post", () => {
    const postId = submitPost(db, simId, agent1, "TIL something cool", 1)
    const post = getPost(db, postId) as SimulatedPost

    expect(post.content).toBe("TIL something cool")
    expect(post.platform).toBe("reddit")
    expect(post.author_id).toBe(agent1)
    expect(post.parent_id).toBeNull()
  })

  test("comment creates threaded comments with parent_id", () => {
    const postId = submitPost(db, simId, agent1, "Discussion topic", 1)

    // Direct comment on post
    const c1 = comment(db, simId, agent2, postId, "Great point!", 1)
    const c1Post = getPost(db, c1) as SimulatedPost
    expect(c1Post.parent_id).toBe(postId)
    expect(c1Post.content).toBe("Great point!")

    // Nested reply to comment
    const c2 = comment(db, simId, agent1, postId, "Thanks!", 1, c1)
    const c2Post = getPost(db, c2) as SimulatedPost
    expect(c2Post.parent_id).toBe(c1) // nested under c1, not the root post
  })

  test("upvote increments likes, downvote increments reposts", () => {
    const postId = submitPost(db, simId, agent1, "Vote on me", 1)

    upvote(db, postId)
    upvote(db, postId)
    upvote(db, postId)
    downvote(db, postId)

    const post = getPost(db, postId) as SimulatedPost
    expect(post.likes).toBe(3)
    expect(post.reposts).toBe(1)
  })

  test("getScore calculates likes - reposts", () => {
    const post: SimulatedPost = {
      id: "x",
      simulation_id: simId,
      platform: "reddit",
      author_id: agent1,
      content: "test",
      parent_id: null,
      likes: 10,
      reposts: 3,
      replies: 0,
      round: 1,
      created_at: "",
    }
    expect(getScore(post)).toBe(7)
  })

  test("getFrontPage returns top-level posts sorted by score", () => {
    const p1 = submitPost(db, simId, agent1, "Medium post", 1)
    const p2 = submitPost(db, simId, agent2, "Best post", 1)
    const p3 = submitPost(db, simId, agent1, "Worst post", 1)

    // p2: score 5 (5 upvotes, 0 downvotes)
    for (let i = 0; i < 5; i++) upvote(db, p2)
    // p1: score 2 (3 upvotes, 1 downvote)
    for (let i = 0; i < 3; i++) upvote(db, p1)
    downvote(db, p1)
    // p3: score -2 (0 upvotes, 2 downvotes)
    downvote(db, p3)
    downvote(db, p3)

    const frontPage = getFrontPage(db, simId, 1)
    expect(frontPage.length).toBe(3)
    expect(frontPage[0].id).toBe(p2) // highest score
    expect(frontPage[1].id).toBe(p1) // second
    expect(frontPage[2].id).toBe(p3) // lowest
  })

  test("getThread returns post and all recursive comments", () => {
    const postId = submitPost(db, simId, agent1, "Root post", 1)
    const c1 = comment(db, simId, agent2, postId, "Comment 1", 1)
    const c2 = comment(db, simId, agent1, postId, "Reply to c1", 1, c1)
    const c3 = comment(db, simId, agent2, postId, "Reply to c2", 1, c2)

    const thread = getThread(db, simId, postId)
    expect(thread.post.id).toBe(postId)
    expect(thread.post.content).toBe("Root post")
    expect(thread.comments.length).toBe(3) // c1, c2, c3
    expect(thread.comments.map((c) => c.id)).toContain(c1)
    expect(thread.comments.map((c) => c.id)).toContain(c2)
    expect(thread.comments.map((c) => c.id)).toContain(c3)
  })
})

// ─── 6. Pattern Detection ─────────────────────────────────────────────────────

describe("Pattern Detection", () => {
  let db: Database
  let simId: string
  let agents: string[]

  beforeEach(() => {
    db = createTestDb()
    simId = seedSimulation(db)
    agents = []
    for (let i = 0; i < 5; i++) {
      agents.push(seedPersona(db, simId, `Agent${i}`))
    }
  })

  test("viral detection: high engagement post is detected", async () => {
    // Create several low-engagement posts in round 1
    for (const agent of agents) {
      createPost(db, { simulation_id: simId, platform: "twitter", author_id: agent, content: "Normal post", round: 1 })
    }

    // Create one viral post with high engagement
    const viralPostId = createPost(db, { simulation_id: simId, platform: "twitter", author_id: agents[0], content: "Viral content!", round: 1 })
    for (let i = 0; i < 20; i++) updatePostEngagement(db, viralPostId, "likes", 1)
    for (let i = 0; i < 10; i++) updatePostEngagement(db, viralPostId, "reposts", 1)

    const patterns = await detectPatterns(db, simId, 1)
    const viralPatterns = patterns.filter((p) => p.type === "viral")
    expect(viralPatterns.length).toBeGreaterThan(0)
    expect(viralPatterns[0].involved_agents).toContain(agents[0])
  })

  test("analyzeEngagement returns correct averages", () => {
    // Round 1: 3 posts
    const p1 = createPost(db, { simulation_id: simId, platform: "twitter", author_id: agents[0], content: "Post 1", round: 1 })
    const p2 = createPost(db, { simulation_id: simId, platform: "twitter", author_id: agents[1], content: "Post 2", round: 1 })
    const p3 = createPost(db, { simulation_id: simId, platform: "twitter", author_id: agents[2], content: "Post 3", round: 1 })

    // p1: 6 likes, 2 reposts
    for (let i = 0; i < 6; i++) updatePostEngagement(db, p1, "likes", 1)
    for (let i = 0; i < 2; i++) updatePostEngagement(db, p1, "reposts", 1)

    // p2: 3 likes, 1 repost
    for (let i = 0; i < 3; i++) updatePostEngagement(db, p2, "likes", 1)
    updatePostEngagement(db, p2, "reposts", 1)

    // p3: 0 likes, 0 reposts

    const eng = analyzeEngagement(db, simId, 1)
    expect(eng.total_posts).toBe(3)
    expect(eng.avg_likes).toBe(3) // (6+3+0)/3
    expect(eng.avg_reposts).toBe(1) // (2+1+0)/3
    expect(eng.top_post_id).toBe(p1) // highest engagement
  })

  test("cascade detection: same keyword in 3+ agents' posts", async () => {
    // All 5 agents post about "blockchain" in round 1
    for (const agent of agents) {
      createPost(db, {
        simulation_id: simId,
        platform: "twitter",
        author_id: agent,
        content: "Blockchain technology is changing everything",
        round: 1,
      })
    }

    const patterns = await detectPatterns(db, simId, 1)
    const cascades = patterns.filter((p) => p.type === "cascade")
    expect(cascades.length).toBeGreaterThan(0)
    // At least one cascade should involve 3+ agents
    const bigCascade = cascades.find((c) => c.involved_agents.length >= 3)
    expect(bigCascade).toBeDefined()
  })

  test("no patterns for normal low engagement", async () => {
    // Create a few posts with zero engagement
    createPost(db, { simulation_id: simId, platform: "twitter", author_id: agents[0], content: "Hello", round: 1 })
    createPost(db, { simulation_id: simId, platform: "twitter", author_id: agents[1], content: "Hi there", round: 1 })

    const patterns = await detectPatterns(db, simId, 1)
    // Should have no viral patterns (all engagement is 0, average is 0)
    const viralPatterns = patterns.filter((p) => p.type === "viral")
    expect(viralPatterns.length).toBe(0)
  })

  test("analyzeEngagement returns zeros for empty round", () => {
    const eng = analyzeEngagement(db, simId, 99)
    expect(eng.total_posts).toBe(0)
    expect(eng.avg_likes).toBe(0)
    expect(eng.avg_reposts).toBe(0)
    expect(eng.top_post_id).toBeNull()
  })
})

// ─── 7. Persona Template ──────────────────────────────────────────────────────

describe("Persona Template", () => {
  test("generatePersonaFromTemplate with person labels", () => {
    const persona = generatePersonaFromTemplate("John Doe", ["person"], "A journalist covering tech", 8)

    expect(persona.name).toBe("John Doe")
    expect(persona.personality.mbti).toBe("ENTJ")
    expect(persona.personality.traits).toEqual(["articulate", "opinionated"])
    expect(persona.personality.communication_style).toBe("personal and direct")
    expect(persona.personality.emotional_tendency).toBe("engaged")
    expect(persona.social_metrics.activity_level).toBe("medium")
    expect(persona.activity_config.response_probability).toBe(0.6)
    expect(persona.activity_config.posting_frequency).toBe(3) // edgeCount 8 > 5
  })

  test("generatePersonaFromTemplate with org labels", () => {
    const persona = generatePersonaFromTemplate("Acme Corp", ["organization"], "A tech company", 3)

    expect(persona.personality.mbti).toBe("ISTJ")
    expect(persona.personality.traits).toEqual(["institutional", "measured"])
    expect(persona.personality.communication_style).toBe("formal corporate")
    expect(persona.personality.emotional_tendency).toBe("neutral")
    expect(persona.activity_config.response_probability).toBe(0.3)
    expect(persona.social_metrics.activity_level).toBe("low") // edgeCount 3 <= 5
    expect(persona.activity_config.posting_frequency).toBe(1) // edgeCount 3 <= 5
  })

  test("influence_score, activity_level, posting_frequency scale with edge count", () => {
    const lowEdge = generatePersonaFromTemplate("Small", ["person"], "Unknown", 2)
    const midEdge = generatePersonaFromTemplate("Medium", ["person"], "Known", 8)
    const highEdge = generatePersonaFromTemplate("Large", ["person"], "Famous", 25)

    // influence_score = min(1, edgeCount / 20)
    expect(lowEdge.social_metrics.influence_score).toBe(0.1) // 2/20
    expect(midEdge.social_metrics.influence_score).toBe(0.4) // 8/20
    expect(highEdge.social_metrics.influence_score).toBe(1) // min(1, 25/20)

    // activity_level
    expect(lowEdge.social_metrics.activity_level).toBe("low")   // <= 5
    expect(midEdge.social_metrics.activity_level).toBe("medium") // > 5, <= 10
    expect(highEdge.social_metrics.activity_level).toBe("high")  // > 10

    // posting_frequency
    expect(lowEdge.activity_config.posting_frequency).toBe(1)  // <= 5
    expect(midEdge.activity_config.posting_frequency).toBe(3)  // > 5, <= 10
    expect(highEdge.activity_config.posting_frequency).toBe(5) // > 10

    // followers scale: 100 + edgeCount * 500
    expect(lowEdge.social_metrics.followers).toBe(1100)   // 100 + 2*500
    expect(midEdge.social_metrics.followers).toBe(4100)   // 100 + 8*500
    expect(highEdge.social_metrics.followers).toBe(12600)  // 100 + 25*500

    // following scale: 50 + edgeCount * 20
    expect(lowEdge.social_metrics.following).toBe(90)   // 50 + 2*20
    expect(midEdge.social_metrics.following).toBe(210)   // 50 + 8*20
    expect(highEdge.social_metrics.following).toBe(550)  // 50 + 25*20
  })
})

// ─── 8. Actions & Posts CRUD ──────────────────────────────────────────────────

describe("Actions & Posts CRUD", () => {
  let db: Database
  let simId: string
  let agent1: string
  let agent2: string

  beforeEach(() => {
    db = createTestDb()
    simId = seedSimulation(db)
    agent1 = seedPersona(db, simId, "Alice")
    agent2 = seedPersona(db, simId, "Bob")
  })

  test("createAction and listActions with filters", () => {
    createAction(db, { simulation_id: simId, agent_id: agent1, round: 1, platform: "twitter", action_type: "create_post", content: "Hello" })
    createAction(db, { simulation_id: simId, agent_id: agent1, round: 2, platform: "twitter", action_type: "like_post" })
    createAction(db, { simulation_id: simId, agent_id: agent2, round: 1, platform: "reddit", action_type: "create_comment", content: "Nice" })

    // No filters — all 3
    const all = listActions(db, simId)
    expect(all.length).toBe(3)

    // Filter by round
    const round1 = listActions(db, simId, { round: 1 })
    expect(round1.length).toBe(2)

    // Filter by agent_id
    const aliceActions = listActions(db, simId, { agent_id: agent1 })
    expect(aliceActions.length).toBe(2)

    // Filter by action_type
    const likes = listActions(db, simId, { action_type: "like_post" })
    expect(likes.length).toBe(1)

    // Combined filters
    const aliceRound1 = listActions(db, simId, { agent_id: agent1, round: 1 })
    expect(aliceRound1.length).toBe(1)
  })

  test("countActions returns total count", () => {
    expect(countActions(db, simId)).toBe(0)

    createAction(db, { simulation_id: simId, agent_id: agent1, round: 1, platform: "twitter", action_type: "create_post" })
    createAction(db, { simulation_id: simId, agent_id: agent2, round: 1, platform: "twitter", action_type: "like_post" })

    expect(countActions(db, simId)).toBe(2)
  })

  test("getTopPosts returns posts sorted by engagement", () => {
    const p1 = createPost(db, { simulation_id: simId, platform: "twitter", author_id: agent1, content: "Low", round: 1 })
    const p2 = createPost(db, { simulation_id: simId, platform: "twitter", author_id: agent2, content: "High", round: 1 })
    const p3 = createPost(db, { simulation_id: simId, platform: "twitter", author_id: agent1, content: "Mid", round: 1 })

    // p2: 10 likes + 5 reposts = 15
    for (let i = 0; i < 10; i++) updatePostEngagement(db, p2, "likes", 1)
    for (let i = 0; i < 5; i++) updatePostEngagement(db, p2, "reposts", 1)

    // p3: 3 likes + 2 replies = 5
    for (let i = 0; i < 3; i++) updatePostEngagement(db, p3, "likes", 1)
    for (let i = 0; i < 2; i++) updatePostEngagement(db, p3, "replies", 1)

    // p1: 0 engagement

    const top = getTopPosts(db, simId, 1, 10) as SimulatedPost[]
    expect(top.length).toBe(3)
    expect(top[0].id).toBe(p2) // highest
    expect(top[1].id).toBe(p3) // second
    expect(top[2].id).toBe(p1) // lowest
  })

  test("getTopPosts respects limit", () => {
    for (let i = 0; i < 5; i++) {
      createPost(db, { simulation_id: simId, platform: "twitter", author_id: agent1, content: `Post ${i}`, round: 1 })
    }

    const top2 = getTopPosts(db, simId, 1, 2) as SimulatedPost[]
    expect(top2.length).toBe(2)
  })
})
