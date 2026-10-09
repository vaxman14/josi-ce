import { nativeMac, macScannerHealth } from './macosScanner.js';
import { constants } from 'node:fs';
import { dirname } from 'node:path';
import { resolveDataPath } from '@josi-ce/core';
import { openStorageFile, pinWindowsDirectory } from './windowsFiles.js';

export interface NativeScannerHealth {
  provider: 'windows-amsi' | 'configured-local-scanner';
  required?: boolean;
  enforced?: boolean;
  status: 'available' | 'error' | 'unavailable';
  checkedAt: string | null;
}

/** Only a recent successful explicit probe establishes availability. This is
 * not a clean verdict for any user document, nor a real-time-protection guess.
 */
export async function nativeScannerHealth(): Promise<NativeScannerHealth> {
  if (nativeMac()) return macScannerHealth();
  const unavailable: NativeScannerHealth = { provider: 'windows-amsi', status: 'unavailable', checkedAt: null };
  if (process.platform !== 'win32' || process.env.JOSI_NATIVE_RUNTIME !== '1') return unavailable;
  let held, file;
  try {
    const path = resolveDataPath('/data/state/antivirus.json');
    held = pinWindowsDirectory(dirname(path));
    file = await openStorageFile(path, constants.O_RDONLY);
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 4096) return unavailable;
    const bytes = Buffer.alloc(4097);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 4096) return unavailable;
    const record = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
    if (Object.keys(record).sort().join(',') !== 'checkedAt,provider,status' || record.provider !== 'windows-amsi'
      || !['available', 'error', 'unavailable'].includes(record.status) || typeof record.checkedAt !== 'string') return unavailable;
    const age = Date.now() - Date.parse(record.checkedAt);
    if (!Number.isFinite(age) || age < -60_000 || age > 15 * 60_000) return unavailable;
    return record;
  } catch { return unavailable; }
  finally { await file?.close(); await held?.close(); }
}
