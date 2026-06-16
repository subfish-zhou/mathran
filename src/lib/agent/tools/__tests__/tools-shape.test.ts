import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentPrincipal } from "@/server/agent-gateway/principal";
import {
  ResourceForbiddenError,
  ResourceNotFoundError,
} from "@/server/agent-gateway/resource-access";
import {
  createProjectEffort,
  getEffort,
  getEffortDetails,
  listEffortIssues,
  searchEfforts,
} from "@/server/agent-gateway/services/efforts";
import { listMentions } from "@/server/agent-gateway/services/forum";
import { getProgramIndex, listPrograms } from "@/server/agent-gateway/services/programs";
import { getProjectIndex } from "@/server/agent-gateway/services/projects";
import {
  getThread,
  searchForumThreadsAndPosts,
  summarizeThread,
} from "@/server/agent-gateway/services/threads";
import { getWikiPage, searchWikiPages } from "@/server/agent-gateway/services/wiki";
import { getAzureClient } from "@/lib/agent/azure-llm";
import { userIdToPrincipal } from "../_lib/user-principal";
import { createEffortTool } from "../create-effort";
import { getProgramIndexTool } from "../get-program-index";
import { getProjectIndexTool } from "../get-project-index";
import { listEffortIssuesTool } from "../list-effort-issues";
import { listMentionsTool } from "../list-mentions";
import { listProgramsTool } from "../list-programs";
import { readEffortDetailsTool } from "../read-effort-details";
import { readEffortTool } from "../read-effort";
import { readProgramTool } from "../read-program";
import { readThreadTool } from "../read-thread";
import { readWikiPageTool } from "../read-wiki-page";
import { searchEffortsTool } from "../search-efforts";
import { searchForumTool } from "../search-forum";
import { searchWikiTool } from "../search-wiki";
import { summarizeThreadTool } from "../summarize-thread";
import type { ToolContext, ToolDefinition, ToolResult } from "../types";

const azureMocks = vi.hoisted(() => ({
  createCompletion: vi.fn(),
}));

vi.mock("../_lib/user-principal", () => ({
  userIdToPrincipal: vi.fn(),
}));

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@/lib/bot-auth", () => ({
  authenticateBot: vi.fn(),
}));

vi.mock("@/server/agent-gateway/services/efforts", () => ({
  getEffort: vi.fn(),
  getEffortDetails: vi.fn(),
  listEffortIssues: vi.fn(),
  createProjectEffort: vi.fn(),
  searchEfforts: vi.fn(),
}));

vi.mock("@/server/agent-gateway/services/forum", () => ({
  listMentions: vi.fn(),
}));

vi.mock("@/server/agent-gateway/services/programs", () => ({
  getProgramIndex: vi.fn(),
  listPrograms: vi.fn(),
}));

vi.mock("@/server/agent-gateway/services/projects", () => ({
  getProjectIndex: vi.fn(),
}));

vi.mock("@/server/agent-gateway/services/threads", () => ({
  getThread: vi.fn(),
  summarizeThread: vi.fn(),
  searchForumThreadsAndPosts: vi.fn(),
}));

vi.mock("@/server/agent-gateway/services/wiki", () => ({
  getWikiPage: vi.fn(),
  searchWikiPages: vi.fn(),
}));

vi.mock("@/lib/agent/azure-llm", () => ({
  DEFAULT_AZURE_MODEL: "mock-model",
  getAzureClient: vi.fn(),
}));

const date = new Date("2026-05-20T00:00:00.000Z");
const principal: AgentPrincipal = { type: "user", userId: "user-1", role: "USER" };

