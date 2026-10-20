/**
 * Injected into every recorded page. Captures user actions into
 * window.__prooflineEvents; the Electron main process drains the array
 * with __prooflineTakeEvents() and ships it to the platform API.
 */
(() => {
  if (window.__prooflineRecorderReady) return;
  window.__prooflineRecorderReady = true;
  window.__prooflineEvents = [];

  const clean = (v) => (v || "").replace(/\s+/g, " ").trim();
  const describe = (el) => {
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      return clean(el.placeholder || el.name || el.id || el.getAttribute("type") || "field");
    }
    if (el.tagName === "SELECT") {
      return clean(el.getAttribute("aria-label") || el.name || el.id || "dropdown");
    }
    const text = clean(el.textContent || "");
    if (text && text.length <= 60) return text;
    const path = [];
    let cur = el;
    while (cur && cur.tagName !== "BODY" && path.length < 5) {
      let sel = cur.tagName.toLowerCase();
      if (cur.id) { sel += "#" + cur.id; path.unshift(sel); break; }
      const parent = cur.parentElement;
      if (!parent) { path.unshift(sel); break; }
      const siblings = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
      if (siblings.length > 1) sel += ":nth-child(" + (Array.prototype.indexOf.call(parent.children, cur) + 1) + ")";
      path.unshift(sel);
      cur = parent;
    }
    return "css:" + path.join(" > ");
  };

  document.addEventListener("click", (e) => {
    const el = e.target.closest("button, a, [role=button], [onclick], label, .cursor-pointer") || e.target;
    try { window.__prooflineEvents.push({ action: "click", target: describe(el) }); } catch (err) {}
  }, true);

  document.addEventListener("change", (e) => {
    const el = e.target;
    if (el.tagName === "SELECT") {
      try { window.__prooflineEvents.push({ action: "select", target: describe(el), value: el.value }); } catch (err) {}
    } else if ((el.tagName === "INPUT" || el.tagName === "TEXTAREA") && el.type !== "checkbox" && el.type !== "radio" && el.type !== "submit") {
      const meta = (el.placeholder || "") + (el.name || "") + (el.id || "") + (el.getAttribute("aria-label") || "");
      const isSecret = el.type === "password" || /password/i.test(meta);
      try { window.__prooflineEvents.push({ action: "fill", target: describe(el), value: isSecret ? "{{password}}" : el.value }); } catch (err) {}
    }
  }, true);

  window.__prooflineTakeEvents = () => window.__prooflineEvents.splice(0);
})();
