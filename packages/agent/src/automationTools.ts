import { AutomationRuntime, parseAutomationToolAction, listAutomationPresence, type Db, type AutomationExecutionContext } from '@josi-ce/core';
import type { ToolExecutionContext } from './execute.js';
import type { ToolSpec } from './tools.js';

const id = { type: 'string', format: 'uuid' };
const properties = { task_id: id, workspace_id: id, observation_id: id };
const browser = { browserProfileId: id, tabId: id };
const desktop = { appId: id, windowId: id };
const shape = (fields: Record<string, unknown>) => ({ type: 'object', properties: fields, required: Object.keys(fields), additionalProperties: false });
const literal = (value: string) => ({ type: 'string', const: value });
export const AUTOMATION_DISCOVERY_TOOL: ToolSpec = { def: {
  name: 'get_automation_workspaces',
  description: 'Read the actual status of the owner’s separate Josi automation desktops and dedicated browsers. Ordinary client connections and personal browser windows are not automation workspaces. An unavailable service means no control is connected; never claim a browser opened or work ran from this discovery alone.',
  parameters: shape({}),
}, actionClass: null };
export const AUTOMATION_RECEIPT_TOOL: ToolSpec = { def: {
  name: 'get_automation_receipt',
  description: 'Read the current saved receipt of an automation operation in this owned conversation. This does not repeat it, settle an uncertain outcome or grant control. Reconcile unknown outcomes with actual destination evidence; a new model assertion cannot turn uncertainty into success.',
  parameters: shape({ reservation_id: id }),
}, actionClass: null };
export const AUTOMATION_CONTROL_TOOLS: ToolSpec[] = [
  { def: { name: 'start_automation_task',
    description: 'Attach a separate-desktop work task to the selected unfinished step of this conversation’s current goal. Call after owning and reviewing the goal and discovering a ready workspace. The same step retains one original task across turns; do not create replacement steps or tasks to evade an uncertain result or limit. This records work only and grants no browser, computer or transmission permission. Use its returned taskId for connection and operations.',
    parameters: shape({ goal_id: id, revision: { type: 'integer', minimum: 1 }, step_id: id, workspace_id: id }) }, actionClass: 'automation_control' },
  { def: { name: 'connect_automation_workspace',
    description: 'Request control of a discovered isolated workspace for an existing active task. Requires current device-owner consent, permission policy and durable turn. Cannot resume human takeover, widen access or authorize an action. The connection may be refused; report the exact next setup/permission instruction.',
    parameters: shape({ task_id: id, workspace_id: id }) }, actionClass: 'automation_control' },
  { def: { name: 'observe_automation_workspace',
    description: 'Capture an initial or refreshed observation of the locally selected permitted application or browser in a connected isolated workspace. Use null for previous_observation_id on its first capture; a refresh names the preceding observation returned for this control session. Requires current control and read permission. Returns a saved capture receipt and opaque observation reference only; it does not expose screen contents to the model, grant input permission or prove a business outcome. Do not claim to see page or app content from this receipt.',
    parameters: shape({ task_id: id, workspace_id: id, control_session_id: id,
      previous_observation_id: { anyOf: [id, { type: 'null' }] },
      surface: { type: 'string', enum: ['browser', 'desktop'] } }) }, actionClass: 'automation_control' },
  { def: { name: 'browser_control',
    description: 'Request one bounded browser operation using a current native observation and opaque profile/tab/element references. Works only in a dedicated Josi workspace. Actual effects and current permissions are verified before dispatch. A lost or uncertain receipt is never permission to retry. Fill uses an authorized value reference, never a raw secret. An input receipt does not verify the user’s business outcome.',
    parameters: shape({ ...properties, action: { oneOf: [
      shape({ kind: literal('browser.observe'), ...browser }),
      shape({ kind: literal('browser.navigate'), ...browser, url: { type: 'string', maxLength: 8192 } }),
      shape({ kind: literal('browser.element'), ...browser, elementId: id, action: literal('click') }),
      shape({ kind: literal('browser.element'), ...browser, elementId: id, action: literal('fill'), valueReference: id }),
    ] } }) }, actionClass: 'automation_control' },
  { def: { name: 'computer_control',
    description: 'Request one bounded native operation inside the separate Josi desktop using current observed app/window/element references. Never targets the user’s normal desktop. Unknown effects, changed targets, missing consent or permissions refuse input. Observation content needs its own authorized projection. Do not turn an input receipt into a completed goal.',
    parameters: shape({ ...properties, action: { oneOf: [
      shape({ kind: literal('desktop.observe'), ...desktop }),
      shape({ kind: literal('desktop.element'), ...desktop, elementId: id, action: literal('press') }),
      shape({ kind: literal('desktop.element'), ...desktop, elementId: id, action: literal('focus') }),
      shape({ kind: literal('desktop.pointer'), ...desktop, action: literal('click'), x: { type: 'number', minimum: 0, maximum: 32768 }, y: { type: 'number', minimum: 0, maximum: 32768 } }),
    ] } }) }, actionClass: 'automation_control' },
];
export const AUTOMATION_TOOL_NAMES = new Set([AUTOMATION_DISCOVERY_TOOL, AUTOMATION_RECEIPT_TOOL, ...AUTOMATION_CONTROL_TOOLS].map(tool => tool.def.name));
export async function automationDiscovery(runtime: AutomationRuntime | undefined, ownerUserId: string, db?: Db) {
  if (!runtime) return { available: !!db, workspaces: db ? await listAutomationPresence(db, ownerUserId) : [],
    controlAvailable: false, reason: 'These are recent isolated-desktop connection reports. Execution is not connected; no local consent or permission is granted by presence.' };
  return { available: true, workspaces: await runtime.inventory(ownerUserId),
    controlAvailable: runtime.actionAvailable, inspectionAvailable: runtime.observationAvailable,
    reason: 'Discovery describes current connections. Every operation still requires its current target, consent and permission checks.' };
}
export async function automationToolAvailability(runtime: AutomationRuntime | undefined, ownerUserId: string): Promise<ToolSpec[]> {
  if (!runtime) return [];
  try {
    const ready = (await runtime.inventory(ownerUserId)).filter(workspace => workspace.state === 'ready');
    if (!ready.length) return [];
    return AUTOMATION_CONTROL_TOOLS.filter(tool => tool.def.name === 'start_automation_task'
        && ready.some(workspace => workspace.computerUse || workspace.browserFamilies.length)
      || tool.def.name === 'connect_automation_workspace'
      || tool.def.name === 'observe_automation_workspace' && runtime.observationAvailable
        && ready.some(workspace => workspace.computerUse || workspace.browserFamilies.length)
      || tool.def.name === 'browser_control' && runtime.actionAvailable && ready.some(workspace => workspace.browserFamilies.length)
      || tool.def.name === 'computer_control' && runtime.actionAvailable && ready.some(workspace => workspace.computerUse));
  } catch { return []; }
}
export async function executeAutomationTool(ctx: ToolExecutionContext, name: string, input: Record<string, unknown>, db?: Db) {
  if (name === 'get_automation_workspaces') return automationDiscovery(ctx.automationRuntime, ctx.userId, db);
  if (!ctx.automationRuntime) return { ok: false, code: 'automation_unavailable',
    message: 'Authenticated isolated-device control is not connected on this execution surface.' };
  if (name === 'get_automation_receipt') {
    if (!ctx.threadId || Object.keys(input).join(',') !== 'reservation_id') throw new Error('Choose this conversation’s exact automation receipt.');
    return ctx.automationRuntime.receipt(ctx.userId, ctx.threadId, String(input.reservation_id));
  }
  if (!ctx.threadId || !ctx.durableTurnId || !ctx.durableLeaseToken || ctx.workMemoryVersion === undefined) {
    return { ok: false, code: 'durable_automation_required', message: 'Automation requires a current durable task turn. Continue from Josi’s task manager.' };
  }
  const context: AutomationExecutionContext = { ownerUserId: ctx.userId, threadId: ctx.threadId,
    turnId: ctx.durableTurnId, leaseToken: ctx.durableLeaseToken, workMemoryVersion: ctx.workMemoryVersion };
  if (name === 'start_automation_task') {
    if (Object.keys(input).sort().join(',') !== 'goal_id,revision,step_id,workspace_id') throw new Error('Choose the exact goal, step, revision and workspace.');
    return ctx.automationRuntime.startTask(context, { goalId: String(input.goal_id), revision: input.revision as number,
      stepId: String(input.step_id), workspaceId: String(input.workspace_id) });
  }
  if (name === 'connect_automation_workspace') {
    if (Object.keys(input).sort().join(',') !== 'task_id,workspace_id') throw new Error('Choose an exact task and workspace.');
    return ctx.automationRuntime.acquire(context, String(input.task_id), String(input.workspace_id));
  }
  if (name === 'observe_automation_workspace') {
    if (Object.keys(input).sort().join(',') !== 'control_session_id,previous_observation_id,surface,task_id,workspace_id'
      || input.previous_observation_id !== null && typeof input.previous_observation_id !== 'string'
      || !['browser', 'desktop'].includes(String(input.surface))) throw new Error('Choose the current control session and exact observation surface.');
    const result = await ctx.automationRuntime.observe(context, { taskId: String(input.task_id), workspaceId: String(input.workspace_id),
      controlSessionId: String(input.control_session_id), surface: input.surface as 'browser' | 'desktop',
      previousObservationId: input.previous_observation_id as string | null });
    return { ...result, observationId: result.status === 'succeeded' ? result.reservation.effectIdentity : null,
      contentProjected: false };
  }
  if (!['browser_control', 'computer_control'].includes(name)
    || Object.keys(input).sort().join(',') !== 'action,observation_id,task_id,workspace_id') throw new Error('Choose a supported exact automation operation.');
  const action = parseAutomationToolAction(input.action);
  if (action.kind.startsWith('browser.') !== (name === 'browser_control')) throw new Error('Use the correct browser or desktop tool.');
  return ctx.automationRuntime.execute(context, { taskId: String(input.task_id), workspaceId: String(input.workspace_id),
    observationId: String(input.observation_id), action });
}