const mockUserIdToPrincipal = vi.mocked(userIdToPrincipal);
const mockGetEffort = vi.mocked(getEffort);
const mockGetEffortDetails = vi.mocked(getEffortDetails);
const mockListEffortIssues = vi.mocked(listEffortIssues);
const mockCreateProjectEffort = vi.mocked(createProjectEffort);
const mockSearchEfforts = vi.mocked(searchEfforts);
const mockListMentions = vi.mocked(listMentions);
const mockGetProgramIndex = vi.mocked(getProgramIndex);
const mockListPrograms = vi.mocked(listPrograms);
const mockGetProjectIndex = vi.mocked(getProjectIndex);
const mockGetThread = vi.mocked(getThread);
const mockSummarizeThread = vi.mocked(summarizeThread);
const mockSearchForumThreadsAndPosts = vi.mocked(searchForumThreadsAndPosts);
const mockGetWikiPage = vi.mocked(getWikiPage);
const mockSearchWikiPages = vi.mocked(searchWikiPages);
const mockGetAzureClient = vi.mocked(getAzureClient);

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    userId: "user-1",
    projectId: "project-ctx",
    programId: "program-ctx",
    db: {} as ToolContext["db"],
    ...overrides,
  };
}

function expectRecord(value: unknown): Record<string, unknown> {
  expect(value).toBeTruthy();
  expect(typeof value).toBe("object");
  return value as Record<string, unknown>;
}

function expectArray(value: unknown): Array<Record<string, unknown>> {
  expect(Array.isArray(value)).toBe(true);
  return value as Array<Record<string, unknown>>;
}

function expectStringData(result: ToolResult, prefix: string): void {
  expect(typeof result.data).toBe("string");
  expect(result.data).toContain(prefix);
}

function expectKeys(value: Record<string, unknown>, keys: string[]): void {
  expect(Object.keys(value).sort()).toEqual([...keys].sort());
}

function mockProgramIndexFixture(): Awaited<ReturnType<typeof getProgramIndex>> {
  return {
    program: {
      id: "program-ctx",
      title: "Program Alpha",
      slug: "program-alpha",
      subtitle: "A focused program",
      description: "Program description",
      status: "ACTIVE",
      mathStatus: "CONJECTURAL",
      visibility: "public",
      parentId: "parent-1",
      mscCodes: ["11Axx"],
      createdAt: date,
    },
    parent: { id: "parent-1", title: "Parent Program" },
    projects: [
      {
        id: "project-ctx",
        title: "Project Alpha",
        status: "ACTIVE",
        role: "core",
        order: 1,
        effortCount: 2,
        wikiPageCount: 3,
        threadCount: 4,
      },
    ],
    dependencies: [
      {
        sourceProjectId: "project-ctx",
        targetProjectId: "project-beta",
        relationKind: "uses",
        label: "main dependency",
      },
    ],
    members: [
      {
        userName: "Ada Lovelace",
        userUsername: "ada",
        role: "editor",
      },
    ],
  } as Awaited<ReturnType<typeof getProgramIndex>>;
}

type ShapeCase = {
  name: string;
  tool: ToolDefinition;
  args: Record<string, unknown>;
  context?: Partial<ToolContext>;
  setupHappy: () => void;
  setupForbidden: () => void;
  expectedDisplay: string;
  forbiddenMessage: string;
  assertData: (result: ToolResult) => void;
  afterHappy?: () => void;
};

