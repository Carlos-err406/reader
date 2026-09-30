const XHTML = "http://www.w3.org/1999/xhtml";
const URL_ATTRIBUTES = new Set(["href", "src", "xlink:href", "action", "formaction", "data", "srcdoc", "poster"]);

/**
 * Runs on every chapter before epub.js renders it. Chapter frames must allow scripts, because
 * WebKit (macOS) delivers no events to a sandboxed frame without them, and taps, scrolling and
 * keys all need events. So the book's own active content is removed instead: nothing from the
 * book may run, and a Content-Security-Policy backs that up.
 */
export function stripActiveContent(doc: Document) {
  doc.querySelectorAll("script, iframe, frame, frameset, object, embed, applet, meta[http-equiv]").forEach((node) => node.remove());
  for (const element of Array.from(doc.getElementsByTagName("*"))) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on") || (URL_ATTRIBUTES.has(name) && /^\s*(javascript|vbscript|data:text\/html)/i.test(attribute.value))) {
        element.removeAttribute(attribute.name);
      }
    }
  }
  const head = doc.head ?? doc.getElementsByTagName("head")[0];
  if (!head) return;
  const policy = doc.createElementNS(XHTML, "meta");
  policy.setAttribute("http-equiv", "Content-Security-Policy");
  policy.setAttribute("content", "script-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'");
  head.insertBefore(policy, head.firstChild);
}
