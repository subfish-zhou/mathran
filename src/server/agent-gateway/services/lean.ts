import { eq } from "drizzle-orm";
import { importLeanRepo as importLeanRepoImpl } from "@/lib/lean/lean-repo-importer";
import { getLeanService } from "@/lib/lean/lean-service";
// TODO(mathran-v0.1): import { getDb } from "@/server/db";
// TODO(mathran-v0.1): import { projects } from "@/server/db/schema";
import { requirePrincipalScope } from "../scopes";
import { authorizeResource, ResourceNotFoundError } from "../resource-access";
import { principalUserId, type AgentPrincipal } from "../principal";
// TODO(mathran-v0.1): import { withSpan } from "@/lib/observability/trace";

export async function importLeanRepo(
  principal: AgentPrincipal,
  args: {
    projectId: string;
    repoUrl: string;
    branch?: string;
    effortId?: string;
    effortTitle?: string;
  },
): Promise<unknown> {
  return withSpan(
    "service.lean.importLeanRepo",
    { principal, attrs: { projectId: args.projectId, effortId: args.effortId } },
    async () => {
  requirePrincipalScope(principal, "lean.write");
  await authorizeResource(principal, { kind: "project", id: args.projectId }, "write");

  const db = getDb();
  return importLeanRepoImpl(
    db,
    args.projectId,
    principalUserId(principal),
    args.repoUrl,
    args.branch || "main",
    { effortId: args.effortId, effortTitle: args.effortTitle },
  );
},
  );
}

export async function getLeanStatus(
  principal: AgentPrincipal,
  args: { projectId: string },
): Promise<unknown> {
  return withSpan(
    "service.lean.getLeanStatus",
    { principal, attrs: { projectId: args.projectId } },
    async () => {
  requirePrincipalScope(principal, "lean.read");
  await authorizeResource(principal, { kind: "project", id: args.projectId }, "read");

  const db = getDb();
  const [project] = await db
    .select({ slug: projects.slug })
    .from(projects)
    .where(eq(projects.id, args.projectId))
    .limit(1);
  if (!project) throw new ResourceNotFoundError("project not found");

  return getLeanService().getStatus(project.slug);
},
  );
}

export async function checkLean(
  principal: AgentPrincipal,
  args: { code: string; projectSlug?: string; imports?: string[] },
): Promise<unknown> {
  return withSpan(
    "service.lean.checkLean",
    { principal, attrs: {} },
    async () => {
  requirePrincipalScope(principal, "lean.read");
  if (args.projectSlug && args.projectSlug !== "default") {
    await authorizeResource(principal, { kind: "project", slug: args.projectSlug }, "read");
  }
  return getLeanService().checkSnippet(args.projectSlug ?? "default", args.code, args.imports);
},
  );
}