const migratedToolCases: ShapeCase[] = [
  {
    name: "read_effort",
    tool: readEffortTool,
    args: { effortId: "effort-1" },
    setupHappy: () => {
      mockGetEffort.mockResolvedValue({
        effort: {
          title: "Effort Alpha",
          type: "PROOF_ATTEMPT",
          status: "DRAFT",
          description: "A detailed effort description",
          document: "Full effort document",
          tags: ["tag-one"],
          arxivId: "2401.00001",
          doi: "10.0000/example",
          createdAt: date,
        },
        project: null,
        creator: { id: "user-2", name: "Ada Lovelace" },
      } as unknown as Awaited<ReturnType<typeof getEffort>>);
    },
    setupForbidden: () => mockGetEffort.mockRejectedValue(new ResourceForbiddenError("forbidden")),
    expectedDisplay: "Read effort: Effort Alpha",
    forbiddenMessage: "You don't have access to this effort.",
    assertData: (result) => expectStringData(result, "# Effort Alpha"),
  },
  {
    name: "read_effort_details",
    tool: readEffortDetailsTool,
    args: { effortId: "effort-1" },
    setupHappy: () => {
      mockGetEffortDetails.mockResolvedValue({
        reviews: [
          {
            id: "review-1",
            status: "approved",
            body: "This review body should be included in the preview.",
            createdAt: date,
            reviewerName: "Ada Lovelace",
          },
        ],
        milestones: [
          {
            id: "milestone-1",
            title: "Prove the lemma",
            description: "Milestone description",
            status: "open",
            dueDate: date,
            createdAt: date,
          },
        ],
        releases: [
          {
            id: "release-1",
            tag: "v1",
            title: "First release",
            isDraft: false,
            createdAt: date,
            authorName: "Ada Lovelace",
          },
        ],
        stats: { stars: 7, watches: 2 },
      } as Awaited<ReturnType<typeof getEffortDetails>>);
    },
    setupForbidden: () =>
      mockGetEffortDetails.mockRejectedValue(new ResourceForbiddenError("forbidden")),
    expectedDisplay: "Read effort details: effort-1 (reviews, milestones, releases, stats)",
    forbiddenMessage: "You don't have access to this effort.",
    assertData: (result) => expectStringData(result, "# Effort Details: effort-1"),
  },
  {
    name: "list_effort_issues",
    tool: listEffortIssuesTool,
    args: { effortId: "effort-1" },
    setupHappy: () => {
      mockListEffortIssues.mockResolvedValue({
        issues: [
          {
            id: "issue-1",
            title: "Close the gap",
            status: "open",
            priority: "high",
            authorName: "Ada Lovelace",
            authorId: "user-2",
            createdAt: date,
          },
        ],
        limit: 20,
        offset: 0,
      } as Awaited<ReturnType<typeof listEffortIssues>>);
    },
    setupForbidden: () =>
      mockListEffortIssues.mockRejectedValue(new ResourceForbiddenError("forbidden")),
    expectedDisplay: "# Effort Issues (1)",
    forbiddenMessage: "You don't have access to this effort.",
    assertData: (result) => {
      const [issue] = expectArray(result.data);
      expectKeys(issue, ["id", "title", "status", "priority", "authorName", "authorId", "createdAt"]);
    },
  },
  {
    name: "create_effort",
    tool: createEffortTool,
    args: {
      title: "New Effort",
      type: "CONSTRUCTION",
      projectId: "llm-project",
      description: "New effort description",
    },
    setupHappy: () => {
      mockCreateProjectEffort.mockResolvedValue({
        id: "effort-new",
        title: "New Effort",
      } as Awaited<ReturnType<typeof createProjectEffort>>);
    },
    setupForbidden: () =>
      mockCreateProjectEffort.mockRejectedValue(new ResourceForbiddenError("forbidden")),
    expectedDisplay: "Created effort \"New Effort\" (CONSTRUCTION) as draft",
    forbiddenMessage: "You don't have permission to create efforts in this project.",
    assertData: (result) => {
      expect(expectRecord(result.data)).toMatchObject({ id: "effort-new", title: "New Effort" });
    },
    afterHappy: () => {
      expect(mockCreateProjectEffort).toHaveBeenCalledWith(
        principal,
        expect.objectContaining({ projectId: "project-ctx" }),
      );
    },
  },
  {
    name: "read_thread",
    tool: readThreadTool,
    args: { threadId: "thread-1", limit: 1 },
    setupHappy: () => {
      mockGetThread.mockResolvedValue({
        thread: {
          title: "Thread Alpha",
          stream: "DISCUSSION",
          status: "open",
        },
        posts: [
          { body: "First post", authorName: "Ada Lovelace", createdAt: date },
          { body: "Second post", authorName: "Grace Hopper", createdAt: date },
        ],
      } as Awaited<ReturnType<typeof getThread>>);
    },
    setupForbidden: () => mockGetThread.mockRejectedValue(new ResourceForbiddenError("forbidden")),
    expectedDisplay: "Read thread: Thread Alpha (1 posts)",
    forbiddenMessage: "You don't have access to this thread.",
    assertData: (result) => expectStringData(result, "# Thread Alpha"),
  },
  {
    name: "summarize_thread",
    tool: summarizeThreadTool,
    args: { threadId: "thread-1" },
    setupHappy: () => {
      mockSummarizeThread.mockResolvedValue({
        thread: {
          id: "thread-1",
          title: "Thread Alpha",
          stream: "DISCUSSION",
          status: "open",
          isLocked: false,
          isPinned: false,
          createdAt: date,
          projectId: "project-ctx",
          programId: null,
          summary: null,
        },
        posts: [
          {
            id: "post-1",
            authorId: "user-2",
            authorName: "Ada Lovelace",
            body: "Discussing the main lemma.",
            createdAt: date,
            truncated: false,
          },
        ],
      } as Awaited<ReturnType<typeof summarizeThread>>);
    },
    setupForbidden: () =>
      mockSummarizeThread.mockRejectedValue(new ResourceForbiddenError("forbidden")),
    expectedDisplay: "Summarized thread: Thread Alpha (1 posts)",
    forbiddenMessage: "You don't have access to this thread.",
    assertData: (result) => expectStringData(result, "# Summary: Thread Alpha"),
  },
  {
    name: "read_wiki_page",
    tool: readWikiPageTool,
    args: { pageId: "wiki-1" },
    setupHappy: () => {
      mockGetWikiPage.mockResolvedValue({
        title: "Wiki Alpha",
        slug: "wiki-alpha",
        content: "Full wiki content",
        updatedAt: date,
      } as Awaited<ReturnType<typeof getWikiPage>>);
    },
    setupForbidden: () => mockGetWikiPage.mockRejectedValue(new ResourceForbiddenError("forbidden")),
    expectedDisplay: "Read wiki page: Wiki Alpha",
    forbiddenMessage: "You don't have access to this wiki page.",
    assertData: (result) => expectStringData(result, "# Wiki Alpha"),
  },
  {
    name: "read_program",
    tool: readProgramTool,
    args: { programId: "llm-program" },
    setupHappy: () => mockGetProgramIndex.mockResolvedValue(mockProgramIndexFixture()),
    setupForbidden: () =>
      mockGetProgramIndex.mockRejectedValue(new ResourceForbiddenError("forbidden")),
    expectedDisplay: "Read program: Program Alpha",
    forbiddenMessage: "You don't have access to this program.",
    assertData: (result) => expectStringData(result, "# Program Alpha"),
    afterHappy: () => {
      expect(mockGetProgramIndex).toHaveBeenCalledWith(principal, { idOrSlug: "program-ctx" });
    },
  },
  {
    name: "get_program_index",
    tool: getProgramIndexTool,
    args: { programId: "llm-program" },
    setupHappy: () => mockGetProgramIndex.mockResolvedValue(mockProgramIndexFixture()),
    setupForbidden: () =>
      mockGetProgramIndex.mockRejectedValue(new ResourceForbiddenError("forbidden")),
    expectedDisplay: "Program index: 1 projects, 1 dependencies, 1 members",
    forbiddenMessage: "You don't have access to this program.",
    assertData: (result) => expectStringData(result, "# Program: Program Alpha"),
    afterHappy: () => {
      expect(mockGetProgramIndex).toHaveBeenCalledWith(principal, { idOrSlug: "program-ctx" });
    },
  },
  {
    name: "get_project_index",
    tool: getProjectIndexTool,
    args: { projectId: "llm-project" },
    setupHappy: () => {
      mockGetProjectIndex.mockResolvedValue({
        project: {
          title: "Project Alpha",
          description: "Project description",
          status: "ACTIVE",
          mathStatus: "CONJECTURAL",
          mscCodes: ["11Axx"],
          visibility: "public",
        },
        efforts: [
          { id: "effort-1", title: "Effort Alpha", type: "PROOF_ATTEMPT", status: "DRAFT" },
        ],
        wikiPages: [{ id: "wiki-1", title: "Wiki Alpha", slug: "wiki-alpha", parentId: null }],
        threads: [{ id: "thread-1", title: "Thread Alpha", stream: "DISCUSSION", postCount: 2 }],
      } as Awaited<ReturnType<typeof getProjectIndex>>);
    },
    setupForbidden: () =>
      mockGetProjectIndex.mockRejectedValue(new ResourceForbiddenError("forbidden")),
    expectedDisplay: "Project index: 1 efforts, 1 wiki pages, 1 threads",
    forbiddenMessage: "You don't have access to this project.",
    assertData: (result) => expectStringData(result, "# Project: Project Alpha"),
    afterHappy: () => {
      expect(mockGetProjectIndex).toHaveBeenCalledWith(principal, { id: "project-ctx" });
    },
  },
  {
    name: "list_programs",
    tool: listProgramsTool,
    args: {},
    setupHappy: () => {
      mockListPrograms.mockResolvedValue([
        {
          id: "program-1",
          title: "Program Alpha",
          status: "ACTIVE",
          mathStatus: "CONJECTURAL",
          parentId: null,
          createdAt: date,
          projectCount: 3,
        },
      ] as Awaited<ReturnType<typeof listPrograms>>);
    },
    setupForbidden: () => mockListPrograms.mockRejectedValue(new ResourceForbiddenError("forbidden")),
    expectedDisplay: "# Programs (1)",
    forbiddenMessage: "You don't have access to these programs.",
    assertData: (result) => {
      const [program] = expectArray(result.data);
      expectKeys(program, [
        "id",
        "title",
        "status",
        "mathStatus",
        "parentId",
        "createdAt",
        "projectCount",
      ]);
    },
  },
  {
    name: "search_efforts",
    tool: searchEffortsTool,
    args: { query: "lemma" },
    setupHappy: () => {
      mockSearchEfforts.mockResolvedValue([
        {
          id: "effort-1",
          title: "Lemma effort",
          type: "PROOF_ATTEMPT",
          status: "DRAFT",
          projectId: "project-ctx",
          description: "A long lemma description",
        },
      ]);
    },
    setupForbidden: () =>
      mockSearchEfforts.mockRejectedValue(new ResourceForbiddenError("forbidden")),
    expectedDisplay: "Found 1 effort(s) matching \"lemma\"",
    forbiddenMessage: "You don't have access to this search scope.",
    assertData: (result) => {
      const [effort] = expectArray(result.data);
      expectKeys(effort, ["id", "title", "type", "status", "projectId", "snippet"]);
    },
  },
  {
    name: "search_forum",
    tool: searchForumTool,
    args: { query: "lemma" },
    setupHappy: () => {
      mockSearchForumThreadsAndPosts.mockResolvedValue({
        threads: [
          {
            id: "thread-1",
            title: "Lemma thread",
            projectId: "project-ctx",
            snippet: "Thread snippet",
            status: "open",
          },
        ],
        posts: [{ id: "post-1", threadId: "thread-1", snippet: "Post snippet" }],
      });
    },
    setupForbidden: () =>
      mockSearchForumThreadsAndPosts.mockRejectedValue(
        new ResourceForbiddenError("forbidden"),
      ),
    expectedDisplay: "Found 1 thread(s) and 1 post(s) matching \"lemma\"",
    forbiddenMessage: "You don't have access to this search scope.",
    assertData: (result) => {
      const data = expectRecord(result.data);
      expect(Array.isArray(data.threads)).toBe(true);
      expect(Array.isArray(data.posts)).toBe(true);
    },
  },
  {
    name: "search_wiki",
    tool: searchWikiTool,
    args: { query: "lemma" },
    setupHappy: () => {
      mockSearchWikiPages.mockResolvedValue([
        {
          id: "wiki-1",
          title: "Lemma wiki",
          slug: "lemma-wiki",
          projectId: "project-ctx",
          programId: null,
          snippet: "Wiki snippet",
          type: "wiki",
        },
      ]);
    },
    setupForbidden: () =>
      mockSearchWikiPages.mockRejectedValue(new ResourceForbiddenError("forbidden")),
    expectedDisplay: "Found 1 wiki page(s) matching \"lemma\"",
    forbiddenMessage: "You don't have access to this search scope.",
    assertData: (result) => {
      const [page] = expectArray(result.data);
      expectKeys(page, ["title", "slug", "projectId", "snippet"]);
    },
  },
];

