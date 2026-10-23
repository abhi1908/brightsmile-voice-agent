/* UI, speech and storage for the BrightSmile voice agent. */
(function () {
  'use strict';
  const KB = window.CLINIC_KB;
  const Engine = window.VoiceEngine;
  const $ = id => document.getElementById(id);

  // ---------- storage (wrapped: storage can be blocked in private windows) ----------
  const store = {
    get(key, fallback) { try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch (e) { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; } },
  };

  const settings = Object.assign({ engine: 'offline', apiKey: '', model: '', voice: '', rate: 1, recLang: 'en-IN', autoListen: true, sheetUrl: '' }, store.get('bs_settings', {}));
  let requests = store.get('bs_requests', []);
  let memoryOnly = false; // true when localStorage is unavailable

  // ---------- call state ----------
  const state = { session: null, history: [], inCall: false, listening: false, speaking: false, thinking: false, muted: false, startedAt: 0, timerId: null, noSpeechRetries: 0 };

  // ---------- speech ----------
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const synth = window.speechSynthesis;
  let recognition = null;
  let voices = [];

  function loadVoices() {
    if (!synth) return;
    voices = synth.getVoices();
    const sel = $('voiceSelect');
    sel.innerHTML = '';
    const sorted = voices.slice().sort((a, b) => score(b) - score(a));
    sorted.forEach(v => {
      const o = document.createElement('option');
      o.value = v.name; o.textContent = `${v.name} (${v.lang})`;
      sel.appendChild(o);
    });
    if (!settings.voice && sorted[0]) settings.voice = sorted[0].name;
    sel.value = settings.voice;
  }
  // Prefer an Indian-English female voice, then any English voice.
  function score(v) {
    let s = 0;
    if (/en[-_]IN/i.test(v.lang)) s += 10;
    if (/^en/i.test(v.lang)) s += 5;
    if (/female|veena|heera|neerja|isha|samantha|google uk english female|aria|jenny/i.test(v.name)) s += 3;
    if (/google|natural|neural|online/i.test(v.name)) s += 2;
    return s;
  }

  // Makes numbers and symbols sound natural when read aloud.
  function toSpeech(text) {
    return text
      .replace(/₹\s?([\d,]+)/g, '$1 rupees')
      .replace(/\b(\d{5}) (\d{5})\b/g, (_, a, b) => (a + b).split('').join(' '))
      .replace(/\bBSD-(\d+)/g, (_, d) => 'B S D ' + d.split('').join(' '))
      .replace(/\bDr\./g, 'Doctor')
      .replace(/\bRCT\b/g, 'root canal');
  }

  function speak(text) {
    return new Promise(resolve => {
      if (state.muted || !synth) return resolve();
      synth.cancel();
      const u = new SpeechSynthesisUtterance(toSpeech(text));
      const v = voices.find(x => x.name === settings.voice);
      if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'en-IN';
      u.rate = +settings.rate || 1;
      let done = false;
      const finish = () => { if (done) return; done = true; state.speaking = false; updateUI(); resolve(); };
      u.onend = finish; u.onerror = finish;
      state.speaking = true; updateUI();
      synth.speak(u);
      // Safety net: some browsers never fire onend.
      setTimeout(finish, Math.max(4000, text.length * 110));
    });
  }

  function setupRecognition() {
    if (!SR) { $('browserWarning').hidden = false; return; }
    recognition = new SR();
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.maxAlternatives = 1;
    let finalText = '';
    recognition.onstart = () => { finalText = ''; state.listening = true; $('interim').textContent = 'Listening…'; updateUI(); };
    recognition.onresult = e => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript;
      }
      $('interim').textContent = (finalText + ' ' + interim).trim() || 'Listening…';
    };
    recognition.onerror = e => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') toast('Microphone access was blocked. Allow the microphone in your browser, or type instead.');
      else if (e.error === 'no-speech') state.noSpeech = true;
      else if (e.error !== 'aborted') toast('Voice input error: ' + e.error);
    };
    recognition.onend = () => {
      state.listening = false;
      $('interim').textContent = '';
      updateUI();
      const text = finalText.trim();
      if (text) { state.noSpeechRetries = 0; processUtterance(text); }
      else if (state.noSpeech && state.inCall && settings.autoListen && state.noSpeechRetries < 2) {
        state.noSpeech = false; state.noSpeechRetries++;
        listen();
      } else if (state.inCall) {
        state.noSpeech = false;
        setStatus('Press the microphone (or Space) when you want to speak.');
      }
    };
  }

  function listen() {
    if (!recognition || !state.inCall || state.thinking) return;
    if (state.speaking && synth) synth.cancel(); // barge-in
    recognition.lang = settings.recLang || 'en-IN';
    try { recognition.start(); } catch (e) { /* already started */ }
  }

  function stopListening() { if (recognition && state.listening) { try { recognition.abort(); } catch (e) { /* ignore */ } } }

  // ---------- call lifecycle ----------
  async function startCall() {
    if (state.inCall) return;
    state.session = Engine.createSession({ engineLabel: settings.engine });
    state.history = [{ role: 'user', content: '(The phone call has just connected. Greet the caller.)' }];
    state.inCall = true; state.startedAt = Date.now(); state.noSpeechRetries = 0;
    $('transcript').innerHTML = '';
    addMsg('system', `Call started · ${engineLabel()}`);
    state.timerId = setInterval(tick, 1000); tick();
    const greeting = Engine.greet(state.session);
    state.history.push({ role: 'assistant', content: JSON.stringify({ reply: greeting, action: 'none' }) });
    addMsg('agent', greeting);
    updateUI();
    await speak(greeting);
    if (state.inCall && settings.autoListen) listen();
  }

  function endCall(reason) {
    if (!state.inCall) return;
    state.inCall = false;
    clearInterval(state.timerId);
    stopListening();
    if (synth) synth.cancel();
    state.speaking = false;
    addMsg('system', reason || 'Call ended');
    renderSummary(Engine.summarize(state.session), state.session);
    updateUI();
    switchTab('summary');
  }

  function tick() {
    const s = Math.floor((Date.now() - state.startedAt) / 1000);
    $('timer').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  async function processUtterance(text) {
    if (!text.trim()) return;
    if (!state.inCall) await startCall();
    stopListening();
    addMsg('caller', text);
    state.thinking = true; updateUI();
    let out;
    try {
      out = settings.engine === 'offline' ? Engine.handle(state.session, text) : await llmTurn(text);
    } finally {
      state.thinking = false;
    }
    let reply = out.reply;
    let savedRec = null;
    if (out.save) {
      if (saveRequest(out.save)) savedRec = out.save;
      else reply = out.saveFailReply || 'Sorry, I could not save your request. Please call the clinic directly.';
    }
    addMsg('agent', reply, savedRec);
    updateUI();
    await speak(reply);
    if (out.end) return endCall('Call ended by caller');
    if (state.inCall && settings.autoListen) listen();
  }

  // ---------- LLM mode ----------
  async function llmTurn(text) {
    const s = state.session;
    // Deterministic guardrails run before the model sees the message.
    const g = Engine.guard(s, text);
    s.log.push({ role: 'caller', text, at: new Date().toISOString() });
    if (g) {
      state.history.push({ role: 'user', content: text }, { role: 'assistant', content: JSON.stringify({ reply: g.reply, action: 'none' }) });
      s.log.push({ role: 'agent', text: g.reply, at: new Date().toISOString() });
      return g;
    }
    state.history.push({ role: 'user', content: text });
    let r;
    try {
      const now = new Date().toLocaleString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      r = await window.LLM.turn({ provider: settings.engine, apiKey: settings.apiKey, model: settings.model, system: KB.buildSystemPrompt(now), history: state.history });
    } catch (err) {
      state.history.pop();
      s.log.pop();
      toast(`AI service error (${err.message}). Answering with the offline engine instead.`);
      return Engine.handle(s, text);
    }
    s.intents.push('llm_' + (r.action || 'none'));
    let reply = r.reply.trim();
    const result = { reply, end: r.action === 'end_call' };
    if (r.action === 'save_request' && r.request) {
      const v = Engine.validateRecord(r.request, s);
      if (v.ok) {
        const rq = v.record;
        const rec = {
          id: s.nextId(), type: rq.type === 'Escalation' ? 'Escalation' : 'Appointment', status: rq.type === 'Escalation' ? 'Needs callback' : 'New request',
          name: String(rq.name).trim(), phone: rq.phone, service: rq.service || '', preferred_date: rq.preferred_date || '', preferred_day: rq.preferred_day || '',
          preferred_time: rq.preferred_time || '', doctor: '', issue: rq.issue || '', priority: rq.type === 'Escalation' ? 'High' : 'Normal',
          created_at: new Date().toISOString(), engine: settings.engine,
        };
        s.callerName = rec.name;
        s.saved.push(rec);
        result.reply = `${reply.replace(/\s*Is there anything else.*$/i, '')} Your reference number is ${rec.id}. Is there anything else I can help you with?`;
        result.save = rec;
        result.saveFailReply = `I'm sorry, I couldn't save your request because of a technical problem. Please call us on ${KB.clinic.phone}.`;
      } else {
        result.reply = `Before I save this, I still need ${v.errors.join(' and ')}. Could you tell me that, please?`;
      }
    }
    state.history.push({ role: 'assistant', content: JSON.stringify({ reply: result.reply, action: r.action }) });
    s.log.push({ role: 'agent', text: result.reply, at: new Date().toISOString() });
    return result;
  }

  // ---------- requests ----------
  function saveRequest(rec) {
    requests.unshift(rec);
    if (!store.set('bs_requests', requests)) {
      if (!memoryOnly) toast('Browser storage is unavailable, so requests are kept for this visit only. Use Export CSV to keep them.');
      memoryOnly = true;
    }
    renderRequests(rec.id);
    pushToSheet(rec);
    return true;
  }

  async function pushToSheet(rec) {
    if (!settings.sheetUrl) return;
    try {
      await fetch(settings.sheetUrl, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(rec) });
      rec.sheet = 'Sent';
    } catch (e) {
      rec.sheet = 'Failed';
      toast('Could not reach Google Sheets. The request is still saved here.');
    }
    store.set('bs_requests', requests);
    renderRequests();
  }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  function renderRequests(freshId) {
    const body = $('reqBody');
    body.innerHTML = requests.map(r => {
      const details = r.type === 'Appointment'
        ? `${esc(r.service)}<span class="small">${esc(r.preferred_day || r.preferred_date)} · ${esc(r.preferred_time)}</span>`
        : `${esc(r.issue)}`;
      const pr = r.priority === 'Normal' ? 'plain' : 'esc';
      return `<tr class="${r.id === freshId ? 'fresh' : ''}">
        <td><b>${esc(r.id)}</b><span class="small">${new Date(r.created_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</span></td>
        <td><span class="tag ${r.type === 'Escalation' ? 'esc' : ''}">${esc(r.type)}</span></td>
        <td>${esc(r.name)}<span class="small">${esc(r.phone && r.phone.slice(0, 5) + ' ' + r.phone.slice(5))}</span></td>
        <td>${details}</td>
        <td><span class="tag ${pr}">${esc(r.priority)}</span></td>
        <td><span class="small">${esc(r.sheet || (settings.sheetUrl ? 'Pending' : 'Local'))}</span></td>
      </tr>`;
    }).join('');
    $('reqEmpty').hidden = requests.length > 0;
    $('reqCount').textContent = requests.length;
    $('statAppt').textContent = requests.filter(r => r.type === 'Appointment').length;
    $('statEsc').textContent = requests.filter(r => r.type === 'Escalation').length;
    $('statUrgent').textContent = requests.filter(r => r.priority === 'High' || r.priority === 'Urgent').length;
  }

  function exportCsv() {
    if (!requests.length) return toast('There are no requests to export yet.');
    const cols = ['id', 'type', 'status', 'name', 'phone', 'service', 'preferred_date', 'preferred_time', 'doctor', 'issue', 'priority', 'created_at', 'engine'];
    const csv = [cols.join(',')].concat(requests.map(r => cols.map(c => `"${String(r[c] == null ? '' : r[c]).replace(/"/g, '""')}"`).join(','))).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `brightsmile-requests-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
  }

  // ---------- rendering ----------
  function addMsg(role, text, rec) {
    const li = document.createElement('li');
    li.className = 'msg ' + role;
    if (role === 'system') li.textContent = text;
    else {
      li.innerHTML = `<span class="who">${role === 'agent' ? 'Maya' : 'Caller'}</span>${esc(text).replace(/\b(BSD-\d+)/g, '<span class="nowrap">$1</span>')}`;
      if (rec) li.innerHTML += `<br><span class="ref">✓ Saved ${esc(rec.type.toLowerCase())} · ${esc(rec.id)}</span>`;
    }
    $('transcript').appendChild(li);
    li.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }

  function renderSummary(sum, session) {
    const topics = sum.topics.map(t => t.replace(/^faq_/, '').replace(/_/g, ' ')).filter((t, i, a) => a.indexOf(t) === i);
    const mins = Math.floor(sum.durationSec / 60), secs = sum.durationSec % 60;
    $('summaryBox').innerHTML = `
      <dl>
        <dt>Caller</dt><dd>${esc(sum.caller)}</dd>
        <dt>Duration</dt><dd>${mins}m ${secs}s · ${sum.callerTurns} caller turns</dd>
        <dt>Outcome</dt><dd>${esc(sum.outcome)}</dd>
        <dt>Sentiment</dt><dd>${esc(sum.sentiment)}</dd>
        <dt>References</dt><dd>${sum.references.length ? sum.references.map(esc).join(', ') : '—'}</dd>
        <dt>Topics</dt><dd>${topics.length ? esc(topics.join(', ')) : '—'}</dd>
      </dl>
      <h3>Transcript</h3>
      <ol>${session.log.map(l => `<li><span class="who">${l.role === 'agent' ? 'Maya' : 'Caller'}:</span> ${esc(l.text)}</li>`).join('')}</ol>`;
  }

  function renderKb() {
    const c = KB.clinic;
    $('kbBox').innerHTML = `
      <h3>Clinic</h3>
      <p><b>${esc(c.name)}</b>, ${esc(c.address)} (${esc(c.landmark)})</p>
      <p>Phone / WhatsApp: ${esc(c.phone)} · ${esc(c.email)} · Languages: ${esc(c.languages)}</p>
      <h3>Hours</h3><p>${esc(KB.hours.text)} Last appointment 6:30 PM.</p>
      <h3>Fees</h3><p>Consultation ₹${KB.consultationFee} · X-ray ₹${KB.xrayFee} if needed</p>
      <h3>Services</h3>
      <table><thead><tr><th>Service</th><th>Price</th><th>Duration</th><th>Doctor</th></tr></thead>
      <tbody>${KB.services.map(s => `<tr><td>${esc(s.name)}</td><td>${esc(s.price)}</td><td>${esc(s.duration)}</td><td>${esc(s.doctor)}</td></tr>`).join('')}</tbody></table>
      <h3>Doctors</h3>
      <table><tbody>${KB.doctors.map(d => `<tr><td><b>${esc(d.name)}</b><br><span class="muted">${esc(d.title)}</span></td><td>${esc(d.daysText)}</td></tr>`).join('')}</tbody></table>
      <h3>Policies</h3>
      <p>${esc(KB.payment)}</p><p>${esc(KB.walkIn)}</p><p>${esc(KB.firstVisit)}</p><p>${esc(KB.cancellation)}</p><p>${esc(c.parking)}</p><p>${esc(KB.hygiene)}</p>
      <h3>Escalation rules</h3>
      <p>Complaints, billing disputes, changes to existing bookings, questions outside this knowledge base, requests for a human and repeated misunderstanding are recorded for a staff callback ${esc(KB.callbackPromise)}. Medical emergencies are directed to 112.</p>`;
  }

  function setStatus(t) { $('status').innerHTML = t; }

  function engineLabel() {
    if (settings.engine === 'offline') return 'Offline engine';
    const name = settings.engine === 'gemini' ? 'Gemini' : 'Claude';
    return `${name} · ${settings.model || window.LLM.DEFAULT_MODELS[settings.engine]}`;
  }

  function updateUI() {
    const callBtn = $('callBtn');
    callBtn.classList.toggle('end', state.inCall);
    callBtn.querySelector('span').textContent = state.inCall ? 'End call' : 'Start call';
    $('micBtn').disabled = !state.inCall || !recognition;
    $('micBtn').classList.toggle('active', state.listening);
    const av = $('avatar');
    av.dataset.state = state.thinking ? 'thinking' : state.speaking ? 'speaking' : state.listening ? 'listening' : 'idle';
    if (!state.inCall) setStatus('Ready. Press <b>Start call</b> to talk.');
    else if (state.thinking) setStatus('Thinking…');
    else if (state.speaking) setStatus('Speaking… (press the mic to interrupt)');
    else if (state.listening) setStatus('Listening… go ahead and speak.');
    else setStatus(recognition ? 'Press the microphone (or Space) to speak, or type below.' : 'Type your message below.');
    $('enginePill').textContent = engineLabel();
  }

  let toastTimer;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 5000);
  }

  function switchTab(name) {
    document.querySelectorAll('.tab').forEach(b => { const on = b.dataset.tab === name; b.classList.toggle('active', on); b.setAttribute('aria-selected', on); });
    document.querySelectorAll('.panel').forEach(p => { p.hidden = p.id !== 'panel-' + name; });
    store.set('bs_tab', name);
  }

  // ---------- settings ----------
  function fillSettings() {
    const f = $('settingsForm');
    f.querySelector(`input[name="engine"][value="${settings.engine}"]`).checked = true;
    $('apiKey').value = settings.apiKey;
    $('model').value = settings.model;
    $('model').placeholder = window.LLM.DEFAULT_MODELS[settings.engine] || '';
    $('rate').value = settings.rate;
    $('recLang').value = settings.recLang;
    $('autoListen').checked = settings.autoListen;
    $('sheetUrl').value = settings.sheetUrl;
    $('llmFields').hidden = settings.engine === 'offline';
  }

  function readSettings() {
    const f = $('settingsForm');
    const engine = f.querySelector('input[name="engine"]:checked').value;
    if (engine !== settings.engine) settings.model = '';
    settings.engine = engine;
    settings.apiKey = $('apiKey').value.trim();
    settings.model = $('model').value.trim();
    settings.voice = $('voiceSelect').value;
    settings.rate = +$('rate').value;
    settings.recLang = $('recLang').value;
    settings.autoListen = $('autoListen').checked;
    settings.sheetUrl = $('sheetUrl').value.trim();
  }

  // ---------- wiring ----------
  function init() {
    setupRecognition();
    if (synth) { loadVoices(); synth.onvoiceschanged = loadVoices; }
    fillSettings();
    renderKb();
    renderRequests();
    switchTab(store.get('bs_tab', 'requests'));
    updateUI();

    $('callBtn').addEventListener('click', () => (state.inCall ? endCall() : startCall()));
    $('micBtn').addEventListener('click', () => (state.listening ? stopListening() : listen()));
    $('muteBtn').addEventListener('click', () => {
      state.muted = !state.muted;
      $('muteBtn').setAttribute('aria-pressed', state.muted);
      if (state.muted && synth) synth.cancel();
      toast(state.muted ? "Maya's voice is muted. Replies still appear as text." : "Maya's voice is on.");
    });
    $('textForm').addEventListener('submit', e => {
      e.preventDefault();
      const v = $('textInput').value.trim();
      if (!v || state.thinking) return;
      $('textInput').value = '';
      processUtterance(v);
    });
    document.querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => { if (!state.thinking) processUtterance(c.textContent); }));
    document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));
    document.addEventListener('keydown', e => {
      if (e.code === 'Space' && state.inCall && !/input|textarea|select|button/i.test(document.activeElement.tagName)) { e.preventDefault(); listen(); }
    });

    $('settingsForm').addEventListener('change', e => {
      if (e.target.name === 'engine') {
        const engine = e.target.value;
        $('llmFields').hidden = engine === 'offline';
        $('model').value = '';
        $('model').placeholder = window.LLM.DEFAULT_MODELS[engine] || '';
      }
    });
    $('settingsForm').addEventListener('submit', e => {
      e.preventDefault();
      readSettings();
      if (settings.engine !== 'offline' && !settings.apiKey) { toast('Add an API key to use the LLM, or choose the offline engine.'); return; }
      store.set('bs_settings', settings);
      updateUI();
      toast(state.inCall ? 'Settings saved. The new engine is used from the next call.' : 'Settings saved.');
    });
    $('sheetTest').addEventListener('click', () => {
      readSettings();
      if (!settings.sheetUrl) return toast('Paste your Apps Script web app URL first.');
      pushToSheet({ id: 'TEST-' + Date.now().toString().slice(-4), type: 'Test', status: 'Test row', name: 'Test caller', phone: '9000000000', service: '', preferred_date: '', preferred_time: '', issue: 'Connection test', priority: 'Normal', created_at: new Date().toISOString(), engine: 'test' })
        .then(() => toast('Test row sent. Check your Google Sheet.'));
    });
    $('exportBtn').addEventListener('click', exportCsv);
    $('clearBtn').addEventListener('click', () => {
      if (!requests.length) return;
      if (!confirm('Delete all saved requests from this browser?')) return;
      requests = []; store.set('bs_requests', requests); renderRequests();
    });
  }

  init();
})();
