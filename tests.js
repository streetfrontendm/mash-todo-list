/* ==========================================================================
   tests.js — engine tests for the Mash Todo List app, run in the browser.
   No test framework: the runner renders results into #results and sets
   document.title to "PASS n" / "FAIL n", which is enough for CI-style checks
   (and readable from headless Chrome/Edge via --dump-dom).
   ========================================================================== */
(function () {
  'use strict';

  var NS = window.TodoAI;
  var dates = NS.dates;
  var todos = NS.todos;
  var nlp = NS.nlp;
  var ai = NS.ai;

  var results = [];
  var current = null;

  function test(name, fn) {
    results.push({ name: name, fn: fn });
  }

  function fail(message) {
    current.failures.push(message);
  }

  function ok(condition, message) {
    if (!condition) fail(message || 'expected truthy value, got ' + JSON.stringify(condition));
    return !!condition;
  }

  function equal(actual, expected, message) {
    var a = JSON.stringify(actual), b = JSON.stringify(expected);
    if (a !== b) fail((message ? message + ' — ' : '') + 'expected ' + b + ', got ' + a);
    return a === b;
  }

  /** In-memory storage backend so tests never touch real localStorage. */
  function memoryBackend(seed) {
    var data = seed || {};
    return {
      persistent: true,
      get: function (key) { return key in data ? data[key] : null; },
      set: function (key, value) { data[key] = String(value); return true; },
      remove: function (key) { delete data[key]; },
      dump: function () { return data; }
    };
  }

  function freshStore(seedTodoList) {
    var backend = memoryBackend();
    var store = NS.createStore({ key: 'test.v1', storage: backend });
    if (seedTodoList && seedTodoList.length) store.addMany(seedTodoList, NOW);
    return store;
  }

  function fakeFetch(payloadText, options) {
    var opts = options || {};
    var calls = [];
    var impl = function (url, init) {
      calls.push({ url: url, init: init });
      if (opts.reject) return Promise.reject(opts.reject);
      return Promise.resolve({
        ok: opts.ok !== false,
        status: opts.status || 200,
        text: function () {
          return Promise.resolve(typeof payloadText === 'string' ? payloadText : JSON.stringify(payloadText));
        }
      });
    };
    impl.calls = calls;
    return impl;
  }

  // Fixed reference point: Wednesday 30 September 2026.
  var NOW = new Date(2026, 8, 30, 9, 0, 0);
  var TODAY = '2026-09-30';
  var TOMORROW = '2026-10-01';


  /* ------------------------------------------------------------- date math */

  test('dates: addDays and daysBetween', function () {
    equal(dates.addDays(TODAY, 1), TOMORROW);
    equal(dates.addDays(TODAY, -1), '2026-09-29');
    equal(dates.addDays('2026-12-31', 1), '2027-01-01');
    equal(dates.daysBetween(TODAY, TOMORROW), 1);
    equal(dates.daysBetween(TOMORROW, TODAY), -1);
    equal(dates.todayISO(NOW), TODAY);
  });

  test('dates: dueTone buckets', function () {
    equal(dates.dueTone('2026-09-29', NOW), 'overdue');
    equal(dates.dueTone(TODAY, NOW), 'today');
    equal(dates.dueTone('2026-10-03', NOW), 'soon');
    equal(dates.dueTone('2026-11-01', NOW), 'later');
    equal(dates.dueTone(null, NOW), null);
  });

  test('dates: humanDue labels', function () {
    equal(dates.humanDue(TODAY, NOW), 'Today');
    equal(dates.humanDue(TOMORROW, NOW), 'Tomorrow');
    equal(dates.humanDue('2026-09-29', NOW), 'Yesterday');
    equal(dates.humanDue('2026-09-28', NOW), '2 days overdue');
    equal(dates.humanDue('2026-10-05', NOW), 'In 5 days');
  });

  /* ------------------------------------------------------------------ store */

  test('store: add, list and stats', function () {
    var store = freshStore([
      { title: 'Alpha', priority: 'high', due: '2026-09-29' },
      { title: 'Beta', priority: 'low', due: TOMORROW }
    ]);
    equal(store.list().length, 2);
    var stat = todos.stats(store.list(), NOW);
    equal([stat.all, stat.active, stat.done, stat.overdue], [2, 2, 0, 1]);
    equal(store.add({ title: '   ' }), null, 'blank titles are rejected');
  });

  test('store: toggle, reopen and repeat roll-forward', function () {
    var store = freshStore([{ title: 'Ping host', repeat: 'daily', due: TODAY }]);
    var id = store.list()[0].id;
    store.setDone(id, true, NOW);
    equal(store.get(id).done, false, 'repeating task stays open');
    equal(store.get(id).due, TOMORROW, 'repeating task moves to tomorrow');

    var plain = store.add({ title: 'One-off' }, NOW);
    store.toggle(plain.id, NOW);
    equal(store.get(plain.id).done, true);
    ok(!!store.get(plain.id).completedAt, 'completion timestamp is set');
    store.toggle(plain.id, NOW);
    equal(store.get(plain.id).done, false);
  });

  test('store: update, remove, clearCompleted and undo', function () {
    var store = freshStore([
      { title: 'Draft memo', priority: 'low', tags: ['work'] },
      { title: 'File taxes', priority: 'high' }
    ]);
    var memo = store.list()[0];
    store.update(memo.id, { priority: 'high', due: TODAY, tags: 'work, urgent' }, NOW);
    equal(store.get(memo.id).priority, 'high');
    equal(store.get(memo.id).tags, ['work', 'urgent']);

    store.remove(memo.id);
    equal(store.list().length, 1);
    equal(store.undo().length, 2, 'undo restores the deleted task');

    store.toggle(store.list()[0].id, NOW);
    equal(store.clearCompleted().length, 1);
    equal(store.list().length, 1);
    equal(store.undo().length, 2, 'undo restores the cleared task');
    equal(store.canUndo(), false, 'undo is single-step');
  });

  test('store: persists to the backend and reloads', function () {
    var backend = memoryBackend();
    var first = NS.createStore({ key: 'persist.v1', storage: backend });
    first.add({ title: 'Survives reload', priority: 'high', tags: ['demo'] }, NOW);

    var second = NS.createStore({ key: 'persist.v1', storage: backend });
    equal(second.list().length, 1);
    equal(second.list()[0].title, 'Survives reload');
    equal(second.list()[0].tags, ['demo']);
    equal(second.list()[0].priority, 'high');
  });

  test('store: resolve finds tasks by fragment', function () {
    var store = freshStore([
      { title: 'Buy milk' },
      { title: 'Buy stamps' },
      { title: 'Call the dentist' }
    ]);
    equal(store.resolve('call the dentist').length, 1);
    equal(store.resolve('dentist')[0].title, 'Call the dentist');
    equal(store.resolve('buy stamps').length, 1);
    equal(store.resolve('nothing like this').length, 0);
    equal(store.resolve('buy', { all: true }).length, 2);
  });

  test('store: filters, search and sorting', function () {
    var list = [
      { title: 'Later low', priority: 'low', due: '2026-12-01', done: false },
      { title: 'Today high', priority: 'high', due: TODAY, done: false },
      { title: 'Overdue low', priority: 'low', due: '2026-09-01', done: false },
      { title: 'Finished', priority: 'high', done: true },
      { title: 'Undated medium', priority: 'medium', done: false }
    ];
    equal(todos.filterTodos(list, { filter: 'active' }, NOW).length, 4);
    equal(todos.filterTodos(list, { filter: 'done' }, NOW).length, 1);
    equal(todos.filterTodos(list, { filter: 'today' }, NOW).length, 1);
    equal(todos.filterTodos(list, { search: 'overdue' }, NOW)[0].title, 'Overdue low');
    equal(todos.sortTodos(list, 'smart', NOW).map(function (t) { return t.title; }),
      ['Overdue low', 'Today high', 'Later low', 'Undated medium', 'Finished'],
      'smart order: overdue first, then today, then later, undated, done');
    equal(todos.sortTodos(list, 'due', NOW)[0].title, 'Overdue low');
    equal(todos.sortTodos(list, 'title', NOW)[0].title, 'Finished');
  });

  test('store: import merges and skips duplicate titles', function () {
    var store = freshStore([{ title: 'Existing task' }]);
    var added = store.mergeAll([
      { title: 'Existing task' },
      { title: 'Imported task', priority: 'high' }
    ], NOW);
    equal(added.length, 1);
    equal(store.list().length, 2);
  });

  /* -------------------------------------------------------------------- nlp */

  test('nlp: parseDate understands the common phrases', function () {
    var cases = [
      ['today', TODAY],
      ['tonight', TODAY],
      ['tomorrow', TOMORROW],
      ['day after tomorrow', '2026-10-02'],
      ['in 3 days', '2026-10-03'],
      ['in 2 weeks', '2026-10-14'],
      ['next week', '2026-10-07'],
      ['next month', '2026-10-30'],
      ['friday', '2026-10-02'],
      ['next friday', '2026-10-09'],
      ['wednesday', '2026-10-07'],
      ['oct 5', '2026-10-05'],
      ['5 october', '2026-10-05'],
      ['2026-10-05', '2026-10-05'],
      ['12/25', '2026-12-25']
    ];
    cases.forEach(function (pair) {
      var found = nlp.parseDate('finish the thing ' + pair[0], NOW);
      equal(found.due, pair[1], 'parsing "' + pair[0] + '"');
    });
  });

  test('nlp: parseDate rolls past dates into next year and reports no match', function () {
    equal(nlp.parseDate('renew in jan 5', NOW).due, '2027-01-05');
    equal(nlp.parseDate('pay 3/1', NOW).due, '2027-03-01');
    equal(nlp.parseDate('someday soon', NOW).due, null);
    equal(nlp.parseDate('someday soon', NOW).matched, null);
  });

  test('nlp: addMonths clamps the day', function () {
    equal(nlp.addMonths('2026-01-31', 1), '2026-02-28');
    equal(nlp.addMonths('2026-09-30', 1), '2026-10-30');
    equal(nlp.addMonths('2026-01-15', 12), '2027-01-15');
  });

  test('nlp: parseQuickAdd extracts date, priority, tags and repeat', function () {
    var a = nlp.parseQuickAdd('Call mom tomorrow !! #family', NOW);
    equal(a.title, 'Call mom');
    equal(a.priority, 'high');
    equal(a.due, TOMORROW);
    equal(a.tags, ['family']);

    var b = nlp.parseQuickAdd('remind me to buy stamps on friday', NOW);
    equal(b.title, 'Buy stamps');
    equal(b.due, '2026-10-02');
    equal(b.priority, 'medium');

    var c = nlp.parseQuickAdd('water plants every week', NOW);
    equal(c.title, 'Water plants');
    equal(c.repeat, 'weekly');
    equal(c.due, null);

    var d = nlp.parseQuickAdd('Email the team p1 tag work, finance', NOW);
    equal(d.title, 'Email the team');
    equal(d.priority, 'high');
    equal(d.tags, ['work', 'finance']);

    var e = nlp.parseQuickAdd('   ', NOW);
    equal(e, null, 'blank input is rejected');

    var f = nlp.parseQuickAdd('tomorrow', NOW);
    equal(f.title, 'New task');
    equal(f.due, TOMORROW);
  });

  test('nlp: selectTodos picks groups and single tasks', function () {
    var store = freshStore([
      { title: 'Pay rent', priority: 'high', due: TODAY },
      { title: 'Read a book', priority: 'low', due: TODAY },
      { title: 'Old thing', priority: 'medium', due: '2026-09-01' }
    ]);
    equal(nlp.selectTodos('everything due today', store, NOW, {}).todos.length, 2);
    equal(nlp.selectTodos('overdue', store, NOW, {}).todos.length, 1);
    equal(nlp.selectTodos('everything', store, NOW, {}).todos.length, 3);
    equal(nlp.selectTodos('high priority', store, NOW, {}).todos.length, 1);
    equal(nlp.selectTodos('pay rent', store, NOW, {}).todos[0].title, 'Pay rent');
    equal(nlp.selectTodos('nothing here matches', store, NOW, {}).todos.length, 0);
  });

  /* ------------------------------------------------- offline assistant ---- */

  test('assistant: adds a task from chat and applies it', function () {
    var store = freshStore([]);
    var reply = nlp.localAssistant('add buy milk tomorrow !! #errands', store, NOW);
    equal(reply.intent, 'add');
    equal(reply.actions.length, 1);
    equal(reply.actions[0].title, 'Buy milk');

    var outcome = ai.applyActions(store, reply.actions, NOW);
    equal(outcome.applied.length, 1);
    equal(store.list().length, 1);
    equal(store.list()[0].due, TOMORROW);
    equal(store.list()[0].priority, 'high');
    equal(store.list()[0].tags, ['errands']);
  });

  test('assistant: completes tasks by name', function () {
    var store = freshStore([{ title: 'Buy milk' }, { title: 'Write the report' }]);
    var a = nlp.localAssistant('i finished the milk', store, NOW);
    equal(a.intent, 'complete');
    ai.applyActions(store, a.actions, NOW);
    equal(store.list()[0].done, true);

    var b = nlp.localAssistant('finish the report', store, NOW);
    equal(b.intent, 'complete');
    ai.applyActions(store, b.actions, NOW);
    equal(store.list()[1].done, true);

    var c = nlp.localAssistant('finish the quarterly report', store, NOW);
    equal(c.actions.length, 0, 'already-done or missing tasks produce no action');
  });

  test('assistant: moves everything due today to tomorrow', function () {
    var store = freshStore([
      { title: 'Pay rent', due: TODAY },
      { title: 'Read a book', due: TODAY },
      { title: 'Old thing', due: '2026-09-01' }
    ]);
    var reply = nlp.localAssistant('move everything due today to tomorrow', store, NOW);
    equal(reply.intent, 'reschedule');
    equal(reply.actions.length, 2);
    ai.applyActions(store, reply.actions, NOW);
    equal(store.list()[0].due, TOMORROW);
    equal(store.list()[1].due, TOMORROW);
    equal(store.list()[2].due, '2026-09-01', 'overdue task untouched');
  });

  test('assistant: reprioritises and deletes', function () {
    var store = freshStore([{ title: 'Water plants', priority: 'low' }, { title: 'Pay rent', priority: 'medium' }]);
    var prio = nlp.localAssistant('make the water plants task high priority', store, NOW);
    equal(prio.intent, 'prioritize');
    ai.applyActions(store, prio.actions, NOW);
    equal(store.list()[0].priority, 'high');

    var del = nlp.localAssistant('delete water plants', store, NOW);
    equal(del.intent, 'delete');
    ai.applyActions(store, del.actions, NOW);
    equal(store.list().length, 1);
    equal(store.list()[0].title, 'Pay rent');
  });

  test('assistant: plan, first and summary are read-only', function () {
    var store = freshStore([
      { title: 'Pay rent', priority: 'high', due: '2026-09-01' },
      { title: 'Read a book', priority: 'low' }
    ]);
    var plan = nlp.localAssistant('plan my day', store, NOW);
    equal(plan.intent, 'plan');
    equal(plan.actions.length, 0, 'planning never writes');
    ok(plan.reply.indexOf('1. Pay rent') !== -1, 'overdue task leads the plan: ' + plan.reply);

    var first = nlp.localAssistant('what should I do first?', store, NOW);
    equal(first.intent, 'first');
    ok(first.reply.indexOf('Pay rent') !== -1);
    equal(first.actions.length, 0);

    var summary = nlp.localAssistant('how many tasks are left?', store, NOW);
    equal(summary.intent, 'summary');
    ok(summary.reply.indexOf('2 open') !== -1, summary.reply);
  });

  test('assistant: clear completed, help and unknown input', function () {
    var store = freshStore([{ title: 'Already done', done: true }, { title: 'Still open' }]);
    var clear = nlp.localAssistant('clear completed', store, NOW);
    equal(clear.intent, 'clear_completed');
    ai.applyActions(store, clear.actions, NOW);
    equal(store.list().length, 1);

    equal(nlp.localAssistant('help', store, NOW).intent, 'help');

    var unknown = nlp.localAssistant('what is the meaning of life?', store, NOW);
    equal(unknown.intent, 'unknown');
    equal(unknown.actions.length, 0);
    equal(store.list().length, 1, 'unknown input never mutates the list');
  });

  /* ---------------------------------------------------------------- ai ---- */

  test('ai: validateActions drops junk and normalises values', function () {
    var cleaned = ai.validateActions([
      { type: 'add', title: 'Alpha', priority: 'high', due: '2026-10-05' },
      { type: 'add', title: '   ' },
      { type: 'nonsense' },
      'not an object',
      { type: 'complete' },
      { type: 'complete', ref: 'x' },
      { type: 'CLEAR-COMPLETED' },
      { type: 'update', ref: 'x', patch: {} },
      { type: 'update', ref: 'x', patch: { due: 'tomorrow' } }
    ]);
    equal(cleaned.length, 4, 'only the four usable actions survive');
    equal(cleaned[0].items[0].title, 'Alpha');
    equal(cleaned[1].ref, 'x');
    equal(cleaned[2].type, 'clear_completed');
    equal(cleaned[3].patch.due, TOMORROW, 'dates are normalised through the nlp parser');
  });

  test('ai: parseReply handles JSON, fenced JSON and prose', function () {
    var a = ai.parseReply('{"reply":"Hi","actions":[{"type":"add","title":"X"}]}');
    equal(a.reply, 'Hi');
    equal(a.actions.length, 1);
    equal(a.parsed, true);

    var b = ai.parseReply('Sure thing!\n```json\n{"reply":"Ok","actions":[]}\n```\nHope that helps');
    equal(b.reply, 'Ok');
    equal(b.actions.length, 0);
    equal(b.parsed, true);

    var c = ai.parseReply('Just do the first thing on your list.');
    equal(c.reply, 'Just do the first thing on your list.');
    equal(c.actions.length, 0);
    equal(c.parsed, false);

    var d = ai.parseReply('{"type":"add","title":"Bare action"}');
    equal(d.actions.length, 1, 'a bare action object still applies');
  });

  test('ai: applyActions executes add, complete, update and clear', function () {
    var store = freshStore([
      { title: 'Pay rent', priority: 'high', due: TODAY },
      { title: 'Buy milk' },
      { title: 'Already done', done: true }
    ]);
    var outcome = ai.applyActions(store, [
      { type: 'add', title: 'Write tests', due: 'tomorrow', priority: 'high' },
      { type: 'update', ref: 'pay rent', patch: { due: '2026-10-05', priority: 'low' } },
      { type: 'complete', ref: 'buy milk' },
      { type: 'clear_completed' },
      { type: 'complete', ref: 'no such task' }
    ], NOW);

    equal(outcome.applied.length, 4);
    equal(outcome.errors.length, 1, 'the unmatched reference is reported, not silently applied');
    equal(store.list().length, 2);
    var rent = store.find(function (t) { return t.title === 'Pay rent'; })[0];
    equal(rent.due, '2026-10-05');
    equal(rent.priority, 'low');
    equal(store.find(function (t) { return t.title === 'Write tests'; }).length, 1);
  });

  test('ai: ask() calls the endpoint and returns its actions', function () {
    var store = freshStore([]);
    var config = {
      provider: 'openai', apiKey: 'test-key', baseUrl: 'https://example.test/v1',
      model: 'test-model', autoApply: true, history: [{ role: 'user', content: 'earlier' }]
    };
    var fetcher = fakeFetch({
      choices: [{ message: { content: '{"reply":"Added it.","actions":[{"type":"add","title":"Ship release","priority":"high"}]}' } }]
    });

    return ai.ask({ text: 'add ship release', config: config, store: store, now: NOW, fetchImpl: fetcher })
      .then(function (result) {
        equal(result.source, 'remote');
        equal(result.reply, 'Added it.');
        equal(result.actions.length, 1);
        equal(fetcher.calls.length, 1);
        equal(fetcher.calls[0].url, 'https://example.test/v1/chat/completions');
        equal(fetcher.calls[0].init.headers.Authorization, 'Bearer test-key');
        var body = JSON.parse(fetcher.calls[0].init.body);
        equal(body.model, 'test-model');
        equal(body.messages[0].role, 'system');
        ok(body.messages[0].content.indexOf(TODAY) !== -1, 'system prompt carries today');
        equal(body.messages[body.messages.length - 1].content, 'add ship release', 'the new message is last');

        ai.applyActions(store, result.actions, NOW);
        equal(store.list()[0].title, 'Ship release');
      });
  });

  test('ai: ask() falls back to the offline engine when the request fails', function () {
    var store = freshStore([]);
    var config = {
      provider: 'openai', apiKey: 'k', baseUrl: 'https://example.test/v1', model: 'm', history: []
    };
    var fetcher = fakeFetch(null, { reject: new Error('Failed to fetch') });

    return ai.ask({ text: 'add call the bank tomorrow', config: config, store: store, now: NOW, fetchImpl: fetcher })
      .then(function (result) {
        equal(result.source, 'local');
        ok(/Could not reach/.test(result.error), 'friendly message: ' + result.error);
        equal(result.actions.length, 1);
        equal(result.actions[0].title, 'Call the bank');
      });
  });

  test('ai: isEnabled, resolveEndpoint and statusLabel', function () {
    equal(ai.isEnabled({ provider: 'local' }), false);
    equal(ai.isEnabled({ provider: 'openai' }), false, 'a key is required for hosted providers');
    equal(ai.isEnabled({ provider: 'openai', apiKey: 'k' }), true);
    equal(ai.resolveEndpoint({ provider: 'openai', apiKey: 'k' }).baseUrl, 'https://api.openai.com/v1');
    equal(ai.resolveEndpoint({ provider: 'ollama' }).baseUrl, 'http://localhost:11434/v1');
    equal(ai.statusLabel({ provider: 'openai', apiKey: 'k', model: 'gpt-x' }).text, 'OpenAI · gpt-x');
    equal(ai.statusLabel({ provider: 'local' }).mode, 'local');
    equal(ai.isEnabled({ provider: 'custom', baseUrl: 'http://localhost:1234/v1' }), true,
      'custom local endpoints need no key');
  });

  test('ai: postChat reports HTTP errors with the body', function () {
    var endpoint = { baseUrl: 'https://x.test/v1', model: 'm', apiKey: 'k', provider: 'custom' };
    return ai.postChat(endpoint, [{ role: 'user', content: 'hi' }],
      { fetchImpl: fakeFetch('{"error":"bad key"}', { ok: false, status: 401 }) })
      .then(function () {
        ok(false, 'a 401 must reject');
      }, function (err) {
        ok(err.message.indexOf('HTTP 401') === 0, 'message was: ' + err.message);
      });
  });

  test('ai: testConnection handles local mode, success and failure', function () {
    var config = { provider: 'openai', apiKey: 'k', baseUrl: 'https://x.test/v1', model: 'm' };
    return ai.testConnection({ provider: 'local' })
      .then(function (local) {
        equal(local.ok, false, 'local mode has nothing to test');
        return ai.testConnection(config, { fetchImpl: fakeFetch({ choices: [{ message: { content: 'ok' } }] }) });
      })
      .then(function (good) {
        equal(good.ok, true);
        ok(good.message.indexOf('OpenAI') !== -1, good.message);
        return ai.testConnection(config, { fetchImpl: fakeFetch(null, { reject: new Error('nope') }) });
      })
      .then(function (bad) {
        equal(bad.ok, false);
        ok(bad.message.indexOf('nope') !== -1, bad.message);
      });
  });

  test('ai: buildSystemPrompt lists the tasks and the schema', function () {
    var store = freshStore([{ title: 'Pay rent', priority: 'high', due: TODAY }]);
    var prompt = ai.buildSystemPrompt(store, NOW);
    ok(prompt.indexOf(TODAY) !== -1, 'today appears');
    ok(prompt.indexOf('Pay rent') !== -1, 'tasks appear');
    ok(prompt.indexOf('"reply"') !== -1, 'the schema appears');
    ok(prompt.indexOf('1 open, 0 done, 0 overdue') !== -1, 'stats appear');
  });

  /* --------------------------------------------------------------- runner */

  function run() {
    var passed = 0, failed = 0;
    var list = document.getElementById('results');
    var summary = document.getElementById('summary');
    document.title = 'RUNNING';

    function finish() {
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

    step(0);
  }

  run();
}());
