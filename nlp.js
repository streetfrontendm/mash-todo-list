/* ==========================================================================
   nlp.js — natural-language parsing.
   Two jobs:
     1. parseQuickAdd(): turn "Call mom tomorrow !! #family" into a todo input.
     2. localAssistant(): an offline assistant that maps a sentence onto actions.
   Exposed as window.TodoAI.nlp.
   ========================================================================== */
(function () {
  'use strict';

  var NS = (window.TodoAI = window.TodoAI || {});
  var dates = NS.dates;
  var todos = NS.todos;

  var WEEKDAYS = {
    sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tues: 2, tue: 2,
    wednesday: 3, wed: 3, weds: 3, thursday: 4, thurs: 4, thur: 4, thu: 4,
    friday: 5, fri: 5, saturday: 6, sat: 6
  };
  var MONTHS = {
    january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3, apr: 3,
    may: 4, june: 5, jun: 5, july: 6, jul: 6, august: 7, aug: 7, september: 8,
    sept: 8, sep: 8, october: 9, oct: 9, november: 10, nov: 10, december: 11, dec: 11
  };
  var NUM_WORDS = {
    a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
    seven: 7, eight: 8, nine: 9, ten: 10, a_couple: 2, couple: 2
  };

  function asDate(now) { return now instanceof Date ? new Date(now.getTime()) : new Date(); }

  /** Shift an ISO date by whole months, clamping the day (Jan 31 + 1 month = Feb 28). */
  function addMonths(iso, count) {
    var d = dates.fromISO(iso);
    var day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + count);
    var last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, last));
    return dates.toISO(d);
  }

  function upcomingWeekday(targetDow, now) {
    var today = asDate(now);
    var offset = (targetDow - today.getDay() + 7) % 7;
    return offset === 0 ? 7 : offset;
  }

  /**
   * Find the first date phrase in `text`.
   * @returns {{due: string|null, matched: string|null}}
   * Notes: times ("3pm") are intentionally left in the title; "next friday" means
   * the Friday of the following week, matching common task-app behaviour.
   */
  function parseDate(text, now) {
    var src = String(text || '');
    var lower = ' ' + src.toLowerCase() + ' ';
    var todayIso = dates.todayISO(now);
    var m;

    function result(due, matched) { return { due: due, matched: matched }; }

    m = lower.match(/\b(day after tomorrow)\b/);
    if (m) return result(dates.addDays(todayIso, 2), m[1]);

    m = lower.match(/\b(today|tonight|this evening|this afternoon)\b/);
    if (m) return result(todayIso, m[1]);

    m = lower.match(/\b(tomorrow|tmrw|tmw|tomorow|tomorow morning)\b/);
    if (m) return result(dates.addDays(todayIso, 1), m[1]);

    m = lower.match(/\bnext\s+(week|month)\b/);
    if (m) return result(m[1] === 'week' ? dates.addDays(todayIso, 7) : addMonths(todayIso, 1), m[0].trim());

    m = lower.match(/\bin\s+(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+(day|days|week|weeks|month|months)\b/);
    if (m) {
      var amount = NUM_WORDS[m[1]] || parseInt(m[1], 10) || 1;
      var unit = m[2].charAt(0) === 'd' ? amount : (m[2].charAt(0) === 'w' ? amount * 7 : null);
      var due = unit === null ? addMonths(todayIso, amount) : dates.addDays(todayIso, unit);
      return result(due, m[0].trim());
    }

    m = lower.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
    if (m) {
      var iso = m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
      if (dates.isISODate(iso)) return result(iso, m[0]);
    }

    m = lower.match(/\b(?:on\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
    if (m) {
      var month = parseInt(m[1], 10);
      var dayNum = parseInt(m[2], 10);
      var year = m[3] ? (m[3].length === 2 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10)) : null;
      if (month >= 1 && month <= 12 && dayNum >= 1 && dayNum <= 31) {
        return result(dates.toISO(resolveYearFwd(year, month - 1, dayNum, now)), m[0]);
      }
    }

    m = lower.match(/\b(?:on\s+|by\s+|due\s+|before\s+)?(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
    if (m) return result(dates.toISO(resolveYearFwd(null, MONTHS[m[1]], parseInt(m[2], 10), now)), m[0].trim());

    m = lower.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\b/);
    if (m) return result(dates.toISO(resolveYearFwd(null, MONTHS[m[2]], parseInt(m[1], 10), now)), m[0].trim());

    m = lower.match(/\b(next|this|on|by|due|before)?\s*(sun|sunday|mon|monday|tue|tues|tuesday|wed|weds|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday)\b/);
    if (m) {
      var offset = upcomingWeekday(WEEKDAYS[m[2]], now);
      if (m[1] === 'next') offset += 7;
      return result(dates.addDays(todayIso, offset), m[0].trim());
    }

    return result(null, null);
  }

  /** Build a Date from month/day, rolling into next year when the date has passed. */
  function resolveYearFwd(year, monthIndex, day, now) {
    var ref = asDate(now);
    var out = new Date(year === null ? ref.getFullYear() : year, monthIndex, day);
    if (year === null && dates.toISO(out) < dates.todayISO(now)) {
      out = new Date(ref.getFullYear() + 1, monthIndex, day);
    }
    return out;
  }

  /* ---------------------------------------------------------- quick add -- */

  var ADD_PREFIX = /^(?:please\s+)?(?:add|create|new|todo|to-do|task|remember|remind me)\b[\s:,-]*(?:to\s+|me\s+to\s+)?/i;

  /**
   * Turn a raw line into todo input fields.
   * Recognises dates, priorities (!! / ! / p1..p3), #tags and repeats.
   */
  function parseQuickAdd(text, now) {
    var raw = String(text || '').replace(/\s+/g, ' ').trim();
    var working = raw;
    var priority = null;
    var repeat = null;
    var tagList = [];

    working = working.replace(ADD_PREFIX, '');

    // priority
    if (/!{2,}|!!|\(!\)|\bp1\b|\bhigh priority\b|\burgent\b|\basap\b/i.test(working)) priority = 'high';
    else if (/!|\bp2\b|\bmedium priority\b/i.test(working)) priority = 'medium';
    else if (/\bp3\b|\blow priority\b|\bwhenever\b/i.test(working)) priority = 'low';

    if (/[!]{1,}/.test(working)) {
      working = working.replace(/\s*!{1,}\s*/g, ' ');
    }
    working = working
      .replace(/\b(high|medium|low) priority\b/gi, ' ')
      .replace(/\b(p[123])\b/gi, ' ')
      .replace(/\b(urgent|asap|whenever)\b/gi, ' ');

    // repeat
    var rep = working.match(/\b(every\s+(day|weekday|week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|daily|weekly|each\s+(day|week))\b/i);
    if (rep) {
      repeat = /week|monday|tuesday|wednesday|thursday|friday|saturday|sunday/i.test(rep[0]) ? 'weekly' : 'daily';
      working = working.replace(rep[0], ' ');
    }

    // tags: "#home" and "tag home, errands"
    working = working.replace(/#([\p{L}\p{N}_-]+)/gu, function (_, tag) {
      tagList.push(tag);
      return ' ';
    });
    working = working.replace(/\btags?\s+((?:[\p{L}\p{N}_-]+)(?:\s*(?:,|and|\/)\s*[\p{L}\p{N}_-]+)*)/giu,
      function (_, group) {
        group.split(/\s*(?:,|and|\/)\s*/).forEach(function (tag) { tagList.push(tag); });
        return ' ';
      });

    // date
    var found = parseDate(working, now);
    if (found.matched) {
      var escaped = found.matched.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
      working = working.replace(new RegExp(escaped, 'i'), ' ');
    }

    var title = working
      .replace(/\s+/g, ' ')
      .replace(/^[\s,:;.\-]+|[\s,:;.\-]+$/g, '')
      .replace(/^(?:due|by|on|for|at)\s+/i, '')
      .trim();

    if (!title && found.due) title = 'New task';
    if (!title) return null;

    return {
      title: title.charAt(0).toUpperCase() + title.slice(1),
      priority: priority || 'medium',
      due: found.due || null,
      tags: tagList,
      repeat: repeat
    };
  }

  /* -------------------------------------------------- selectors & intents */

  var SELECTORS = [
    { re: /\b(overdue)\b/i, pick: function (all, now) { return all.filter(function (t) { return dates.dueTone(t.due, now) === 'overdue'; }); } },
    { re: /\b(due\s+today|today'?s)\b/i, pick: function (all, now) { return all.filter(function (t) { return dates.dueTone(t.due, now) === 'today'; }); } },
    { re: /\b(high\s+priority|important|urgent)\b/i, pick: function (all) { return all.filter(function (t) { return t.priority === 'high'; }); } },
    { re: /\b(no\s+due\s+date|without\s+(?:a\s+)?date|undated)\b/i, pick: function (all) { return all.filter(function (t) { return !t.due; }); } },
    { re: /\b(everything|all(?: of them)?|all tasks|the rest)\b/i, pick: function (all) { return all; } }
  ];

  /**
   * Resolve a phrase like "everything due today" or "the milk task" to todos.
   * @returns {{todos: Array, done: Array, selector: string|null}}
   */
  function selectTodos(ref, store, now, opts) {
    opts = opts || {};
    var all = store.list().filter(function (t) { return opts.includeDone ? true : !t.done; });
    var text = String(ref == null ? '' : ref).trim();
    var lower = text.toLowerCase();
    var selector = null;

    for (var i = 0; i < SELECTORS.length; i++) {
      var match = lower.match(SELECTORS[i].re);
      if (match) {
        selector = match[0];
        var picked = SELECTORS[i].pick(all, now);
        // "everything" alone means "everything still open"; but "everything due today"
        // should not silently become "everything".
        if (!(/everything|all/.test(lower) && picked.length === 0)) {
          return { todos: picked, done: [], selector: selector };
        }
      }
    }

    var cleaned = lower
      .replace(/\b(the|a|an|task|tasks|item|items|todo|todos|ones|my)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    cleaned = cleaned.replace(/^(?:about|for|to|of)\s+/, '').trim();

    var found = store.resolve(cleaned || text, { all: !!opts.all, includeDone: !!(opts.all || opts.includeDone) });
    var done = store.list().filter(function (t) { return t.done && found.indexOf(t) !== -1; });
    return { todos: found, done: done, selector: selector };
  }

  /* ------------------------------------------------ offline assistant ---- */

  var ADD_VERB = /^(?:please\s+)?(?:add|create|new task|new todo|remember|remind me|i need to|i have to|todo)\b/i;
  var COMPLETE_VERB = /^(?:i\s+|i've\s+|ive\s+|just\s+)?(?:finished|completed|did|done with|checked off|ticked off)\s+(.+)$/i;
  var MARK_DONE = /^(?:mark|set|check|tick)?\s*(.+?)\s+(?:as\s+)?(?:done|complete|completed|finished)\b\s*$/i;
  var COMPLETE_OBJ = /^(?:check off|tick off|complete|finish|close|do)\s+(.+)$/i;
  var DELETE_VERB = /^(?:please\s+)?(?:delete|remove|drop|cancel|forget|get rid of|scratch)\s+(.+)$/i;
  var MOVE_VERB = /^(?:move|reschedule|push|postpone|defer|shift|change)\s+(.+?)\s+(?:to|until|for|by|onto|till)\s+(.+)$/i;
  var PRIORITY_VERB = /(?:make|mark|set|change|prioritize|prioritise)\s+(.+?)\s+(?:to\s+|as\s+)?(high|medium|low|top|urgent|p[123])\s*(?:priority)?\s*$/i;

  function quoteList(items, limit) {
    var names = items.slice(0, limit || 4).map(function (t) { return '"' + t.title + '"'; });
    if (items.length > names.length) names.push('+' + (items.length - names.length) + ' more');
    return names.join(', ');
  }

  function dueLabel(todo, now) {
    return todo.due ? dates.humanDue(todo.due, now) : 'no date';
  }

  function planReply(store, now) {
    var open = NS.todos.sortTodos(store.list().filter(function (t) { return !t.done; }), 'smart', now);
    var stat = NS.todos.stats(store.list(), now);
    if (!open.length) {
      return {
        intent: 'plan',
        reply: 'Nothing is open right now — your list is clear. 🎉 Add something and I will slot it in.',
        actions: []
      };
    }
    var lines = open.slice(0, 5).map(function (t, i) {
      return (i + 1) + '. ' + t.title + ' — ' + dueLabel(t, now) + ' (' + t.priority + ' priority)';
    });
    var head = 'Here is a sensible order for today' +
      (stat.overdue ? ' — ' + stat.overdue + ' task(s) are overdue' : '') + ':';
    var tail = open.length > 5 ? '\n\n(' + (open.length - 5) + ' more task(s) after that.)' : '';
    return { intent: 'plan', reply: head + '\n\n' + lines.join('\n') + tail, actions: [] };
  }
  /**
   * Offline assistant: understand a sentence and return {intent, reply, actions}.
   * It never touches storage itself — the caller applies the returned actions.
   */
  function localAssistant(text, store, now) {
    var input = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    var lower = input.toLowerCase();
    var stat = NS.todos.stats(store.list(), now);
    var open = store.list().filter(function (t) { return !t.done; });

    if (!input) {
      return { intent: 'empty', reply: 'Tell me what to change, e.g. "add call the bank tomorrow".', actions: [] };
    }

    // ---- help
    if (/^(help|hi|hello|hey|what can you do|how do you work|what are you)\b/.test(lower)) {
      return {
        intent: 'help',
        reply: 'I am your list assistant and I run fully offline.\n\n' +
          '• "add buy milk tomorrow !! #errands"\n' +
          '• "finish the report" — marks a task done\n' +
          '• "move everything due today to tomorrow"\n' +
          '• "make the budget task high priority"\n' +
          '• "delete the milk task"\n' +
          '• "plan my day" or "what should I do first?"\n' +
          '• "clear completed"\n\n' +
          'Connect an API key in AI settings for free-form conversation.',
        actions: []
      };
    }

    // ---- clear completed
    if (/\b(clear|remove|delete|purge|hide)\s+(?:the\s+|all\s+)?(?:completed|finished|done|checked)\b/.test(lower)) {
      return {
        intent: 'clear_completed',
        reply: stat.done ? 'Clearing ' + stat.done + ' completed task(s).' : 'There is nothing completed to clear.',
        actions: stat.done ? [{ type: 'clear_completed' }] : []
      };
    }

    // ---- plan my day ("plants" must not match, so the verb list is explicit)
    if (/\b(plan|plans|planning|planned|schedule|scheduling|organise|organize|organising|organizing)\b/.test(lower) ||
      /\bmy day\b/.test(lower)) {
      return planReply(store, now);
    }

    // ---- what first
    if (/\b(what|which)\b.*\b(first|next|now|start|priorit)\w*\b/.test(lower) || /\bwhat should i\b/.test(lower)) {
      var ranked = NS.todos.sortTodos(open, 'smart', now);
      if (!ranked.length) {
        return { intent: 'first', reply: 'Your list is empty — nothing to prioritise.', actions: [] };
      }
      var top = ranked[0];
      var why = [];
      if (dates.dueTone(top.due, now) === 'overdue') why.push('it is overdue');
      else if (dates.dueTone(top.due, now) === 'today') why.push('it is due today');
      if (top.priority === 'high') why.push('it is high priority');
      return {
        intent: 'first',
        reply: 'Start with "' + top.title + '" — ' + dueLabel(top, now) + ', ' + top.priority + ' priority' +
          (why.length ? ' (' + why.join(' and ') + ')' : '') + '.' +
          (ranked[1] ? '\n\nAfter that: "' + ranked[1].title + '".' : ''),
        actions: []
      };
    }

    // ---- summary
    if (/\b(how many|summary|overview|status|what'?s left|whats left|anything left|count)\b/.test(lower)) {
      return {
        intent: 'summary',
        reply: stat.all === 0
          ? 'Your list is empty.'
          : 'You have ' + stat.active + ' open task(s) and ' + stat.done + ' completed' +
            (stat.overdue ? ', ' + stat.overdue + ' overdue' : '') +
            (stat.today ? ', ' + stat.today + ' due today' : '') + '.',
        actions: []
      };
    }

    // ---- complete
    var m = input.match(COMPLETE_VERB) || input.match(MARK_DONE) || input.match(COMPLETE_OBJ);
    if (m && m[1] && !/^(?:what|how|why|when)\b/i.test(input)) {
      if (/^(everything|all|my list|them)$/i.test(m[1].trim())) {
        return {
          intent: 'complete',
          reply: open.length ? 'Marking all ' + open.length + ' open task(s) done.' : 'Nothing is open.',
          actions: open.map(function (t) { return { type: 'complete', ids: [t.id], label: t.title }; })
        };
      }
      var sel = selectTodos(m[1], store, now, {});
      if (sel.todos.length) {
        return {
          intent: 'complete',
          reply: 'Nice — marking ' + quoteList(sel.todos, 3) + ' as done.',
          actions: sel.todos.map(function (t) { return { type: 'complete', ids: [t.id], label: t.title }; })
        };
      }
      if (sel.done.length) {
        return { intent: 'complete', reply: '"' + sel.done[0].title + '" is already done. ✅', actions: [] };
      }
      return { intent: 'complete', reply: 'I could not find a task matching "' + m[1].trim() + '".', actions: [] };
    }

    // ---- delete
    m = input.match(DELETE_VERB);
    if (m && !/\b(completed|finished|done|checked)\b/i.test(m[1])) {
      var del = selectTodos(m[1], store, now, { all: /everything|all/i.test(m[1]) });
      if (del.todos.length) {
        return {
          intent: 'delete',
          reply: 'Deleting ' + quoteList(del.todos, 3) + '. (Undo is available if that was wrong.)',
          actions: del.todos.map(function (t) { return { type: 'delete', ids: [t.id], label: t.title }; })
        };
      }
      return { intent: 'delete', reply: 'I could not find a task matching "' + m[1].trim() + '".', actions: [] };
    }

    // ---- move / reschedule
    m = input.match(MOVE_VERB);
    if (m) {
      var when = parseDate(m[2], now);
      if (!when.due) {
        return {
          intent: 'reschedule',
          reply: 'I understood the tasks but not the date in "' + m[2].trim() +
            '". Try "tomorrow", "next friday" or "2026-10-05".',
          actions: []
        };
      }
      var targets = selectTodos(m[1], store, now, { all: true });
      if (!targets.todos.length) {
        return { intent: 'reschedule', reply: 'I could not find any task matching "' + m[1].trim() + '".', actions: [] };
      }
      return {
        intent: 'reschedule',
        reply: 'Moving ' + quoteList(targets.todos, 4) + ' to ' +
          dates.humanDue(when.due, now).toLowerCase() + ' (' + when.due + ').',
        actions: targets.todos.map(function (t) {
          return { type: 'update', ids: [t.id], label: t.title, patch: { due: when.due } };
        })
      };
    }

    // ---- priority
    m = input.match(PRIORITY_VERB);
    if (m) {
      var level = /^(high|top|urgent|p1)$/i.test(m[2]) ? 'high' : (/^low$/i.test(m[2]) ? 'low' : 'medium');
      var prio = selectTodos(m[1], store, now, { all: /everything|all/i.test(m[1]) });
      if (prio.todos.length) {
        return {
          intent: 'prioritize',
          reply: 'Setting ' + quoteList(prio.todos, 4) + ' to ' + level + ' priority.',
          actions: prio.todos.map(function (t) {
            return { type: 'update', ids: [t.id], label: t.title, patch: { priority: level } };
          })
        };
      }
      return { intent: 'prioritize', reply: 'I could not find a task matching "' + m[1].trim() + '".', actions: [] };
    }

    // ---- add: explicit verb, or a phrase carrying task-ish signals
    var looksLikeTask = ADD_VERB.test(input) || /[!#]/.test(input) ||
      !!parseDate(input, now).due || /\b(every day|every week|daily|weekly)\b/i.test(input);
    if (looksLikeTask) {
      var parsed = parseQuickAdd(input, now);
      if (parsed) {
        return {
          intent: 'add',
          reply: 'Added "' + parsed.title + '"' +
            (parsed.due ? ' for ' + dates.humanDue(parsed.due, now).toLowerCase() : '') +
            (parsed.priority !== 'medium' ? ' (' + parsed.priority + ' priority)' : '') +
            (parsed.tags.length ? ' #' + parsed.tags.join(' #') : '') + '.',
          actions: [{
            type: 'add',
            title: parsed.title,
            priority: parsed.priority,
            due: parsed.due,
            tags: parsed.tags,
            repeat: parsed.repeat
          }]
        };
      }
    }

    // ---- fallback: keep the chat useful instead of dead-ending
    return {
      intent: 'unknown',
      reply: 'I am not sure what to change there. I can add, complete, reschedule, reprioritise or delete tasks. ' +
        (stat.active ? 'Right now you have ' + stat.active + ' open task(s).' : 'Your list is currently empty.') +
        '\n\nTip: connect a model in AI settings for free-form questions.',
      actions: []
    };
  }

  NS.nlp = {
    parseDate: parseDate,
    parseQuickAdd: parseQuickAdd,
    selectTodos: selectTodos,
    localAssistant: localAssistant,
    addMonths: addMonths,
    WEEKDAYS: WEEKDAYS,
    MONTHS: MONTHS
  };
}());
