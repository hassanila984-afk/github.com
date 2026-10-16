/**
 * Jarvis relay — Google Apps Script web app.
 * Keeps the AI key on Google's side, and gives Jarvis tools that run inside
 * your own Google account: web search, Calendar, Gmail (read + drafts only),
 * and a small memory.
 *
 * Script Properties (Project Settings → Script properties):
 *   PASSCODE           secret the page must send. Gmail/Calendar tools only switch on
 *                      when it is at least 12 characters long.
 *   GEMINI_API_KEY     free key from https://aistudio.google.com/apikey  (used when present)
 *   ANTHROPIC_API_KEY  paid key from https://console.anthropic.com (used only without a Gemini key; no tools)
 *   MODEL              optional; overrides the default model
 *
 * After pasting this code, run the function `authorize` once from the editor
 * (choose it next to the Run button) so Google asks for Gmail/Calendar access.
 */
var RELAY_VERSION = 4;
// The lite model answers fastest on the free tier; the bigger one is the backup when it is busy.
var GEMINI_MODELS = ['gemini-flash-lite-latest', 'gemini-flash-latest'];
var MAX_TOOL_ROUNDS = 6;

function authorize() {
  GmailApp.getInboxUnreadCount();
  CalendarApp.getDefaultCalendar().getName();
  Maps.newGeocoder();
  Logger.log('Access granted. Jarvis can use Gmail, Calendar and Maps now.');
}

// Opening the /exec link in a browser shows which version is live and what is configured (never the keys).
function doGet() {
  var props = PropertiesService.getScriptProperties();
  var pass = props.getProperty('PASSCODE') || '';
  return json_({ ok: true, status: 'Jarvis relay is running', version: RELAY_VERSION,
    gemini_key: !!props.getProperty('GEMINI_API_KEY'), anthropic_key: !!props.getProperty('ANTHROPIC_API_KEY'),
    passcode_set: !!pass, account_tools: pass.length >= 12 });
}

function doPost(e) {
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var props = PropertiesService.getScriptProperties();
    var gemini = props.getProperty('GEMINI_API_KEY');
    var anthropic = props.getProperty('ANTHROPIC_API_KEY');
    var pass = props.getProperty('PASSCODE');
    if (!gemini && !anthropic) return json_({ ok: false, error: 'no_key' });
    if (locked_()) return json_({ ok: false, error: 'locked' });
    if (!pass || req.pass !== pass) { failed_(); return json_({ ok: false, error: 'bad_pass' }); }

    var messages = (Array.isArray(req.messages) ? req.messages : [])
      .filter(function (m) { return m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim(); })
      .slice(-30)
      .map(function (m) { return { role: m.role, content: m.content.slice(0, 8000) }; });
    while (messages.length && messages[0].role !== 'user') messages.shift();
    if (!messages.length || messages[messages.length - 1].role !== 'user') return json_({ ok: false, error: 'bad_request' });
    var system = String(req.system || '').slice(0, 20000);
    var model = props.getProperty('MODEL');

    if (!gemini) return json_(askClaude_(anthropic, model || 'claude-opus-5-5', system, messages));
    var ctx = { key: gemini, models: model ? [model] : GEMINI_MODELS, account: pass.length >= 12, place: placeFrom_(req.location) };
    return json_(runJarvis_(ctx, system, messages));
  } catch (err) {
    return json_({ ok: false, error: 'relay_error', detail: String(err) });
  }
}

/* ---------------- Gemini with tools ---------------- */

