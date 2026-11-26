/**
 * The `jarvis ui` page: one self-contained HTML document (no CDN, no build step, works offline).
 * Kept as a TS string so the npm bundle and the standalone binary need no extra files.
 * Note for editing: the page is a String.raw template, so it must contain no backticks and no
 * dollar-brace sequences (they'd be evaluated here). Write those as '$' + '{…}' or &#36;{…}.
 */
export const UI_PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Jarvis settings</title>
<style>
:root {
  --bg: #f6f7f9; --panel: #ffffff; --text: #1c2024; --muted: #5f6873; --line: #dde1e6;
  --accent: #2f6fde; --accent-text: #ffffff; --ok: #1f8a4c; --warn: #a15c00; --bad: #c22f2f;
  --code: #f0f2f5; --warn-bg: #fff6e5; --bad-bg: #fdecec; --ok-bg: #e8f6ee;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14171a; --panel: #1c2024; --text: #e6e8eb; --muted: #9aa3ad; --line: #2e343a;
    --accent: #5b8ff0; --accent-text: #0b0d10; --ok: #4cc27f; --warn: #e0a040; --bad: #f07070;
    --code: #23282d; --warn-bg: #2d2416; --bad-bg: #321b1b; --ok-bg: #16291f;
  }
}
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
header { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; padding: 12px 20px; background: var(--panel); border-bottom: 1px solid var(--line); position: sticky; top: 0; z-index: 2; }
header h1 { font-size: 16px; margin: 0 12px 0 0; }
header .cwd { color: var(--muted); font-family: ui-monospace, Consolas, monospace; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 40ch; }
.spacer { flex: 1; }
.layout { display: grid; grid-template-columns: 200px 1fr; max-width: 1100px; margin: 0 auto; gap: 20px; padding: 20px; }
nav button { display: block; width: 100%; text-align: left; padding: 8px 12px; margin-bottom: 2px; border: 0; border-radius: 6px; background: none; color: var(--text); cursor: pointer; font: inherit; }
nav button:hover { background: var(--code); }
nav button.active { background: var(--accent); color: var(--accent-text); }
main { min-width: 0; }
section { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 20px; margin-bottom: 16px; }
h2 { font-size: 15px; margin: 0 0 4px; }
.hint { color: var(--muted); font-size: 13px; margin: 0 0 12px; }
label { display: block; font-weight: 600; margin: 14px 0 4px; }
label .sub { font-weight: 400; color: var(--muted); }
input[type=text], input[type=number], input[type=password], textarea, select {
  width: 100%; padding: 7px 9px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--text); font: inherit;
}
textarea { font-family: ui-monospace, Consolas, monospace; font-size: 13px; min-height: 90px; resize: vertical; }
textarea.big { min-height: 320px; }
input:focus, textarea:focus, select:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
button.btn { padding: 7px 14px; border-radius: 6px; border: 1px solid var(--line); background: var(--panel); color: var(--text); cursor: pointer; font: inherit; }
button.btn:hover { border-color: var(--accent); }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); font-weight: 600; }
button.btn:disabled { opacity: .5; cursor: default; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0 16px; }
.effective { color: var(--muted); font-size: 12px; margin-top: 3px; }
code { background: var(--code); padding: 1px 5px; border-radius: 4px; font-size: 12px; }
table { width: 100%; border-collapse: collapse; }
td, th { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: 12px; color: var(--muted); font-weight: 600; }
.pill { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 12px; }
.pill.ok { background: var(--ok-bg); color: var(--ok); }
.pill.none { background: var(--code); color: var(--muted); }
.pill.bad { background: var(--bad-bg); color: var(--bad); }
.banner { padding: 10px 14px; border-radius: 8px; margin-bottom: 16px; }
.banner.warn { background: var(--warn-bg); color: var(--warn); }
.banner.bad { background: var(--bad-bg); color: var(--bad); }
.banner.ok { background: var(--ok-bg); color: var(--ok); }
.banner ul { margin: 6px 0 0; padding-left: 20px; }
.tool { border-bottom: 1px solid var(--line); padding: 12px 0; }
.tool:last-child { border-bottom: 0; }
.tool .name { font-weight: 600; }
.status { font-size: 13px; color: var(--muted); }
.status.dirty { color: var(--warn); font-weight: 600; }
@media (max-width: 760px) {
  .layout { grid-template-columns: 1fr; padding: 12px; }
  nav { display: flex; flex-wrap: wrap; gap: 4px; }
  nav button { width: auto; }
  .grid2 { grid-template-columns: 1fr; }
}
</style>
</head>
<body>
<header>
  <h1>Jarvis settings</h1>
  <span class="cwd" id="cwd"></span>
  <span class="spacer"></span>
  <label for="scope" style="margin:0">Editing</label>
  <select id="scope" style="width:auto">
    <option value="global">Global (all projects)</option>
    <option value="project">This project (shared, committed)</option>
    <option value="local">This project, just me (gitignored)</option>
  </select>
  <span class="status" id="status"></span>
  <button class="btn" id="revert">Revert</button>
  <button class="btn primary" id="save">Save</button>
