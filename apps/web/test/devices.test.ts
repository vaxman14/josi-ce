import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), upload: vi.fn() },
  ApiError: class ApiError extends Error { constructor(readonly status: number, message: string, readonly body?: unknown) { super(message); } },
}));

import { browserName, DEVICE_ID_PATTERN, dispositionName, formatSize, mintDeviceId, targetLabel } from '../src/lib/devices';

describe('device helpers', () => {
  it('mints ids the server accepts', () => {
    const id = mintDeviceId();
    expect(id).toMatch(DEVICE_ID_PATTERN);
    expect(id.startsWith('web-')).toBe(true);
    expect(mintDeviceId()).not.toBe(id);
  });

  it('names the browser from a user agent', () => {
    expect(browserName('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36')).toBe('Chrome on Linux');
    expect(browserName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0 Safari/537.36 Edg/126.0')).toBe('Edge on Windows');
    expect(browserName('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Version/17.0 Safari/605.1.15')).toBe('Safari on macOS');
    expect(browserName('Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0')).toBe('Firefox on Linux');
    expect(browserName('')).toBe('Browser');
  });

  it('labels the server and reads download names', () => {
    expect(targetLabel({ id: 'linux-aaaaaaaa', name: 'host', platform: 'linux', lastSeenAt: '' })).toBe('This server (Downloads folder)');
    expect(targetLabel({ id: 'web-aaaaaaaa', name: 'Phone', platform: 'web', lastSeenAt: '' })).toBe('Phone');
    expect(dispositionName("attachment; filename*=UTF-8''caf%C3%A9.txt")).toBe('café.txt');
    expect(dispositionName(null)).toBeNull();
    expect(formatSize(1536)).toBe('2 KB');
  });
});
