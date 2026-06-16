import { and, eq } from "drizzle-orm";
import { projectMembers, programMembers } from "@/server/db/schema";
import type { Database } from "@/server/db";

type Db = Database;

/**
 * Check if a user can access a project based on visibility.
 * SUPER_ADMIN/ADMIN bypass all checks. Public projects are always accessible.
 * Private projects require the user to be the creator or a member.
 */
export async function canAccessProject(
  db: Db,
  projectId: string,
  userId: string | null,
  userRole: string | null,
  projectVisibility?: string,
  projectCreatedBy?: string,
): Promise<boolean> {
  if (userRole === "SUPER_ADMIN" || userRole === "ADMIN") return true;
  const visibility = projectVisibility ?? "public";
  if (visibility === "public") return true;
  if (!userId) return false;
  if (projectCreatedBy === userId) return true;
  const [membership] = await db
    .select({ userId: projectMembers.userId })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
    .limit(1);
  return !!membership;
}

/**
 * Check if a user can access a program based on visibility.
 */
export async function canAccessProgram(
  db: Db,
  programId: string,
  userId: string | null,
  userRole: string | null,
  programVisibility?: string,
  programCreatedBy?: string,
): Promise<boolean> {
  if (userRole === "SUPER_ADMIN" || userRole === "ADMIN") return true;
  const visibility = programVisibility ?? "public";
  if (visibility === "public") return true;
  if (!userId) return false;
  if (programCreatedBy === userId) return true;
  const [membership] = await db
    .select({ userId: programMembers.userId })
    .from(programMembers)
    .where(and(eq(programMembers.programId, programId), eq(programMembers.userId, userId)))
    .limit(1);
  return !!membership;
}
