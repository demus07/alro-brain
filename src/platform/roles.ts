import type { Role } from "@/auth/sessions";

export const ROLES: Role[] = ["owner", "admin", "member"];
export const ROLE_LABEL: Record<Role, string> = { owner: "Owner", admin: "Admin", member: "Member" };

/** Owners and admins manage people, team sources, the agent team and company settings. */
export const isAdmin = (viewer: { role: Role }) => viewer.role === "owner" || viewer.role === "admin";

export function requireAdmin(viewer: { role: Role }) {
  if (!isAdmin(viewer)) throw new Error("Only an admin can do that.");
}
