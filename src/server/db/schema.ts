/**
 * Minimal Drizzle schema for the standalone agent runtime.
 *
 * mathran has no relational database (PRD §3b); these table definitions exist
 * so the ported agent/gateway query builders type-check and so the handful of
 * unit tests that exercise real Drizzle operators (eq/and/desc/…) against
 * mocked `getDb()` handles have genuine column objects to reference. Only the
 * columns actually touched by the ported call sites are modelled. Cross-table
 * foreign keys and relations from the original Mathub schema are intentionally
 * omitted — they are irrelevant without a live connection.
 */

import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  vector,
} from "drizzle-orm/pg-core";

// ===================== Conversations / channel messages =====================

export const channelMessages = pgTable("channel_messages", {
  id: text("id").primaryKey(),
  channelId: text("channel_id").notNull(),
  authorKind: text("author_kind").notNull(),
  content: text("content").notNull(),
  toolCallId: text("tool_call_id"),
  toolResult: jsonb("tool_result"),
  metadata: jsonb("metadata"),
  isSummary: boolean("is_summary").notNull().default(false),
  isCompacted: boolean("is_compacted").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ===================== User memories =====================

export const userMemories = pgTable("user_memories", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  category: text("category").notNull(),
  kind: text("kind").notNull(),
  slug: text("slug"),
  content: text("content").notNull(),
  mentionCount: integer("mention_count").notNull().default(0),
  lastUsedAt: timestamp("last_used_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at"),
  sourceConversationId: text("source_conversation_id"),
});

// ===================== Embeddings =====================

export const embeddings = pgTable("embeddings", {
  id: text("id").primaryKey(),
  contentType: text("content_type").notNull(),
  contentId: text("content_id").notNull(),
  embedding: vector("embedding", { dimensions: 1536 }),
  chunkText: text("chunk_text"),
});

// ===================== Assistant goal runs =====================

export const assistantGoalRuns = pgTable("assistant_goal_runs", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id"),
  userId: text("user_id"),
  objective: text("objective"),
  status: text("status"),
  tokenBudget: integer("token_budget"),
  consecutiveBlockedTurns: integer("consecutive_blocked_turns"),
  lastBlockSignature: text("last_block_signature"),
  startedAt: timestamp("started_at"),
  lastHeartbeat: timestamp("last_heartbeat"),
});

export const assistantGoalSummaries = pgTable("assistant_goal_summaries", {
  id: text("id").primaryKey(),
  runId: text("run_id"),
  content: text("content"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ===================== Projects / programs / membership =====================

export const projects = pgTable("projects", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull(),
  visibility: text("visibility").notNull(),
  createdBy: text("created_by"),
});

export const projectMembers = pgTable("project_members", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  userId: text("user_id").notNull(),
  role: text("role").notNull(),
});

export const programs = pgTable("programs", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull(),
  visibility: text("visibility").notNull(),
  createdBy: text("created_by"),
});

export const programMembers = pgTable("program_members", {
  id: text("id").primaryKey(),
  programId: text("program_id").notNull(),
  userId: text("user_id").notNull(),
  role: text("role").notNull(),
});

export const programProjects = pgTable("program_projects", {
  id: text("id").primaryKey(),
  programId: text("program_id").notNull(),
  projectId: text("project_id").notNull(),
});

// ===================== Workspace efforts =====================

export const workspaceEfforts = pgTable("workspace_efforts", {
  id: text("id").primaryKey(),
  projectId: text("project_id"),
  title: text("title"),
  type: text("type"),
  status: text("status"),
  isDeleted: boolean("is_deleted").notNull().default(false),
});

export const workspaceEffortRelations = pgTable("workspace_effort_relations", {
  id: text("id").primaryKey(),
  fromEffortId: text("from_item_id").notNull(),
  toEffortId: text("to_item_id").notNull(),
  relationType: text("relation_type").notNull(),
});

// ===================== Forum / wiki / channels =====================

export const threads = pgTable("threads", {
  id: text("id").primaryKey(),
  projectId: text("project_id"),
  programId: text("program_id"),
});

export const posts = pgTable("posts", {
  id: text("id").primaryKey(),
  threadId: text("thread_id"),
});

export const wikiPages = pgTable("wiki_pages", {
  id: text("id").primaryKey(),
  projectId: text("project_id"),
  programId: text("program_id"),
  isDeleted: boolean("is_deleted").notNull().default(false),
});

export const channels = pgTable("channels", {
  id: text("id").primaryKey(),
  kind: text("kind"),
  projectId: text("project_id"),
  programId: text("program_id"),
  threadId: text("thread_id"),
  effortId: text("effort_id"),
  createdBy: text("created_by"),
  dmParticipantAUserId: text("dm_participant_a_user_id"),
  dmParticipantBUserId: text("dm_participant_b_user_id"),
  dmParticipantABotId: text("dm_participant_a_bot_id"),
  dmParticipantBBotId: text("dm_participant_b_bot_id"),
});

// ===================== Users =====================

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  role: text("role").notNull(),
  deletedAt: timestamp("deleted_at"),
});
