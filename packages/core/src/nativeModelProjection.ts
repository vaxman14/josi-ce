import { createHash, randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import type { MasterKey } from './masterKey.js';
import { Secret } from './sealing.js';
import { refuseMemorySecret } from './memorySafety.js';
import { vaultRecords } from './vault.js';
import type { AutomationExecutionContext, AutomationModelProjection } from './automationRuntime.js';
import type { AutomationReservationStore, AutomationReservationView } from './automationReservations.js';
import { sameAutomationIdentity } from './automationTargets.js';
import type { NativeAutomationTransport, NativeObservationPayload } from './nativeAutomationTransport.js';
import { nativeProjectionRecipient, openNativeProjection } from './nativeProjectionEnvelope.js';

/** Called by the trusted assistant loop, never an LLM tool or HTTP body.
 * Export and actual provider transmission have separate one-use fences. */
export async function prepareNativeModelProjection(db: Db, master: MasterKey, transport: NativeAutomationTransport,
  reservations: AutomationReservationStore, context: Readonly<AutomationExecutionContext>,
  captureReservationId: string): Promise<AutomationModelProjection> {
  const actor = context.ownerUserId, capture = await transport.result(actor, captureReservationId);
  if (!capture || capture.payload.command.operation !== 'observe' || capture.result?.outcome !== 'succeeded') {
    throw new Error('The original captured observation is unavailable.');
  }
  const source = capture.payload, control = await transport.current(actor, source.command.workspaceId);
  if (control.holder?.taskId !== source.command.taskId || control.holder.controlSessionId !== source.command.sessionId) {
    throw new Error('The original isolated task no longer controls this desktop.');
  }
  const targets = await vaultRecords(db, master).automationTargets({
    verifyFreshAdministrator: async () => { throw new Error('Use protected target administration.'); },
    verifyProtectedHuman: async () => { throw new Error('Use protected target administration.'); },
  }).inventory(actor);
  const candidates = targets.models.filter(m => sameAutomationIdentity(m.identity, control.identity) && m.candidate.role === 'primary');
  // Old registered configurations may remain in the Vault history. Compare
  // the current destination through the canonical resolver before dispatch.
  const current = await db.query<{ updated_at: string; provider: string; model: string }>(
    "select updated_at::text as updated_at,provider,model from llm_providers where role='primary'");
  const matching = candidates.filter(m => m.candidate.configurationVersion === current[0]?.updated_at
    && m.candidate.providerId === current[0]?.provider && m.candidate.model === current[0]?.model);
  if (targets.reconciliationRequired || !targets.reference || matching.length !== 1) {
    throw new Error('Register the current primary model for this workspace and grant its exact model-transmission permission.');
  }
  const model = matching[0];
  if (['vertex_ai', 'ernie', 'openai_subscription', 'anthropic_subscription'].includes(model.candidate.providerId)) {
    throw new Error('This model needs a separate authenticated transport before it can receive desktop captures.');
  }
  const expiresAtMs = Math.min(control.leaseUntilMs - 500, source.command.expiresAtMs + 10_000);
  if (expiresAtMs < Date.now() + 4000) throw new Error('The captured observation or desktop lease is too close to expiry.');
  let recipient: ReturnType<typeof nativeProjectionRecipient> | null = nativeProjectionRecipient();
  const { photo: _photo, windowId: _window, ...sourceCommand } = source.command;
  const payload: NativeObservationPayload = { ...source, purpose: 'josi-native-projection',
    command: { ...sourceCommand, id: randomUUID(), operation: 'project', expiresAtMs,
      observationId: capture.result.observationId, resultObservationId: randomUUID(), windowId: capture.result.windowId!,
      projection: { sourceReservationId: captureReservationId, recipientPublicKey: recipient.publicKey,
        configurationId: model.configurationId, configurationRevision: model.configurationRevision, modelReference: targets.reference } } };
  let reservation: AutomationReservationView | null = null, marked = false, body: Secret | null = null;
  try {
    const reserved = await reservations.reserve({ actorUserId: actor, taskId: source.command.taskId,
      turnId: context.turnId, leaseToken: context.leaseToken, effectIdentity: payload.command.resultObservationId,
      proposalId: randomUUID(), identity: control.identity, effectCoverage: 'verified',
      effects: [{ action: 'model.transmit', target: { kind: 'model', configurationId: model.configurationId,
        configurationRevision: model.configurationRevision }, bytes: payload.command.maxOutputBytes }],
      expected: { permissions: control.permissions, cardinal: control.cardinal }, expiresAtMs, payload: new Secret(JSON.stringify(payload)) });
    reservation = reserved.reservation;
    if (!reserved.created) throw new Error('This projection cannot be replayed.');
    await reservations.markDispatched({ actorUserId: actor, id: reservation.id, turnId: context.turnId,
      leaseToken: context.leaseToken, proof: { phase: 'prepared', commandId: payload.command.id } });
    marked = true;
    await reservations.confirmNativeDispatch(actor, reservation.id, { phase: 'queue', commandId: payload.command.id });
    while (Date.now() < expiresAtMs) {
      const delivery = await transport.result(actor, reservation.id);
      if (delivery) {
        if (delivery.result?.outcome !== 'succeeded' || !delivery.projection) throw new Error('The guest did not release this projection.');
        const digest = createHash('sha256').update(JSON.stringify(payload.command)).digest('hex');
        body = openNativeProjection(recipient.privateKey, delivery.projection, `josi-native-projection.1\n${reservation.id}\n${digest}`);
        break;
      }
      await new Promise<void>(resolve => { const timer = setTimeout(resolve, 100); timer.unref(); });
    }
    if (!body || Date.now() >= expiresAtMs) throw new Error('The observation projection expired.');
    // The authenticated guest supplied this object, but content remains
    // untrusted and gets no authority to alter task, rules, tools or routing.
    if (refuseMemorySecret(body.reveal())) throw new Error('The capture contains a known sensitive value and cannot be projected.');
    const observation = JSON.parse(body.reveal());
    if (observation.id?.toLowerCase() !== source.command.resultObservationId
      || observation.workspaceId?.toLowerCase() !== source.command.workspaceId
      || observation.taskId?.toLowerCase() !== source.command.taskId || observation.sessionId?.toLowerCase() !== source.command.sessionId
      || observation.appId?.toLowerCase() !== source.command.appId || observation.windowId?.toLowerCase() !== capture.result.windowId
      || observation.generation !== source.command.generation || observation.untrustedContent !== true
      || observation.installationRevision !== source.command.installationRevision) throw new Error('The projected capture identity did not match.');
    recipient = null;
    const id = reservation.id;
    let ended = false, attempted = false;
    return {
      expectedPrimary: { providerId: model.candidate.providerId, model: model.candidate.model,
        configurationVersion: model.candidate.configurationVersion },
      content: () => {
        if (ended || !body || Date.now() >= expiresAtMs) throw new Error('This observation projection expired.');
        return body;
      },
      beforeDispatch: async () => {
        if (ended || attempted || !body) throw new Error('This observation projection cannot be sent again.');
        attempted = true;
        await reservations.confirmNativeDispatch(actor, id, { phase: 'model-send', reservationId: id });
      },
      finish: async success => {
        if (ended) return;
        ended = true; body = null;
        try {
          const receipt = await transport.finishProjection(actor, id, attempted ? success ? 'succeeded' : 'uncertain' : 'no_effect');
          await reservations.settle({ actorUserId: actor, id, outcome: receipt.outcome,
            evidenceIds: [receipt.evidenceId], proof: { phase: 'model-result', reservationId: id } });
        } catch { await reservations.recordDispatchUncertainty(actor, id).catch(() => {}); }
      },
    };
  } catch {
    body = null; recipient = null;
    if (reservation) {
      if (marked) await reservations.recordDispatchUncertainty(actor, reservation.id).catch(() => {});
      else await reservations.cancelBeforeDispatch(actor, reservation.id).catch(() => {});
    }
    throw new Error('Captured content was not sent to a model. Check the original capture, registered primary model, current local consent and model-transmission permission.');
  }
}