function runJarvis_(ctx, system, messages) {
  var tz = Session.getScriptTimeZone();
  var now = Utilities.formatDate(new Date(), tz, "EEEE yyyy-MM-dd HH:mm '(" + tz + ")'");
  var memory = PropertiesService.getScriptProperties().getProperty('MEMORY') || '';
  var sys = system + '\n\n--- Tools and context (from the relay) ---\n' +
    'Current date and time: ' + now + '.\n' +
    (ctx.place ? 'Hero\'s approximate current location: ' + ctx.place + '. Use it for anything "nearby".\n' : 'Hero\'s location is unknown; ask for the city if a question needs it.\n') +
    'You have tools. Use them instead of saying you cannot do something: web_search for anything live or factual (news, prices, places, delivery, opening hours, weather), ' +
    (ctx.account ? 'calendar_list / calendar_add for Hero\'s Google Calendar, gmail_search / gmail_read / gmail_draft for Hero\'s Gmail, ' : '') +
    'memory_save when Hero asks you to remember something or shares a lasting fact.\n' +
    (ctx.account ? 'Before calendar_add or gmail_draft, tell Hero exactly what you will add or write and wait for a clear yes in the conversation; only then call it with confirmed=true. You can never send emails, only drafts that Hero sends from Gmail.\n' :
      'Gmail and Calendar tools are switched off until Hero sets a passcode of 12+ characters in the relay; say so if asked.\n') +
    'If a tool fails, say so briefly. Keep spoken answers short.\n' +
    (memory ? '\nThings Hero asked you to remember:\n' + memory + '\n' : '');

  var contents = messages.map(function (m) { return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }; });
  var tools = [{ functionDeclarations: toolDecls_(ctx.account) }];
  var used = [];
  for (var round = 0; round < MAX_TOOL_ROUNDS; round++) {
    var res = gemini_(ctx, { systemInstruction: { parts: [{ text: sys }] }, contents: contents, tools: tools, generationConfig: { maxOutputTokens: 2048 } });
    if (!res.ok) return res;
    var cand = res.cand, parts = (cand.content && cand.content.parts) || [];
    var calls = parts.filter(function (p) { return p.functionCall; });
    if (!calls.length) {
      var text = parts.filter(function (p) { return p.text && !p.thought; }).map(function (p) { return p.text; }).join('').trim();
      if (!text) return { ok: false, error: cand.finishReason === 'SAFETY' ? 'refused' : 'empty', used: used };
      return { ok: true, text: text, truncated: cand.finishReason === 'MAX_TOKENS', used: used };
    }
    contents.push({ role: 'model', parts: parts });   // keep the model's parts as-is (they can carry thought signatures)
    contents.push({ role: 'user', parts: calls.map(function (p) {
      var name = p.functionCall.name, out;
      used.push(name);
      try { out = runTool_(ctx, name, p.functionCall.args || {}); } catch (err) { out = { error: String(err) }; }
      return { functionResponse: { name: name, response: { result: out } } };
    }) });
  }
  return { ok: false, error: 'empty', used: used };
}

function toolDecls_(account) {
  var t = [
    { name: 'web_search', description: 'Search Google for live or factual information: news, prices, places, businesses, delivery options, opening hours, weather, facts. Returns a short summary with names, addresses and phone numbers when relevant.',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'What to search for, including the city if location matters' } }, required: ['query'] } },
    { name: 'memory_save', description: 'Save a lasting fact Hero wants Jarvis to remember (preferences, people, plans).',
      parameters: { type: 'object', properties: { fact: { type: 'string' } }, required: ['fact'] } }
  ];
  if (!account) return t;
  return t.concat([
    { name: 'calendar_list', description: 'List events in Hero\'s Google Calendar from days_from (0 = today, -1 = yesterday) for `days` days.',
      parameters: { type: 'object', properties: { days_from: { type: 'integer' }, days: { type: 'integer' } }, required: ['days_from', 'days'] } },
    { name: 'calendar_add', description: 'Add an event or reminder to Hero\'s Google Calendar. Only after Hero clearly said yes to the exact event.',
      parameters: { type: 'object', properties: {
        title: { type: 'string' }, start: { type: 'string', description: 'Local date-time, e.g. 2026-10-17T15:00' },
        minutes: { type: 'integer', description: 'Duration in minutes (default 30)' }, reminder_minutes: { type: 'integer', description: 'Popup reminder before the start (default 15)' },
        details: { type: 'string' }, confirmed: { type: 'boolean' } }, required: ['title', 'start', 'confirmed'] } },
    { name: 'gmail_search', description: 'Search Hero\'s Gmail with Gmail search syntax (e.g. "is:unread", "from:ali newer_than:7d"). Returns subject, sender, date, snippet and thread_id.',
      parameters: { type: 'object', properties: { query: { type: 'string' }, max: { type: 'integer' } }, required: ['query'] } },
    { name: 'gmail_read', description: 'Read the messages of one Gmail thread by thread_id.',
      parameters: { type: 'object', properties: { thread_id: { type: 'string' } }, required: ['thread_id'] } },
    { name: 'gmail_draft', description: 'Create a Gmail draft (never sends). Use reply_thread_id to draft a reply. Only after Hero clearly said yes to the exact text.',
      parameters: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' }, reply_thread_id: { type: 'string' }, confirmed: { type: 'boolean' } }, required: ['body', 'confirmed'] } }
  ]);
}

