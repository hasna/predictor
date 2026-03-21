/**
 * Engine barrel — re-exports from orchestrator, simulator, patterns, and agent-brain.
 */

export {
  createPrediction,
  startPrediction,
  stopPrediction,
  getPredictionStatus,
  listPredictions,
} from "./orchestrator.ts"

export { runSimulation, runRound, getActiveAgents, buildAgentContext, executeDecision } from "./simulator.ts"

export { detectPatterns, analyzeEngagement } from "./patterns.ts"

export { decideAction, setBrainClient } from "./agent-brain.ts"
export type { AgentContext, AgentDecision } from "./agent-brain.ts"
