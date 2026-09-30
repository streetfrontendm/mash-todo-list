/* ==========================================================================
   uitest.js — integration tests that drive the real index.html in an iframe.
   Snapshot/restore of the app's localStorage keys keeps real data safe.
   ========================================================================== */
(function () {
  'use strict';

  var KEYS = ['todo-ai.v1', 'todo-ai.seeded.v1', 'todo-ai.ai.v1'];
  var results = [];
  var current = null;
  var saved = {};

  function test(name, fn) { results.push({ name: name, fn: fn }); }

  function ok(condition, message) {
    if (!condition) current.failures.push(message || 'expected truthy value');
    return !!condition;
  }

  function equal(actual, expected, message) {
    if (actual !== expected) {
      current.failures.push((message ? message + ' — ' : '') + 'expected ' + JSON.stringify(expected) +
        ', got ' + JSON.stringify(actual));
    }
  }

  function frame() { return document.getElementById('app'); }
  function doc() { return frame().contentDocument; }
  function view() { return doc().defaultView; }
  function $(selector) { return doc().querySelector(selector); }
  function $$(selector) { return Array.prototype.slice.call(doc().querySelectorAll(selector)); }
  function text(selector) {
    var node = $(selector);
    return node ? node.textContent.trim() : null;
  }
  function wait(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

  function snapshotStorage() {
    KEYS.forEach(function (key) { saved[key] = window.localStorage.getItem(key); });
    KEYS.forEach(function (key) { window.localStorage.removeItem(key); });
  }

  function restoreStorage() {
    KEYS.forEach(function (key) {
      if (saved[key] === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, saved[key]);
    });
  }

  function reloadApp() {
    return new Promise(function (resolve, reject) {
      var frame = document.getElementById('app');
      var fresh = document.createElement('iframe');
      fresh.id = 'app';
      fresh.width = '1100';
      fresh.height = '720';
      fresh.onload = function () { setTimeout(resolve, 80); };
      fresh.src = 'index.html';
      frame.parentNode.replaceChild(fresh, frame);
      setTimeout(function () { reject(new Error('iframe reload timed out')); }, 8000);
    });
  }

  function submit(selector) {
    fire($(selector), 'submit', { bubbles: true, cancelable: true });
  }

  /** new (view().Event)(...) - note the parentheses: "new view().Event()" parses as (new view()).Event(). */
  function fire(target, type, init) {
    var win = view();
    var Ctor = type === 'keydown' ? win.KeyboardEvent : win.Event;
    target.dispatchEvent(new Ctor(type, init || {}));
  }

  function setValue(selector, value) { $(selector).value = value; }

  function fill(selector, value) {
    var input = $(selector);
    input.value = value;
    fire(input, 'input', { bubbles: true });
  }

  function rowTitles() {
    return $$('.task-title').map(function (node) { return node.textContent.trim(); });
  }

  function findRow(title) {
    var rows = $$('.task');
    for (var i = 0; i < rows.length; i++) {
      var cell = rows[i].querySelector('.task-title');
      if (cell && cell.textContent.trim() === title) return rows[i];
    }
    return null;
  }

  function lastAssistant() {
    var messages = $$('#chat-log .msg-assistant');
    return messages[messages.length - 1];
  }


  /* ------------------------------------------------------------- the tests */

  test('boot: seeds the demo list and reports local mode', function () {
    ok(!!$('#quick-add'), 'quick add input exists');
    equal($$('.task').length, 4, 'four demo tasks render');
    equal(text('#ai-status'), 'Local mode');
    ok($('#empty-state').hidden, 'empty state is hidden while tasks exist');
    ok(/4 tasks left/.test(text('#items-left')), 'footer count: ' + text('#items-left'));
    ok(/1 overdue/.test(text('#items-left')), 'overdue count is surfaced');
  });

  test('quick add: parses date, priority and tag from one line', function () {
    setValue('#quick-add', 'Call the vet tomorrow !! #pets');
    submit('#quick-add-form');
    equal($$('.task').length, 5, 'a fifth task appears');
    var row = findRow('Call the vet');
    ok(!!row, 'task title was parsed');
    ok(!!row && /#pets/.test(row.textContent), 'tag chip rendered');
    ok(!!row && /high/.test(row.textContent), 'priority rendered');
    ok(!!row && /Tomorrow/.test(row.textContent), 'due badge rendered');
    equal($('#quick-add').value, '', 'input is cleared');
  });

  test('filters and search narrow the list', function () {
    $$('[data-filter]')[1].click();
    equal($$('.task').length, 5, 'active filter keeps open tasks');
    $$('[data-filter]')[2].click();
    equal($$('.task').length, 0, 'done filter is empty');
    ok(!$('#empty-state').hidden, 'empty state is shown');
    $$('[data-filter]')[0].click();
    fill('#search', 'vet');
    equal($$('.task').length, 1, 'search narrows to the match');
    fill('#search', '');
    equal($$('.task').length, 5, 'clearing the search restores the list');
  });

  test('checkbox toggles a task and feeds the footer counters', function () {
    findRow('Call the vet').querySelector('.task-check').click();
    var row = findRow('Call the vet');
    ok(row.classList.contains('is-done'), 'row is marked done');
    ok(/1 done/.test(text('#items-left')), 'footer shows 1 done: ' + text('#items-left'));
    ok(!$('#btn-clear-done').disabled, 'clear completed becomes available');
    $$('[data-filter]')[2].click();
    equal($$('.task').length, 1, 'done filter shows the completed task');
    $$('[data-filter]')[0].click();
  });

  test('inline editing updates the task', function () {
    findRow('Call the vet').querySelector('button[data-action="edit"]').click();
    ok(!!$('.task-edit-row'), 'editor opens');
    $('.task-edit-row [data-field="title"]').value = 'Call the vet about the cat';
    $('.task-edit-row [data-field="priority"]').value = 'low';
    $('.task-edit-row button[data-action="save-edit"]').click();
    ok(!!findRow('Call the vet about the cat'), 'title was saved');
    ok(!$('.task-edit-row'), 'editor closed');
  });

  test('assistant: offline chat adds a task end to end', function () {
    setValue('#chat-input', 'add buy stamps friday');
    submit('#chat-form');
    return wait(250).then(function () {
      var last = lastAssistant();
      ok(/Buy stamps/.test(last.textContent), 'assistant confirms the new task: ' + last.textContent);
      var row = findRow('Buy stamps');
      ok(!!row, 'the task is in the list');
      ok(!!row && !!row.querySelector('.due'), 'the parsed date shows as a badge');
      ok(/Offline answer/.test(last.textContent), 'offline mode is disclosed');
    });
  });

  test('assistant: plan my day is read-only and lists tasks', function () {
    var before = $$('.task').length;
    setValue('#chat-input', 'plan my day');
    submit('#chat-form');
    return wait(250).then(function () {
      ok(/1\./.test(lastAssistant().textContent), 'plan is numbered: ' + lastAssistant().textContent);
      equal($$('.task').length, before, 'nothing changed in the list');
    });
  });

  test('assistant: pending changes wait for approval when auto-apply is off', function () {
    $('#btn-settings').click();
    ok(!$('#settings-modal').hidden, 'settings modal opens');
    $('#auto-apply').checked = false;
    submit('#settings-form');
    ok($('#settings-modal').hidden, 'saving closes the modal');
    equal(text('#ai-status'), 'Local mode', 'still local mode without a key');

    setValue('#chat-input', 'add water the office plants');
    submit('#chat-form');
    return wait(250).then(function () {
      var pending = $('#chat-log [data-pending="true"]');
      ok(!!pending, 'pending action row is rendered');
      ok(!!pending && /Apply 1 change/.test(pending.textContent),
        'apply button is labelled: ' + (pending ? pending.textContent : ''));
      pending.querySelector('button[data-action="apply-actions"]').click();
      ok(!!findRow('Water the office plants'), 'approving adds the task');
      ok(!$('#chat-log [data-pending="true"]'), 'pending row is consumed');
    });
  });

  test('undo button reverts the last change', function () {
    var before = $$('.task').length;
    ok(!$('#btn-undo').disabled, 'undo is available after a change');
    $('#btn-undo').click();
    equal($$('.task').length, before - 1, 'the added task is gone');
  });

  function key(name) {
    if (doc().activeElement && doc().activeElement.blur) doc().activeElement.blur();
    fire(doc(), 'keydown', { key: name, bubbles: true, cancelable: true });
  }

  test('settings: provider selection updates the endpoint and status', function () {
    $('#btn-settings').click();
    var provider = $('#provider');
    provider.value = 'openai';
    fire(provider, 'change', { bubbles: true });
    equal($('#base-url').value, 'https://api.openai.com/v1', 'base URL is prefilled');
    equal($('#model').value, 'gpt-4o-mini', 'model is prefilled');
    $('#api-key').value = 'test-key-not-real';
    $('#auto-apply').checked = true;
    submit('#settings-form');
    equal(text('#ai-status'), 'OpenAI · gpt-4o-mini', 'status reflects the provider');

    // Back to local mode so nothing points at a fake key.
    $('#btn-settings').click();
    provider = $('#provider');
    provider.value = 'local';
    fire(provider, 'change', { bubbles: true });
    $('#api-key').value = '';
    submit('#settings-form');
    equal(text('#ai-status'), 'Local mode', 'back to local mode');
  });

  test('Escape closes the settings modal', function () {
    $('#btn-settings').click();
    ok(!$('#settings-modal').hidden, 'modal is open');
    key('Escape');
    ok($('#settings-modal').hidden, 'modal closed on Escape');
  });

  test('keyboard: j/k selects rows, x toggles, ? shows the help panel', function () {
    // key() blurs inputs first so the shortcut layer is active.
    key('j');
    var first = $('.task.is-active');
    ok(first, 'j selects a task');
    var firstId = first.getAttribute('data-id');
    key('k');
    var other = $('.task.is-active');
    ok(other && other.getAttribute('data-id') !== firstId, 'k moves the selection');
    key('j');
    ok($('.task.is-active') && $('.task.is-active').getAttribute('data-id') === firstId,
      'j returns to the first row');
    var title = $('.task.is-active').querySelector('.task-title').textContent.trim();
    var wasDone = $('.task.is-active').classList.contains('is-done');
    key('x');
    ok(findRow(title).classList.contains('is-done') !== wasDone, 'x toggles the selected task');
    key('x');
    ok(findRow(title).classList.contains('is-done') === wasDone, 'x toggles it back');
    key('?');
    ok(!$('#shortcut-help').hidden, 'help panel opened');
    equal($('#btn-shortcuts').getAttribute('aria-expanded'), 'true', 'trigger reflects the state');
    key('Escape');
    ok($('#shortcut-help').hidden, 'Escape closes the help panel');
    key('Escape');
    equal($('.task.is-active'), null, 'Escape clears the selection');
    // Return focus to the input so later tests start from the usual state.
    $('#quick-add').focus();
  });

  test('clear completed then undo restores the tasks', function () {
    var doneCount = $$('.task.is-done').length;
    ok(doneCount > 0, 'there is at least one completed task');
    $('#btn-clear-done').click();
    equal($$('.task.is-done').length, 0, 'completed tasks removed');
    $('#btn-undo').click();
    equal($$('.task.is-done').length, doneCount, 'undo brought them back');
  });

  test('persistence: tasks survive an app reload', function () {
    var before = rowTitles().sort();
    return reloadApp().then(function () {
      ok(!!$('#quick-add'), 'app booted again');
      var after = rowTitles().sort();
      equal(after.length, before.length, 'same number of tasks');
      equal(after.join('|'), before.join('|'), 'same task titles');
    });
  });

  /* --------------------------------------------------------------- runner */

  function run() {
    var passed = 0, failed = 0;
    var list = document.getElementById('results');
    var summary = document.getElementById('summary');

    function finish() {
      restoreStorage();
      summary.textContent = passed + ' passed, ' + failed + ' failed (of ' + results.length + ')';
      summary.className = failed ? 'fail' : 'pass';
      document.title = (failed ? 'FAIL ' : 'PASS ') + passed + '/' + results.length;
      document.getElementById('dump').textContent =
        JSON.stringify({ passed: passed, failed: failed, total: results.length });
    }

    function step(index) {
      if (index >= results.length) { finish(); return Promise.resolve(); }
      var entry = results[index];
      current = { name: entry.name, failures: [] };
      return Promise.resolve()
        .then(function () { return wait(40); })
        .then(entry.fn)
        .then(null, function (err) {
          current.failures.push('threw ' + (err && err.message ? err.message : String(err)));
        })
        .then(function () {
          var li = document.createElement('li');
          li.className = current.failures.length ? 'fail' : 'pass';
          li.textContent = current.failures.length
            ? entry.name + ' — ' + current.failures.join(' | ')
            : entry.name;
          list.appendChild(li);
          if (current.failures.length) failed++; else passed++;
          return step(index + 1);
        });
    }

    document.title = 'RUNNING';
    wait(200).then(function () { return step(0); });
  }

  try {
    // Throws when the iframe is cross-origin (i.e. opened straight from disk).
    snapshotStorage();
  } catch (err) {
    var summary = document.getElementById('summary');
    summary.textContent = 'Cannot reach the app frame or localStorage (' + err.message +
      '). Run serve.ps1 and open http://localhost:8080/uitest.html';
    summary.className = 'fail';
    document.title = 'FAIL setup';
    return;
  }

  wait(300).then(function () {
    if (!document.getElementById('app').contentDocument) {
      throw new Error('the app frame is cross-origin');
    }
    return run();
  }).then(null, function (err) {
    var summary = document.getElementById('summary');
    summary.textContent = 'UI tests could not start: ' + err.message +
      ' — serve the folder over http (see README) and reload.';
    summary.className = 'fail';
    document.title = 'FAIL setup';
  });
}());
