/* ==========================================================================
   app.js — DOM wiring: rendering, events, settings, chat panel.
   Depends on store.js, nlp.js and ai.js (loaded first, as plain scripts).
   ========================================================================== */
(function () {
  'use strict';

  var NS = window.TodoAI;
  var dates = NS.dates;
  var todoUtils = NS.todos;
  var nlp = NS.nlp;
  var ai = NS.ai;

  var store = NS.createStore();
  var SEED_KEY = 'todo-ai.seeded.v1';

  var state = {
    filter: 'all',
    search: '',
    sort: 'smart',
    config: ai.loadConfig(),
    busy: false,
    editingId: null,
    activeId: null,
    helpOpen: false
  };

  var els = {};
  ['quick-add-form', 'quick-add', 'task-list', 'empty-state', 'items-left', 'search', 'sort',
    'btn-undo', 'btn-clear-done', 'btn-export', 'btn-import', 'file-import', 'btn-settings',
    'btn-shortcuts', 'shortcut-help', 'chat-log', 'chat-form', 'chat-input', 'btn-send',
    'ai-status', 'settings-modal', 'settings-form', 'provider', 'base-url', 'model', 'api-key',
    'auto-apply', 'btn-test', 'settings-status', 'toast'].forEach(function (id) {
      els[id] = document.getElementById(id);
    });

  /* ------------------------------------------------------------- helpers -- */

  function el(tag, props, children) {
    var node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (key) {
        if (key === 'class') node.className = props[key];
        else if (key === 'text') node.textContent = props[key];
        else if (props[key] === true) node.setAttribute(key, '');
        else if (props[key] !== false && props[key] != null) node.setAttribute(key, props[key]);
      });
    }
    (children || []).forEach(function (child) {
      if (child) node.appendChild(child);
    });
    return node;
  }

  var toastTimer = null;
  function toast(message, ms) {
    els.toast.textContent = message;
    els.toast.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.hidden = true; }, ms || 3200);
  }

  function nowDate() { return new Date(); }

  function pluralise(count, one, many) {
    return count + ' ' + (count === 1 ? one : (many || one + 's'));
  }

  /* ------------------------------------------------------------ rendering -- */

  function dueBadge(todo, now) {
    if (!todo.due) return null;
    var tone = dates.dueTone(todo.due, now) || 'later';
    return el('span', { class: 'due', 'data-tone': tone, title: todo.due },
      [document.createTextNode(dates.humanDue(todo.due, now))]);
  }

  function renderTask(todo, now) {
    var item = el('li', {
      class: 'task' + (todo.done ? ' is-done' : '') + (state.activeId === todo.id ? ' is-active' : ''),
      'data-id': todo.id,
      tabindex: '-1'
    });

    var checkbox = el('input', {
      type: 'checkbox',
      class: 'task-check',
      'data-action': 'toggle',
      'aria-label': (todo.done ? 'Reopen ' : 'Complete ') + todo.title
    });
    checkbox.checked = todo.done;

    var main = el('div', { class: 'task-main' });
    main.appendChild(el('div', { class: 'task-title', text: todo.title }));

    var meta = el('div', { class: 'task-meta' });
    var badge = dueBadge(todo, now);
    if (badge) meta.appendChild(badge);
    meta.appendChild(el('span', { class: 'prio', 'data-priority': todo.priority, text: todo.priority }));
    if (todo.repeat) meta.appendChild(el('span', { class: 'tag repeat', text: '↻ ' + todo.repeat }));
    todo.tags.forEach(function (tag) {
      meta.appendChild(el('span', { class: 'tag', text: '#' + tag }));
    });
    if (todo.notes) meta.appendChild(el('span', { class: 'muted', text: todo.notes }));
    if (meta.childNodes.length) main.appendChild(meta);

    if (state.editingId === todo.id) main.appendChild(renderEditor(todo));

    var actions = el('div', { class: 'task-actions' });
    actions.appendChild(el('button', {
      type: 'button', 'data-action': 'edit', title: 'Edit task',
      'aria-label': 'Edit ' + todo.title
    }, [document.createTextNode(state.editingId === todo.id ? '✕' : '✎')]));
    actions.appendChild(el('button', {
      type: 'button', class: 'danger', 'data-action': 'delete', title: 'Delete task',
      'aria-label': 'Delete ' + todo.title
    }, [document.createTextNode('🗑')]));

    item.appendChild(checkbox);
    item.appendChild(main);
    item.appendChild(actions);
    return item;
  }

  function renderEditor(todo) {
    var row = el('div', { class: 'task-edit-row' });

    var title = el('input', { type: 'text', 'data-field': 'title', value: todo.title, 'aria-label': 'Task title' });
    var priority = el('select', { 'data-field': 'priority', 'aria-label': 'Priority' });
    todoUtils.PRIORITIES.slice().reverse().forEach(function (level) {
      var option = el('option', { value: level, text: level });
      option.selected = level === todo.priority;
      priority.appendChild(option);
    });
    var due = el('input', { type: 'date', 'data-field': 'due', value: todo.due || '', 'aria-label': 'Due date' });
    var tags = el('input', { type: 'text', 'data-field': 'tags', value: todo.tags.join(', '), 'aria-label': 'Tags' });
    var save = el('button', { type: 'button', class: 'btn btn-primary', 'data-action': 'save-edit' },
      [document.createTextNode('Save')]);
    var cancel = el('button', { type: 'button', class: 'btn btn-ghost', 'data-action': 'cancel-edit' },
      [document.createTextNode('Cancel')]);

    row.appendChild(title);
    row.appendChild(priority);
    row.appendChild(due);
    row.appendChild(tags);
    row.appendChild(save);
    row.appendChild(cancel);
    return row;
  }

  function emptyMessage() {
    switch (state.filter) {
      case 'active': return 'Nothing open. Enjoy it. 🎉';
      case 'done': return 'No completed tasks yet.';
      case 'today': return 'Nothing due today.';
      default: return state.search ? 'No task matches "' + state.search + '".' : 'No tasks yet — add one above.';
    }
  }

  function render() {
    var now = nowDate();
    var visible = todoUtils.sortTodos(
      todoUtils.filterTodos(store.list(), { filter: state.filter, search: state.search }, now),
      state.sort, now);

    els['task-list'].textContent = '';
    visible.forEach(function (todo) {
      els['task-list'].appendChild(renderTask(todo, now));
    });

    els['empty-state'].hidden = visible.length > 0;
    els['empty-state'].textContent = emptyMessage();

    var stat = todoUtils.stats(store.list(), now);
    Array.prototype.forEach.call(document.querySelectorAll('[data-count]'), function (node) {
      var key = node.getAttribute('data-count');
      node.textContent = key === 'today' ? String(stat.today) : String(stat[key]);
    });

    els['items-left'].textContent = stat.all === 0 ? 'No tasks'
      : pluralise(stat.active, 'task') + ' left · ' + stat.done + ' done' +
        (stat.overdue ? ' · ' + stat.overdue + ' overdue' : '');

    els['btn-undo'].disabled = !store.canUndo();
    els['btn-undo'].title = store.canUndo() ? 'Undo ' + store.undoLabel() : 'Nothing to undo';
    els['btn-clear-done'].disabled = stat.done === 0;

    if (state.editingId) {
      var field = els['task-list'].querySelector('.task[data-id="' + state.editingId + '"] [data-field="title"]');
      if (field) { field.focus(); field.select(); }
    }

    applyHighlight(false);
  }

  /* ------------------------------------------------------ keyboard nav --- */

  function visibleTaskIds() {
    return Array.prototype.map.call(els['task-list'].children, function (li) {
      return li.getAttribute('data-id');
    });
  }

  /** Paint the selected row. Called on every render, and after moving with j/k. */
  function applyHighlight(focus) {
    var ids = visibleTaskIds();
    if (state.activeId && ids.indexOf(state.activeId) === -1) state.activeId = null;

    Array.prototype.forEach.call(els['task-list'].children, function (li) {
      var on = state.activeId !== null && li.getAttribute('data-id') === state.activeId;
      li.classList.toggle('is-active', on);
      if (on && focus) {
        try { li.focus({ preventScroll: true }); } catch (err) { li.focus(); }
        if (li.scrollIntoView) li.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  function moveHighlight(delta) {
    var ids = visibleTaskIds();
    if (!ids.length) {
      toast('There is nothing to select.');
      return null;
    }
    var index = ids.indexOf(state.activeId);
    var next = index === -1 ? (delta > 0 ? 0 : ids.length - 1) : index + delta;
    if (next < 0) next = ids.length - 1;
    if (next >= ids.length) next = 0;
    state.activeId = ids[next];
    applyHighlight(true);
    return store.get(state.activeId);
  }

  function selectedTodo() {
    return state.activeId ? store.get(state.activeId) : null;
  }

  /** Selected task, else the first visible one (so "x" works without pressing j first). */
  function targetTodo() {
    var todo = selectedTodo();
    if (todo) return todo;
    var ids = visibleTaskIds();
    return ids.length ? store.get(ids[0]) : null;
  }

  function toggleSelected() {
    var todo = targetTodo();
    if (!todo) { toast('No task to toggle.'); return; }
    state.activeId = todo.id;
    store.toggle(todo.id, nowDate());
    applyHighlight(false);
  }

  function editSelected() {
    var todo = targetTodo();
    if (!todo) { toast('No task to edit.'); return; }
    state.activeId = todo.id;
    state.editingId = todo.id;
    render();
  }

  function deleteSelected() {
    var todo = selectedTodo();
    if (!todo) { toast('Select a task with j or k first.'); return; }
    store.remove(todo.id);
    state.activeId = null;
    toast('Deleted "' + todo.title + '" — Undo restores it.');
  }

  function toggleHelp(force) {
    var open = force === undefined ? els['shortcut-help'].hidden : !!force;
    els['shortcut-help'].hidden = !open;
    state.helpOpen = open;
    els['btn-shortcuts'].setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function isTypingTarget(node) {
    if (!node || !node.tagName) return false;
    var tag = node.tagName.toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable === true;
  }

  /* --------------------------------------------------------- chat panel -- */

  function addMessage(role, text, options) {
    options = options || {};
    var body = el('div', { class: 'msg-body' });
    String(text || '').split('\n').forEach(function (line) {
      body.appendChild(el('p', { text: line }));
    });

    var msg = el('div', {
      class: 'msg msg-' + role + (options.className ? ' ' + options.className : '')
    }, [body]);
    if (options.thinking) msg.setAttribute('data-thinking', 'true');

    els['chat-log'].appendChild(msg);
    els['chat-log'].scrollTop = els['chat-log'].scrollHeight;
    return msg;
  }

  function removeThinking() {
    Array.prototype.forEach.call(els['chat-log'].querySelectorAll('[data-thinking="true"]'), function (node) {
      node.parentNode.removeChild(node);
    });
  }

  function describeApplied(result) {
    var list = el('ul', { class: 'applied' });
    result.applied.forEach(function (entry) {
      list.appendChild(el('li', { class: 'ok', text: entry.text }));
    });
    result.errors.forEach(function (entry) {
      list.appendChild(el('li', { text: 'Skipped: ' + entry.message }));
    });
    return list.childNodes.length ? list : null;
  }

  function pushHistory(role, content) {
    state.config.history = (state.config.history || []).concat([{ role: role, content: content }]);
    if (state.config.history.length > 40) {
      state.config.history = state.config.history.slice(-40);
    }
    ai.saveConfig(state.config);
  }

  function updateAiStatus(extra) {
    var status = ai.statusLabel(state.config);
    els['ai-status'].textContent = extra || status.text;
    els['ai-status'].setAttribute('data-mode', extra ? 'busy' : status.mode);
  }

  function renderPendingActions(msg, actions) {
    var body = msg.querySelector('.msg-body');
    var wrapped = ai.validateActions(actions);
    var row = el('div', { class: 'task-edit-row', 'data-pending': 'true' });
    var apply = el('button', { type: 'button', class: 'btn btn-primary', 'data-action': 'apply-actions' },
      [document.createTextNode('Apply ' + pluralise(wrapped.length, 'change'))]);
    var dismiss = el('button', { type: 'button', class: 'btn btn-ghost', 'data-action': 'dismiss-actions' },
      [document.createTextNode('Dismiss')]);

    apply.addEventListener('click', function () {
      var outcome = ai.applyActions(store, actions, nowDate());
      var summary = describeApplied(outcome);
      if (summary) body.appendChild(summary);
      row.parentNode.removeChild(row);
      toast(pluralise(outcome.applied.length, 'change') + ' applied');
    });
    dismiss.addEventListener('click', function () {
      row.parentNode.removeChild(row);
      body.appendChild(el('p', { class: 'muted small', text: 'Suggestion dismissed — nothing changed.' }));
    });

    row.appendChild(apply);
    row.appendChild(dismiss);
    body.appendChild(row);
    els['chat-log'].scrollTop = els['chat-log'].scrollHeight;
  }

  function send(text) {
    var message = String(text == null ? '' : text).trim();
    if (!message || state.busy) return;

    var history = (state.config.history || []).slice();
    state.busy = true;
    els['btn-send'].disabled = true;
    updateAiStatus('Thinking…');

    addMessage('user', message);
    pushHistory('user', message);
    addMessage('assistant', 'Thinking…', { thinking: true, className: 'is-thinking' });

    var payload = {
      text: message,
      config: state.config,
      store: store,
      now: nowDate(),
      history: history
    };

    ai.ask(payload).then(function (result) {
      removeThinking();
      var notes = [];
      if (result.source === 'local' && ai.isEnabled(state.config)) notes.push('Remote request failed, so this answer came from the offline engine.');
      else if (result.source === 'local') notes.push('Offline answer — no API key configured.');

      var msg = addMessage('assistant', result.reply || 'Done.');
      var body = msg.querySelector('.msg-body');

      if (result.actions && result.actions.length) {
        if (state.config.autoApply !== false) {
          var outcome = ai.applyActions(store, result.actions, nowDate());
          var summary = describeApplied(outcome);
          if (summary) body.appendChild(summary);
        } else {
          renderPendingActions(msg, result.actions);
        }
      }

      if (result.error) notes.push(result.error);
      if (notes.length) body.appendChild(el('p', { class: 'muted small', text: notes.join(' ') }));

      pushHistory('assistant', result.reply || 'Done.');
    }).then(function () {
      state.busy = false;
      els['btn-send'].disabled = false;
      updateAiStatus();
    }, function (err) {
      removeThinking();
      state.busy = false;
      els['btn-send'].disabled = false;
      updateAiStatus();
      addMessage('assistant', 'Something went wrong: ' + (err && err.message ? err.message : String(err)),
        { className: 'is-error' });
    });
  }

  function restoreChatHistory() {
    var history = state.config.history || [];
    if (!history.length) return;
    els['chat-log'].textContent = '';
    history.slice(-10).forEach(function (turn) {
      addMessage(turn.role === 'user' ? 'user' : 'assistant', turn.content);
    });
    addMessage('assistant', 'Continuing where we left off. Reload afterwards to start a fresh chat.');
  }

  /* ------------------------------------------------------------- settings -- */

  function openSettings() {
    var config = state.config;
    var preset = ai.PRESETS[config.provider] || ai.PRESETS.local;
    els.provider.value = config.provider;
    els['base-url'].value = config.baseUrl || preset.baseUrl || '';
    els.model.value = config.model || preset.model || '';
    els['api-key'].value = config.apiKey || '';
    els['auto-apply'].checked = config.autoApply !== false;
    els['settings-status'].textContent = '';
    els['settings-status'].removeAttribute('data-state');
    els['settings-modal'].hidden = false;
    els.provider.focus();
  }

  function closeModal(id) {
    document.getElementById(id).hidden = true;
    if (id === 'settings-modal') els['btn-settings'].focus();
  }

  function setSettingsStatus(message, ok) {
    els['settings-status'].textContent = message;
    els['settings-status'].setAttribute('data-state', ok ? 'ok' : 'error');
  }

  function readSettingsForm() {
    var provider = els.provider.value;
    var preset = ai.PRESETS[provider] || ai.PRESETS.custom;
    return {
      provider: provider,
      baseUrl: els['base-url'].value.trim(),
      model: els.model.value.trim(),
      apiKey: els['api-key'].value,
      autoApply: els['auto-apply'].checked,
      history: state.config.history || []
    };
  }

  function saveSettings(persist) {
    var next = readSettingsForm();
    state.config = next;
    if (persist !== false) {
      var ok = ai.saveConfig(next);
      if (!ok) toast('Settings work for this session, but storage is blocked so they will not persist.', 5000);
    }
    updateAiStatus();
    return next;
  }

  /* --------------------------------------------------------- export/import */

  function download(filename, text) {
    var blob = new Blob([text], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var link = el('a', { href: url, download: filename });
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function importFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var list = null;
      try {
        var parsed = JSON.parse(String(reader.result));
        list = Array.isArray(parsed) ? parsed : (parsed && parsed.todos) || null;
      } catch (err) { list = null; }
      if (!list) { toast('That file is not a Mash Todo List export.'); return; }
      var added = store.mergeAll(list, nowDate());
      toast(added.length ? 'Imported ' + pluralise(added.length, 'task') : 'Nothing new to import.');
    };
    reader.readAsText(file);
  }

  /* ---------------------------------------------------------------- events */

  function taskIdFrom(node) {
    var item = node.closest ? node.closest('.task') : null;
    return item ? item.getAttribute('data-id') : null;
  }

  function saveEditor(node) {
    var id = taskIdFrom(node);
    if (!id) return;
    var row = node.closest('.task-edit-row');
    if (!row) return;
    var title = row.querySelector('[data-field="title"]').value.trim();
    if (!title) { toast('A task needs a title.'); return; }
    store.update(id, {
      title: title,
      priority: row.querySelector('[data-field="priority"]').value,
      due: row.querySelector('[data-field="due"]').value || null,
      tags: row.querySelector('[data-field="tags"]').value
    }, nowDate());
    state.editingId = null;
    render();
  }

  function wireTaskList() {
    var list = els['task-list'];

    list.addEventListener('change', function (event) {
      var target = event.target;
      if (!target || target.getAttribute('data-action') !== 'toggle') return;
      var id = taskIdFrom(target);
      if (id) store.toggle(id, nowDate());
    });

    list.addEventListener('click', function (event) {
      var button = event.target.closest ? event.target.closest('button[data-action]') : null;
      if (!button) return;
      var action = button.getAttribute('data-action');
      var id = taskIdFrom(button);
      if (action === 'edit') {
        state.editingId = state.editingId === id ? null : id;
        render();
      } else if (action === 'delete') {
        var target = store.get(id);
        store.remove(id);
        state.editingId = null;
        if (target) toast('Deleted "' + target.title + '"');
      } else if (action === 'save-edit') {
        saveEditor(button);
      } else if (action === 'cancel-edit') {
        state.editingId = null;
        render();
      }
    });

    list.addEventListener('keydown', function (event) {
      if (!event.target.closest || !event.target.closest('.task-edit-row')) return;
      if (event.key === 'Enter') { event.preventDefault(); saveEditor(event.target); }
      else if (event.key === 'Escape') { state.editingId = null; render(); }
    });
  }

  function wireQuickAdd() {
    els['quick-add-form'].addEventListener('submit', function (event) {
      event.preventDefault();
      var parsed = nlp.parseQuickAdd(els['quick-add'].value, nowDate());
      if (!parsed) return;
      var todo = store.add(parsed, nowDate());
      if (!todo) return;
      els['quick-add'].value = '';
      var extras = [];
      if (todo.due) extras.push(dates.humanDue(todo.due, nowDate()).toLowerCase());
      if (todo.priority !== 'medium') extras.push(todo.priority + ' priority');
      if (todo.repeat) extras.push('repeats ' + todo.repeat);
      toast('Added "' + todo.title + '"' + (extras.length ? ' — ' + extras.join(', ') : ''));
    });
  }

  function wireToolbar() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-filter]'), function (chip) {
      chip.addEventListener('click', function () {
        state.filter = chip.getAttribute('data-filter');
        Array.prototype.forEach.call(document.querySelectorAll('[data-filter]'), function (other) {
          other.classList.toggle('is-active', other === chip);
        });
        render();
      });
    });

    els.search.addEventListener('input', function () {
      state.search = els.search.value;
      render();
    });

    els.sort.addEventListener('change', function () {
      state.sort = els.sort.value;
      render();
    });

    els['btn-clear-done'].addEventListener('click', function () {
      var removed = store.clearCompleted();
      toast(removed.length ? 'Cleared ' + pluralise(removed.length, 'task') : 'Nothing completed to clear.');
    });

    els['btn-undo'].addEventListener('click', function () {
      var label = store.undoLabel();
      var restored = store.undo();
      if (restored) toast('Undone: ' + label);
    });

    els['btn-export'].addEventListener('click', function () {
      download('mash-todo-' + dates.todayISO(nowDate()) + '.json', store.toJSON(true));
      toast('Exported ' + pluralise(store.list().length, 'task'));
    });

    els['btn-import'].addEventListener('click', function () { els['file-import'].click(); });
    els['file-import'].addEventListener('change', function (event) {
      importFile(event.target.files && event.target.files[0]);
      event.target.value = '';
    });
  }

  function wireChat() {
    els['chat-form'].addEventListener('submit', function (event) {
      event.preventDefault();
      var text = els['chat-input'].value;
      els['chat-input'].value = '';
      send(text);
    });

    els['chat-input'].addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        var text = els['chat-input'].value;
        els['chat-input'].value = '';
        send(text);
      }
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-prompt]'), function (chip) {
      chip.addEventListener('click', function () {
        send(chip.getAttribute('data-prompt'));
      });
    });
  }

  function wireSettings() {
    els['btn-settings'].addEventListener('click', openSettings);

    Array.prototype.forEach.call(document.querySelectorAll('[data-close]'), function (node) {
      node.addEventListener('click', function () {
        closeModal(node.getAttribute('data-close'));
      });
    });

    els.provider.addEventListener('change', function () {
      var preset = ai.PRESETS[els.provider.value] || ai.PRESETS.custom;
      els['base-url'].value = preset.baseUrl || '';
      els.model.value = preset.model || '';
      els['base-url'].placeholder = preset.baseUrl || 'https://your-endpoint/v1';
      els.model.placeholder = preset.model || 'model-name';
    });

    els['settings-form'].addEventListener('submit', function (event) {
      event.preventDefault();
      saveSettings(true);
      closeModal('settings-modal');
      toast(ai.isEnabled(state.config)
        ? 'Assistant connected: ' + ai.statusLabel(state.config).text
        : 'Saved. Still in local (offline) mode.');
    });

    els['btn-test'].addEventListener('click', function () {
      var draft = saveSettings(false);
      setSettingsStatus('Testing…', true);
      ai.testConnection(draft).then(function (result) {
        setSettingsStatus(result.message, result.ok);
      });
    });
  }

  function wireKeyboard() {
    els['btn-shortcuts'].addEventListener('click', function () {
      toggleHelp();
      if (state.helpOpen) els['btn-shortcuts'].focus();
    });

    document.addEventListener('keydown', function (event) {
      var modalOpen = !els['settings-modal'].hidden;

      // Escape has to work even while typing, so it is handled before the guard.
      if (event.key === 'Escape') {
        if (modalOpen) { closeModal('settings-modal'); return; }
        if (state.editingId) { state.editingId = null; render(); return; }
        if (state.helpOpen) { toggleHelp(false); return; }
        if (state.activeId) { state.activeId = null; applyHighlight(false); return; }
        return;
      }

      if (modalOpen || isTypingTarget(event.target)) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      // Let focused buttons keep their native Space/Enter activation.
      if ((event.key === ' ' || event.key === 'Enter') &&
          event.target && event.target.closest && event.target.closest('button')) return;

      switch (event.key) {
        case 'j': case 'ArrowDown': event.preventDefault(); moveHighlight(1); break;
        case 'k': case 'ArrowUp': event.preventDefault(); moveHighlight(-1); break;
        case 'n': case '/': event.preventDefault(); els['quick-add'].focus(); break;
        case 'x': case ' ': event.preventDefault(); toggleSelected(); break;
        case 'e': event.preventDefault(); editSelected(); break;
        case 'Delete': case 'Backspace': event.preventDefault(); deleteSelected(); break;
        case '?': case 'h': event.preventDefault(); toggleHelp(); break;
        default: break;
      }
    });
  }

  /* --------------------------------------------------------------- startup */

  function seedIfEmpty() {
    var storage = NS.makeStorage();
    if (store.list().length || storage.get(SEED_KEY)) return;
    var today = dates.todayISO(nowDate());
    store.addMany([
      { title: 'Submit expense report', priority: 'high', due: dates.addDays(today, -1), tags: ['work'] },
      { title: 'Buy groceries for the week', priority: 'medium', due: dates.addDays(today, 1), tags: ['errands'] },
      { title: 'Water the plants', priority: 'low', repeat: 'daily', due: today },
      { title: 'Try the assistant — ask "what should I do first?"', priority: 'low', tags: ['demo'] }
    ], nowDate());
    storage.set(SEED_KEY, new Date().toISOString());
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    // file:// has no service-worker support; the app still works, just online-only.
    if (window.location.protocol === 'file:') return;
    window.addEventListener('load', function () {
      try {
        var ready = navigator.serviceWorker.register('sw.js');
        if (ready && ready.catch) {
          ready.catch(function () { /* offline support is best-effort */ });
        }
      } catch (err) { /* offline support is best-effort */ }
    });
  }

  function init() {
    seedIfEmpty();
    store.subscribe(render);

    wireQuickAdd();
    wireTaskList();
    wireToolbar();
    wireChat();
    wireSettings();
    wireKeyboard();
    registerServiceWorker();

    render();
    updateAiStatus();
    restoreChatHistory();

    if (!store.persistent) {
      toast('Heads up: this browser blocks local storage here, so tasks will not survive a reload.', 6000);
    }
    els['quick-add'].focus();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Exposed for the browser test harness (tests.html).
  window.TodoApp = { store: store, render: render, send: send, state: state };
}());
