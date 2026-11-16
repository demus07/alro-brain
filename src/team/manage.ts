import { and, count, eq, isNull } from "drizzle-orm";
import type { Role } from "@/auth/sessions";
import type { Db } from "@/db/client";
import { people, teamAgents } from "@/db/schema";
import { departmentSlug, type Viewer } from "@/db/scope";
import { audit } from "@/lib/audit";
import { isAdmin } from "@/platform/roles";
import { departmentOf } from "./presets";

/**
 * Who may change the agent team. A specialist's job is a set of instructions that runs with
 * the access of whoever asks the team, so changing one changes what everyone's agent does:
 * adding is for admins, and a specialist is changed only by whoever added it or an admin.
 */
export type Member = Viewer & { role: Role };

/** Something the member did wrong or isn't allowed to do, worded for them to read. */
export class TeamError extends Error {}

export interface SpecialistInput {
  name: string;
  job: string;
  tools: string[];
}

/** Adding a department or a specialist: admins, or anyone while they are the only member (a solo founder owns it all anyway). */
export async function canAdd(db: Db, viewer: Member): Promise<boolean> {
  if (isAdmin(viewer)) return true;
  const [{ members }] = await db
    .select({ members: count() })
    .from(people)
    .where(and(eq(people.orgId, viewer.orgId), eq(people.isMember, true), isNull(people.deactivatedAt)));
  return members <= 1;
}

/** Editing, switching off or removing a specialist: whoever added it, or an admin. */
export const canChange = (viewer: Member, specialist: { createdBy: string | null }) => isAdmin(viewer) || specialist.createdBy === viewer.personId;

async function mustAdd(db: Db, viewer: Member) {
  if (!(await canAdd(db, viewer))) throw new TeamError("Only an admin can add to the agent team.");
}

/** The specialist, if it is in the viewer's org and they may change it. */
async function mine(db: Db, viewer: Member, id: string) {
  const [row] = /^[0-9a-f-]{36}$/i.test(id)
    ? await db
        .select()
        .from(teamAgents)
        .where(and(eq(teamAgents.id, id), eq(teamAgents.orgId, viewer.orgId)))
    : [];
  if (!row) throw new TeamError("That specialist is no longer there.");
  if (!canChange(viewer, row)) throw new TeamError("Only an admin or whoever added this specialist can change it.");
  return row;
}

/** The lead picks specialists by name, so a name is used once per department. */
async function clean(db: Db, orgId: string, department: string, input: SpecialistInput, exceptId?: string): Promise<SpecialistInput> {
  const name = input.name.trim();
  const job = input.job.trim();
  if (!name || !job) throw new TeamError("Give it a name and say what its job is.");
  const others = await db
    .select({ id: teamAgents.id, name: teamAgents.name })
    .from(teamAgents)
    .where(and(eq(teamAgents.orgId, orgId), eq(teamAgents.department, department)));
  if (others.some((o) => o.id !== exceptId && o.name.toLowerCase() === name.toLowerCase())) throw new TeamError(`That department already has a specialist called ${name}.`);
  return { name, job, tools: input.tools };
}

/** Adds a ready-made department's specialists (skipping any already there by name). */
export async function addDepartment(db: Db, viewer: Member, id: string) {
  await mustAdd(db, viewer);
  const preset = departmentOf(id);
  if (!preset) throw new TeamError("Unknown department.");
  const existing = await db
    .select({ name: teamAgents.name })
    .from(teamAgents)
    .where(and(eq(teamAgents.orgId, viewer.orgId), eq(teamAgents.department, id)));
  const fresh = preset.specialists.filter((s) => !existing.some((e) => e.name === s.name));
  if (!fresh.length) return;
  await db.insert(teamAgents).values(fresh.map((s) => ({ orgId: viewer.orgId, department: id, name: s.name, job: s.job, tools: s.tools, createdBy: viewer.personId })));
  await audit(db, { orgId: viewer.orgId, personId: viewer.personId, action: "team.add", target: id, detail: { department: id, specialists: fresh.map((s) => s.name) } });
}

export async function addSpecialist(db: Db, viewer: Member, input: SpecialistInput & { department: string }) {
  await mustAdd(db, viewer);
  const department = departmentSlug(input.department);
  if (!department) throw new TeamError("Say which department it belongs to.");
  const values = await clean(db, viewer.orgId, department, input);
  await db.insert(teamAgents).values({ orgId: viewer.orgId, department, ...values, createdBy: viewer.personId });
  await audit(db, { orgId: viewer.orgId, personId: viewer.personId, action: "team.add", target: `${department}/${values.name}`, detail: { department, tools: values.tools } });
}

export async function updateSpecialist(db: Db, viewer: Member, id: string, input: SpecialistInput) {
  const row = await mine(db, viewer, id);
  const values = await clean(db, viewer.orgId, row.department, input, id);
  await db.update(teamAgents).set(values).where(eq(teamAgents.id, id));
  await audit(db, { orgId: viewer.orgId, personId: viewer.personId, action: "team.update", target: `${row.department}/${values.name}`, detail: { change: "edit", jobChanged: values.job !== row.job, tools: values.tools, ...(values.name !== row.name ? { renamedFrom: row.name } : {}) } });
}

/** Switches a specialist off (the lead no longer sees it) or back on. */
export async function toggleSpecialist(db: Db, viewer: Member, id: string) {
  const row = await mine(db, viewer, id);
  await db.update(teamAgents).set({ enabled: !row.enabled }).where(eq(teamAgents.id, id));
  await audit(db, { orgId: viewer.orgId, personId: viewer.personId, action: "team.update", target: `${row.department}/${row.name}`, detail: { change: row.enabled ? "switch_off" : "switch_on" } });
}

export async function removeSpecialist(db: Db, viewer: Member, id: string) {
  const row = await mine(db, viewer, id);
  await db.delete(teamAgents).where(eq(teamAgents.id, id));
  await audit(db, { orgId: viewer.orgId, personId: viewer.personId, action: "team.remove", target: `${row.department}/${row.name}` });
}
