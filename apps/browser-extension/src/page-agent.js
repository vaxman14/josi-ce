'use strict';
(() => {
  // A versioned marker in the extension's isolated world, never a DOM attribute
  // or a window.postMessage bridge a website could invoke.
  if (globalThis.__josiPageAgentV2) return;
  globalThis.__josiPageAgentV2 = true;
  const api = globalThis.browser ?? globalThis.chrome;
  let session = null, stopped = false, observation = null, revision = 0, acting = 0;
  let elements = new Map();
  const bump = () => { revision++; };
  const mutations = new MutationObserver(bump);
  mutations.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  for (const type of ['scroll', 'resize', 'input', 'change']) addEventListener(type, bump, true);
  // One photo may use up to 72 KB of JPEG (96 KB as base64); a photo reply
  // including the fresh page read stays under the host's frame size.
  const PHOTO_BASE64_LIMIT = 98304, OUTPUT_LIMIT = 163840, MAX_ELEMENTS = 300, MAX_WALK = 20000, UPLOAD_LIMIT = 8 * 1024 * 1024;
  const CANDIDATES = 'img,a[href],button,input,textarea,select,[role="button"],[role="link"],[role="option"],[role="checkbox"],[role="tab"],[draggable="true"],[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]';
  const tag = element => String(element?.tagName ?? '').toLowerCase();

  // Passwords and payment details are never read, listed or filled.
  const SENSITIVE_NAME = /card|cvv|cvc|ccnum|passw|ssn/i;
  function sensitive(element) {
    if (!element || typeof element.getAttribute !== 'function') return false;
    const type = String(element.getAttribute('type') ?? '').toLowerCase();
    const autocomplete = String(element.getAttribute('autocomplete') ?? '').toLowerCase().trim();
    if (tag(element) === 'input' && type === 'password') return true;
    if (/(^|\s)cc-/.test(autocomplete) || /(current|new)-password|one-time-code/.test(autocomplete)) return true;
    return ['name', 'id'].some(key => SENSITIVE_NAME.test(String(element.getAttribute(key) ?? '')));
  }

  // ---------------------------------------------------------------- finding
  /** Every candidate, including inside open shadow roots and same-origin
   * frames. Cross-origin frames are counted, not entered. */
  function collect() {
    const found = [], frames = { crossOrigin: 0 };
    let walked = 0;
    const visit = (root, frame) => {
      for (const element of root.querySelectorAll(CANDIDATES)) found.push({ element, frame });
      for (const element of root.querySelectorAll('*')) {
        if (++walked > MAX_WALK) return;
        if (element.shadowRoot) visit(element.shadowRoot, frame);
        if (tag(element) === 'iframe' || tag(element) === 'frame') {
          let inner = null;
          try { inner = element.contentDocument; } catch { inner = null; }
          if (inner?.documentElement) {
            const box = element.getBoundingClientRect();
            visit(inner, { x: (frame?.x ?? 0) + box.x + element.clientLeft, y: (frame?.y ?? 0) + box.y + element.clientTop, element });
          } else frames.crossOrigin++;
        }
      }
    };
    visit(document, null);
    return { found, frames };
  }
  const view = element => element.ownerDocument?.defaultView ?? globalThis;
  function rectOf(element, frame) {
    const r = element.getBoundingClientRect();
    return { x: r.x + (frame?.x ?? 0), y: r.y + (frame?.y ?? 0), width: r.width, height: r.height };
  }
  const visible = element => {
    const rect = element.getBoundingClientRect(), style = view(element).getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
      && !element.closest('[hidden],[inert],[aria-hidden="true"]');
  };
  const label = element => element.labels?.[0]?.textContent;
  const name = element => String(element.getAttribute('aria-label') || label(element)
    || element.getAttribute('title') || (tag(element) === 'select' ? '' : element.innerText) || element.getAttribute('placeholder') || element.getAttribute('name') || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const editable = element => element.isContentEditable && !['input', 'textarea'].includes(tag(element));
  const disabled = element => element.matches(':disabled,[aria-disabled="true"]');
  const options = element => [...element.options].slice(0, 40).map(o => String(o.text).replace(/\s+/g, ' ').trim().slice(0, 80));
  /** The property setter the page's own framework listens through. */
  function setValue(element, value) {
    for (let p = Object.getPrototypeOf(element); p; p = Object.getPrototypeOf(p)) {
      const d = Object.getOwnPropertyDescriptor(p, 'value');
      if (d?.set) { d.set.call(element, value); return; }
    }
    element.value = value;
  }
  const fire = (element, type) => element.dispatchEvent(new (view(element).Event)(type, { bubbles: true }));

  // ---------------------------------------------------------------- reading
  function observe(request, photo, photoCenter) {
    elements = new Map(); const nodes = [];
    const { found, frames } = collect();
    const listed = found.filter(c => !sensitive(c.element));
    if (photoCenter !== null) listed.sort((a, b) => Math.abs(rectOf(a.element, a.frame).y - photoCenter) - Math.abs(rectOf(b.element, b.frame).y - photoCenter));
    for (const { element, frame } of listed) {
      if (nodes.length >= MAX_ELEMENTS) break;
      if (!visible(element)) continue;
      const id = crypto.randomUUID(), rect = rectOf(element, frame), kind = tag(element);
      elements.set(id, { element, frame, name: name(element), ...rect });
      nodes.push({ id, role: element.getAttribute('role') || (editable(element) ? 'editor' : kind),
        name: kind === 'img' ? String(element.alt || name(element)).slice(0, 300) : name(element),
        inputType: kind === 'input' ? String(element.type) : null, disabled: disabled(element),
        ...(kind === 'textarea' ? { hasValue: element.value.length > 0 } : {}),
        ...(kind === 'select' ? { options: options(element), selected: String(element.selectedOptions?.[0]?.text ?? '').trim().slice(0, 80) } : {}),
        ...(frame ? { inFrame: true } : {}),
        bounds: rect });
    }
    observation = { id: crypto.randomUUID(), revision, url: location.href };
    const url = new URL(location.href);
    // No input values, cookies, storage, passwords or arbitrary JavaScript
    // evaluation. Text remains untrusted page data for the host to filter.
    const result = { kind: 'observation', observationId: observation.id, revision, title: document.title.slice(0, 300),
      url: url.origin + url.pathname, text: (document.body?.innerText ?? '').slice(0, 20000), elements: nodes,
      partial: listed.length > nodes.length, framesUnsupported: frames.crossOrigin > 0, crossOriginFrames: frames.crossOrigin,
      viewport: { width: innerWidth, height: innerHeight } };
    if (photo) result.photo = photo;
    if (request.maxOutputBytes !== undefined) {
      if (!Number.isSafeInteger(request.maxOutputBytes) || request.maxOutputBytes < 1024 || request.maxOutputBytes > OUTPUT_LIMIT) throw new Error('invalid_budget');
      const size = () => new TextEncoder().encode(JSON.stringify(result)).length;
      // Leave room for native tab identifiers. Trimming is explicit in the
      // result and never expands the server-reserved output ceiling.
      while (size() > request.maxOutputBytes - 128 && result.elements.length) {
        elements.delete(result.elements.pop().id); result.partial = true;
      }
      while (size() > request.maxOutputBytes - 128 && result.text.length) {
        result.text = result.text.slice(0, Math.floor(result.text.length * 0.75)); result.partial = true;
      }
      if (size() > request.maxOutputBytes - 128) throw new Error('output_budget');
    }
    return result;
  }
  async function picture(request) {
    const image = elements.get(request.elementId)?.element;
    if (tag(image) !== 'img' || !image.isConnected || !visible(image)) throw new Error('photo_unavailable');
    const expectedSource = image.currentSrc || image.src;
    // Pictures from another site (an image server) cannot be read as
    // pixels here; the background takes a screenshot of the shown area.
    const crossSite = new URL(expectedSource).origin !== location.origin || !!elements.get(request.elementId).frame;
    image.scrollIntoView({ block: 'center', behavior: 'instant' });
    if (!image.complete || !image.naturalWidth) {
      image.loading = 'eager';
      let timer;
      try { await Promise.race([image.decode(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('photo_load_timeout')), Math.max(1, Math.min(3000, request.expiresAt - Date.now() - 1500)));
      })]); } finally { clearTimeout(timer); }
    }
    if (stopped || session !== request.sessionId || Date.now() >= request.expiresAt || location.href !== request.expectedUrl
      || !image.isConnected || !image.complete || !image.naturalWidth || image.currentSrc !== expectedSource) throw new Error('photo_changed');
    // Lazy content and sticky bars can move the page after scrolling; a
    // screenshot crop needs the picture where it settles, so wait until two
    // measurements a moment apart agree (at most about a second).
    const frame = elements.get(request.elementId).frame;
    let bounds = rectOf(image, frame);
    for (let i = 0; i < 8; i++) {
      await new Promise(resolve => setTimeout(resolve, 120));
      const next = rectOf(image, frame);
      const settled = ['x', 'y', 'width', 'height'].every(k => Math.abs(next[k] - bounds[k]) < 1);
      bounds = next;
      if (settled) break;
    }
    if (stopped || session !== request.sessionId || Date.now() >= request.expiresAt || location.href !== request.expectedUrl) throw new Error('photo_changed');
    if (mutations.takeRecords().length) revision++;
    const center = bounds.y + bounds.height / 2;
    // The worker downloads a picture from another site itself (it has site
    // access), so the tab need not be showing; the screenshot is the fallback.
    if (crossSite) return { center, photo: { screenshot: true, source: /^https:/.test(expectedSource) ? expectedSource.slice(0, 2048) : null, alt: String(image.alt || '').slice(0, 300), untrustedContent: true,
      area: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, viewportWidth: innerWidth, viewportHeight: innerHeight } } };
    // Read already loaded pixels only. Drawing a cross-origin image fails
    // closed; this is not a fetch proxy or a path to arbitrary local files.
    let jpeg = '', width = 0, height = 0;
    for (const longest of [768, 512]) {
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, longest / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext('2d');
      context.fillStyle = 'white'; context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.8, 0.6, 0.4, 0.25]) {
        jpeg = canvas.toDataURL('image/jpeg', quality).split(',')[1];
        width = canvas.width; height = canvas.height;
        if (jpeg.length <= PHOTO_BASE64_LIMIT) break;
      }
      if (jpeg.length <= PHOTO_BASE64_LIMIT) break;
    }
    if (!jpeg || jpeg.length > PHOTO_BASE64_LIMIT) throw new Error('photo_budget');
    return { center, photo: { mediaType: 'image/jpeg', base64: jpeg, width, height, alt: String(image.alt || '').slice(0, 300), untrustedContent: true } };
  }

  // ---------------------------------------------------------------- acting
  function target(request, key = 'elementId') {
    const entry = elements.get(request[key]), element = entry?.element;
    if (!element?.isConnected || !visible(element) || disabled(element)) throw new Error('element_changed');
    const rect = rectOf(element, entry.frame);
    if (name(element) !== entry.name || ['x', 'y', 'width', 'height'].some(k => rect[k] !== entry[k])) throw new Error('element_changed');
    if (sensitive(element)) throw new Error('sensitive_field');
    return { element, frame: entry.frame, rect };
  }
  function fill(element, value) {
    if (typeof value !== 'string' || value.length > 16384) throw new Error('unsupported_field');
    if (editable(element)) {
      // Rich editors take text through the editing command, so their own
      // handlers (undo, autosave, mentions) see an ordinary insertion.
      element.focus();
      const doc = element.ownerDocument, selection = view(element).getSelection();
      const range = doc.createRange(); range.selectNodeContents(element);
      selection.removeAllRanges(); selection.addRange(range);
      if (!doc.execCommand('insertText', false, value)) { element.textContent = value; fire(element, 'input'); }
      if (!String(element.innerText ?? element.textContent).includes(value.trim().slice(0, 40))) throw new Error('fill_not_verified');
      return;
    }
    const kind = tag(element);
    if (!(kind === 'input' || kind === 'textarea')
      || (kind === 'input' && !['text', 'search', 'email', 'url', 'tel', 'number', ''].includes(String(element.getAttribute('type') ?? '').toLowerCase()))
      || element.readOnly) throw new Error('unsupported_field');
    setValue(element, value);
    fire(element, 'input'); fire(element, 'change');
  }
  function choose(element, wanted) {
    if (tag(element) !== 'select' || typeof wanted !== 'string' || !wanted.trim()) throw new Error('unsupported_field');
    const key = wanted.replace(/\s+/g, ' ').trim().toLowerCase();
    const all = [...element.options];
    const option = all.find(o => o.text.replace(/\s+/g, ' ').trim().toLowerCase() === key) ?? all.find(o => o.value.toLowerCase() === key)
      ?? (all.filter(o => o.text.toLowerCase().includes(key)).length === 1 ? all.find(o => o.text.toLowerCase().includes(key)) : undefined);
    if (!option || option.disabled) throw new Error('option_not_found');
    setValue(element, option.value);
    fire(element, 'input'); fire(element, 'change');
    if (element.value !== option.value) throw new Error('select_not_verified');
    return String(option.text).trim().slice(0, 80);
  }
  function drag(from, to) {
    // Pointer and mouse events for libraries that track the pointer, then the
    // HTML drag sequence for native drop targets. Untrusted events: the page
    // may ignore them, so the result always needs a fresh read.
    const point = r => ({ clientX: r.x + r.width / 2 - (from.frame?.x ?? 0), clientY: r.y + r.height / 2 - (from.frame?.y ?? 0) });
    const a = point(from.rect), b = point(to.rect), win = view(from.element);
    const pointer = (element, type, at) => element.dispatchEvent(new win.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, buttons: type === 'pointerup' ? 0 : 1, ...at }));
    const mouse = (element, type, at) => element.dispatchEvent(new win.MouseEvent(type, { bubbles: true, cancelable: true, buttons: type === 'mouseup' ? 0 : 1, ...at }));
    pointer(from.element, 'pointerdown', a); mouse(from.element, 'mousedown', a);
    for (let i = 1; i <= 8; i++) {
      const at = { clientX: a.clientX + (b.clientX - a.clientX) * i / 8, clientY: a.clientY + (b.clientY - a.clientY) * i / 8 };
      pointer(i < 8 ? from.element : to.element, 'pointermove', at); mouse(i < 8 ? from.element : to.element, 'mousemove', at);
    }
    pointer(to.element, 'pointerup', b); mouse(to.element, 'mouseup', b);
    const data = new win.DataTransfer();
    const dragEvent = (element, type, at) => element.dispatchEvent(new win.DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data, ...at }));
    dragEvent(from.element, 'dragstart', a); dragEvent(to.element, 'dragenter', b); dragEvent(to.element, 'dragover', b);
    dragEvent(to.element, 'drop', b); dragEvent(from.element, 'dragend', b);
  }
  function upload(element, file) {
    if (tag(element) !== 'input' || String(element.type).toLowerCase() !== 'file') throw new Error('not_a_file_field');
    if (!file || typeof file.base64 !== 'string' || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > UPLOAD_LIMIT) throw new Error('file_unavailable');
    const binary = atob(file.base64), bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    if (bytes.length !== file.size) throw new Error('file_unavailable');
    const win = view(element), data = new win.DataTransfer();
    data.items.add(new win.File([bytes], String(file.name).slice(0, 255), { type: String(file.mediaType).slice(0, 100) }));
    element.files = data.files;
    fire(element, 'input'); fire(element, 'change');
    if (element.files?.length !== 1 || element.files[0].size !== file.size) throw new Error('upload_not_verified');
  }

  // A person using the page while Josi acts takes over (the worker stops).
  // Only during Josi's own command and a moment after it, so reading the page
  // yourself between Josi's steps never ends the link.
  function stopForHuman(event) {
    if (!event.isTrusted || !session || !(acting > 0 || Date.now() < quietUntil)) return;
    stopped = true;
    void api.runtime.sendMessage({ kind: 'local_input', sessionId: session }).catch(() => {});
  }
  let quietUntil = 0;
  for (const type of ['pointerdown', 'keydown', 'wheel']) addEventListener(type, stopForHuman, true);

  api.runtime.onMessage.addListener((request, sender, respond) => {
    if (sender.id !== api.runtime.id || sender.tab || request?.channel !== 'josi-page' || request.version !== 1) return false;
    acting++;
    void (async () => {
    try {
      if (request.expectedUrl !== location.href || !Number.isSafeInteger(request.expiresAt) || Date.now() >= request.expiresAt) throw new Error('stale_target');
      if (request.sessionId !== session) { session = request.sessionId; stopped = false; observation = null; elements.clear(); }
      if (stopped) throw new Error('human_control');
      if (mutations.takeRecords().length) revision++;
      if (request.kind === 'observe') return observe(request, null, null);
      if (!observation || request.observationId !== observation.id || observation.revision !== revision
        || observation.url !== location.href) throw new Error('observation_changed');
      if (request.kind === 'photo') {
        const shot = await picture(request);
        return observe(request, shot.photo, shot.center);
      }
      if (request.kind === 'scroll') {
        if (request.direction !== 1 && request.direction !== -1) throw new Error('invalid_scroll');
        observation = null; elements.clear();
        scrollBy({ top: request.direction * Math.round(innerHeight * 0.85), behavior: 'instant' });
        await new Promise(resolve => setTimeout(resolve, 350));
        if (stopped || Date.now() >= request.expiresAt || location.href !== request.expectedUrl) throw new Error('page_changed');
        if (mutations.takeRecords().length) revision++;
        return observe(request, null, null);
      }
      const chosen = target(request);
      const second = request.kind === 'drag' ? target(request, 'toElementId') : null;
      const element = chosen.element;
      // Consume the observation before dispatch. Repeated messages cannot
      // repeat an uncertain click, even if DOM mutation has not yet occurred.
      observation = null; elements.clear();
      if (request.kind === 'draft') {
        // This narrow action never focuses, presses Enter, clicks or submits.
        if (tag(element) !== 'textarea' || element.readOnly || element.value.length > 0
          || typeof request.value !== 'string' || !request.value.trim()
          || new TextEncoder().encode(request.value).length > 2048
          || element.maxLength >= 0 && request.value.length > element.maxLength) throw new Error('unsupported_draft');
        setValue(element, request.value); fire(element, 'input'); fire(element, 'change');
        if (!element.isConnected || element.value !== request.value) throw new Error('draft_not_verified');
        return { kind: 'draft_filled', matched: true, verificationRequired: true };
      }
      if (request.kind === 'click') {
        if (tag(element) === 'input' && String(element.type).toLowerCase() === 'file') throw new Error('use_upload_for_files');
        element.click();
      } else if (request.kind === 'fill') fill(element, request.value);
      else if (request.kind === 'select') return { kind: 'input_issued', chosen: choose(element, request.value), verificationRequired: true };
      else if (request.kind === 'drag') drag(chosen, second);
      else if (request.kind === 'upload') { upload(element, request.file); return { kind: 'file_set', name: String(request.file.name).slice(0, 255), size: request.file.size, verificationRequired: true }; }
      else throw new Error('unsupported_operation');
      return { kind: 'input_issued', verificationRequired: true };
    } catch (error) {
      // Codes are this agent's own constants, never page text.
      const message = error instanceof Error ? error.message : '';
      return { kind: 'refused', code: /^[a-z_]{3,40}$/.test(message) ? message : 'fresh_observation_or_permission_required' };
    } finally { delete request.value; delete request.file; }
    })().then(result => { acting--; quietUntil = Date.now() + 1500; respond(result); });
    return true;
  });
  // For the unit test only (Node with jsdom); never present in a browser.
  if (globalThis.__josiPageAgentTest) globalThis.__josiPageAgentTest.exports = { sensitive, collect, observe: request => observe(request, null, null), choose, fill };
})();
