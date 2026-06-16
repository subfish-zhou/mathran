export type ProjectRole = "ADMIN" | "OWNER" | "MAINTAINER" | "CONTRIBUTOR" | "VIEWER";

const VALID_ROLES: ProjectRole[] = ["ADMIN", "OWNER", "MAINTAINER", "CONTRIBUTOR", "VIEWER"];

export function getUserProjectRole(
  userId: string,
  userGlobalRole: string,
  projectCreatedBy: string,
  projectMembership?: { role: string } | null
): ProjectRole {
  if (userGlobalRole === "SUPER_ADMIN" || userGlobalRole === "ADMIN") return "ADMIN";
  if (userGlobalRole === "FELLOW") return "MAINTAINER";
  if (projectCreatedBy === userId) return "OWNER";
  if (projectMembership) {
    const role = projectMembership.role as ProjectRole;
    return VALID_ROLES.includes(role) ? role : "VIEWER";
  }
  return "VIEWER";
}

export function canDeleteProject(role: ProjectRole): boolean {
  return role === "ADMIN" || role === "OWNER";
}

export function canRestoreProject(role: ProjectRole): boolean {
  return role === "ADMIN" || role === "OWNER";
}

export function canDeleteThread(role: ProjectRole, isAuthor: boolean): boolean {
  return role === "ADMIN" || role === "OWNER" || role === "MAINTAINER" || isAuthor;
}

export function canDeleteWorkspaceEffort(role: ProjectRole, isAuthor: boolean): boolean {
  return role === "ADMIN" || role === "OWNER" || role === "MAINTAINER" || isAuthor;
}

export function canManageMembers(role: ProjectRole): boolean {
  return role === "ADMIN" || role === "OWNER";
}

export function isMaintainerOrAbove(role: ProjectRole): boolean {
  return role === "ADMIN" || role === "OWNER" || role === "MAINTAINER";
}

export function isContributorOrAbove(role: ProjectRole): boolean {
  return role === "ADMIN" || role === "OWNER" || role === "MAINTAINER" || role === "CONTRIBUTOR";
}

export function isAtLeastContributor(role: ProjectRole): boolean {
  return role === "ADMIN" || role === "OWNER" || role === "MAINTAINER" || role === "CONTRIBUTOR";
}

export function isAtLeastMaintainer(role: ProjectRole): boolean {
  return role === "ADMIN" || role === "OWNER" || role === "MAINTAINER";
}

// IMPL [unimpl-TODOS-P1-USER-ROLE] USER (read-only) helpers
export function isReadOnlyGlobalRole(globalRole: string | null | undefined): boolean {
  return globalRole === "USER";
}

// IMPL [unimpl-TODOS-P1-USER-ROLE] REVIEWER permissions
export function canReviewWiki(globalRole: string | null | undefined): boolean {
  return (
    globalRole === "SUPER_ADMIN" ||
    globalRole === "ADMIN" ||
    globalRole === "FELLOW" ||
    globalRole === "REVIEWER"
  );
}

export function canApproveWikiCommit(globalRole: string | null | undefined): boolean {
  return canReviewWiki(globalRole);
}

export function canSubmitForReview(globalRole: string | null | undefined): boolean {
  // USER (read-only) cannot submit; everyone else can
  return globalRole !== "USER";
}