function runTool_(ctx, name, a) {
  var tz = Session.getScriptTimeZone();
  if (name === 'web_search') {
    var q = String(a.query || '').slice(0, 500) + (ctx.place ? '\n(Searcher is near: ' + ctx.place + ')' : '');
    var r = gemini_(ctx, { contents: [{ role: 'user', parts: [{ text: 'Search the web and answer concisely with the key facts. Include names, addresses, phone numbers, prices and dates when relevant.\n\n' + q }] }],
      tools: [{ google_search: {} }], generationConfig: { maxOutputTokens: 1500 } });
    if (!r.ok) return { error: 'search unavailable: ' + r.error };
    return { summary: ((r.cand.content && r.cand.content.parts) || []).filter(function (p) { return p.text && !p.thought; }).map(function (p) { return p.text; }).join('').trim().slice(0, 4000) };
  }
  if (name === 'memory_save') {
    var props = PropertiesService.getScriptProperties();
    var mem = ((props.getProperty('MEMORY') || '') + '\n- ' + String(a.fact || '').slice(0, 500)).trim();
    while (mem.length > 8000) mem = mem.slice(mem.indexOf('\n- ', 1) + 1);
    props.setProperty('MEMORY', mem);
    return { saved: true };
  }
  if (!ctx.account) return { error: 'Gmail and Calendar are switched off: the relay passcode must be at least 12 characters.' };
  if (name === 'calendar_list') {
    var start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() + (parseInt(a.days_from, 10) || 0));
    var end = new Date(start); end.setDate(end.getDate() + Math.min(31, Math.max(1, parseInt(a.days, 10) || 1)));
    return { events: CalendarApp.getDefaultCalendar().getEvents(start, end).slice(0, 40).map(function (ev) {
      return { title: ev.getTitle(), start: Utilities.formatDate(ev.getStartTime(), tz, 'EEE yyyy-MM-dd HH:mm'), end: Utilities.formatDate(ev.getEndTime(), tz, 'HH:mm'),
        all_day: ev.isAllDayEvent(), location: ev.getLocation() || undefined };
    }) };
  }
  if (name === 'calendar_add') {
    if (a.confirmed !== true) return { error: 'Not added: confirm the exact event with Hero first.' };
    var m = String(a.start || '').match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/);
    if (!m) return { error: 'start must look like 2026-10-17T15:00' };
    var s = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    var ev = CalendarApp.getDefaultCalendar().createEvent(String(a.title || 'Reminder').slice(0, 200), s,
      new Date(s.getTime() + Math.max(5, parseInt(a.minutes, 10) || 30) * 60000), { description: String(a.details || '').slice(0, 2000) });
    ev.removeAllReminders(); ev.addPopupReminder(Math.max(0, parseInt(a.reminder_minutes, 10) || 15));
    return { added: true, when: Utilities.formatDate(s, tz, 'EEE yyyy-MM-dd HH:mm') };
  }
  if (name === 'gmail_search') {
    return { threads: GmailApp.search(String(a.query || 'in:inbox'), 0, Math.min(10, Math.max(1, parseInt(a.max, 10) || 5))).map(function (t) {
      var msg = t.getMessages()[t.getMessageCount() - 1];
      return { thread_id: t.getId(), subject: t.getFirstMessageSubject(), from: msg.getFrom(), date: Utilities.formatDate(msg.getDate(), tz, 'yyyy-MM-dd HH:mm'),
        unread: t.isUnread(), snippet: msg.getPlainBody().replace(/\s+/g, ' ').slice(0, 300) };
    }) };
  }
  if (name === 'gmail_read') {
    var th = GmailApp.getThreadById(String(a.thread_id || ''));
    if (!th) return { error: 'thread not found' };
    return { subject: th.getFirstMessageSubject(), messages: th.getMessages().slice(-5).map(function (x) {
      return { from: x.getFrom(), to: x.getTo(), date: Utilities.formatDate(x.getDate(), tz, 'yyyy-MM-dd HH:mm'), body: x.getPlainBody().slice(0, 3000) };
    }) };
  }
  if (name === 'gmail_draft') {
    if (a.confirmed !== true) return { error: 'Not drafted: confirm the exact text with Hero first.' };
    var body = String(a.body || '').slice(0, 10000);
    if (a.reply_thread_id) {
      var rt = GmailApp.getThreadById(String(a.reply_thread_id));
      if (!rt) return { error: 'thread not found' };
      rt.getMessages()[rt.getMessageCount() - 1].createDraftReply(body);
      return { drafted: true, note: 'Reply draft saved in Gmail Drafts. Hero sends it.' };
    }
    if (!a.to) return { error: 'missing recipient' };
    GmailApp.createDraft(String(a.to), String(a.subject || ''), body);
    return { drafted: true, note: 'Draft saved in Gmail Drafts. Hero sends it.' };
  }
  return { error: 'unknown tool ' + name };
}

