// Copy text, on every address Josi is opened at.
//
// Browsers only offer navigator.clipboard on HTTPS and localhost. A Linux
// server opened over plain http://10.10.1.x:8080 has none, and the old
// `navigator.clipboard?.writeText` skipped the copy without a word. So: the
// modern API when it exists and works, else a hidden textarea and the older
// copy command, and a thrown error when both fail so the page can say so.

export async function copyText(value: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(value); return; } catch { /* fall back below */ }
  }
  const field = document.createElement('textarea');
  field.value = value;
  field.setAttribute('readonly', '');
  field.setAttribute('aria-hidden', 'true');
  field.style.position = 'fixed';
  field.style.top = '0';
  field.style.left = '0';
  field.style.width = '1px';
  field.style.height = '1px';
  field.style.opacity = '0';
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  document.body.appendChild(field);
  let copied = false;
  try {
    field.focus();
    field.select();
    field.setSelectionRange(0, value.length);
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  } finally {
    field.remove();
    focused?.focus();
  }
  if (!copied) throw new Error('This browser would not copy it. Select the text and copy it by hand.');
}
