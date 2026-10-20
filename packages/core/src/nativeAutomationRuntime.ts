import { randomUUID } from 'node:crypto';
import { prepareNativeModelProjection } from './nativeModelProjection.js';
import type { Db } from './db.js';
import type { MasterKey } from './masterKey.js';
import { Secret } from './sealing.js';
import { vaultRecords } from './vault.js';
import { listAutomationPresence } from './automationPresence.js';
import { cardinalContentDigest } from './cardinalRules.js';
import { AutomationRuntime, AutomationRuntimeRefusal, automationIntentDigest, type PreparedAutomationOperation } from './automationRuntime.js';
import type { AutomationReservationProofPort } from './automationReservations.js';
import { NativeTransportError, type NativeObservationPayload } from './nativeAutomationTransport.js';
import { isBrowserApplication } from './nativeBrowserObservation.js';

/** Shared by API and worker. The database carries Vault-authenticated bounded
 * delivery records; only the live native API boundary can issue a permit.
 * This first adapter classifies AX inspection only, never generic input. */
export function createNativeInspectionRuntime(db: Db, master: MasterKey): AutomationRuntime {
  const records = vaultRecords(db, master);
  const transport = records.nativeAutomation({ requireNativeConnection: async () => {
    throw new NativeTransportError('Native permits require the current hardware-authenticated API connection.');
  } });
  const proofs: AutomationReservationProofPort = {
    verifyDispatch: async (tx, context, proof) => {
      if ((proof as { phase?: unknown })?.phase === 'prepared') return transport.verifyPrepared(tx, context, proof);
      if ((proof as { phase?: unknown })?.phase === 'model-send') return transport.sendProjection(tx, context, proof);
      if ((proof as { phase?: unknown })?.phase === 'queue') return transport.enqueue(tx, context, proof);
      throw new NativeTransportError('Use the native API for the final guest permit.');
    },
    verifyOutcome: (tx, context, proof) => transport.verifyOutcome(tx, context, proof),
  };
  const reservations = records.automationReservations(proofs);
  return new AutomationRuntime(db, master, {
    ...proofs, actionsAvailable: true,
    prepareModelProjection: (context, captureId) => prepareNativeModelProjection(db, master, transport, reservations, context, captureId),
    inventory: async (owner, signal) => {
      const reports = await listAutomationPresence(db, owner);
      for (const report of reports) {
        if (signal.aborted) throw new NativeTransportError('Discovery ended.');
        try {
          const current = await transport.current(owner, report.identity.workspaceId);
          if (report.state !== 'offline' && current.leaseUntilMs > Date.now()) {
            report.state = 'ready'; report.computerUse = !current.browser;
            report.browserFamilies = current.browser ? [current.browser.family] : [];
          }
        } catch { /* Presence alone cannot advertise inspection. */ }
      }
      return reports;
    },
    acquire: async (context, taskId, workspaceId, signal) => {
      if (signal.aborted) throw new NativeTransportError('Control acquisition ended.');
      const control = await transport.acquire(context.ownerUserId, workspaceId, taskId);
      if (!control.holder || signal.aborted) throw new NativeTransportError('Control acquisition ended.');
      return { identity: control.identity, taskId, controlSessionId: control.holder.controlSessionId, expiresAtMs: control.leaseUntilMs };
    },
    prepare: async (context, request, signal): Promise<PreparedAutomationOperation> => {
      const action = request.action;
      if (action.kind !== 'browser.draft' && action.kind !== 'browser.photo') throw new AutomationRuntimeRefusal('unclassified_effect');
      const source = await transport.result(context.ownerUserId, action.sourceReservationId);
      const c = await transport.current(context.ownerUserId, request.workspaceId);
      if (signal.aborted || !source || source.payload.command.operation !== 'observe'
        || source.result?.outcome !== 'succeeded' || source.result.observationId !== request.observationId
        || source.result.windowId !== action.tabId || source.payload.command.taskId !== request.taskId
        || source.payload.command.workspaceId !== request.workspaceId
        || !c.browser || c.browser.family !== 'chrome' || action.browserProfileId !== c.browser.profileId
        || c.holder?.taskId !== request.taskId || c.holder.controlSessionId !== source.payload.command.sessionId
        || !source.payload.command.browser) throw new AutomationRuntimeRefusal('target_changed');
      const expiresAtMs = c.leaseUntilMs - 500;
      if (expiresAtMs - Date.now() < 4000) throw new AutomationRuntimeRefusal('connection_refreshing');
      const { photo: _photo, windowId: _window, ...sourceCommand } = source.payload.command;
      const payload: NativeObservationPayload = { ...source.payload,
        purpose: action.kind === 'browser.photo' ? 'josi-native-observation' : 'josi-native-draft',
        command: { ...sourceCommand, id: randomUUID(), operation: action.kind === 'browser.photo' ? 'observe' : 'draft', expiresAtMs,
          observationId: request.observationId, resultObservationId: randomUUID(), windowId: action.tabId,
          ...(action.kind === 'browser.photo'
            ? { maxOutputBytes: 65536, photo: { sourceReservationId: action.sourceReservationId, elementId: action.elementId } }
            : { elementId: action.elementId, maxOutputBytes: Buffer.byteLength(action.text),
              draft: { sourceReservationId: action.sourceReservationId, text: action.text } }) } };
      // One input attempt for this capture, including after timeout/restart.
      const h = cardinalContentDigest({ purpose: 'native-browser-input.1', taskId: request.taskId, observationId: request.observationId });
      const effectIdentity = `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
      return { identity: c.identity, observationId: request.observationId,
        effectIdentity: action.kind === 'browser.photo' ? payload.command.resultObservationId : effectIdentity,
        intentDigest: automationIntentDigest(request), effectCoverage: 'verified',
        effects: [{ action: action.kind === 'browser.photo' ? 'browser.observe' : 'browser.fill',
          target: { kind: 'browser', browser: 'chrome', profileId: c.browser.profileId,
          origin: payload.command.browser!.origin }, bytes: payload.command.maxOutputBytes }],
        expected: { permissions: c.permissions, cardinal: c.cardinal }, expiresAtMs,
        payload: new Secret(JSON.stringify(payload)), dispatchProof: { phase: 'prepared', commandId: payload.command.id } };
    },
    prepareObservation: async (context, request, signal): Promise<PreparedAutomationOperation> => {
      if (signal.aborted) throw new AutomationRuntimeRefusal('device_offline');
      const c = await transport.current(context.ownerUserId, request.workspaceId);
      if (request.surface === 'browser' ? !c.browser || !request.browserOrigin : c.browser || isBrowserApplication(c.application.bundleId)) {
        throw new AutomationRuntimeRefusal('unclassified_effect');
      }
      const expiresAtMs = c.leaseUntilMs - 500;
      if (signal.aborted || c.holder?.taskId !== request.taskId || c.holder.controlSessionId !== request.controlSessionId) {
        throw new AutomationRuntimeRefusal('local_consent_required');
      }
      if (expiresAtMs - Date.now() < 5000) throw new AutomationRuntimeRefusal('connection_refreshing');
      const observationId = randomUUID();
      const payload: NativeObservationPayload = { purpose: 'josi-native-observation', schemaVersion: 1,
        storageSessionId: c.storageSessionId, consent: c.consent, targetReference: c.targetReference,
        guestBootId: c.guestBootId, guestChannelId: c.guestChannelId, application: c.application,
        ...(c.browser ? { browser: c.browser } : {}),
        command: { id: randomUUID(), workspaceId: c.identity.workspaceId, appId: c.application.applicationId,
          installationRevision: c.application.installationRevision, taskId: request.taskId, sessionId: request.controlSessionId,
          generation: c.generation, expiresAtMs, operation: 'observe', observationId: request.previousObservationId,
          ...(c.browser ? { browser: { profileId: c.browser.profileId, family: c.browser.family, origin: request.browserOrigin! } } : {}),
          resultObservationId: observationId, maxOutputBytes: 64 * 1024 } };
      return { identity: c.identity, observationId, intentDigest: cardinalContentDigest(request), effects: [
        c.browser ? { action: 'browser.observe', target: { kind: 'browser', browser: c.browser.family,
          profileId: c.browser.profileId, origin: request.browserOrigin! }, bytes: payload.command.maxOutputBytes }
          : { action: 'computer.observe', target: { kind: 'application', applicationId: c.application.applicationId,
            installationRevision: c.application.installationRevision }, bytes: payload.command.maxOutputBytes },
      ], effectCoverage: 'verified', expected: { permissions: c.permissions, cardinal: c.cardinal }, expiresAtMs,
      payload: new Secret(JSON.stringify(payload)), dispatchProof: { phase: 'prepared', commandId: payload.command.id } };
    },
    dispatch: async (reservationId, prepared, signal) => {
      const payload = JSON.parse(prepared.payload.reveal()) as NativeObservationPayload;
      if (signal.aborted) throw new NativeTransportError('Delivery ended.');
      await reservations.confirmNativeDispatch(prepared.identity.userId, reservationId, { phase: 'queue', commandId: payload.command.id });
      while (!signal.aborted && Date.now() < prepared.expiresAtMs) {
        const delivery = await transport.result(prepared.identity.userId, reservationId);
        if (delivery?.result) return { outcome: delivery.result.outcome, evidenceIds: [delivery.result.evidenceId],
          proof: { phase: 'native-result', reservationId } };
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
          const timer = setTimeout(done, 200); timer.unref();
          signal.addEventListener('abort', done, { once: true });
          if (signal.aborted) done();
        });
      }
      throw new NativeTransportError('The native delivery outcome could not be confirmed. Do not resend it.');
    },
  });
}