// One Gemini request, falling back to the next model when the free tier is busy.
function gemini_(ctx, body) {
  var out;
  for (var i = 0; i < ctx.models.length; i++) {
    var res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(ctx.models[i]) + ':generateContent', {
      method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': ctx.key },
      payload: JSON.stringify(body), muteHttpExceptions: true
    });
    var code = res.getResponseCode(), data = JSON.parse(res.getContentText() || '{}');
    if (code === 200) {
      var cand = (data.candidates || [])[0];
      if (!cand) return { ok: false, error: (data.promptFeedback && data.promptFeedback.blockReason) ? 'refused' : 'empty' };
      return { ok: true, cand: cand };
    }
    var msg = (data.error && (data.error.status || data.error.message)) || String(code);
    var bad = code === 400 && /API_KEY|api key/i.test(JSON.stringify(data.error || {}));
    out = { ok: false, error: code === 429 ? 'rate_limited' : (code === 503 || code === 500 ? 'busy' : (bad || code === 403 ? 'bad_key' : (code === 404 ? 'bad_model' : 'api_error'))), detail: msg };
    if (out.error !== 'busy' && out.error !== 'rate_limited') return out;
  }
  if (out.error === 'busy') out.error = 'rate_limited';
  return out;
}

function placeFrom_(loc) {
  if (!loc || typeof loc.lat !== 'number' || typeof loc.lon !== 'number') return '';
  var key = 'geo_' + loc.lat.toFixed(2) + '_' + loc.lon.toFixed(2), cache = CacheService.getScriptCache(), hit = cache.get(key);
  if (hit) return hit;
  var place = loc.lat.toFixed(3) + ', ' + loc.lon.toFixed(3);
  try {
    var g = Maps.newGeocoder().setLanguage('en').reverseGeocode(loc.lat, loc.lon);
    if (g && g.results && g.results[0]) place = g.results[0].formatted_address + ' (' + place + ')';
  } catch (err) {}
  cache.put(key, place, 21600);
  return place;
}

/* ---------------- passcode lockout: 10 wrong tries locks the relay for an hour ---------------- */
function locked_() { return (+CacheService.getScriptCache().get('bad_pass') || 0) >= 10; }
function failed_() { var c = CacheService.getScriptCache(); c.put('bad_pass', String((+c.get('bad_pass') || 0) + 1), 3600); }

/* ---------------- Claude (paid key, no tools) ---------------- */

function askClaude_(key, model, system, messages) {
  var body = {
    model: model,
    max_tokens: 2048,
    system: system,
    messages: messages,
    output_config: { effort: 'low' },   // quick answers for voice
    fallbacks: 'default'                 // retry on another model if a safety check declines
  };
  var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'server-side-fallback-2026-07-01'
    },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  var data = JSON.parse(res.getContentText() || '{}');
  if (code !== 200) {
    var type = data && data.error && data.error.type;
    return { ok: false, error: code === 429 ? 'rate_limited' : (code === 401 ? 'bad_key' : 'api_error'), detail: type || String(code) };
  }
  if (data.stop_reason === 'refusal') return { ok: false, error: 'refused' };
  var text = (data.content || []).filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('').trim();
  if (!text) return { ok: false, error: 'empty' };
  return { ok: true, text: text, truncated: data.stop_reason === 'max_tokens' };
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
