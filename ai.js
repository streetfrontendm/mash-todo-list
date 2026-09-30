/* ==========================================================================
   ai.js — the assistant layer.
   • Talks to any OpenAI-compatible /chat/completions endpoint (bring your own key).
   • Falls back to the offline nlp.localAssistant when there is no key or the
     request fails, so the assistant always works.
   • Applies model-proposed changes through a small, validated action schema.
   Exposed as window.TodoAI.ai.
   ========================================================================== */
(function () {
  'use strict';

  var NS = (window.TodoAI = window.TodoAI || {});
  var dates = NS.dates;
  var todos = NS.todos;
  var nlp = NS.nlp;

  var CONFIG_KEY = 'todo-ai.ai.v1';
  var MAX_ACTIONS = 40;
  var REQUEST_TIMEOUT_MS = 45000;

  var PRESETS = {
    openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', needsKey: true },
    openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini', needsKey: true },
    groq: { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', needsKey: true },
    ollama: { label: 'Ollama', baseUrl: 'http://localhost:11434/v1', model: 'llama3.2', needsKey: false },
    custom: { label: 'Custom', baseUrl: '', model: '', needsKey: false },
    local: { label: 'Local mode', baseUrl: '', model: '', needsKey: false }
  };

  /* --------------------------------------------------------------- config */

  function defaultConfig() {
    return {
      provider: 'local',
      baseUrl: '',
      model: '',
      apiKey: '',
      autoApply: true,
      history: []
    };
  }

  function loadConfig(storage) {
    var store = storage || NS.makeStorage();
    var cfg = defaultConfig();
    try {
      var raw = store.get(CONFIG_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        Object.keys(cfg).forEach(function (key) {
          if (parsed && parsed[key] !== undefined) cfg[key] = parsed[key];
        });
      }
    } catch (err) { /* corrupt config: start fresh */ }
    if (!Array.isArray(cfg.history)) cfg.history = [];
    if (cfg.history.length > 40) cfg.history = cfg.history.slice(-40);
    return cfg;
  }

  function saveConfig(config, storage) {
    var store = storage || NS.makeStorage();
    var ok = store.set(CONFIG_KEY, JSON.stringify(config));
    return ok || !store.persistent;
  }

  /** Fill blank fields from the provider preset. */
  function resolveEndpoint(config) {
    var preset = PRESETS[config.provider] || PRESETS.custom;
    var baseUrl = String(config.baseUrl || preset.baseUrl || '').replace(/\/+$/, '');
    return {
      provider: config.provider,
      label: preset.label,
      baseUrl: baseUrl,
      model: String(config.model || preset.model || ''),
      apiKey: String(config.apiKey || ''),
      needsKey: preset.needsKey,
      autoApply: config.autoApply !== false
    };
  }

  function isEnabled(config) {
    var ep = resolveEndpoint(config);
    if (config.provider === 'local' || !ep.baseUrl) return false;
    if (ep.needsKey && !ep.apiKey) return false;
    return true;
  }

  function statusLabel(config) {
    var ep = resolveEndpoint(config);
    if (!isEnabled(config)) return { mode: 'local', text: 'Local mode' };
    return { mode: 'online', text: ep.label + ' · ' + ep.model };
  }

  /* --------------------------------------------------------------- prompt */

  var SCHEMA = [
    '{"reply": "short human answer, plain text",',
    ' "actions": [',
    '   {"type": "add", "title": "string", "priority": "low|medium|high", "due": "YYYY-MM-DD or null", "tags": ["string"], "repeat": "daily|weekly|null", "notes": "string"},',
    '   {"type": "add", "items": [{"title": "string", "priority": "low|medium|high", "due": "YYYY-MM-DD or null", "tags": [], "repeat": null}]},',
    '   {"type": "update", "ref": "task id or distinctive title text", "patch": {"title": "string", "due": "YYYY-MM-DD or null", "priority": "low|medium|high", "tags": [], "notes": "string", "repeat": "daily|weekly|null"}},',
    '   {"type": "complete", "ref": "task id or title text"},',
    '   {"type": "delete", "ref": "task id or title text"},',
    '   {"type": "clear_completed"}',
    ' ]}'
  ].join('\n');

  function serializeTodos(list, now) {
    if (!list.length) return '(the list is empty)';
    return list.map(function (t) {
      return '- id=' + t.id + ' | "' + t.title + '" | priority=' + t.priority +
        ' | due=' + (t.due || 'none') + (t.due ? ' (' + dates.humanDue(t.due, now) + ')' : '') +
        ' | tags=' + (t.tags.length ? t.tags.join(',') : 'none') +
        ' | repeat=' + (t.repeat || 'none') +
        ' | status=' + (t.done ? 'done' : 'open');
    }).join('\n');
  }

  function buildSystemPrompt(store, now) {
    var list = store.list();
    var stat = todos.stats(list, now);
    return [
      'You are the assistant inside a small todo-list web app. You can read the list and',
      'propose changes to it. Today is ' + dates.todayISO(now) + '.',
      '',
      'Always answer with a single JSON object and nothing else, in this shape:',
      SCHEMA,
      '',
      'Rules:',
      '- Prefer "ref" with the task id; a distinctive fragment of the title also works.',
      '- Only include actions the user actually asked for; never invent tasks.',
      '- Keep "reply" to at most 3 short sentences: it renders in a narrow chat panel.',
      '- For pure questions ("what should I do first?") return "actions": [] and answer in "reply".',
      '- Resolve relative dates against today (' + dates.todayISO(now) + ') and use YYYY-MM-DD.',
      '- Never delete more than 5 tasks in one turn; ask for confirmation instead.',
      '',
      'Current list (' + stat.active + ' open, ' + stat.done + ' done, ' + stat.overdue + ' overdue):',
      serializeTodos(list, now)
    ].join('\n');
  }

  function buildMessages(history, store, now) {
    var messages = [{ role: 'system', content: buildSystemPrompt(store, now) }];
    (history || []).slice(-12).forEach(function (turn) {
      if (!turn || typeof turn.content !== 'string') return;
      if (turn.role !== 'user' && turn.role !== 'assistant') return;
      messages.push({ role: turn.role, content: turn.content });
    });
    return messages;
  }


  /* ---------------------------------------------------- reply decoding --- */

  /** Pull the first balanced JSON object out of a model reply. */
  function extractJson(text) {
    var src = String(text || '');
    var fenced = src.match(/```(?:json)?\s*([\s\S]*?)```/i);
    var candidate = fenced ? fenced[1] : src;
    var start = candidate.indexOf('{');
    if (start === -1) return null;
    var depth = 0, inString = false, escaped = false;
    for (var i = start; i < candidate.length; i++) {
      var ch = candidate.charAt(i);
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(candidate.slice(start, i + 1)); }
          catch (err) { return null; }
        }
      }
    }
    return null;
  }

  /**
   * Normalise a model reply into {reply, actions}.
   * Handles strict JSON, fenced JSON, a bare action array and plain prose.
   */
  function parseReply(text) {
    var raw = String(text == null ? '' : text).trim();
    if (!raw) return { reply: '', actions: [], parsed: false };

    var data = extractJson(raw);
    if (!data) {
      var arr = raw.match(/\[[\s\S]*\]/);
      if (arr) {
        try { data = { actions: JSON.parse(arr[0]) }; } catch (err) { data = null; }
      }
    }
    if (!data) return { reply: raw, actions: [], parsed: false };

    var reply = typeof data.reply === 'string' ? data.reply
      : (typeof data.message === 'string' ? data.message : '');
    var actions = Array.isArray(data.actions) ? data.actions : [];
    if (!reply && !actions.length && typeof data.type === 'string') actions = [data];
    return { reply: reply.trim(), actions: actions.slice(0, MAX_ACTIONS), parsed: true };
  }

  function validDue(value) {
    if (value === null || value === undefined || value === '') return null;
    var text = String(value).trim();
    if (dates.isISODate(text)) return text;
    return nlp.parseDate(text, new Date()).due || null;
  }

  /** Drop malformed actions and clamp values before anything touches the store. */
  function validateActions(actions) {
    var out = [];
    var allowed = { add: 1, update: 1, complete: 1, delete: 1, clear_completed: 1 };
    (Array.isArray(actions) ? actions : []).slice(0, MAX_ACTIONS).forEach(function (action) {
      if (!action || typeof action !== 'object') return;
      var type = String(action.type || '').toLowerCase().replace(/[\s-]/g, '_');
      if (!allowed[type]) return;
      if (type === 'clear_completed') { out.push({ type: 'clear_completed' }); return; }

      var ref = action.ref != null ? String(action.ref) : (action.id != null ? String(action.id) : '');
      var ids = Array.isArray(action.ids) ? action.ids.map(String) : null;
      var all = !!action.all;

      if (type === 'add') {
        var items = Array.isArray(action.items) ? action.items : [action];
        var clean = items.slice(0, 20).map(function (item) {
          return {
            title: String(item.title == null ? '' : item.title).trim(),
            priority: item.priority,
            due: validDue(item.due),
            tags: item.tags,
            repeat: item.repeat,
            notes: item.notes
          };
        }).filter(function (item) { return item.title; });
        if (clean.length) out.push({ type: 'add', items: clean, label: action.label });
        return;
      }

      var patch = {};
      if (type === 'update') {
        var source = (action.patch && typeof action.patch === 'object') ? action.patch : action;
        if (source.title != null) patch.title = String(source.title).trim();
        if (source.notes != null) patch.notes = String(source.notes);
        if (source.priority != null) patch.priority = source.priority;
        if (source.tags != null) patch.tags = source.tags;
        if (source.repeat !== undefined) patch.repeat = source.repeat;
        if (source.due !== undefined) patch.due = validDue(source.due);
        if (typeof source.done === 'boolean') patch.done = source.done;
        if (!Object.keys(patch).length) return;
      }

      if (!ref && !ids && !all) return;
      out.push({ type: type, ref: ref, ids: ids, all: all, patch: patch, label: action.label });
    });
    return out;
  }

  /* ------------------------------------------------- applying actions ---- */

  function describeUpdate(patch, now) {
    var bits = [];
    if (patch.due !== undefined) bits.push('due ' + (patch.due ? patch.due : 'cleared'));
    if (patch.priority) bits.push(patch.priority + ' priority');
    if (patch.title) bits.push('renamed');
    if (patch.tags) bits.push('tags');
    if (patch.repeat) bits.push(patch.repeat);
    if (patch.notes) bits.push('notes');
    if (typeof patch.done === 'boolean') bits.push(patch.done ? 'done' : 'reopened');
    return bits.join(', ') || 'updated';
  }

  function targetsFor(action, store, now) {
    if (action.ids && action.ids.length) {
      return action.ids.map(function (id) { return store.get(id); }).filter(Boolean);
    }
    if (!action.ref) return action.all ? store.list().filter(function (t) { return !t.done; }) : [];
    return nlp.selectTodos(action.ref, store, now, { all: !!action.all }).todos;
  }

  /**
   * Execute validated actions against the store.
   * @returns {{applied: Array, errors: Array, changed: boolean}}
   */
  function applyActions(store, actions, now) {
    var clean = validateActions(actions);
    var applied = [];
    var errors = [];

    clean.forEach(function (action) {
      if (action.type === 'clear_completed') {
        var cleared = store.clearCompleted();
        if (cleared.length) applied.push({ type: 'clear_completed', text: 'Cleared ' + cleared.length + ' completed task(s)' });
        return;
      }

      if (action.type === 'add') {
        var added = store.addMany(action.items, now);
        added.forEach(function (todo) {
          applied.push({
            type: 'add',
            text: 'Added "' + todo.title + '"' +
              (todo.due ? ' for ' + dates.humanDue(todo.due, now).toLowerCase() : '') +
              (todo.priority !== 'medium' ? ' (' + todo.priority + ')' : '')
          });
        });
        if (!added.length) errors.push({ action: action, message: 'Nothing to add' });
        return;
      }

      var targets = targetsFor(action, store, now);
      if (!targets.length) {
        errors.push({ action: action, message: 'No task matched "' + (action.label || action.ref || '') + '"' });
        return;
      }

      targets.forEach(function (todo) {
        if (action.type === 'complete') {
          store.setDone(todo.id, true, now);
          var after = store.get(todo.id);
          applied.push({
            type: 'complete',
            text: after && after.repeat
              ? 'Completed "' + todo.title + '" — next one due ' + after.due
              : 'Completed "' + todo.title + '"'
          });
        } else if (action.type === 'delete') {
          store.remove(todo.id);
          applied.push({ type: 'delete', text: 'Deleted "' + todo.title + '"' });
        } else if (action.type === 'update') {
          var next = store.update(todo.id, action.patch, now);
          if (next) {
            applied.push({ type: 'update', text: 'Updated "' + todo.title + '" — ' + describeUpdate(action.patch, now) });
          }
        }
      });
    });

    return { applied: applied, errors: errors, changed: applied.length > 0 };
  }


  /* --------------------------------------------------------------- network */

  function friendlyError(err) {
    var message = (err && err.message) ? err.message : String(err);
    if (/abort/i.test(message)) return 'The request timed out after ' + Math.round(REQUEST_TIMEOUT_MS / 1000) + 's.';
    if (/failed to fetch|networkerror|load failed/i.test(message)) {
      return 'Could not reach the endpoint. Check the URL, your connection, and that the ' +
        'provider allows browser (CORS) requests — local servers such as Ollama need ' +
        'OLLAMA_ORIGINS set, e.g. OLLAMA_ORIGINS="*".';
    }
    return message;
  }

  /** POST to an OpenAI-compatible /chat/completions endpoint. Resolves with the text. */
  function postChat(endpoint, messages, options) {
    options = options || {};
    var fetchImpl = options.fetchImpl || (typeof window !== 'undefined' ? window.fetch : null);
    if (!fetchImpl) return Promise.reject(new Error('fetch() is unavailable in this browser'));

    var headers = { 'Content-Type': 'application/json' };
    if (endpoint.apiKey) headers.Authorization = 'Bearer ' + endpoint.apiKey;
    if (endpoint.provider === 'openrouter') {
      try { headers['HTTP-Referer'] = window.location.origin; } catch (err) { /* opaque origin */ }
      headers['X-Title'] = 'Mash Todo List';
    }

    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS) : null;

    var body = {
      model: endpoint.model,
      messages: messages,
      temperature: options.temperature == null ? 0.2 : options.temperature,
      max_tokens: options.maxTokens || 900,
      stream: false
    };

    return fetchImpl(endpoint.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body),
      signal: controller ? controller.signal : undefined
    }).then(function (response) {
      return response.text().then(function (text) {
        if (!response.ok) {
          throw new Error('HTTP ' + response.status + ': ' + String(text).slice(0, 240));
        }
        var data;
        try { data = JSON.parse(text); }
        catch (err) { throw new Error('The endpoint returned something that is not JSON'); }
        var choice = data && data.choices && data.choices[0];
        var content = choice && choice.message && choice.message.content;
        if (typeof content !== 'string' || !content.trim()) {
          throw new Error('The endpoint returned no message content');
        }
        return content;
      });
    }).then(function (content) {
      if (timer) clearTimeout(timer);
      return content;
    }, function (err) {
      if (timer) clearTimeout(timer);
      throw err;
    });
  }

  /* ------------------------------------------------------------ orchestrator */

  /**
   * One assistant turn. Uses the configured model when available and otherwise
   * (or on failure) answers with the offline engine.
   * @returns {Promise<{source, reply, actions, intent?, error?, raw?}>}
   */
  function ask(options) {
    options = options || {};
    var config = options.config || defaultConfig();
    var store = options.store;
    var now = options.now || new Date();
    var text = String(options.text || '');
    var history = (options.history || []).concat([{ role: 'user', content: text }]);

    function localAnswer(error) {
      var result = nlp.localAssistant(text, store, now);
      return {
        source: 'local',
        intent: result.intent,
        reply: result.reply,
        actions: result.actions,
        error: error || null
      };
    }

    if (!isEnabled(config)) return Promise.resolve(localAnswer(null));

    var endpoint = resolveEndpoint(config);
    return postChat(endpoint, buildMessages(history, store, now), options)
      .then(function (content) {
        var parsed = parseReply(content);
        return {
          source: 'remote',
          reply: parsed.reply || 'Done.',
          actions: parsed.actions,
          raw: content,
          error: null
        };
      })
      .catch(function (err) {
        return localAnswer(friendlyError(err));
      });
  }

  function testConnection(config, options) {
    var endpoint = resolveEndpoint(config);
    if (!isEnabled(config)) {
      return Promise.resolve({ ok: false, message: 'Nothing to test: that is local mode or the endpoint/model is incomplete.' });
    }
    return postChat(endpoint, [
      { role: 'user', content: 'Reply with exactly: ok' }
    ], Object.assign({}, options, { maxTokens: 8 }))
      .then(function () {
        return { ok: true, message: 'Connected to ' + endpoint.label + ' using ' + endpoint.model + '.' };
      })
      .catch(function (err) {
        return { ok: false, message: friendlyError(err) };
      });
  }

  NS.ai = {
    PRESETS: PRESETS,
    CONFIG_KEY: CONFIG_KEY,
    defaultConfig: defaultConfig,
    loadConfig: loadConfig,
    saveConfig: saveConfig,
    resolveEndpoint: resolveEndpoint,
    isEnabled: isEnabled,
    statusLabel: statusLabel,
    buildSystemPrompt: buildSystemPrompt,
    buildMessages: buildMessages,
    extractJson: extractJson,
    parseReply: parseReply,
    validateActions: validateActions,
    applyActions: applyActions,
    postChat: postChat,
    friendlyError: friendlyError,
    ask: ask,
    testConnection: testConnection
  };
}());
