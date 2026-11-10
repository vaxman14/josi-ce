// "Send to my devices": this browser's device id and the calls to
// /api/device-transfers. The server contract lives in
// apps/api/src/http/deviceTransferRoutes.ts.
import { api, ApiError } from './api';

export const DEVICE_ID_PATTERN = /^[a-z]{2,8}-[0-9a-f]{8,64}$/;
const STORAGE_KEY = 'josi_transfer_device_id';

export interface TargetDevice { id: string; name: string; platform: string; lastSeenAt: string }
export interface TargetPerson { id: string; name: string }
export interface Targets { devices: TargetDevice[]; people: TargetPerson[]; maxBytes: number }
export interface Transfer {
  id: string; name: string; mediaType: string; size: number; state: string; createdAt: string;
  own: boolean; mine: boolean; from: string; fromDevice: string | null; to: string; toDevice: string | null;
}
export interface Inbox { transfers: Transfer[]; sent: Transfer[] }

/** web-<32 hex>. */
export function mintDeviceId(random: (bytes: Uint8Array) => Uint8Array = bytes => crypto.getRandomValues(bytes)): string {
  const bytes = random(new Uint8Array(16));
  return `web-${Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')}`;
}

/** A readable name such as "Chrome on Linux" from a user agent string. */
export function browserName(ua: string): string {
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\/|CriOS\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux|X11/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

/** The id kept for this browser profile. Falls back to a per-page id when storage is blocked. */
let fallbackId: string | null = null;
export function thisDeviceId(): string {
  try {
    const kept = window.localStorage.getItem(STORAGE_KEY);
    if (kept && DEVICE_ID_PATTERN.test(kept)) return kept;
    const id = mintDeviceId();
    window.localStorage.setItem(STORAGE_KEY, id);
    return id;
  } catch {
    fallbackId ??= mintDeviceId();
    return fallbackId;
  }
}

/** How the server's own PC service is labelled when it appears as a target. */
export function targetLabel(device: TargetDevice): string {
  return device.platform === 'linux' ? 'This server (Downloads folder)' : device.name;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const base = '/device-transfers';
const q = (id: string) => encodeURIComponent(id);

export const registerThisDevice = (id: string, name: string) => api.put<{ ok: boolean }>(`${base}/devices/${q(id)}`, { name, platform: 'web' });
export const loadTargets = (id: string) => api.get<Targets>(`${base}/devices?deviceId=${q(id)}`);
export const loadInbox = (id: string) => api.get<Inbox>(`${base}/inbox?deviceId=${q(id)}`);
export const acceptTransfer = (transferId: string, deviceId: string) => api.post(`${base}/${q(transferId)}/accept`, { deviceId });
export const declineTransfer = (transferId: string) => api.post(`${base}/${q(transferId)}/decline`);
export const markReceived = (transferId: string, deviceId: string) => api.post(`${base}/${q(transferId)}/received`, { deviceId });

export function sendFile(file: File, target: { device: string } | { person: string }, fromDevice: string): Promise<{ id: string; state: string }> {
  const form = new FormData();
  form.append('file', file);
  const to = 'device' in target ? `toDevice=${q(target.device)}` : `toUser=${q(target.person)}`;
  return api.upload(`${base}?${to}&fromDevice=${q(fromDevice)}`, form);
}

/** The file name from a Content-Disposition header (RFC 5987 filename* first). */
export function dispositionName(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  if (star) { try { return decodeURIComponent(star[1]!.trim()); } catch { /* fall through */ } }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
  return plain ? plain[1]!.trim() : null;
}

/** Fetches the file and has the browser save it. Resolves once the save has been triggered. */
export async function downloadTransfer(transfer: Transfer, deviceId: string): Promise<void> {
  const res = await fetch(`/api${base}/${q(transfer.id)}/content?deviceId=${q(deviceId)}`, { credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: string } | null;
    throw new ApiError(res.status, body?.error ?? `Request failed (${res.status})`, body);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = dispositionName(res.headers.get('Content-Disposition')) ?? transfer.name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
