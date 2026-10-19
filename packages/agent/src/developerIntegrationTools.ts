import { DeveloperCredentialError, loadDeveloperCredentials, recordDeveloperCheck } from '@josi-ce/connectors';
import { VaultError, type Db, type MasterKey } from "@josi-ce/core";
import {
  discoverObsidianVaults,
  readObsidianNote,
  describeDeveloperService,
  isDeveloperService,
  listDeveloperResources,
} from "@josi-ce/connectors";
import type { ToolSpec } from "./tools.js";

export const DEVELOPER_INTEGRATION_TOOL = "list_native_integrations";
export const DEVELOPER_INTEGRATION_TOOLS: ToolSpec[] = [
  {
    def: {
      name: DEVELOPER_INTEGRATION_TOOL,
      description:
        "List this user’s connected native developer/productivity integrations, their provider identity, health, and supported capability summary. Read-only; never returns credentials.",
      parameters: { type: "object", properties: {} },
    },
    actionClass: null,
  },
  {
    def: {
      name: "list_native_resources",
      description:
        "List up to 25 resources from one connected native provider using that provider’s fixed read-only API (repositories, projects, sites, accounts, services, organizations, or shared Notion pages).",
      parameters: {
        type: "object",
        properties: { provider: { type: "string" } },
        required: ["provider"],
      },
    },
    actionClass: null,
  },
];

export async function developerIntegrationToolAvailability(
  db: Db,
  userId: string,
): Promise<ToolSpec[]> {
  const [row] = await db.query<{ n: number }>(
    `select count(*)::int n from developer_connections where owner_user_id=$1`,
    [userId],
  );
  const [user] = await db.query<{ role: string }>(
    `select role from users where id=$1`,
    [userId],
  );
  return [
    ...((row?.n ?? 0) > 0 ? DEVELOPER_INTEGRATION_TOOLS : []),
    ...(user?.role === "super_admin" ? OBSIDIAN_TOOLS : []),
  ];
}

export async function executeDeveloperIntegrationTool(db: Db, userId: string) {
  const rows = await db.query<{
    service: string;
    account_label: string | null;
    status: string;
    last_check_at: string | null;
    last_check_ok: boolean | null;
    last_error: string | null;
    last_used_at: string | null;
  }>(
    `select service,account_label,status,last_check_at,last_check_ok,last_error,last_used_at from developer_connections where owner_user_id=$1 order by service`,
    [userId],
  );
  return {
    ok: true,
    integrations: rows.map((row) => {
      const descriptor = describeDeveloperService(row.service);
      return {
        provider: row.service,
        label: descriptor?.label ?? row.service,
        account: row.account_label,
        status: row.status,
        last_checked_at: row.last_check_at,
        last_used_at: row.last_used_at,
        healthy: row.last_check_ok,
        problem: row.last_error,
        capability:
          descriptor?.capability ?? "Provider connection status only.",
      };
    }),
  };
}

export async function executeDeveloperResourceTool(
  db: Db,
  userId: string,
  input: Record<string, unknown>,
  access: { masterKey: () => MasterKey; fetchImpl?: typeof fetch },
) {
  const service = String(input.provider ?? "");
  if (!isDeveloperService(service))
    return { ok: false, message: "Choose a supported native provider." };
  let prepared;
  try {
    prepared = await loadDeveloperCredentials(db, access.masterKey(), { ownerUserId: userId, service });
  } catch (error) {
    if (error instanceof VaultError || error instanceof DeveloperCredentialError) return { ok: false, message: error.message };
    return { ok: false, message: 'The connection credentials are unavailable.' };
  }
  try {
    const resources = await listDeveloperResources({ service, ...prepared.credentials, fetchImpl: access.fetchImpl });
    const recorded = await recordDeveloperCheck(db, { ownerUserId: userId, service, reference: prepared.reference,
      check: { ok: true, detail: 'Resource discovery completed.' }, used: true, preserveStatus: true });
    if (!recorded) return { ok: false, message: 'The connection or its permission changed during discovery. Reload it before continuing.' };
    return { ok: true, provider: service, resources };
  } catch {
    await recordDeveloperCheck(db, { ownerUserId: userId, service, reference: prepared.reference,
      check: { ok: false, detail: 'Resource discovery failed.' }, preserveStatus: true });
    return { ok: false, provider: service, message: 'Resource discovery failed. Recheck the provider credential and permissions.' };
  }
}

export const OBSIDIAN_TOOLS: ToolSpec[] = [
  {
    def: {
      name: "list_obsidian_vaults",
      description:
        "Discover native Obsidian vaults beneath the installer workspace. Administrator only; no Sync credentials.",
      parameters: { type: "object", properties: {} },
    },
    actionClass: null,
  },
  {
    def: {
      name: "read_obsidian_note",
      description:
        "Read a Markdown note inside an Obsidian workspace vault. Administrator only; never modifies Markdown, attachments or configuration.",
      parameters: {
        type: "object",
        properties: { vault: { type: "string" }, note: { type: "string" } },
        required: ["vault", "note"],
      },
    },
    actionClass: null,
  },
];
export async function executeObsidianTool(
  db: Db,
  userId: string,
  name: string,
  input: Record<string, unknown>,
) {
  const [user] = await db.query<{ role: string }>(
    `select role from users where id=$1`,
    [userId],
  );
  if (user?.role !== "super_admin")
    return {
      ok: false,
      message: "Workspace vault access requires an administrator.",
    };
  try {
    const root = process.env.JOSI_WORKSPACE_ROOT || "/workspace";
    return name === "list_obsidian_vaults"
      ? { ok: true, vaults: await discoverObsidianVaults(root) }
      : {
          ok: true,
          ...(await readObsidianNote(
            root,
            String(input.vault ?? ""),
            String(input.note ?? ""),
          )),
        };
  } catch {
    return {
      ok: false,
      message: "The workspace vault or Markdown note is unavailable.",
    };
  }
}