</header>
<div class="layout">
  <nav id="nav"></nav>
  <main>
    <div id="messages"></div>
    <div id="view"></div>
  </main>
</div>
<script>
(function () {
  'use strict';
  // The token comes in the URL once; keep it in memory and drop it from the address bar/history.
  var params = new URLSearchParams(location.search);
  var TOKEN = params.get('token') || '';
  if (TOKEN) history.replaceState(null, '', location.pathname);

  var S = null;          // server state
  var scope = 'global';  // which file we edit
  var draft = {};        // unsaved copy of that file
  var dirty = false;
  var tab = 'models';
  var models = [];

  var TABS = [
    ['models', 'Models'], ['providers', 'Providers & keys'], ['permissions', 'Permissions'],
    ['tools', 'Tools'], ['context', 'Context'], ['mcp', 'MCP servers'], ['hooks', 'Hooks'], ['raw', 'Raw JSON']
  ];

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function clone(x) { return JSON.parse(JSON.stringify(x || {})); }

  function api(method, path, body) {
    return fetch(path, {
      method: method,
      headers: { 'x-jarvis-token': TOKEN, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.error || ('HTTP ' + r.status)); e.details = j.details; throw e; }
        return j;
      });
    });
  }

  // ---- draft helpers: "a.b.c" paths; empty values are removed so files stay tidy ----
  function get(path) {
    return path.split('.').reduce(function (o, k) { return o == null ? undefined : o[k]; }, draft);
  }
  function isEmpty(v) {
    return v === undefined || v === '' || (Array.isArray(v) && v.length === 0) ||
      (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);
  }
  function set(path, value) {
    var keys = path.split('.');
    var stack = [draft];
    for (var i = 0; i < keys.length - 1; i++) {
      var o = stack[i];
      if (o[keys[i]] == null || typeof o[keys[i]] !== 'object') o[keys[i]] = {};
      stack.push(o[keys[i]]);
    }
    var last = stack[stack.length - 1];
    if (isEmpty(value)) delete last[keys[keys.length - 1]]; else last[keys[keys.length - 1]] = value;
    for (var j = keys.length - 2; j >= 0; j--) if (isEmpty(stack[j + 1])) delete stack[j][keys[j]];
    markDirty(true);
  }
  function effective(path) {
    return path.split('.').reduce(function (o, k) { return o == null ? undefined : o[k]; }, S.effective);
  }
  function lines(text) { return text.split('\n').map(function (l) { return l.trim(); }).filter(Boolean); }

  function markDirty(v) {
    dirty = v;
    $('status').textContent = v ? 'Unsaved changes' : (S && S.scopes[scope].exists ? 'Saved' : 'No file yet');
    $('status').className = 'status' + (v ? ' dirty' : '');
  }

  function message(kind, html) {
    $('messages').innerHTML = html ? '<div class="banner ' + kind + '">' + html + '</div>' : '';
  }

  // ---- rendering ----
  function renderNav() {
    $('nav').innerHTML = TABS.map(function (t) {
      return '<button data-tab="' + t[0] + '" class="' + (t[0] === tab ? 'active' : '') + '">' + esc(t[1]) + '</button>';
    }).join('');
  }

  function field(path, labelText, sub, opts) {
    opts = opts || {};
    var v = get(path);
    var eff = effective(path);
    var type = opts.type || 'text';
    var input = type === 'lines'
      ? '<textarea data-path="' + path + '" data-kind="lines" placeholder="' + esc(opts.placeholder || 'one per line') + '">' + esc((v || []).join('\n')) + '</textarea>'
      : '<input type="' + (type === 'number' ? 'number' : 'text') + '" data-path="' + path + '" data-kind="' + type + '"' +
        (opts.list ? ' list="' + opts.list + '"' : '') + (opts.step ? ' step="' + opts.step + '"' : '') +
        ' placeholder="' + esc(opts.placeholder || '') + '" value="' + esc(v == null ? '' : v) + '">';
    var effText = eff === undefined ? 'not set' : (Array.isArray(eff) ? eff.join(', ') || '(empty)' : String(eff));
    return '<label>' + esc(labelText) + (sub ? ' <span class="sub">' + esc(sub) + '</span>' : '') + '</label>' + input +
      '<div class="effective">In effect (all files merged): ' + esc(effText) + '</div>';
  }

  function trustBanner() {
    if (scope === 'global' || S.trusted) return '';
    var u = S.untrusted;
    var pending = [];
    if (u.hooks) pending.push(u.hooks + ' hook(s)');
    if (u.mcpServers.length) pending.push('MCP server(s) ' + u.mcpServers.join(', '));
    return '<div class="banner warn"><b>This folder is not trusted.</b> Jarvis ignores this folder\'s hooks, MCP servers, ' +
      'allow rules and provider URLs until you trust it' + (pending.length ? ' (it defines ' + esc(pending.join(' and ')) + ')' : '') +
      '. Only trust folders whose .jarvis settings you have reviewed. ' +
      '<button class="btn" id="trust">Trust this folder</button></div>';
  }

  var VIEWS = {
    models: function () {
      return '<section><h2>Models</h2><p class="hint">Format: <code>provider/model</code>. Backups are tried in order when the main model is rate-limited or down.</p>' +
        '<datalist id="models">' + models.map(function (m) { return '<option value="' + esc(m) + '">'; }).join('') + '</datalist>' +
        field('model', 'Main model', '', { list: 'models', placeholder: 'groq/openai/gpt-oss-120b' }) +
        field('fallbacks', 'Fallback models', 'one per line, in order', { type: 'lines' }) +
        '<div class="row" style="margin-top:12px"><button class="btn" id="loadModels">' + (models.length ? 'Reload model list (' + models.length + ')' : 'Load model list for suggestions') + '</button></div>' +
        '</section><section><h2>Sub-agents</h2><p class="hint">Used by the Task tool (built-in agents: ' + esc(S.agents.join(', ')) + ').</p>' +
        '<div class="grid2">' + field('agents.model', 'Sub-agent model', 'optional, e.g. a fast free one', { list: 'models' }) +
        field('agents.maxSteps', 'Max steps per sub-agent', 'default 30', { type: 'number' }) + '</div></section>' +
        '<section><h2>Retries</h2><div class="grid2">' + field('retry.maxRetries', 'Retries per model', 'default 3', { type: 'number' }) +
        field('retry.maxWaitSeconds', 'Longest wait accepted (s)', 'default 30', { type: 'number' }) + '</div></section>';
    },

    providers: function () {
      var rows = S.providers.map(function (p) {
        var status = p.local
          ? (p.running ? '<span class="pill ok">running</span>' : '<span class="pill none">not running</span>')
          : (p.keySource ? '<span class="pill ok">key from ' + esc(p.keySource) + '</span>' : '<span class="pill none">no key</span>');
        var keyCell = p.local ? '<span class="hint">no key needed</span>' :
          '<div class="row"><input type="password" autocomplete="off" data-key="' + esc(p.name) + '" placeholder="paste key" style="flex:1;min-width:140px">' +
          '<button class="btn" data-savekey="' + esc(p.name) + '">Save key</button>' +
          (p.keySource === 'keychain' || p.keySource === 'file' ? '<button class="btn" data-delkey="' + esc(p.name) + '">Remove</button>' : '') + '</div>' +
          (p.signup ? '<div class="effective">Get one: ' + esc(p.signup) + (p.apiKeyEnv ? ' · or set ' + esc(p.apiKeyEnv) : '') + '</div>' : '');
        return '<tr><td><b>' + esc(p.name) + '</b><div class="effective">' + esc(p.baseURL || '') + '</div></td><td>' + status + '</td><td>' + keyCell + '</td>' +
          '<td style="width:90px"><input type="number" data-path="providers.' + esc(p.name) + '.rpm" data-kind="number" value="' + esc(get('providers.' + p.name + '.rpm') || '') + '" placeholder="RPM"></td>' +
          '<td style="width:100px"><input type="number" data-path="providers.' + esc(p.name) + '.tpm" data-kind="number" value="' + esc(get('providers.' + p.name + '.tpm') || '') + '" placeholder="TPM"></td></tr>';
      }).join('');
      return '<section><h2>Providers & API keys</h2><p class="hint">Keys are checked with the provider, then stored in your OS keychain (shared by all projects, never in settings files). ' +
        'RPM/TPM are optional rate limits saved in the file you are editing.</p>' +
        '<table><tr><th>Provider</th><th>Status</th><th>API key</th><th>RPM</th><th>TPM</th></tr>' + rows + '</table></section>';
    },

    permissions: function () {
      return trustBanner() + '<section><h2>Permission rules</h2><p class="hint">Rules: <code>Tool</code>, <code>Tool(exact)</code>, <code>Tool(prefix:*)</code>; a trailing <code>*</code> on the tool name matches a prefix, e.g. <code>mcp__github__*</code>. ' +
        'Deny beats allow. Without a rule, read-only tools inside the project run freely and everything else asks.</p>' +
        field('permissions.allow', 'Always allow', 'one rule per line', { type: 'lines', placeholder: 'Bash(git status)\nBash(npm test:*)' }) +
        field('permissions.deny', 'Always block', 'one rule per line', { type: 'lines', placeholder: 'Read(.env)\nBash(rm -rf:*)' }) + '</section>';
    },

    tools: function () {
      var disabled = get('tools.disabled') || [];
      var descs = get('tools.descriptions') || {};
      var effDisabled = effective('tools.disabled') || [];
      return '<section><h2>Tools</h2><p class="hint">Turn tools off, or replace the description the model sees. Applies from the next message. ' +
        'Disabling here only adds to the disabled list of this file; a tool disabled in another file stays off.</p>' +
        S.tools.map(function (t) {
          var off = disabled.indexOf(t.name) !== -1;
          var offElsewhere = !off && effDisabled.indexOf(t.name) !== -1;
          return '<div class="tool"><div class="row"><label class="row" style="margin:0;font-weight:600"><input type="checkbox" data-tool="' + esc(t.name) + '"' + (off ? '' : ' checked') + '> ' + esc(t.name) + '</label>' +
            '<span class="pill ' + (t.readOnly ? 'ok' : 'none') + '">' + (t.readOnly ? 'read-only' : 'asks') + '</span>' +
            (offElsewhere ? '<span class="pill bad">disabled in another file</span>' : '') + '</div>' +
            '<textarea data-desc="' + esc(t.name) + '" placeholder="' + esc(t.description) + '" style="min-height:54px;margin-top:6px">' + esc(descs[t.name] || '') + '</textarea></div>';
        }).join('') + '</section>';
    },

    context: function () {
      return '<section><h2>Context management</h2><p class="hint">How Jarvis keeps conversations under the model\'s limit. Fractions are of the context window (0–1).</p><div class="grid2">' +
        field('context.clearToolOutputAt', 'Clear old tool output at', 'default 0.5', { type: 'number', step: '0.05' }) +
        field('context.compactAt', 'Summarize older messages at', 'default 0.75', { type: 'number', step: '0.05' }) +
        field('context.keepToolResults', 'Recent tool results kept intact', 'default 4', { type: 'number' }) +
        field('context.defaultWindow', 'Context window if unknown', 'default 32768', { type: 'number' }) +
        field('context.maxToolOutputLines', 'Max lines per tool result', 'default 400', { type: 'number' }) +
        field('context.maxToolOutputBytes', 'Max bytes per tool result', '', { type: 'number' }) +
        '</div></section>';
    },

    mcp: function () {
      return trustBanner() + '<section><h2>MCP servers</h2><p class="hint">Each entry is either a local server (<code>command</code> + <code>args</code>) or a remote one (<code>url</code>). ' +
        'Write secrets as <code>&#36;{GITHUB_TOKEN}</code>; the value is read from your environment. Restart Jarvis to apply.</p>' +
        jsonEditor('mcpServers', { fs: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] }, github: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer $' + '{GITHUB_TOKEN}' } } }) +
        '</section>';
    },

    hooks: function () {
      return trustBanner() + '<section><h2>Hooks</h2><p class="hint">Commands run at: ' + esc(S.hookEvents.join(', ')) + '. ' +
        '<code>matcher</code> is a regex on the tool name. Exit code 2 blocks (or, for PostToolUse, sends stderr to the model). ' +
        'Env: <code>JARVIS_FILE</code>, <code>JARVIS_TOOL</code>, <code>JARVIS_EVENT</code>, <code>JARVIS_PROJECT_DIR</code>. Applies from the next message.</p>' +
        jsonEditor('hooks', { PostToolUse: [{ matcher: 'Edit|Write', command: 'npx prettier --write "$env:JARVIS_FILE"' }], Stop: [{ command: 'npm test --silent', timeout: 300 }] }) +
        '</section>';
    },

    raw: function () {
      return '<section><h2>Raw JSON</h2><p class="hint">The whole file: <code>' + esc(S.scopes[scope].file) + '</code>. Unknown keys are kept.</p>' +
        '<textarea class="big" id="rawText">' + esc(JSON.stringify(draft, null, 2)) + '</textarea>' +
        '<div class="row" style="margin-top:8px"><button class="btn" id="rawApply">Apply to form</button><span class="effective" id="rawErr"></span></div></section>';
    }
  };

  function jsonEditor(path, example) {
    var v = get(path);
    return '<textarea class="big" data-json="' + path + '" placeholder="' + esc(JSON.stringify(example, null, 2)) + '">' + esc(v ? JSON.stringify(v, null, 2) : '') + '</textarea>' +
      '<div class="row" style="margin-top:8px"><button class="btn" data-example="' + path + '">Insert example</button><span class="effective" data-jsonerr="' + path + '"></span></div>';
  }
  function render() {
    $('cwd').textContent = S.cwd;
    $('cwd').title = S.cwd;
    renderNav();
    var sc = S.scopes[scope];
    var head = '<p class="hint" style="margin:0 0 12px">File: <code>' + esc(sc.file) + '</code>' + (sc.exists ? '' : ' (created on save)') + '</p>';
    if (sc.error) head += '<div class="banner bad">This file has invalid JSON and can\'t be edited in the form: ' + esc(sc.error) + '. Fix it in an editor or replace it via Raw JSON.</div>';
    $('view').innerHTML = head + VIEWS[tab]();
    markDirty(dirty);
  }

  function load(keepMsg) {
    return api('GET', '/api/state').then(function (st) {
      S = st;
      draft = clone(S.scopes[scope].data);
      dirty = false;
      if (!keepMsg) message('', '');
      render();
    }).catch(function (e) { message('bad', esc(e.message)); });
  }

  function save() {
    // Flush JSON editors first, so a half-typed value isn't silently lost.
    var bad = false;
    document.querySelectorAll('[data-json]').forEach(function (el) { if (!applyJson(el)) bad = true; });
    if (bad) return message('bad', 'Fix the JSON errors before saving.');
    $('save').disabled = true;
    api('PUT', '/api/settings/' + scope, draft).then(function (r) {
      S = r.state;
      draft = clone(S.scopes[scope].data);
      dirty = false;
      message('ok', 'Saved to <code>' + esc(r.saved) + '</code>. Jarvis picks most changes up on the next message; MCP servers need a restart.');
      render();
    }).catch(function (e) {
      message('bad', esc(e.message) + (e.details ? '<ul>' + e.details.map(function (d) { return '<li>' + esc(d) + '</li>'; }).join('') + '</ul>' : ''));
    }).then(function () { $('save').disabled = false; });
  }

  function applyJson(el) {
    var path = el.getAttribute('data-json');
    var err = document.querySelector('[data-jsonerr="' + path + '"]');
    var text = el.value.trim();
    if (!text) { set(path, undefined); err.textContent = ''; return true; }
    try {
      var v = JSON.parse(text);
      if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('must be a JSON object { … }');
      set(path, v);
      err.textContent = '';
      return true;
    } catch (e) {
      err.textContent = 'Invalid JSON: ' + e.message;
      err.style.color = 'var(--bad)';
      return false;
    }
  }

  // ---- events (delegated, so re-rendering doesn't need re-binding) ----
  document.addEventListener('input', function (ev) {
    var el = ev.target;
    var path = el.getAttribute('data-path');
    if (path) {
      var kind = el.getAttribute('data-kind');
      var v = el.value;
      if (kind === 'lines') set(path, lines(v));
      else if (kind === 'number') set(path, v === '' ? undefined : Number(v));
      else set(path, v.trim());
      return;
    }
    var desc = el.getAttribute('data-desc');
    if (desc) {
      var d = clone(get('tools.descriptions'));
      if (el.value.trim()) d[desc] = el.value.trim(); else delete d[desc];
      set('tools.descriptions', d);
      return;
    }
    if (el.hasAttribute('data-json') || el.id === 'rawText') markDirty(true);
  });

  document.addEventListener('change', function (ev) {
    var el = ev.target;
    var tool = el.getAttribute('data-tool');
    if (tool) {
      var list = (get('tools.disabled') || []).filter(function (n) { return n !== tool; });
      if (!el.checked) list.push(tool);
      set('tools.disabled', list);
    }
    if (el.hasAttribute('data-json')) applyJson(el);
  });

  document.addEventListener('click', function (ev) {
    var el = ev.target.closest('button');
    if (!el) return;
    if (el.dataset.tab) {
      document.querySelectorAll('[data-json]').forEach(applyJson);
      tab = el.dataset.tab;
      render();
    } else if (el.id === 'loadModels') {
      el.disabled = true;
      el.textContent = 'Loading…';
      api('GET', '/api/models').then(function (r) {
        models = r.models;
        if (r.errors.length) message('warn', 'Some providers could not list models:<ul>' + r.errors.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>');
        render();
      }).catch(function (e) { message('bad', esc(e.message)); render(); });
    } else if (el.dataset.savekey) {
      var name = el.dataset.savekey;
      var input = document.querySelector('[data-key="' + name + '"]');
      el.disabled = true;
      el.textContent = 'Checking…';
      api('POST', '/api/keys/' + encodeURIComponent(name), { key: input.value }).then(function (r) {
        S.providers = r.state.providers;
        message('ok', 'Key for ' + esc(name) + ' works and was saved to your ' + esc(r.saved) + '.');
        render();
      }).catch(function (e) { message('bad', esc(e.message)); el.disabled = false; el.textContent = 'Save key'; });
    } else if (el.dataset.delkey) {
      var p = el.dataset.delkey;
      if (!confirm('Remove the stored key for ' + p + '?')) return;
      api('DELETE', '/api/keys/' + encodeURIComponent(p)).then(function (r) {
        S.providers = r.state.providers;
        message('ok', 'Removed the stored key for ' + esc(p) + '.');
        render();
      }).catch(function (e) { message('bad', esc(e.message)); });
    } else if (el.dataset.example) {
      var ta = document.querySelector('[data-json="' + el.dataset.example + '"]');
      ta.value = ta.getAttribute('placeholder');
      applyJson(ta);
    } else if (el.id === 'trust') {
      if (!confirm('Trust ' + S.cwd + '? Its .jarvis settings will be able to run hooks and MCP servers.')) return;
      api('POST', '/api/trust').then(function (r) {
        S = r.state;
        message('ok', 'Folder trusted.');
        render();
      }).catch(function (e) { message('bad', esc(e.message)); });
    } else if (el.id === 'rawApply') {
      try {
        var v = JSON.parse($('rawText').value || '{}');
        if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('must be a JSON object');
        draft = v;
        markDirty(true);
        $('rawErr').textContent = 'Applied. Click Save to write it.';
      } catch (e) {
        $('rawErr').textContent = 'Invalid JSON: ' + e.message;
      }
    }
  });

  $('save').addEventListener('click', save);
  $('revert').addEventListener('click', function () { if (!dirty || confirm('Discard unsaved changes?')) load(); });
  $('scope').addEventListener('change', function (ev) {
    if (dirty && !confirm('Discard unsaved changes in this file?')) { ev.target.value = scope; return; }
    scope = ev.target.value;
    draft = clone(S.scopes[scope].data);
    dirty = false;
    message('', '');
    render();
  });
  window.addEventListener('beforeunload', function (ev) { if (dirty) { ev.preventDefault(); ev.returnValue = ''; } });
  document.addEventListener('keydown', function (ev) {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 's') { ev.preventDefault(); save(); }
  });

  if (!TOKEN) message('bad', 'This page needs the link printed by <code>jarvis ui</code> (it contains a one-time token).');
  load(!TOKEN);
})();
</script>
</body>
</html>`;
