import { z } from 'zod';

export const policySchema = z.enum(['instant', 'focused', 'deep', 'persistent']);
export type Policy = z.infer<typeof policySchema>;
export type TaskState = 'active' | 'paused' | 'waiting' | 'completed' | 'cancelled' | 'failed';
export type Lane = 'interactive' | 'background';
export const taskInputSchema = z.object({
  intent: z.string().trim().min(1).max(32000),
  policy: policySchema.default('focused'),
  priority: z.number().int().min(1).max(10).default(5),
  maxCalls: z.number().int().min(1).max(1000).optional(),
  maxParallel: z.number().int().min(1).max(32).default(3),
  maxDurationMs: z.number().int().min(100).max(86400000).default(1800000),
  allowedTools: z.array(z.string()).max(32).default([]),
});
export type TaskInput = z.input<typeof taskInputSchema>;
export interface Task {
  id: string; intent: string; policy: Policy; lane: Lane; state: TaskState;
  revision: number; priority: number; maxCalls: number; calls: number;
  maxParallel: number; maxDurationMs: number; activeSince: number;
  allowedTools: string[]; createdAt: number; updatedAt: number;
  wakeVersion: number; virtualRuntime: number; latestArtifactId: string | null; stopReason: string | null;
}
export interface Operation {
  kind: 'reason' | 'tool'; instruction: string; tool: string | null; inputJson: string | null;
}
export const decisionSchema = z.object({
  artifact: z.object({
    title: z.string().min(1).max(200), body: z.string().min(1).max(100000),
    confidence: z.enum(['unverified', 'supported']),
    evidence: z.array(z.string().max(2000)).max(20),
  }).nullable(),
  next: z.enum(['complete', 'continue', 'wait']),
  operations: z.array(z.object({
    kind: z.enum(['reason', 'tool']), instruction: z.string().min(1).max(8000),
    tool: z.string().nullable(), inputJson: z.string().max(16000).nullable(),
  })).max(6),
  reason: z.string().max(4000),
});
export type Decision = z.infer<typeof decisionSchema>;
export interface Job {
  id: string; taskId: string; revision: number; kind: 'controller' | 'reason' | 'tool';
  state: 'queued' | 'running' | 'completed' | 'cancelled' | 'failed' | 'uncertain';
  instruction: string; tool: string | null; inputJson: string | null; wakeVersion: number;
  dependsOn: string[]; attempts: number; availableAt: number;
  result: string | null; error: string | null; createdAt: number;
}
export interface Artifact {
  id: string; taskId: string; revision: number; title: string; body: string;
  confidence: 'unverified' | 'supported'; evidence: string[]; createdAt: number;
}
export interface RuntimeEvent {
  seq: number; taskId: string | null; kind: string; data: unknown; createdAt: number;
}
export interface Memory {
  id: string; taskId: string; key: string; value: string; source: string;
  confidence: 'unverified' | 'supported'; version: number; updatedAt: number;
}
export const inboundSchema = z.object({
  id: z.string().min(1).max(200).optional(),
  source: z.string().min(1).max(100), subject: z.string().min(1).max(1000),
  type: z.string().min(1).max(100), payload: z.unknown().optional(),
  originTaskId: z.string().optional(), causation: z.array(z.string()).max(16).default([]),
});
export type InboundInput = z.input<typeof inboundSchema>;
export interface InboundEvent extends z.output<typeof inboundSchema> { id: string }
export interface Delivery {
  id: string; taskId: string; event: InboundEvent; firstAt: number; count: number; dueAt: number; state: 'pending' | 'delivered';
}
export interface Subscription { id: string; taskId: string; source: string; subject: string; type: string }
export interface Timer { id: string; taskId: string; dueAt: number; intervalMs: number | null; fired: number }
export interface ToolDescription {
  name: string; description: string; inputSchema: Record<string, unknown>; effect: 'read' | 'write';
}
export interface ModelRequest {
  task: Task; job: Job; artifacts: Artifact[]; observations: { instruction: string; result: string }[];
  memory: Memory[]; mailbox: InboundEvent[]; tools: ToolDescription[];
}
export interface ModelProvider {
  execute(request: ModelRequest, signal: AbortSignal): Promise<Decision | string>;
}
export interface RuntimeConfig {
  interactiveSlots: number; backgroundSlots: number; maxWorkersPerTask: number;
  tickMs: number; debounceMs: number; jobTimeoutMs: number; maxAttempts: number;
}
export const runtimeConfigSchema = z.object({
  interactiveSlots: z.number().int().min(1).max(64).default(2),
  backgroundSlots: z.number().int().min(1).max(128).default(8),
  maxWorkersPerTask: z.number().int().min(1).max(32).default(4),
  tickMs: z.number().int().min(1).default(25),
  debounceMs: z.number().int().min(0).default(500),
  jobTimeoutMs: z.number().int().min(10).default(120000),
  maxAttempts: z.number().int().min(1).max(10).default(3),
});
export class ConflictError extends Error {}
export class NotFoundError extends Error {}
