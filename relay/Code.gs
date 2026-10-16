/**
 * Jarvis relay — Google Apps Script web app.
 * Keeps the AI key on Google's side; the Jarvis page only sends the
 * conversation and a passcode.
 *
 * Script Properties (Project Settings → Script properties):
 *   PASSCODE           any secret word; the page must send the same one
 *   GEMINI_API_KEY     free key from https://aistudio.google.com/apikey  (used when present)
 *   ANTHROPIC_API_KEY  paid key from https://console.anthropic.com      (used when there is no Gemini key)
 *   MODEL              optional; defaults to gemini-flash-latest / claude-opus-5-5
 */
var RELAY_VERSION = 3;

// Opening the /exec link in a browser shows this: which version is live and which keys it can see (never the keys).
function doGet() {
  var props = PropertiesService.getScriptProperties();
  return json_({ ok: true, status: 'Jarvis relay is running', version: RELAY_VERSION,
    gemini_key: !!props.getProperty('GEMINI_API_KEY'), anthropic_key: !!props.getProperty('ANTHROPIC_API_KEY'),
    passcode_set: !!props.getProperty('PASSCODE') });
}

function doPost(e) {
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var props = PropertiesService.getScriptProperties();
    var gemini = props.getProperty('GEMINI_API_KEY');
    var anthropic = props.getProperty('ANTHROPIC_API_KEY');
    var pass = props.getProperty('PASSCODE');
    if (!gemini && !anthropic) return json_({ ok: false, error: 'no_key' });
    if (!pass || req.pass !== pass) return json_({ ok: false, error: 'bad_pass' });

    var messages = (Array.isArray(req.messages) ? req.messages : [])
      .filter(function (m) { return m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim(); })
      .slice(-30)
      .map(function (m) { return { role: m.role, content: m.content.slice(0, 8000) }; });
    while (messages.length && messages[0].role !== 'user') messages.shift();
    if (!messages.length || messages[messages.length - 1].role !== 'user') return json_({ ok: false, error: 'bad_request' });
    var system = String(req.system || '').slice(0, 20000);
    var model = props.getProperty('MODEL');

    return json_(gemini ? askGeminiWithBackup_(gemini, model, system, messages)
                        : askClaude_(anthropic, model || 'claude-opus-5-5', system, messages));
  } catch (err) {
    return json_({ ok: false, error: 'relay_error', detail: String(err) });
  }
}

// The free tier is sometimes busy (503) or rate limited (429); fall back to the lighter model.
function askGeminiWithBackup_(key, model, system, messages) {
  var models = model ? [model] : ['gemini-flash-latest', 'gemini-flash-lite-latest'];
  var out;
  for (var i = 0; i < models.length; i++) {
    out = askGemini_(key, models[i], system, messages);
    if (out.ok || (out.error !== 'busy' && out.error !== 'rate_limited')) return out;
  }
  if (out.error === 'busy') out.error = 'rate_limited';
  return out;
}

function askGemini_(key, model, system, messages) {
  var body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: messages.map(function (m) { return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }; }),
    generationConfig: { maxOutputTokens: 2048 }
  };
  var res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': key },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  var data = JSON.parse(res.getContentText() || '{}');
  if (code !== 200) {
    var msg = (data.error && (data.error.status || data.error.message)) || String(code);
    var bad = code === 400 && /API_KEY|api key/i.test(JSON.stringify(data.error || {}));
    return { ok: false, error: code === 429 ? 'rate_limited' : (code === 503 || code === 500 ? 'busy' : (bad || code === 403 ? 'bad_key' : (code === 404 ? 'bad_model' : 'api_error'))), detail: msg };
  }
  var cand = (data.candidates || [])[0];
  if (!cand) return { ok: false, error: (data.promptFeedback && data.promptFeedback.blockReason) ? 'refused' : 'empty' };
  var text = ((cand.content && cand.content.parts) || []).filter(function (p) { return p.text && !p.thought; }).map(function (p) { return p.text; }).join('').trim();
  if (!text) return { ok: false, error: cand.finishReason === 'SAFETY' ? 'refused' : 'empty' };
  return { ok: true, text: text, truncated: cand.finishReason === 'MAX_TOKENS' };
}

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
