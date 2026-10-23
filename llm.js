/*
 * Optional LLM brain (Google Gemini or Anthropic Claude), called directly from the browser.
 * The API key stays in this browser's localStorage and is sent only to the chosen provider.
 */
(function (root) {
  const DEFAULT_MODELS = { gemini: 'gemini-2.5-flash', claude: 'claude-haiku-5-5' };

  function parseJson(text) {
    const cleaned = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    try { return JSON.parse(cleaned); } catch (e) { /* fall through */ }
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch (e) { /* fall through */ } }
    // The model answered in plain text: still usable as a spoken reply.
    return { reply: cleaned, action: 'none' };
  }

  async function callGemini({ apiKey, model, system, history }) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: history.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      generationConfig: { temperature: 0.3, maxOutputTokens: 400, responseMimeType: 'application/json' },
    };
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data.error && data.error.message) || `Gemini error ${res.status}`);
    const text = (((data.candidates || [])[0] || {}).content || {}).parts?.map(p => p.text).join('') || '';
    return parseJson(text);
  }

  async function callClaude({ apiKey, model, system, history }) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({ model, max_tokens: 400, temperature: 0.3, system, messages: history }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data.error && data.error.message) || `Claude error ${res.status}`);
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    return parseJson(text);
  }

  /**
   * history: [{role: 'user'|'assistant', content}] — must start with a user turn,
   * so the caller-side "call connected" event is sent first.
   */
  async function turn({ provider, apiKey, model, system, history }) {
    const fn = provider === 'claude' ? callClaude : callGemini;
    const out = await fn({ apiKey, model: model || DEFAULT_MODELS[provider], system, history });
    if (!out || typeof out.reply !== 'string' || !out.reply.trim()) throw new Error('The AI returned an empty reply');
    out.action = out.action || 'none';
    return out;
  }

  root.LLM = { turn, DEFAULT_MODELS };
})(typeof globalThis !== 'undefined' ? globalThis : this);
