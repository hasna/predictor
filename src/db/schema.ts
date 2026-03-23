/**
 * SQLite schema for predictor.
 * Uses bun:sqlite native API.
 */

export const SCHEMA_VERSION = 2

export const SCHEMA_SQL = `
-- ─── Simulations ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS simulations (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  project_id TEXT,
  graph_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'stopped')) DEFAULT 'pending',
  config TEXT NOT NULL DEFAULT '{}',
  total_rounds INTEGER NOT NULL DEFAULT 0,
  current_round INTEGER NOT NULL DEFAULT 0,
  agent_count INTEGER NOT NULL DEFAULT 0,
  action_count INTEGER NOT NULL DEFAULT 0,
  cost_total REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Agent Personas ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_personas (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  simulation_id TEXT NOT NULL REFERENCES simulations(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  name TEXT NOT NULL,
  personality TEXT NOT NULL DEFAULT '{}',
  social_metrics TEXT NOT NULL DEFAULT '{}',
  activity_config TEXT NOT NULL DEFAULT '{}',
  memory TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_personas_simulation ON agent_personas(simulation_id);

-- ─── Agent Actions ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_actions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  simulation_id TEXT NOT NULL REFERENCES simulations(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agent_personas(id) ON DELETE CASCADE,
  round INTEGER NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('twitter', 'reddit', 'forum')),
  action_type TEXT NOT NULL CHECK (action_type IN ('create_post', 'like_post', 'repost', 'quote_post', 'reply', 'follow', 'create_comment', 'upvote', 'downvote', 'do_nothing')),
  content TEXT NOT NULL DEFAULT '',
  target_post_id TEXT,
  target_agent_id TEXT,
  reasoning TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_actions_simulation ON agent_actions(simulation_id);
CREATE INDEX IF NOT EXISTS idx_agent_actions_agent ON agent_actions(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_actions_round ON agent_actions(round);

-- ─── Simulated Posts ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS simulated_posts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  simulation_id TEXT NOT NULL REFERENCES simulations(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('twitter', 'reddit', 'forum')),
  author_id TEXT NOT NULL REFERENCES agent_personas(id) ON DELETE CASCADE,
  content TEXT NOT NULL DEFAULT '',
  parent_id TEXT REFERENCES simulated_posts(id) ON DELETE SET NULL,
  likes INTEGER NOT NULL DEFAULT 0,
  reposts INTEGER NOT NULL DEFAULT 0,
  replies INTEGER NOT NULL DEFAULT 0,
  round INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_simulated_posts_simulation ON simulated_posts(simulation_id);
CREATE INDEX IF NOT EXISTS idx_simulated_posts_author ON simulated_posts(author_id);
CREATE INDEX IF NOT EXISTS idx_simulated_posts_round ON simulated_posts(round);

-- ─── Emergent Patterns ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS emergent_patterns (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  simulation_id TEXT NOT NULL REFERENCES simulations(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('cascade', 'opinion_shift', 'viral', 'polarization', 'consensus')),
  description TEXT NOT NULL DEFAULT '',
  involved_agents TEXT NOT NULL DEFAULT '[]',
  first_seen_round INTEGER NOT NULL,
  intensity REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_emergent_patterns_simulation ON emergent_patterns(simulation_id);

-- ─── Prediction Reports ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS prediction_reports (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  simulation_id TEXT NOT NULL REFERENCES simulations(id) ON DELETE CASCADE,
  sections TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL DEFAULT 0,
  key_predictions TEXT NOT NULL DEFAULT '[]',
  methodology TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_prediction_reports_simulation ON prediction_reports(simulation_id);

-- ─── Feedback ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  message TEXT NOT NULL,
  email TEXT,
  category TEXT DEFAULT 'general',
  version TEXT,
  machine_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Schema version tracking ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`
