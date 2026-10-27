/**
 * Code that runs inside the web page (each frame), kept as a plain string so
 * no bundler transform can break it when Playwright sends it to the page.
 *
 * It finds form fields the way a screen reader does — by their labels and
 * ARIA roles, not by CSS classes — so it keeps working when a job site
 * changes its styling. Every element it reports gets a `data-outreach-ref`
 * attribute, which is how the server points at it afterwards.
 *
 * API (see runInPage in scan.ts): scan(opts), state(ref), options(ref),
 * click(ref).
 */
export const INPAGE_SOURCE = String.raw`
var ATTR = "data-outreach-ref";
var W = window;
if (!W.__outreachNextRef) W.__outreachNextRef = 1;

var FIELD_SELECTOR = "input, textarea, select, [contenteditable=''], [contenteditable='true'], [role=combobox], [role=textbox], [role=radio], [role=checkbox], [role=switch], button[aria-haspopup=listbox], [role=button][aria-haspopup=listbox]";
var BUTTON_SELECTOR = "button, input[type=submit], input[type=button], [role=button], a[href], [role=link], [role=tab], [role=menuitem]";
var SKIP_TYPES = { hidden: 1, submit: 1, button: 1, reset: 1, image: 1, range: 1, color: 1, search: 1 };
var OUTSIDE_FORM = "#onetrust-consent-sdk, #CybotCookiebotDialog, [id*=cookie-banner i], [class*=cookie-banner i], [id*=cookieconsent i], [aria-label*=cookie i], [role=search], nav";

/** Texts that are values, not labels (an attached file's name), while describing a field. */
var SKIP_TEXT = [];

function clean(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }
function clip(s, n) { s = clean(s); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
function lower(s) { return clean(s).toLowerCase(); }

function refOf(el) {
  var r = el.getAttribute(ATTR);
  if (!r) { r = String(W.__outreachNextRef++); el.setAttribute(ATTR, r); }
  return r;
}

function byRef(ref) {
  var sel = "[" + ATTR + "=\"" + ref + "\"]";
  var found = document.querySelector(sel);
  if (found) return found;
  var roots = shadowRoots();
  for (var i = 0; i < roots.length; i++) { found = roots[i].querySelector(sel); if (found) return found; }
  return null;
}

var shadowCache = null;
function shadowRoots() {
  if (shadowCache) return shadowCache;
  var out = [], queue = [document], seen = 0;
  while (queue.length) {
    var root = queue.shift();
    var all = root.querySelectorAll("*");
    for (var i = 0; i < all.length && seen < 40000; i++, seen++) {
      if (all[i].shadowRoot) { out.push(all[i].shadowRoot); queue.push(all[i].shadowRoot); }
    }
  }
  shadowCache = out;
  return out;
}

function deepAll(selector) {
  var out = Array.prototype.slice.call(document.querySelectorAll(selector));
  var roots = shadowRoots();
  for (var i = 0; i < roots.length; i++) out = out.concat(Array.prototype.slice.call(roots[i].querySelectorAll(selector)));
  return out;
}

function visible(el) {
  if (!el || !el.isConnected || el.nodeType !== 1) return false;
  if (typeof el.checkVisibility === "function" && !el.checkVisibility({ checkVisibilityCSS: true })) return false;
  var r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  if (r.right + W.scrollX < 0 || r.bottom + W.scrollY < 0) return false;
  return true;
}

function labelsOf(el) {
  var out = [];
  try { if (el.labels) out = Array.prototype.slice.call(el.labels); } catch (e) {}
  var wrap = el.closest ? el.closest("label") : null;
  if (wrap && out.indexOf(wrap) < 0) out.push(wrap);
  return out;
}

/** Choices are often hidden and drawn with CSS; their label or box is visible. */
function visibleChoice(el) {
  if (visible(el)) return true;
  var labels = labelsOf(el);
  for (var i = 0; i < labels.length; i++) if (visible(labels[i])) return true;
  return visible(el.parentElement);
}

function visibleFile(el) {
  if (visible(el) || visible(el.parentElement)) return true;
  if (el.parentElement && visible(el.parentElement.parentElement)) return true;
  var labels = labelsOf(el);
  for (var i = 0; i < labels.length; i++) if (visible(labels[i])) return true;
  return false;
}

function isControl(el) {
  if (el.nodeType !== 1) return false;
  var tag = el.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || tag === "BUTTON") return true;
  var role = el.getAttribute("role");
  return role === "button" || role === "combobox" || role === "listbox" || role === "option" || role === "radio" || role === "checkbox" || role === "textbox";
}

/** Visible text under container, skipping controls and the excluded elements. */
function ownText(container, exclude, max) {
  if (!container) return "";
  max = max || 400;
  var parts = [], total = 0;
  var walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: function (n) {
      if (n.nodeType === 1) {
        var tag = n.tagName;
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEMPLATE" || tag === "svg" || tag === "SVG") return NodeFilter.FILTER_REJECT;
        if (exclude && exclude.indexOf(n) >= 0) return NodeFilter.FILTER_REJECT;
        if (isControl(n)) return NodeFilter.FILTER_REJECT;
        if (n.getAttribute("aria-hidden") === "true" || n.hidden) return NodeFilter.FILTER_REJECT;
        // Validation messages come and go; they're not part of the question.
        var role = n.getAttribute("role");
        var cls = typeof n.className === "string" ? n.className : "";
        if (role === "alert" || role === "status" || n.getAttribute("aria-live") || /(^|[\s_-])(error|errors|invalid)([\s_-]|$)/i.test(cls)) return NodeFilter.FILTER_REJECT;
        if (typeof n.checkVisibility === "function" && !n.checkVisibility({ checkVisibilityCSS: true })) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_SKIP;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  var node;
  while ((node = walker.nextNode()) && total < max) {
    var t = clean(node.nodeValue);
    if (t && SKIP_TEXT.indexOf(t) < 0) { parts.push(t); total += t.length + 1; }
  }
  return clip(parts.join(" "), max);
}

function idsText(el, ids) {
  var root = el.getRootNode ? el.getRootNode() : document;
  return clean(ids.split(/\s+/).map(function (id) {
    var n = (root.getElementById && root.getElementById(id)) || document.getElementById(id);
    return n ? clean(n.innerText || n.textContent) : "";
  }).join(" "));
}

function directLabel(el) {
  var lb = el.getAttribute("aria-labelledby");
  if (lb) { var t = idsText(el, lb); if (t) return t; }
  var labels = labelsOf(el);
  var text = labels.map(function (l) { return ownText(l, [el]); }).filter(Boolean).join(" ");
  if (text) return text;
  var al = el.getAttribute("aria-label");
  if (clean(al)) return al;
  return "";
}

function fieldKindCount(node) {
  var seen = {}, count = 0;
  var els = node.querySelectorAll(FIELD_SELECTOR);
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    var kind = kindOf(el);
    if (!kind) continue;
    var key = (kind === "radio" || kind === "checkbox") && el.name ? "n:" + el.name : "r:" + refOf(el);
    if (!seen[key]) { seen[key] = 1; count++; }
  }
  return count;
}

/** The question text around a control: its nearest wrapper that holds only this field. */
function contextLabel(start, exclude) {
  var node = start;
  for (var depth = 0; node && node !== document.body && depth < 6; depth++, node = node.parentElement) {
    if (node.nodeType !== 1) continue;
    if (fieldKindCount(node) > 1) break;
    var t = ownText(node, exclude, 300);
    if (t) return t;
  }
  return "";
}

/** Text just before the control, for flat forms without wrappers. */
function precedingText(el) {
  var n = el;
  for (var up = 0; n && up < 3; up++, n = n.parentElement) {
    var s = n.previousSibling;
    while (s) {
      if (s.nodeType === 3) { var t = clean(s.nodeValue); if (t) return t; }
      else if (s.nodeType === 1) {
        if (isControl(s) || (s.querySelector && s.querySelector("input, select, textarea, [role=combobox]"))) return "";
        var t2 = clean(s.innerText || s.textContent);
        if (t2) return clip(t2, 200);
      }
      s = s.previousSibling;
    }
  }
  return "";
}

function describedBy(el) {
  var ids = el.getAttribute("aria-describedby");
  return ids ? clip(idsText(el, ids), 200) : "";
}

function humanize(s) { return clean(String(s || "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_\-\[\].]+/g, " ")); }

function cleanLabel(raw) {
  var t = clean(raw);
  var required = /[*✱]/.test(t) || /\(required\)/i.test(t) || /\brequired\s*$/i.test(t);
  // "Resume/CV * (PDF)" or "Email*": the asterisk marks required, it's not part of the question.
  t = t.replace(/(^|\s)[*✱]+(?=\s|$)/g, " ").replace(/([^\s*✱])[*✱]+(?=\s|$)/g, "$1");
  var optional = /\(optional\)/i.test(t) || /\boptional\s*$/i.test(t);
  t = t.replace(/\s*[*✱]+\s*$/, "").replace(/^\*\s*/, "").replace(/\s*\((required|optional)\)\s*/ig, " ").replace(/\s+(required|optional)$/i, "");
  t = t.replace(/\s*[*✱]+\s*$/, "");
  return { text: clip(t, 250), required: required, optional: optional };
}

function kindOf(el) {
  var tag = el.tagName;
  var role = (el.getAttribute("role") || "").toLowerCase();
  if (tag === "SELECT") return el.multiple ? "multiselect" : "select";
  if (tag === "TEXTAREA") return "textarea";
  if (tag === "INPUT") {
    var type = (el.getAttribute("type") || "text").toLowerCase();
    if (SKIP_TYPES[type]) return null;
    if (type === "radio") return "radio";
    if (type === "checkbox") return "checkbox";
    if (type === "file") return "file";
    if (type === "password") return "password";
    if (role === "combobox" || el.getAttribute("aria-autocomplete") === "list" || el.getAttribute("aria-haspopup") === "listbox") return "combobox";
    if (type === "date" || type === "month" || type === "datetime-local" || type === "time" || type === "week") return "date";
    return "text";
  }
  if (role === "combobox") return "combobox";
  if ((tag === "BUTTON" || role === "button") && el.getAttribute("aria-haspopup") === "listbox") return "combobox";
  if (role === "radio") return "radio";
  if (role === "checkbox" || role === "switch") return "checkbox";
  if (role === "textbox" || el.isContentEditable) return "richtext";
  return null;
}

function isChecked(el) {
  if (el.tagName === "INPUT") return !!el.checked;
  return el.getAttribute("aria-checked") === "true" || el.getAttribute("aria-pressed") === "true" || el.getAttribute("aria-selected") === "true";
}

function isPlaceholderText(t) {
  return !t || /^(select|choose|please select|please choose|pick|search|start typing|type to search|--|—|none selected)\b/i.test(t) || /^select (one|an option|\.\.\.)$/i.test(t);
}

/** The text a custom dropdown shows as its current value. */
function comboValue(el, labelText) {
  if (el.tagName === "INPUT" && clean(el.value)) return clean(el.value);
  if (el.tagName !== "INPUT") {
    var own = clean(el.innerText || el.textContent);
    return isPlaceholderText(own) ? "" : clip(own, 200);
  }
  var node = el.parentElement;
  for (var depth = 0; node && depth < 3; depth++, node = node.parentElement) {
    if (node.querySelector("label")) break;
    if (fieldKindCount(node) > 1) break;
    var exclude = [el].concat(Array.prototype.slice.call(node.querySelectorAll("[class*=placeholder i], [role=listbox], [class*=menu i]")));
    var t = ownText(node, exclude, 200);
    if (t && lower(t) !== lower(labelText)) return isPlaceholderText(t) ? "" : t;
  }
  return "";
}

function valueOf(el, kind, labelText) {
  switch (kind) {
    case "text": case "textarea": case "date": return clean(el.value);
    case "richtext": return clip(el.innerText || el.textContent, 300);
    case "select":
      var o = el.selectedOptions && el.selectedOptions[0];
      return o && o.value !== "" && !(o.disabled && o.index === 0) ? clean(o.text) : "";
    case "multiselect":
      return Array.prototype.slice.call(el.selectedOptions || []).map(function (x) { return clean(x.text); }).join("; ");
    case "file":
      return el.files && el.files.length ? Array.prototype.slice.call(el.files).map(function (f) { return f.name; }).join(", ") : "";
    case "checkbox": return isChecked(el) ? "checked" : "";
    case "combobox": return comboValue(el, labelText);
  }
  return "";
}

function listboxFor(el) {
  var ids = (el.getAttribute("aria-controls") || el.getAttribute("aria-owns") || "").split(/\s+/).filter(Boolean);
  for (var i = 0; i < ids.length; i++) {
    var root = el.getRootNode ? el.getRootNode() : document;
    var n = (root.getElementById && root.getElementById(ids[i])) || document.getElementById(ids[i]);
    if (n) return n;
  }
  return null;
}

function visibleOptions(scope) {
  var sel = "[role=option], [role=listbox] li, [role=menu] [role=menuitem], [class*=option i]:not(option)";
  var els = scope ? Array.prototype.slice.call(scope.querySelectorAll(sel)) : deepAll(sel);
  var out = [], seen = {};
  for (var i = 0; i < els.length && out.length < 400; i++) {
    var o = els[i];
    if (!visible(o)) continue;
    if (o.querySelector && o.querySelector("[role=option], [class*=option i]")) continue;
    if (o.getAttribute("aria-disabled") === "true") continue;
    var text = clip(o.innerText || o.textContent, 200);
    if (!text || seen[text]) continue;
    seen[text] = 1;
    out.push({ ref: refOf(o), label: text });
  }
  return out;
}

function choiceLabel(el) {
  var t = directLabel(el);
  if (!t && el.tagName !== "INPUT") t = clean(el.innerText || el.textContent);
  if (!t) {
    var s = el.nextSibling;
    while (s && !t) { t = s.nodeType === 3 ? clean(s.nodeValue) : (s.nodeType === 1 && !isControl(s) ? clean(s.innerText || s.textContent) : ""); s = s.nextSibling; }
  }
  if (!t) t = el.value && el.value !== "on" ? el.value : "";
  return cleanLabel(t).text;
}

function commonAncestor(els) {
  var a = els[0].parentElement;
  while (a && !els.every(function (e) { return a.contains(e); })) a = a.parentElement;
  return a || document.body;
}

function groupQuestion(members, container) {
  var fieldset = members[0].closest("fieldset");
  if (fieldset && members.every(function (m) { return fieldset.contains(m); })) {
    var legend = fieldset.querySelector("legend");
    if (legend && clean(legend.innerText || legend.textContent)) return clean(legend.innerText || legend.textContent);
  }
  var group = members[0].closest("[role=radiogroup], [role=group]");
  if (group && members.every(function (m) { return group.contains(m); })) {
    var gl = directLabel(group);
    if (gl) return gl;
  }
  var exclude = members.slice();
  members.forEach(function (m) { labelsOf(m).forEach(function (l) { exclude.push(l); }); });
  return contextLabel(container, exclude) || precedingText(container);
}

function base(el, kind) {
  return {
    ref: refOf(el),
    kind: kind,
    tag: el.tagName.toLowerCase(),
    name: el.getAttribute("name") || "",
    id: el.id || "",
    autocomplete: (el.getAttribute("autocomplete") || "").toLowerCase(),
    inputType: (el.getAttribute("type") || "").toLowerCase(),
    placeholder: clip(el.getAttribute("placeholder") || "", 120),
    description: describedBy(el),
    disabled: !!(el.disabled || el.getAttribute("aria-disabled") === "true"),
    readOnly: !!el.readOnly,
    inForm: !!(el.form || el.closest("form"))
  };
}

function describeSingle(el, kind) {
  SKIP_TEXT = kind === "file" && el.files ? Array.prototype.slice.call(el.files).map(function (f) { return clean(f.name); }) : [];
  try { return describeSingleInner(el, kind); } finally { SKIP_TEXT = []; }
}

function describeSingleInner(el, kind) {
  var raw = directLabel(el);
  var question = "";
  if (kind === "checkbox") {
    question = contextLabel(el.parentElement, [el].concat(labelsOf(el)));
    if (lower(question) === lower(raw)) question = "";
  }
  if (!clean(raw)) raw = contextLabel(el.parentElement, [el]) || precedingText(el);
  if (!clean(raw)) raw = el.getAttribute("placeholder") || el.getAttribute("title") || humanize(el.getAttribute("name") || el.id || "");
  var lab = cleanLabel(raw);
  var q = cleanLabel(question);
  var f = base(el, kind);
  f.label = q.text ? clip(q.text + " — " + lab.text, 250) : lab.text;
  f.required = !!(el.required || el.getAttribute("aria-required") === "true" || lab.required || q.required);
  f.optional = lab.optional || q.optional;
  f.value = valueOf(el, kind, lab.text);
  f.multiple = !!el.multiple;
  f.accept = el.getAttribute("accept") || "";
  f.maxLength = el.maxLength > 0 ? el.maxLength : 0;
  if (kind === "select" || kind === "multiselect") {
    f.options = Array.prototype.slice.call(el.options).map(function (o, i) {
      return { label: clean(o.text), value: o.value, index: i, placeholder: o.value === "" || (o.disabled && i === 0) };
    }).filter(function (o) { return !o.placeholder && o.label; }).slice(0, 600);
  } else if (kind === "combobox") {
    var lb = listboxFor(el);
    f.options = lb ? visibleOptions(lb).map(function (o) { return { label: o.label }; }) : [];
    f.expanded = el.getAttribute("aria-expanded") === "true";
  }
  return f;
}

function describeGroup(kind, members) {
  var container = commonAncestor(members);
  var lab = cleanLabel(groupQuestion(members, container));
  var f = base(members[0], kind);
  f.label = lab.text || humanize(f.name);
  f.required = members.some(function (m) { return m.required || m.getAttribute("aria-required") === "true"; }) || lab.required ||
    !!(container.closest("[aria-required=true]"));
  f.optional = lab.optional;
  f.options = members.map(function (m) { return { label: choiceLabel(m), ref: refOf(m), value: m.value || "" }; });
  f.value = members.filter(isChecked).map(function (m) { return choiceLabel(m); }).join("; ");
  return f;
}

/** Yes / No drawn as two buttons (Ashby and others). */
function yesNoGroups(taken) {
  var out = [];
  var buttons = deepAll("button, [role=button]").filter(function (b) { return /^(yes|no)$/i.test(clean(b.innerText || b.textContent)) && visible(b); });
  var parents = [];
  buttons.forEach(function (b) { if (parents.indexOf(b.parentElement) < 0) parents.push(b.parentElement); });
  parents.forEach(function (p) {
    var pair = buttons.filter(function (b) { return b.parentElement === p; });
    if (pair.length !== 2) return;
    var texts = pair.map(function (b) { return lower(b.innerText || b.textContent); }).sort().join("/");
    if (texts !== "no/yes") return;
    if (taken.some(function (t) { return p.contains(t); })) return;
    var lab = cleanLabel(contextLabel(p, pair) || precedingText(p));
    var f = base(pair[0], "radio");
    f.tag = "buttons";
    f.label = lab.text;
    f.required = lab.required;
    f.optional = lab.optional;
    f.options = pair.map(function (b) { return { label: clean(b.innerText || b.textContent), ref: refOf(b), value: "" }; });
    f.value = pair.filter(function (b) {
      return b.getAttribute("aria-pressed") === "true" || b.getAttribute("aria-checked") === "true" || /(^|[\s_-])(active|selected|checked|isSelected|pressed)/i.test(b.className || "");
    }).map(function (b) { return clean(b.innerText || b.textContent); }).join("");
    out.push({ el: pair[0], field: f });
  });
  return out;
}

function collectFields() {
  var candidates = deepAll(FIELD_SELECTOR).filter(function (el) {
    if (el.closest && el.closest(OUTSIDE_FORM)) return false;
    return kindOf(el) !== null;
  });
  candidates = candidates.filter(function (el) {
    for (var i = 0; i < candidates.length; i++) if (candidates[i] !== el && el.contains(candidates[i])) return false;
    return true;
  });
  var entries = [], groups = {}, loginForm = false;
  candidates.forEach(function (el) {
    var kind = kindOf(el);
    if (kind === "radio" || kind === "checkbox") {
      if (!visibleChoice(el)) return;
      var key = null;
      if (el.tagName === "INPUT" && el.name) key = (el.form ? refOf(el.form) : "doc") + "|" + kind + "|" + el.name;
      else if (kind === "radio") { var g = el.closest("[role=radiogroup], fieldset") || el.parentElement; key = "c|" + refOf(g); }
      else { var cg = el.closest("fieldset, [role=group]"); if (cg) key = "c|" + refOf(cg); }
      if (key) {
        if (!groups[key]) { groups[key] = { kind: kind, members: [] }; entries.push({ group: key, el: el }); }
        groups[key].members.push(el);
        return;
      }
      entries.push({ el: el, kind: kind });
      return;
    }
    if (kind === "file") { if (!visibleFile(el)) return; }
    else if (!visible(el)) return;
    if (kind === "password") { loginForm = true; return; }
    entries.push({ el: el, kind: kind });
  });

  var fields = [];
  entries.forEach(function (entry) {
    try {
      if (entry.group) {
        var g = groups[entry.group];
        if (g.kind === "checkbox" && g.members.length === 1) fields.push({ el: entry.el, field: describeSingle(g.members[0], "checkbox") });
        else fields.push({ el: entry.el, field: describeGroup(g.kind === "radio" ? "radio" : "checkboxes", g.members) });
      } else {
        fields.push({ el: entry.el, field: describeSingle(entry.el, entry.kind) });
      }
    } catch (e) {}
  });
  var taken = fields.map(function (f) { return f.el; });
  yesNoGroups(taken).forEach(function (y) { fields.push(y); });
  fields.sort(function (a, b) {
    var pos = a.el.compareDocumentPosition(b.el);
    return pos & 4 ? -1 : pos & 2 ? 1 : 0;
  });
  return { fields: fields.map(function (f) { return f.field; }), loginForm: loginForm };
}

function collectButtons(includeLinks) {
  var out = [];
  deepAll(BUTTON_SELECTOR).forEach(function (el) {
    if (out.length >= 250) return;
    var isLink = el.tagName === "A" || el.getAttribute("role") === "link";
    if (isLink && !includeLinks && !/apply|application|interested|continue|next/i.test(el.innerText || "")) return;
    if (el.getAttribute("aria-haspopup") === "listbox") return;
    if (!visible(el)) return;
    var text = clip(el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("title") || "", 100);
    if (!text) return;
    out.push({
      ref: refOf(el),
      text: text,
      tag: el.tagName.toLowerCase(),
      type: (el.getAttribute("type") || "").toLowerCase(),
      link: isLink,
      href: isLink ? (el.href || el.getAttribute("href") || "") : "",
      target: el.getAttribute("target") || "",
      inForm: !!el.closest("form"),
      disabled: !!(el.disabled || el.getAttribute("aria-disabled") === "true")
    });
  });
  return out;
}

function collectErrors() {
  var out = [];
  var seen = {};
  function add(t) { t = clip(t, 200); if (t && !seen[t] && out.length < 10) { seen[t] = 1; out.push(t); } }
  deepAll("[role=alert], [aria-live=assertive], [class*=error i], [class*=invalid i], [id*=error i]").forEach(function (el) {
    if (!visible(el) || el.querySelector("input, select, textarea")) return;
    if (/^(input|select|textarea)$/i.test(el.tagName)) return;
    var t = clean(el.innerText || el.textContent);
    if (t && t.length < 200) add(t);
  });
  deepAll("[aria-invalid=true]").forEach(function (el) {
    if (!visible(el)) return;
    var label = cleanLabel(directLabel(el) || contextLabel(el.parentElement, [el])).text;
    if (label) add(label + ": needs a valid answer");
  });
  return out;
}

var CONFIRMATION = /thank(s| you) for (your )?(applying|application|submitting)|application (has been |was )?(successfully )?(received|submitted|sent|complete)|we('ve| have) received your application|successfully (submitted|applied)|you('ve| have) (successfully )?applied|application submitted/i;

var api = {
  scan: function (opts) {
    opts = opts || {};
    var collected = collectFields();
    var bodyText = document.body ? clean(document.body.innerText) : "";
    var confirmation = bodyText.match(CONFIRMATION);
    return {
      url: location.href,
      title: document.title,
      fields: collected.fields,
      buttons: collectButtons(!!opts.links),
      errors: collectErrors(),
      loginForm: collected.loginForm,
      confirmation: confirmation ? clip(bodyText.slice(Math.max(0, confirmation.index - 40), confirmation.index + 160), 220) : "",
      text: opts.text ? bodyText.slice(0, opts.text) : ""
    };
  },
  state: function (ref) {
    var el = byRef(ref);
    if (!el) return null;
    var kind = kindOf(el) || "";
    return {
      kind: kind,
      value: kind ? valueOf(el, kind, cleanLabel(directLabel(el)).text) : clean(el.innerText),
      checked: isChecked(el) || /(^|[\s_-])(active|selected|checked|isSelected|pressed)/i.test(el.className || ""),
      expanded: el.getAttribute("aria-expanded") === "true",
      invalid: el.getAttribute("aria-invalid") === "true",
      text: clip(el.innerText || el.textContent || "", 200),
      containerText: clip((el.parentElement && el.parentElement.parentElement ? el.parentElement.parentElement.innerText : "") || "", 400)
    };
  },
  options: function (ref) {
    var el = ref ? byRef(ref) : null;
    var lb = el ? listboxFor(el) : null;
    var opts = lb && visible(lb) ? visibleOptions(lb) : [];
    return opts.length ? opts : visibleOptions(null);
  },
  click: function (ref) {
    var el = byRef(ref);
    if (!el) return false;
    el.scrollIntoView({ block: "center" });
    el.click();
    return true;
  },
  labelClick: function (ref) {
    var el = byRef(ref);
    if (!el) return false;
    var labels = labelsOf(el);
    if (!labels.length) return false;
    labels[0].click();
    return true;
  }
};
`;
