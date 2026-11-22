import "server-only";

/**
 * This build is single-user and single-workspace: every installation has one
 * workspace, "local". Workspace-scoped data (context items, files, audit events)
 * is still stored and queried by workspace id, so adding workspaces later can't
 * leak data between them. There are no user accounts; see docs/security.md.
 */
export const LOCAL_WORKSPACE = "local";
export const currentWorkspace = (): string => LOCAL_WORKSPACE;
