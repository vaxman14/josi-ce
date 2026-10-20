export { createDeviceControlGate, type DeviceControlPorts, type DeviceConsent,
  type DeviceAuthority, type VerifiedDeviceCommand, type DeviceControlState, type DeviceDispatchReceipt } from './deviceControl.js';
export { createProtectedConfirmationBroker, verifyProtectedControlSignature, type ProtectedConfirmationPorts, type ProtectedConfirmationResult } from './protectedConfirmation.js';
export { createBrowserWorkspaceBridge, type BrowserWorkspaceSession, type BrowserWorkspacePorts,
  type BrowserWorkspaceCommand, type BrowserWorkspaceResult, type BrowserFamily, type BrowserActualTarget } from './browserWorkspace.js';