const notFoundCases = [
  {
    name: "read_effort",
    tool: readEffortTool,
    args: { effortId: "missing-effort" },
    setup: () => mockGetEffort.mockRejectedValue(new ResourceNotFoundError("missing")),
    message: "Effort not found",
  },
  {
    name: "read_thread",
    tool: readThreadTool,
    args: { threadId: "missing-thread" },
    setup: () => mockGetThread.mockRejectedValue(new ResourceNotFoundError("missing")),
    message: "Thread not found",
  },
  {
    name: "read_wiki_page",
    tool: readWikiPageTool,
    args: { pageId: "missing-page" },
    setup: () => mockGetWikiPage.mockRejectedValue(new ResourceNotFoundError("missing")),
    message: "Wiki page not found",
  },
  {
    name: "get_project_index",
    tool: getProjectIndexTool,
    args: { projectId: "missing-project" },
    setup: () => mockGetProjectIndex.mockRejectedValue(new ResourceNotFoundError("missing")),
    message: "Project not found",
  },
  {
    name: "get_program_index",
    tool: getProgramIndexTool,
    args: { programId: "missing-program" },
    setup: () => mockGetProgramIndex.mockRejectedValue(new ResourceNotFoundError("missing")),
    message: "Program not found",
  },
];

describe("agent tool service shape", () => {
  beforeEach(() => {
    mockUserIdToPrincipal.mockReset();
    mockGetEffort.mockReset();
    mockGetEffortDetails.mockReset();
    mockListEffortIssues.mockReset();
    mockCreateProjectEffort.mockReset();
    mockSearchEfforts.mockReset();
    mockListMentions.mockReset();
    mockGetProgramIndex.mockReset();
    mockListPrograms.mockReset();
    mockGetProjectIndex.mockReset();
    mockGetThread.mockReset();
    mockSummarizeThread.mockReset();
    mockSearchForumThreadsAndPosts.mockReset();
    mockGetWikiPage.mockReset();
    mockSearchWikiPages.mockReset();
    mockGetAzureClient.mockReset();
    azureMocks.createCompletion.mockReset();

    mockUserIdToPrincipal.mockResolvedValue(principal);
    azureMocks.createCompletion.mockResolvedValue({
      choices: [{ message: { content: "Mock thread summary" } }],
    });
    mockGetAzureClient.mockReturnValue({
      chat: { completions: { create: azureMocks.createCompletion } },
    } as unknown as ReturnType<typeof getAzureClient>);
  });

  it.each(migratedToolCases)("$name happy path keeps the legacy shape", async (testCase) => {
    testCase.setupHappy();

    const result = await testCase.tool.execute(
      testCase.args,
      ctx(testCase.context),
    );

    expect(result.success).toBe(true);
    expect(result.displayText).toContain(testCase.expectedDisplay);
    testCase.assertData(result);
    testCase.afterHappy?.();
  });

  it.each(migratedToolCases)("$name forbidden maps to the tool default", async (testCase) => {
    testCase.setupForbidden();

    const result = await testCase.tool.execute(
      testCase.args,
      ctx(testCase.context),
    );

    expect(result.success).toBe(false);
    expect(result.data).toBeNull();
    expect(result.displayText).toBe(testCase.forbiddenMessage);
  });

  it.each(notFoundCases)("$name not_found maps to the legacy not found text", async (testCase) => {
    testCase.setup();

    const result = await testCase.tool.execute(testCase.args, ctx());

    expect(result.success).toBe(false);
    expect(result.data).toBeNull();
    expect(result.displayText).toBe(testCase.message);
  });

  it("list_mentions renders mention snippets", async () => {
    mockListMentions.mockResolvedValue([
      {
        postId: "post-1",
        threadId: "thread-1",
        body: "@ada please check this lemma in the proof thread.",
        authorId: "user-2",
        createdAt: date,
      },
    ]);

    const result = await listMentionsTool.execute({ limit: 5 }, ctx());

    expect(result.success).toBe(true);
    expect(result.displayText).toContain("# Mentions (1)");
    expect(result.displayText).toContain("@ada in [thread thread-1](/api/bot/v1/threads/thread-1)");
    const [mention] = expectArray(result.data);
    expectKeys(mention, ["postId", "threadId", "body", "authorId", "createdAt"]);
  });

  it("list_mentions forbidden maps to the tool default", async () => {
    mockListMentions.mockRejectedValue(new ResourceForbiddenError("forbidden"));

    const result = await listMentionsTool.execute({}, ctx());

    expect(result.success).toBe(false);
    expect(result.data).toBeNull();
    expect(result.displayText).toBe("You don't have access to mentions.");
  });
});
