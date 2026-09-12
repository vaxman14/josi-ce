/** Fetch audio with the same session/CSRF contract as the normal JSON API. */
export async function fetchVoiceAudio(path: string, body: unknown, signal?: AbortSignal): Promise<ArrayBuffer> {
  const token = /(?:^|;\s*)josi_csrf=([^;]+)/.exec(document.cookie)?.[1];
  const response = await fetch(`/api${path}`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
    headers: { 'Content-Type': 'application/json', ...(token ? { 'x-josi-csrf': decodeURIComponent(token) } : {}) },
    body: JSON.stringify(body) });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(error?.error ?? 'Voice audio could not be loaded');
  }
  return response.arrayBuffer();
}

export function speechChunks(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining) {
    let end = Math.min(400, remaining.length);
    if (end < remaining.length) {
      const sentence = remaining.slice(0, end).search(/[.!?][^.!?]*$/);
      end = sentence > 100 ? sentence + 1 : remaining.lastIndexOf(' ', end);
      if (end <= 0) end = 400;
    }
    chunks.push(remaining.slice(0, end));
    remaining = remaining.slice(end).trimStart();
  }
  return chunks;
}
