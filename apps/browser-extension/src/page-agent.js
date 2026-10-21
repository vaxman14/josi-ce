'use strict';
(() => {
  // A versioned marker in the extension's isolated world, never a DOM attribute
  // or a window.postMessage bridge a website could invoke.
  if (globalThis.__josiPageAgentV1) return;
  globalThis.__josiPageAgentV1 = true;
  const api = globalThis.browser ?? globalThis.chrome;
  let session = null, stopped = false, observation = null, revision = 0;
  let elements = new Map();
  const mutations = new MutationObserver(() => { revision++; });
  mutations.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  addEventListener('scroll', () => { revision++; }, true);
  addEventListener('resize', () => { revision++; }, true);
  addEventListener('input', () => { revision++; }, true);
  addEventListener('change', () => { revision++; }, true);
  const visible = element => {
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
      && !element.closest('[hidden],[inert],[aria-hidden="true"]');
  };
  const name = element => String(element.getAttribute('aria-label') || element.labels?.[0]?.textContent
    || element.getAttribute('title') || element.innerText || element.getAttribute('placeholder') || '').trim().slice(0, 300);
  function stopForHuman(event) {
    if (!event.isTrusted || !session) return;
    stopped = true;
    void api.runtime.sendMessage({ kind: 'local_input', sessionId: session }).catch(() => {});
  }
  addEventListener('pointerdown', stopForHuman, true);
  addEventListener('keydown', stopForHuman, true);
  addEventListener('wheel', stopForHuman, true);
  api.runtime.onMessage.addListener((request, sender, respond) => {
    if (sender.id !== api.runtime.id || sender.tab || request?.channel !== 'josi-page' || request.version !== 1) return false;
    void (async () => {
    try {
      if (request.expectedUrl !== location.href || !Number.isSafeInteger(request.expiresAt) || Date.now() >= request.expiresAt) throw new Error('stale_target');
      if (request.sessionId !== session) { session = request.sessionId; stopped = false; observation = null; elements.clear(); }
      if (stopped) throw new Error('human_control');
      if (mutations.takeRecords().length) revision++;
      let photo = null, photoCenter = null;
      if (request.kind === 'photo') {
        if (!observation || request.observationId !== observation.id || observation.revision !== revision
          || observation.url !== location.href) throw new Error('observation_changed');
        const image = elements.get(request.elementId)?.element;
        if (!(image instanceof HTMLImageElement) || !image.isConnected || !visible(image)) throw new Error('photo_unavailable');
        const expectedSource = image.currentSrc || image.src;
        if (new URL(expectedSource).origin !== location.origin) throw new Error('photo_unavailable');
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
        await new Promise(resolve => setTimeout(resolve, 50));
        if (stopped || session !== request.sessionId || Date.now() >= request.expiresAt || location.href !== request.expectedUrl) throw new Error('photo_changed');
        if (mutations.takeRecords().length) revision++;
        const photoBounds = image.getBoundingClientRect(); photoCenter = photoBounds.y + photoBounds.height / 2;
        // Read already loaded pixels only. Drawing a cross-origin image fails
        // closed; this is not a fetch proxy or a path to arbitrary local files.
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, 768 / Math.max(image.naturalWidth, image.naturalHeight));
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const context = canvas.getContext('2d');
        context.fillStyle = 'white'; context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        let jpeg = '';
        for (const quality of [0.8, 0.6, 0.4, 0.25]) {
          jpeg = canvas.toDataURL('image/jpeg', quality).split(',')[1];
          if (jpeg.length <= 32768) break;
        }
        if (!jpeg || jpeg.length > 32768) throw new Error('photo_budget');
        photo = { mediaType: 'image/jpeg', base64: jpeg, width: canvas.width, height: canvas.height,
          alt: String(image.alt || '').slice(0, 300), untrustedContent: true };
      }
      if (request.kind === 'observe' || request.kind === 'photo') {
        elements = new Map(); const nodes = [];
        const candidates = document.querySelectorAll('img,a[href],button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"]');
        const ordered = [...candidates];
        if (photoCenter !== null) ordered.sort((a, b) => Math.abs(a.getBoundingClientRect().y - photoCenter) - Math.abs(b.getBoundingClientRect().y - photoCenter));
        for (const element of ordered) {
          if (nodes.length >= 300) break;
          if (!visible(element)) continue;
          const id = crypto.randomUUID(), rect = element.getBoundingClientRect();
          elements.set(id, { element, name: name(element), x: rect.x, y: rect.y, width: rect.width, height: rect.height });
          nodes.push({ id, role: element.getAttribute('role') || element.tagName.toLowerCase(),
            name: element instanceof HTMLImageElement ? String(element.alt || name(element)).slice(0, 300) : name(element),
            inputType: element instanceof HTMLInputElement ? element.type : null, disabled: element.matches(':disabled,[aria-disabled="true"]'),
            ...(element instanceof HTMLTextAreaElement ? { hasValue: element.value.length > 0 } : {}),
            bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
        }
        observation = { id: crypto.randomUUID(), revision, url: location.href };
        const url = new URL(location.href);
        // No input values, cookies, storage, passwords or arbitrary JavaScript
        // evaluation. Text remains untrusted page data for the host to filter.
        const result = { kind: 'observation', observationId: observation.id, revision, title: document.title.slice(0, 300),
          url: url.origin + url.pathname, text: (document.body?.innerText ?? '').slice(0, 20000), elements: nodes,
          partial: candidates.length > nodes.length, framesUnsupported: document.querySelectorAll('iframe,frame').length > 0,
          viewport: { width: innerWidth, height: innerHeight } };
        if (photo) result.photo = photo;
        if (request.maxOutputBytes !== undefined) {
          if (!Number.isSafeInteger(request.maxOutputBytes) || request.maxOutputBytes < 1024 || request.maxOutputBytes > 65536) throw new Error('invalid_budget');
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
      if (!observation || request.observationId !== observation.id || observation.revision !== revision
        || observation.url !== location.href) throw new Error('observation_changed');
      if (request.kind === 'scroll') {
        if (!Number.isSafeInteger(request.deltaY) || !request.deltaY || Math.abs(request.deltaY) > 2000) throw new Error('invalid_scroll');
        observation = null; elements.clear();
        scrollBy({ top: request.deltaY, behavior: 'instant' });
        return { kind: 'input_issued', verificationRequired: true };
      }
      const target = elements.get(request.elementId), element = target?.element;
      if (!element?.isConnected || !visible(element) || element.matches(':disabled,[aria-disabled="true"]')) throw new Error('element_changed');
      const rect = element.getBoundingClientRect();
      if (name(element) !== target.name || ['x', 'y', 'width', 'height'].some(key => rect[key] !== target[key])) throw new Error('element_changed');
      // Consume the observation before dispatch. Repeated messages cannot
      // repeat an uncertain click, even if DOM mutation has not yet occurred.
      observation = null; elements.clear();
      if (request.kind === 'draft') {
        // This narrow action never focuses, presses Enter, clicks or submits.
        // Only a textarea is supported; site input/change handlers may autosave.
        if (!(element instanceof HTMLTextAreaElement) || element.readOnly || element.value.length > 0
          || typeof request.value !== 'string' || !request.value.trim()
          || new TextEncoder().encode(request.value).length > 2048
          || element.maxLength >= 0 && request.value.length > element.maxLength) throw new Error('unsupported_draft');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(element, request.value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        if (!element.isConnected || element.value !== request.value) throw new Error('draft_not_verified');
        return { kind: 'draft_filled', matched: true, verificationRequired: true };
      }
      if (request.kind === 'click') {
        if (element instanceof HTMLInputElement && element.type === 'file') throw new Error('file_transfer_requires_broker');
        element.click();
      } else if (request.kind === 'fill') {
        if (typeof request.value !== 'string' || request.value.length > 16384
          || !(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
          || (element instanceof HTMLInputElement && !['text', 'search', 'email', 'url', 'tel', 'number'].includes(element.type))
          || element.readOnly) throw new Error('unsupported_field');
        const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, request.value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      } else throw new Error('unsupported_operation');
      return { kind: 'input_issued', verificationRequired: true };
    } catch { return { kind: 'refused', code: 'fresh_observation_or_permission_required' }; }
    })().then(respond);
    return true;
  });
})();
