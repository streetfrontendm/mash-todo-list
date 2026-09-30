/* ==========================================================================
   store.js — dates, todo helpers and the persistent store.
   No dependencies; exposes window.TodoAI.dates and window.TodoAI.todos.
   Pure helpers are exported so tests.html can exercise them directly.
   ========================================================================== */
(function () {
  'use strict';

  var NS = (window.TodoAI = window.TodoAI || {});
  var PRIORITIES = ['low', 'medium', 'high'];
  var PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

  /* ------------------------------------------------------------- dates -- */

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function toISO(date) {
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
  }

  function fromISO(iso) {
    var p = String(iso).split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }

  function isISODate(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      !isNaN(fromISO(value).getTime());
  }

  function asDate(now) {
    return now instanceof Date ? new Date(now.getTime()) : new Date();
  }

  function todayISO(now) { return toISO(asDate(now)); }

  function addDays(iso, days) {
    var d = fromISO(iso);
    d.setDate(d.getDate() + days);
    return toISO(d);
  }

  /** Whole days from `fromIso` to `toIso` (positive = in the future). */
  function daysBetween(fromIso, toIso) {
    var a = fromISO(fromIso), b = fromISO(toIso);
    return Math.round((b - a) / 86400000);
  }

  /** overdue | today | soon (<=3 days) | later | null */
  function dueTone(iso, now) {
    if (!isISODate(iso)) return null;
    var diff = daysBetween(todayISO(now), iso);
    if (diff < 0) return 'overdue';
    if (diff === 0) return 'today';
    if (diff <= 3) return 'soon';
    return 'later';
  }

  function humanDue(iso, now) {
    if (!isISODate(iso)) return '';
    var diff = daysBetween(todayISO(now), iso);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    if (diff === -1) return 'Yesterday';
    if (diff < 0) return Math.abs(diff) + ' days overdue';
    if (diff <= 6) return 'In ' + diff + ' days';
    return fromISO(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  NS.dates = {
    toISO: toISO,
    fromISO: fromISO,
    isISODate: isISODate,
    todayISO: todayISO,
    addDays: addDays,
    daysBetween: daysBetween,
    dueTone: dueTone,
    humanDue: humanDue
  };

  /* ------------------------------------------------------- todo helpers -- */

  function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }

  function uid() {
    return 't_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  function normalizePriority(value) {
    if (typeof value === 'number') return PRIORITIES[clamp(Math.round(value), 0, 2)];
    var v = String(value == null ? '' : value).toLowerCase().trim();
    if (v === 'high' || v === 'h' || v === 'p1' || v === '1' || v === 'urgent') return 'high';
    if (v === 'medium' || v === 'med' || v === 'm' || v === 'p2' || v === '2') return 'medium';
    if (v === 'low' || v === 'l' || v === 'p3' || v === '3') return 'low';
    return 'medium';
  }

  function normalizeTags(tags) {
    var out = [];
    if (!tags) return out;
    var list = Array.isArray(tags) ? tags : String(tags).split(/[,\s]+/);
    list.forEach(function (raw) {
      var tag = String(raw).replace(/^#/, '').trim().toLowerCase();
      if (tag && out.indexOf(tag) === -1) out.push(tag);
    });
    return out.slice(0, 8);
  }

  function createTodo(input, now) {
    input = input || {};
    var title = String(input.title == null ? '' : input.title).replace(/\s+/g, ' ').trim();
    if (!title) return null;
    var stamp = asDate(now).toISOString();
    var done = !!input.done;
    return {
      id: input.id || uid(),
      title: title.slice(0, 240),
      notes: String(input.notes || '').trim(),
      priority: normalizePriority(input.priority),
      due: NS.dates.isISODate(input.due) ? input.due : null,
      tags: normalizeTags(input.tags),
      repeat: input.repeat === 'daily' || input.repeat === 'weekly' ? input.repeat : null,
      done: done,
      createdAt: input.createdAt || stamp,
      completedAt: done ? (input.completedAt || stamp) : null
    };
  }

  function searchBlob(todo) {
    return (todo.title + ' ' + (todo.notes || '') + ' ' + (todo.tags || []).join(' ')).toLowerCase();
  }

  function matchesSearch(todo, query) {
    var q = String(query || '').trim().toLowerCase();
    if (!q) return true;
    return q.split(/\s+/).every(function (term) { return searchBlob(todo).indexOf(term) !== -1; });
  }

  function matchesFilter(todo, filter, now) {
    switch (filter) {
      case 'active': return !todo.done;
      case 'done': return todo.done;
      case 'today': return !todo.done && NS.dates.dueTone(todo.due, now) === 'today';
      case 'overdue': return !todo.done && NS.dates.dueTone(todo.due, now) === 'overdue';
      default: return true;
    }
  }

  /**
   * Lower score = should be done sooner.
   * Ordering is deliberate and deterministic: date bucket first (overdue beats
   * everything), then priority rank, so "smart" sort never depends on tie order.
   */
  function urgencyScore(todo, now) {
    if (todo.done) return 1000;
    var bucket = { overdue: 0, today: 1, soon: 2, later: 3 };
    var tone = NS.dates.dueTone(todo.due, now);
    var when = tone && bucket[tone] !== undefined ? bucket[tone] : 4;
    return when * 10 + PRIORITY_RANK[todo.priority];
  }

  function filterTodos(todos, options, now) {
    options = options || {};
    return todos.filter(function (todo) {
      return matchesFilter(todo, options.filter || 'all', now) && matchesSearch(todo, options.search);
    });
  }

  function sortTodos(todos, sortBy, now) {
    var copy = todos.slice();
    switch (sortBy) {
      case 'due':
        return copy.sort(function (a, b) {
          var ad = a.due || '9999-12-31', bd = b.due || '9999-12-31';
          return ad === bd ? PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] : (ad < bd ? -1 : 1);
        });
      case 'priority':
        return copy.sort(function (a, b) {
          return (PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]) ||
            (a.title < b.title ? -1 : 1);
        });
      case 'created':
        return copy.sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : -1; });
      case 'title':
        return copy.sort(function (a, b) { return a.title.localeCompare(b.title); });
      default:
        return copy.sort(function (a, b) {
          return (urgencyScore(a, now) - urgencyScore(b, now)) ||
            (a.createdAt < b.createdAt ? -1 : 1);
        });
    }
  }

  function stats(todos, now) {
    var out = { all: todos.length, active: 0, done: 0, today: 0, overdue: 0 };
    todos.forEach(function (todo) {
      if (todo.done) { out.done++; return; }
      out.active++;
      var tone = NS.dates.dueTone(todo.due, now);
      if (tone === 'today') out.today++;
      if (tone === 'overdue') out.overdue++;
    });
    return out;
  }

  NS.todos = {
    PRIORITIES: PRIORITIES,
    PRIORITY_RANK: PRIORITY_RANK,
    normalizePriority: normalizePriority,
    normalizeTags: normalizeTags,
    createTodo: createTodo,
    matchesSearch: matchesSearch,
    matchesFilter: matchesFilter,
    filterTodos: filterTodos,
    sortTodos: sortTodos,
    urgencyScore: urgencyScore,
    stats: stats
  };

  /* ------------------------------------------------------------- storage -- */

  /** localStorage wrapper that degrades to memory (e.g. blocked file:// origins). */
  function makeStorage(backend) {
    var memory = {};
    var native = null;
    if (backend !== undefined) {
      native = backend;
    } else {
      try {
        var probe = '__todoai_probe__';
        window.localStorage.setItem(probe, '1');
        window.localStorage.removeItem(probe);
        native = window.localStorage;
      } catch (err) {
        native = null;
      }
    }
    return {
      persistent: !!native,
      get: function (key) {
        try { return native ? native.getItem(key) : (key in memory ? memory[key] : null); }
        catch (err) { return key in memory ? memory[key] : null; }
      },
      set: function (key, value) {
        memory[key] = value;
        if (!native) return false;
        try { native.setItem(key, value); return true; }
        catch (err) { return false; }
      },
      remove: function (key) {
        delete memory[key];
        if (!native) return;
        try { native.removeItem(key); } catch (err) { /* ignore */ }
      }
    };
  }

  function safeParse(text) {
    if (!text) return [];
    try {
      var data = JSON.parse(text);
      return Array.isArray(data) ? data : (data && data.todos) || [];
    } catch (err) {
      return [];
    }
  }

  function sanitizeList(raw, now) {
    if (!Array.isArray(raw)) return [];
    var seen = {};
    return raw.map(function (item) { return createTodo(item, now); })
      .filter(function (todo) {
        if (!todo || seen[todo.id]) return false;
        seen[todo.id] = true;
        return true;
      });
  }

  /**
   * The store owns the todo list plus a one-step undo snapshot.
   * Every mutation persists and notifies subscribers with the fresh list.
   */
  function createStore(options) {
    options = options || {};
    var key = options.key || 'todo-ai.v1';
    var storage = options.storage || makeStorage();
    var listeners = [];
    var state = sanitizeList(safeParse(storage.get(key)));
    var snapshot = null;
    var undoLabel = '';

    function persist() {
      storage.set(key, JSON.stringify({
        version: 1,
        savedAt: new Date().toISOString(),
        todos: state
      }));
    }

    function commit(next, opts) {
      if (!opts || opts.snapshot !== false) {
        snapshot = JSON.stringify(state);
        undoLabel = (opts && opts.onUndo) || 'change';
      }
      state = next;
      persist();
      listeners.forEach(function (fn) { fn(state); });
      return state;
    }

    var api = {
      persistent: storage.persistent,
      key: key,

      list: function () { return state.slice(); },
      raw: function () { return state; },
      get: function (id) {
        var found = null;
        state.forEach(function (t) { if (t.id === id) found = t; });
        return found;
      },
      find: function (predicate) { return state.filter(predicate); },

      /** Resolve a free-text reference ("milk", "call mom", or an id) to todo(s). */
      resolve: function (ref, opts) {
        opts = opts || {};
        var needle = String(ref == null ? '' : ref).toLowerCase().trim();
        if (!needle) return [];
        var pool = state.filter(function (t) { return opts.includeDone ? true : !t.done; });
        var byId = pool.filter(function (t) { return t.id === needle; });
        if (byId.length) return [byId[0]];
        var exact = pool.filter(function (t) { return t.title.toLowerCase() === needle; });
        if (exact.length) return exact.slice(0, 1);
        var starts = pool.filter(function (t) {
          return t.title.toLowerCase().indexOf(needle) === 0;
        });
        if (starts.length) return opts.all ? starts : starts.slice(0, 1);
        var contains = pool.filter(function (t) { return searchBlob(t).indexOf(needle) !== -1; });
        if (contains.length) return opts.all ? contains : contains.slice(0, 1);
        var words = needle.split(/\s+/).filter(function (w) { return w.length > 2; });
        if (!words.length) return [];
        return pool.filter(function (t) {
          var blob = searchBlob(t);
          return words.every(function (w) { return blob.indexOf(w) !== -1; });
        }).slice(0, opts.all ? 200 : 1);
      },

      add: function (input, now) {
        var todo = createTodo(input, now);
        if (!todo) return null;
        commit(state.concat([todo]), { onUndo: 'add "' + todo.title + '"' });
        return todo;
      },

      addMany: function (inputs, now) {
        var added = [];
        inputs.forEach(function (input) {
          var todo = createTodo(input, now);
          if (todo) added.push(todo);
        });
        if (!added.length) return [];
        commit(state.concat(added), { onUndo: 'add ' + added.length + ' task(s)' });
        return added;
      },

      update: function (id, patch, now) {
        var target = api.get(id);
        if (!target) return null;
        var merged = createTodo(Object.assign({}, target, patch, {
          id: target.id,
          createdAt: target.createdAt
        }), now);
        if (!merged) return null;
        commit(state.map(function (t) { return t.id === id ? merged : t; }),
          { onUndo: 'edit "' + merged.title + '"' });
        return merged;
      },

      setDone: function (id, done, now) {
        var target = api.get(id);
        if (!target) return null;
        var patch = { done: !!done, completedAt: done ? asDate(now).toISOString() : null };
        // A repeating task rolls its due date forward instead of closing for good.
        if (done && target.repeat) {
          var base = NS.dates.isISODate(target.due) ? target.due : NS.dates.todayISO(now);
          patch.done = false;
          patch.completedAt = null;
          patch.due = NS.dates.addDays(base, target.repeat === 'weekly' ? 7 : 1);
        }
        return api.update(id, patch, now);
      },

      toggle: function (id, now) {
        var target = api.get(id);
        return target ? api.setDone(id, !target.done, now) : null;
      },

      remove: function (id) {
        var target = api.get(id);
        if (!target) return null;
        var next = state.filter(function (t) { return t.id !== id; });
        if (next.length === state.length) return null;
        commit(next, { onUndo: 'delete "' + target.title + '"' });
        return target;
      },

      removeMany: function (ids) {
        var set = {};
        ids.forEach(function (id) { set[id] = true; });
        var removed = state.filter(function (t) { return set[t.id]; });
        if (!removed.length) return [];
        commit(state.filter(function (t) { return !set[t.id]; }),
          { onUndo: 'delete ' + removed.length + ' task(s)' });
        return removed;
      },

      clearCompleted: function () {
        var removed = state.filter(function (t) { return t.done; });
        if (!removed.length) return [];
        commit(state.filter(function (t) { return !t.done; }),
          { onUndo: 'clear ' + removed.length + ' completed task(s)' });
        return removed;
      },

      replaceAll: function (list, now) {
        commit(sanitizeList(list, now), { onUndo: 'import tasks' });
        return state;
      },

      /** Merge imported todos, skipping titles that already exist. */
      mergeAll: function (list, now) {
        var titles = {};
        state.forEach(function (t) { titles[t.title.toLowerCase()] = true; });
        var incoming = sanitizeList(list, now).filter(function (t) {
          if (titles[t.title.toLowerCase()]) return false;
          titles[t.title.toLowerCase()] = true;
          return true;
        });
        if (!incoming.length) return [];
        commit(state.concat(incoming), { onUndo: 'import ' + incoming.length + ' task(s)' });
        return incoming;
      },

      reset: function () { return commit([]); },

      canUndo: function () { return snapshot !== null; },
      undoLabel: function () { return undoLabel; },
      undo: function () {
        if (snapshot === null) return null;
        var restored = sanitizeList(safeParse(snapshot));
        snapshot = null;
        undoLabel = '';
        return commit(restored, { snapshot: false });
      },

      subscribe: function (fn) {
        listeners.push(fn);
        return function () {
          listeners = listeners.filter(function (item) { return item !== fn; });
        };
      },

      toJSON: function (pretty) {
        return JSON.stringify({
          version: 1,
          savedAt: new Date().toISOString(),
          todos: state
        }, null, pretty ? 2 : 0);
      }
    };

    return api;
  }

  NS.createStore = createStore;
  NS.makeStorage = makeStorage;
}());
