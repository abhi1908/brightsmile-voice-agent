/*
 * Conversation engine for the BrightSmile voice agent.
 *
 * Works fully offline: intent detection + slot filling + escalation rules,
 * all grounded in kb.js. The same guardrails are reused when an LLM is enabled.
 * Runs in the browser (window.VoiceEngine) and in Node (for automated tests).
 */
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const KB = isNode ? require('./kb.js') : root.CLINIC_KB;
  const api = factory(KB);
  if (isNode) module.exports = api;
  else root.VoiceEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (KB) {
  'use strict';

  // ---------- text helpers ----------

  function norm(t) {
    return String(t || '')
      .toLowerCase()
      .replace(/[’‘`]/g, "'")
      .replace(/\bx-ray/g, 'x ray')
      .replace(/(\d)\s*\.\s*(\d)/g, '$1:$2')
      .replace(/\bp\.\s?m\.?/g, 'pm').replace(/\ba\.\s?m\.?/g, 'am')
      .replace(/[^a-z0-9:'+\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  const words = t => t.split(' ').filter(Boolean);

  function lev(a, b) {
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
    }
    return dp[a.length][b.length];
  }

  // Tolerates small spelling mistakes ("timmings", "apointment") on longer words only.
  function wordMatches(w, target) {
    if (w === target) return true;
    if (target.endsWith('*')) return w.startsWith(target.slice(0, -1));
    if (target.length < 6 || w[0] !== target[0]) return false;
    const max = target.length >= 9 ? 2 : 1;
    if (Math.abs(w.length - target.length) > max) return false;
    return lev(w, target) <= max;
  }

  function has(text, phrases) {
    const padded = ' ' + text + ' ';
    const ws = words(text);
    return phrases.some(p => {
      const np = p.endsWith('*') ? p : norm(p);
      if (np.includes(' ')) return padded.includes(' ' + np + ' ');
      return ws.some(w => wordMatches(w, np));
    });
  }

  const titleCase = s => s.replace(/\b[a-z]/g, c => c.toUpperCase());
  const firstName = n => (n || '').split(' ')[0];
  const formatPhone = p => p.slice(0, 5) + ' ' + p.slice(5);

  // ---------- vocabularies ----------

  const V = {
    yes: ['yes', 'yeah', 'yep', 'yup', 'yah', 'sure', 'ok', 'okay', 'correct', 'right', 'haan', 'han', 'ha', 'ji', 'please', 'of course', 'definitely', 'perfect', 'fine', 'go ahead', 'sounds good', 'absolutely', 'confirm', 'confirmed', 'done'],
    no: ['no', 'nope', 'nah', 'nahi', 'nahin', 'not', 'wrong', 'incorrect', "don't", 'dont', 'never mind', 'nevermind'],
    emergencyRed: ['heavy bleeding', 'bleeding a lot', 'bleeding badly', 'bleeding heavily', 'not stopping', "won't stop", 'wont stop', 'swelling', 'swollen', "can't breathe", 'cant breathe', 'cannot breathe', 'difficulty breathing', 'trouble breathing', 'breathing problem', 'accident', 'broken jaw', 'knocked out', 'fainted', 'unconscious', 'high fever'],
    emergencyPain: ['emergency', 'unbearable', 'severe pain', 'extreme pain', 'terrible pain', 'very bad pain', 'killing me'],
    privacy: [/\b(other|another) patient/, /\bsomeone else'?s?\b/, /\b(his|her|their) (appointment|number|phone|details|booking)/, /\bpatient (list|details|records|data)/, /\b(phone|mobile|contact) number of\b/, /\bwho (else )?(has|booked|came|visited)\b/, /\blast patient\b/, /\b(appointment|booking|details) of [a-z]+/, /\b[a-z]+'s (appointment|booking|number|details)/],
    injection: [/ignore (all |your |the |any )?(previous |above |earlier )?(instructions|rules|prompt)/, /system prompt/, /\byou are now\b/, /\bpretend (to be|you are)\b/, /\bjailbreak\b/, /developer mode/, /reveal (your )?(prompt|instructions|rules)/, /\bforget (your|all) (rules|instructions)\b/],
    complaint: ['complaint', 'complain', 'nobody answered', 'no one answered', 'nobody picked', 'no one picked', "didn't pick", 'didnt pick', 'not picking', 'rude', 'worst', 'terrible service', 'pathetic', 'very bad', 'not happy', 'unhappy', 'disappointed', 'frustrated', 'angry', 'waited for', 'kept waiting', 'bad experience', 'bad service', 'horrible', 'useless', 'fraud', 'cheated', 'unprofessional', 'not satisfied'],
    payment: ['refund', 'already paid', 'i paid', 'have paid', 'overcharged', 'charged twice', 'double charged', 'extra charge', 'wrong bill', 'billing issue', 'billing problem', 'bill is wrong', 'unpaid', 'payment failed', 'money deducted', 'amount deducted', 'deducted', 'not refunded'],
    human: ['human', 'real person', 'talk to someone', 'speak to someone', 'talk to a person', 'speak to a person', 'speak with someone', 'talk to staff', 'speak to staff', 'manager', 'staff member', 'customer care', 'operator', 'call me back', 'callback', 'call back', 'transfer my call', 'transfer the call', 'connect me'],
    reschedule: ['reschedule', 'postpone', 'prepone', 'change my appointment', 'change the appointment', 'cancel my appointment', 'cancel the appointment', 'cancel appointment', 'cancel my booking', 'move my appointment', 'shift my appointment', 'existing appointment', 'my booking'],
    medical: [/\b(which|what|any) (medicine|medicines|tablet|tablets|painkiller|antibiotic)/, /\bpain ?killer/, /\bantibiotic/, /\bshould i take\b/, /\bcan i take\b/, /\bis it serious\b/, /\bis (this|it|that) normal\b/, /\bhome remed/, /\bwhat should i do\b/, /\bdiagnos/, /\bdosage\b/, /\bhow (do|can) i (stop|cure|treat|fix)\b/],
    offTopic: ['weather', 'joke', 'cricket', 'movie', 'movies', 'politics', 'election', 'news', 'recipe', 'song', 'stock market', 'bitcoin', 'capital of', 'football', 'horoscope'],
    nonDental: ['eye', 'eyes', 'skin', 'hair', 'heart', 'blood test', 'lasik', 'botox', 'physiotherapy', 'ear', 'nose', 'pregnancy', 'vaccine', 'covid test', 'liposuction', 'spectacles', 'tattoo'],
    booking: ['book', 'booking', 'appointment', 'appoinment', 'appointments', 'slot', 'reserve', 'schedule', 'chahiye'],
    cancelFlow: ['cancel', 'never mind', 'nevermind', 'forget it', 'leave it', 'stop', 'not now', 'later', "don't want", 'dont want', 'no need'],
    greeting: ['hi', 'hello', 'hey', 'hii', 'helo', 'namaste', 'namaskar', 'good morning', 'good afternoon', 'good evening'],
    thanks: ['thank', 'thanks', 'thank you', 'thankyou', 'dhanyavad', 'dhanyawad', 'shukriya'],
    bye: ['bye', 'goodbye', 'good bye', "that's all", 'thats all', 'that is all', 'nothing else', 'no more', 'hang up', 'end call', 'end the call', 'see you'],
    negative: ['angry', 'frustrated', 'worst', 'terrible', 'nobody', 'bad', 'rude', 'pathetic', 'disappointed', 'unhappy', 'complaint', 'useless', 'horrible', 'waiting', 'fraud', 'pain', 'not happy', 'cheated'],
    positive: ['thanks', 'thank you', 'great', 'good', 'awesome', 'perfect', 'helpful', 'wonderful', 'excellent', 'nice'],
  };

  const STOP = new Set('what is the of for a an how much does do it its cost costs price prices fee fees charge charges your you i me my to in at are will be would rate rates kitna hai tell please can could about there clinic here approx approximately roughly total rupees ka ki ke get got done treatment treatments procedure and or on per one tooth teeth dental much and also expensive cheap budget generally usually normally typically like know want need'.split(' '));

  // ---------- extraction ----------

  const NUM = { zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

  function digitsFromWords(text) {
    let t = text.replace(/\b(double|triple)\s+(zero|oh|one|two|three|four|five|six|seven|eight|nine|\d)\b/g, (_, k, d) => {
      const digit = /\d/.test(d) ? d : String(NUM[d]);
      return digit.repeat(k === 'double' ? 2 : 3);
    });
    return t.replace(/\b(zero|oh|one|two|three|four|five|six|seven|eight|nine)\b/g, w => String(NUM[w]));
  }

  // Returns { phone } for a valid Indian mobile, { partial: n } for a wrong-length number, or null.
  function extractPhone(text) {
    const t = digitsFromWords(text);
    const runs = t.match(/\+?\d[\d\s-]{3,}\d/g);
    if (!runs) return null;
    let best = null;
    for (const r of runs) {
      let d = r.replace(/\D/g, '');
      if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
      if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
      if (d.length === 10 && /^[6-9]/.test(d)) return { phone: d };
      if (d.length >= 5) best = { partial: d.length };
    }
    return best;
  }

  function stripPhones(text) {
    return digitsFromWords(text).replace(/\+?\d[\d\s-]{5,}\d/g, ' ');
  }

  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
  const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

  const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const isoDate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const dayLabel = d => d.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });

  function monthIndex(m) { return MONTHS.findIndex(x => x.startsWith(m.slice(0, 3))); }

  function parseDate(text, now) {
    const today = startOfDay(now);
    const t = ' ' + stripPhones(text) + ' ';
    if (/ (day after tomorrow|parso|parson) /.test(t)) return addDays(today, 2);
    if (/ (tomorrow|tommorow|tomorow|tmrw|tmr|kal) /.test(t)) return addDays(today, 1);
    if (/ (today|aaj|right now|now itself) /.test(t)) return today;
    let m = t.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s(?:of\\s)?${MONTH_RE}\\b`)) ;
    if (m) return futureDate(today, +m[1], monthIndex(m[2]));
    m = t.match(new RegExp(`\\b${MONTH_RE}\\s(\\d{1,2})(?:st|nd|rd|th)?\\b`));
    if (m) return futureDate(today, +m[2], monthIndex(m[1]));
    m = t.match(/\b(\d{1,2})\/(\d{1,2})\b/);
    if (m) return futureDate(today, +m[1], +m[2] - 1);
    m = t.match(/\b(\d{1,2})(st|nd|rd|th)\b/);
    if (m) {
      let d = new Date(today.getFullYear(), today.getMonth(), +m[1]);
      if (d < today) d = new Date(today.getFullYear(), today.getMonth() + 1, +m[1]);
      return d;
    }
    for (const w of words(t.trim())) {
      const idx = WEEKDAYS.findIndex(d => wordMatches(w, d) || w === d.slice(0, 3));
      if (idx >= 0) {
        let diff = (idx - today.getDay() + 7) % 7;
        if (diff === 0) diff = 7;
        return addDays(today, diff);
      }
    }
    return null;
  }

  function futureDate(today, day, month) {
    if (month < 0 || month > 11 || day < 1 || day > 31) return null;
    let d = new Date(today.getFullYear(), month, day);
    if (d < today) d = new Date(today.getFullYear() + 1, month, day);
    return d;
  }

  const toMin = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

  function timeLabel(min, approx) {
    const h = Math.floor(min / 60), m = min % 60;
    const h12 = ((h + 11) % 12) + 1;
    const label = `${h12}${m ? ':' + String(m).padStart(2, '0') : ''} ${h >= 12 ? 'PM' : 'AM'}`;
    return approx ? `around ${label}` : label;
  }

  // Returns { min, approx } (minutes from midnight) or null.
  function parseTime(text) {
    let t = stripPhones(text)
      .replace(/\bhalf past (\w+)/g, '$1:30').replace(/\bquarter past (\w+)/g, '$1:15')
      .replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/g, w => String(NUM[w]))
      .replace(/\b(\d{1,2}) (thirty|fifteen|forty five)\b/g, (_, h, m) => `${h}:${{ thirty: '30', fifteen: '15', 'forty five': '45' }[m]}`);
    t = ' ' + t + ' ';
    const build = (h, m, mer) => {
      h = +h; m = +(m || 0);
      if (h > 23 || m > 59) return null;
      if (mer) {
        if (mer.startsWith('p') && h < 12) h += 12;
        if (mer.startsWith('a') && h === 12) h = 0;
      } else if (h >= 1 && h <= 7) h += 12;
      else if (h === 12) h = 12;
      return { min: h * 60 + m, approx: false };
    };
    let m = t.match(/\b(\d{1,2})(?::(\d{2})|\s(\d{2}))?\s?(am|pm|a m|p m)\b/);
    if (m) return build(m[1], m[2] || m[3], m[4].replace(' ', ''));
    m = t.match(/\b(\d{1,2})(?::(\d{2}))?\s?o\s?'?\s?clock\b/);
    if (m) return build(m[1], m[2]);
    m = t.match(/\b(\d{1,2}):(\d{2})\b/);
    if (m) return build(m[1], m[2]);
    m = t.match(/\b(?:at|around|by|about|after|before|for) (\d{1,2})\b(?!\s?(?:st|nd|rd|th|days?|weeks?|months?|minutes?|mins?|years?))/);
    if (m) return build(m[1]);
    m = t.match(/\b(\d{1,2}) baje\b/);
    if (m) return build(m[1]);
    if (/\b(early morning)\b/.test(t)) return { min: 9 * 60 + 30, approx: true };
    if (/\b(morning|subah)\b/.test(t)) return { min: 10 * 60, approx: true };
    if (/\b(noon|midday)\b/.test(t)) return { min: 12 * 60, approx: true };
    if (/\b(afternoon|dopahar)\b/.test(t)) return { min: 15 * 60, approx: true };
    if (/\b(evening|shaam|sham|after office|after work)\b/.test(t)) return { min: 17 * 60, approx: true };
    return null;
  }

  const NOT_NAME = new Set('pathetic ridiculous terrible horrible bad worst unacceptable too frustrating annoying urgent important regarding about my me him her them someone not calling looking having in a the interested sure fine ok okay going very so also from here there available free busy sorry new an trying want wanting planning just good great calling with on at your patient fine actually really kind bit little afraid worried scared'.split(' '));
  const NAME_STOP = new Set('and my mobile number phone i want would like calling here speaking please for to book need is the from on at tomorrow today with who'.split(' '));
  const NOT_FOR_NAME = new Set('a an the my me him her them us you your this that next tomorrow today monday tuesday wednesday thursday friday saturday sunday morning evening afternoon two one some how what appointment booking check checkup consultation cleaning filling braces whitening root kids child son daughter wife husband mother father mom dad family'.split(' '));

  function extractName(text, implicit) {
    let m = text.match(/\b(?:my name is|my name's|name is|naam hai|this is|i am|i'm|im|call me|mera naam)\s+([a-z]+(?:\s+[a-z]+){0,3})/);
    let candidate = null;
    if (m) {
      if (NOT_NAME.has(m[1].split(' ')[0])) return null;
      candidate = m[1];
    } else if (implicit) {
      const ws = words(text.replace(/\b(it's|its|it is|sure|yeah|yes|ok|okay|uh|um|hmm|name|mera naam|naam|hai|ji|mr|mrs|ms|dr)\b/g, ' ').trim());
      if (!ws.length || ws.length > 3 || /\d/.test(text)) return null;
      candidate = ws.join(' ');
    }
    if (!candidate) {
      // "Book a filling for Neha on Tuesday"
      const f = text.match(/\b(?:book|booking|appointment|slot)\b.*?\bfor ([a-z]+)\b/);
      if (f && !NOT_FOR_NAME.has(f[1]) && !NOT_NAME.has(f[1]) && !matchService(f[1]) && f[1].length > 2) candidate = f[1];
    }
    if (!candidate) return null;
    const out = [];
    for (const w of words(candidate)) {
      if (NAME_STOP.has(w)) break;
      out.push(w);
      if (out.length === 3) break;
    }
    return out.length ? titleCase(out.join(' ')) : null;
  }

  function matchService(text) {
    if (has(text, V.nonDental)) return null;
    // Longest keyword wins so "root canal" beats "pain" etc.
    let best = null, bestLen = 0;
    for (const s of KB.services) {
      for (const k of s.keywords) {
        const score = k.length + (s.id === 'consult' ? 0 : 100);
        if (has(text, [k]) && score > bestLen) { best = s; bestLen = score; }
      }
    }
    return best;
  }

  function yesNo(text) {
    if (has(text, V.no)) return 'no';
    if (has(text, V.yes)) return 'yes';
    return null;
  }

  // ---------- clinic logic ----------

  const H = KB.hours;
  const OPEN = toMin(H.open), CLOSE = toMin(H.close), LAST = toMin(H.lastAppointment);
  const LUNCH_FROM = toMin(H.lunch.from), LUNCH_TO = toMin(H.lunch.to);

  function nowMinutes(now) { return now.getHours() * 60 + now.getMinutes(); }

  function openNowText(now) {
    const day = now.getDay(), min = nowMinutes(now);
    if (H.days.includes(day) && min >= OPEN && min < CLOSE) {
      if (min >= LUNCH_FROM && min < LUNCH_TO) return 'We are on our lunch break right now and will be back at 2:30 PM. We are open until 7 PM today.';
      return 'Yes, we are open right now, until 7 PM today.';
    }
    let next = addDays(startOfDay(now), H.days.includes(day) && min < OPEN ? 0 : 1);
    while (!H.days.includes(next.getDay())) next = addDays(next, 1);
    const when = isoDate(next) === isoDate(now) ? 'today' : isoDate(next) === isoDate(addDays(now, 1)) ? 'tomorrow' : 'on ' + WEEKDAYS[next.getDay()].replace(/^./, c => c.toUpperCase());
    return `We are closed right now. We open again ${when} at 9 AM.`;
  }

  function doctorFor(service) { return KB.doctors.find(d => d.name === service.doctor); }

  // Validates a date for booking; returns an error sentence or null.
  function dateProblem(d, s) {
    const now = s.now();
    const today = startOfDay(now);
    if (d < today) return 'That date has already passed.';
    if (!H.days.includes(d.getDay())) return 'We are closed on Sundays.';
    if (d > addDays(today, 90)) return 'We take appointment requests up to three months ahead.';
    if (isoDate(d) === isoDate(now) && nowMinutes(now) >= LAST - 30) return 'We have no more slots left for today.';
    const svc = s.booking.service;
    if (svc) {
      const doc = doctorFor(svc);
      if (doc && !doc.days.includes(d.getDay())) return `${doc.name}, who handles ${svc.name.toLowerCase()}, is available on ${doc.daysText}.`;
    }
    return null;
  }

  function timeProblem(t, s) {
    if (t.min < OPEN) return 'We start seeing patients at 9 AM.';
    if (t.min > LAST) return 'Our last appointment of the day is at 6:30 PM.';
    if (t.min >= LUNCH_FROM && t.min < LUNCH_TO) return 'That is during our lunch break from 1:30 to 2:30 PM.';
    const b = s.booking;
    if (b.service && b.service.id === 'kids' && t.min < LUNCH_TO) return 'Dr. Priya Kumari sees children in the afternoons, from 2:30 PM.';
    const now = s.now();
    if (b.date && isoDate(b.date) === isoDate(now) && t.min < nowMinutes(now) + 30) return 'That time is too soon for today.';
    return null;
  }

  // ---------- FAQ answering ----------

  function faqAnswers(s, text) {
    const out = [];
    const add = (intent, answer) => { if (answer && !out.some(o => o.answer === answer)) out.push({ intent, answer }); };
    const svc = matchService(text);
    const askedFee = has(text, ['fee', 'fees', 'charge', 'charges', 'cost', 'costs', 'price', 'prices', 'pricing', 'how much', 'rate', 'rates', 'kitna', 'kitne paise', 'expensive', 'cheap', 'budget', 'afford']);
    const askedDuration = has(text, ['how long', 'duration', 'sittings', 'sitting', 'how many visits', 'time does it take', 'time will it take']);
    const askedDoctor = has(text, ['doctor', 'doctors', 'dentist', 'dentists', 'specialist', 'orthodontist', 'endodontist', 'dr']);
    const doctorNamed = KB.doctors.find(d => { const [first, last] = d.name.toLowerCase().replace('dr. ', '').split(' '); return has(text, [last]) || (askedDoctor && has(text, [first])); });
    const unknownThing = has(text, V.nonDental);

    if (/\b(need|necessary|required|compulsory|must|have to|mandatory).{0,25}appointment|walk ?in|without (an )?appointment|come directly|directly come|just come|just walk/.test(text)) add('faq_walkin', KB.walkIn);
    if (has(text, ['who are you', 'are you a robot', 'are you human', 'are you real', 'are you ai', 'are you a bot', 'your name', 'am i talking to'])) add('faq_identity', `I'm ${KB.clinic.agentName}, the AI voice assistant for ${KB.clinic.name}. I can answer questions, record appointment requests, and connect you with our staff whenever you need.`);
    if (!/(sunday|monday|tuesday|wednesday|thursday|friday|saturday|weekend|holiday|tomorrow)/.test(text) && /\b(open|available|working)\b.{0,12}\b(now|today|right now|abhi)\b|\bare you (open|closed)\b|\bis the clinic open\b/.test(text)) add('faq_open_now', openNowText(s.now()));
    if (has(text, ['sunday', 'sundays', 'weekend', 'weekends', 'holiday', 'holidays', 'ravivar'])) add('faq_sunday', 'We are closed on Sundays. We are open Monday to Saturday, 9 AM to 7 PM.');
    if (has(text, ['timing', 'timings', 'hours', 'opening', 'closing', 'kitne baje', 'what time do you', 'when do you open', 'when do you close', 'open till', 'open until', 'close at', 'open at', 'working days', 'lunch'])) add('faq_timings', `We are open ${H.text}`);
    if (has(text, ['address', 'where', 'location', 'located', 'situated', 'directions', 'reach you', 'landmark', 'kahan', 'kaha', 'map', 'how to reach', 'how do i reach', 'how do i get'])) add('faq_address', `We are at ${KB.clinic.address}, ${KB.clinic.landmark}.`);
    if (has(text, ['parking', 'park'])) add('faq_parking', KB.clinic.parking);
    if (has(text, ['x ray', 'xray', 'scan'])) add('faq_xray', `An X-ray, if the doctor needs one, costs ₹${KB.xrayFee}.`);

    if (unknownThing) {
      // Handled by the "unknown" path — never guess about services we don't list.
    } else if (svc && svc.id !== 'consult' && (askedFee || askedDuration)) {
      const parts = [];
      if (askedFee) parts.push(`${svc.name} costs ${svc.price}`);
      if (askedDuration) parts.push(`it usually takes ${svc.duration}`);
      add('faq_service_price', parts.join(', and ').replace(/^./, c => c.toUpperCase()) + '. The doctor confirms the exact cost after examining you.');
    } else if (svc && svc.id !== 'consult') {
      add('faq_service', `Yes, we offer ${svc.name.toLowerCase()}. It costs ${svc.price} and is done by ${svc.doctor}.`);
    } else if (askedFee) {
      const content = words(text).filter(w => !STOP.has(w) && !/^\d+$/.test(w));
      const aboutConsult = /consult|check|visit|appointment|doctor|first|meet|see/.test(text) || svc;
      if (aboutConsult || content.length === 0) add('faq_fee', `Our consultation fee is ₹${KB.consultationFee}. If an X-ray is needed, it is ₹${KB.xrayFee} extra.`);
    } else if (svc && svc.id === 'consult' && /\b(do you|provide|offer|have)\b/.test(text)) {
      add('faq_service', `Yes, we do general check-ups. The consultation fee is ₹${KB.consultationFee}.`);
    }

    if (has(text, ['services', 'service', 'treatments', 'what do you do', 'what do you offer', 'what all', 'facilities', 'procedures', 'what can you treat']) && !svc && !unknownThing) {
      add('faq_services', 'We offer check-ups, cleaning, fillings, root canals, extractions, teeth whitening, braces and clear aligners, implants, crowns, and children\'s dentistry.');
    }
    if (doctorNamed) {
      add('faq_doctor', `${doctorNamed.name}, our ${doctorNamed.title.split(' (')[0].toLowerCase()}, is available ${doctorNamed.daysText}.`);
    } else if (askedDoctor && !svc) {
      add('faq_doctors', 'We have three dentists. Dr. Ananya Sinha, our endodontist, is in Monday to Saturday; Dr. Rohit Verma, our orthodontist, on Tuesday, Thursday and Saturday; and Dr. Priya Kumari, our children\'s dentist, on Monday, Wednesday and Friday afternoons.');
    }
    if (has(text, ['insurance', 'mediclaim', 'cashless', 'reimbursement', 'claim'])) add('faq_insurance', KB.paymentParts.insurance);
    if (has(text, ['emi', 'installment', 'instalment', 'installments'])) add('faq_emi', KB.paymentParts.emi);
    if (has(text, ['payment', 'pay', 'upi', 'card', 'cards', 'cash', 'gpay', 'paytm', 'phonepe', 'credit', 'debit', 'online payment'])) add('faq_payment', KB.paymentParts.methods + ' ' + KB.paymentParts.emi);
    if (has(text, ['phone number', 'contact number', 'your number', 'whatsapp', 'email', 'contact you', 'call you', 'landline'])) add('faq_contact', `You can call or WhatsApp us on ${KB.clinic.phone}, or email ${KB.clinic.email}.`);
    if (has(text, ['hindi', 'language', 'languages', 'english', 'bhasha'])) add('faq_language', `Yes, our staff speak ${KB.clinic.languages}.`);
    if (has(text, ['bring', 'first visit', 'first time', 'documents', 'reports', 'prepare', 'carry'])) add('faq_first_visit', KB.firstVisit);
    if (has(text, ['hygiene', 'hygienic', 'steril*', 'infection', 'instruments', 'sanitise', 'sanitize', 'sanitized'])) add('faq_hygiene', KB.hygiene);
    if (has(text, ['cancellation policy', 'cancel policy', 'late', 'how to cancel'])) add('faq_cancellation', KB.cancellation);
    return out.slice(0, 2);
  }

  // ---------- session ----------

  function createSession(opts) {
    opts = opts || {};
    const fixed = opts.now ? new Date(opts.now) : null;
    return {
      now: () => (fixed ? new Date(fixed) : new Date()),
      engine: opts.engineLabel || 'offline',
      mode: 'idle', // idle | booking | confirm_booking | escalation | confirm_escalation | ended
      booking: {},
      escalation: null,
      pending: null,
      offer: null,
      offerIssue: null,
      fallbacks: 0,
      fallbackTexts: [],
      slotFails: 0,
      callerName: null,
      intents: [],
      log: [],
      saved: [],
      sentiment: 0,
      startedAt: fixed ? new Date(fixed) : new Date(),
      nextId: opts.nextId || (() => 'BSD-' + String(Math.floor(10000 + Math.random() * 90000))),
    };
  }

  function greet(s) {
    const g = `Hello, thank you for calling ${KB.clinic.name}. I'm ${KB.clinic.agentName}, your virtual assistant. How may I help you today?`;
    s.log.push({ role: 'agent', text: g, at: s.now().toISOString() });
    return g;
  }

  function result(s, intent, reply, extra) {
    s.intents.push(intent);
    return Object.assign({ intent, reply }, extra || {});
  }

  function handle(s, raw) {
    const text = norm(raw);
    s.log.push({ role: 'caller', text: raw, at: s.now().toISOString() });
    if (has(text, V.negative)) s.sentiment -= 1;
    if (has(text, V.positive)) s.sentiment += 1;
    const out = route(s, text, raw);
    if (out.save) s.saved.push(out.save);
    s.log.push({ role: 'agent', text: out.reply, at: s.now().toISOString() });
    return out;
  }

  // Deterministic safety checks that run before anything else (also used in LLM mode).
  function guard(s, text) {
    if (has(text, V.emergencyRed)) {
      s.offer = 'urgent_callback';
      return result(s, 'emergency', `This could be an emergency. ${KB.emergency} Would you also like our dentist to call you back urgently?`);
    }
    if (has(text, V.emergencyPain)) {
      s.offer = 'urgent_callback';
      return result(s, 'urgent_pain', "I'm sorry you're in so much pain. I can't advise on treatment over the phone, but I can ask our dentist to call you back urgently for a same-day visit. Shall I do that?");
    }
    if (V.privacy.some(r => r.test(text))) {
      return result(s, 'privacy_refusal', "I'm sorry, I can't share any information about other patients, as that is private. I'm happy to help with your own appointment or questions.");
    }
    if (V.injection.some(r => r.test(text))) {
      return result(s, 'prompt_injection', `I'm ${KB.clinic.agentName}, the receptionist for ${KB.clinic.name}, and I can only help with clinic questions and appointments. What can I help you with?`);
    }
    return null;
  }

  function route(s, text, raw) {
    if (s.mode === 'ended') return result(s, 'ended', 'This call has ended. Please start a new call if you need anything else.', { end: true });
    if (!text) return result(s, 'silence', "Sorry, I didn't hear anything. How can I help you?");

    const g = guard(s, text);
    if (g) {
      if (s.mode !== 'idle' && g.intent !== 'privacy_refusal' && g.intent !== 'prompt_injection') { s.mode = 'idle'; s.booking = {}; s.escalation = null; s.pending = null; }
      if (s.mode !== 'idle' && s.pending) g.reply += ' ' + question(s);
      return g;
    }

    switch (s.mode) {
      case 'booking': return bookingTurn(s, text);
      case 'confirm_booking': return confirmBookingTurn(s, text);
      case 'escalation': return escalationTurn(s, text);
      case 'confirm_escalation': return confirmEscalationTurn(s, text, raw);
    }

    if (s.offer) {
      const yn = yesNo(text);
      const short = words(text).length <= 4;
      if (yn && (short || (yn === 'yes' && ['book', 'callback', 'urgent_callback'].includes(s.offer)))) return handleOffer(s, yn, text, raw);
      s.offer = null;
    }
    return idleTurn(s, text, raw);
  }

  function handleOffer(s, yn, text, raw) {
    const offer = s.offer;
    s.offer = null;
    if (yn === 'no') {
      if (offer === 'anything_else') return goodbye(s);
      s.offer = 'anything_else';
      return result(s, 'offer_declined', 'Alright. Is there anything else I can help you with?');
    }
    if (offer === 'book') return startBooking(s, text);
    if (offer === 'callback') return startEscalation(s, { category: 'Information not in knowledge base', priority: 'Normal', empathy: 'Sure, I will ask a staff member to call you back.' }, s.offerIssue || raw, text);
    if (offer === 'urgent_callback') return startEscalation(s, { category: 'Urgent dental problem', priority: 'Urgent', empathy: 'Okay, I will mark this as urgent for our dentist.' }, s.offerIssue || raw, text);
    if (offer === 'anything_else') return result(s, 'anything_else', 'Sure, what would you like to know?');
    return idleTurn(s, text, raw);
  }

  function escalationTrigger(text) {
    if (has(text, V.payment)) return { category: 'Payment / billing dispute', priority: 'High', empathy: "I'm sorry for the trouble. Billing issues need our accounts team to check your records, so I'll ask them to call you back." };
    if (has(text, V.complaint)) return { category: 'Complaint', priority: 'High', empathy: "I'm really sorry about that, I understand how frustrating it must be. I'll make sure our front-desk manager looks into it and calls you back." };
    if (has(text, V.reschedule)) return { category: 'Reschedule / cancel existing booking', priority: 'Normal', empathy: "I can't change existing bookings myself, but I'll pass your request to our front desk so they can update it." };
    if (has(text, V.human)) return { category: 'Caller asked for a human', priority: 'Normal', empathy: "Sure, I'll arrange for a member of our team to call you back." };
    return null;
  }

  function isBookingIntent(text) {
    if (/\b(need|necessary|required|compulsory|must|have to).{0,25}appointment|walk ?in|without (an )?appointment/.test(text)) return false;
    if (has(text, ['how much', 'cost', 'fee', 'fees', 'price']) && !has(text, ['book', 'booking', 'want', 'like', 'need'])) return false;
    const svc = matchService(text);
    if (svc && /\b(want|need|like|get|getting|do|book)\b/.test(text) && (parseDate(text, new Date()) || parseTime(text) || /\b(want|need|like)\b/.test(text)) && !/\b(do you|does|is there)\b/.test(text)) return true;
    return has(text, V.booking) || /\b(want|like|need|wish|can i|could i|planning) (to )?(come|visit|see (a |the )?(doctor|dentist)|get (a |an )?(check|appointment))/.test(text);
  }

  function idleTurn(s, text, raw) {
    const esc = escalationTrigger(text);
    if (esc) return startEscalation(s, esc, raw, text);

    if (V.medical.some(r => r.test(text))) {
      s.offer = 'book';
      return result(s, 'medical_advice_declined', "I'm not able to give medical advice over the phone, but our dentist can examine you properly. Would you like me to book a consultation?");
    }

    if (isBookingIntent(text)) return startBooking(s, text);

    const faqs = faqAnswers(s, text);
    if (faqs.length) {
      s.fallbacks = 0;
      faqs.slice(1).forEach(f => s.intents.push(f.intent));
      return result(s, faqs[0].intent, faqs.map(f => f.answer).join(' '));
    }

    if (has(text, V.offTopic)) return result(s, 'off_topic', `I'm sorry, I can only help with questions about ${KB.clinic.name}, like our timings, treatments, fees or booking an appointment.`);

    const askingAboutSomething = /\b(do you|does the clinic|does your|can you|can the doctor|is there|have you got|you have|available|provide|offer|treat|treatment for|cure|fix|how much|cost|price|fee)\b/.test(text);
    if (askingAboutSomething || has(text, V.nonDental)) {
      s.offer = 'callback';
      s.offerIssue = raw;
      return result(s, 'unknown_question', "I'm sorry, I don't have that information, and I don't want to give you a wrong answer. Would you like a staff member to call you back about it?");
    }

    const wc = words(text).length;
    if (has(text, V.bye)) return goodbye(s);
    if (has(text, V.thanks)) { s.offer = 'anything_else'; return result(s, 'thanks', "You're welcome! Is there anything else I can help you with?"); }
    if (wc <= 4 && has(text, V.greeting)) return result(s, 'greeting', 'Hello! How can I help you today?');
    const yn = yesNo(text);
    if (wc <= 3 && yn === 'no') { s.offer = 'anything_else'; return result(s, 'no', 'Alright. Is there anything else I can help you with?'); }
    if (wc <= 3 && yn === 'yes') return result(s, 'yes', 'Sure, what would you like to know? I can help with timings, treatments, fees or an appointment.');

    return fallback(s, raw);
  }

  function fallback(s, raw) {
    s.fallbacks += 1;
    s.fallbackTexts.push(raw);
    if (s.fallbacks >= 2) {
      s.fallbacks = 0;
      const issue = 'Agent could not understand: "' + s.fallbackTexts.join('" / "') + '"';
      s.fallbackTexts = [];
      return startEscalation(s, { category: 'Repeated misunderstanding', priority: 'Normal', empathy: "I'm sorry, I'm having trouble understanding. Let me have a staff member call you back." }, issue, '');
    }
    return result(s, 'fallback', "Sorry, I didn't quite get that. I can tell you about our timings, location, treatments and fees, or book an appointment for you. What would you like?");
  }

  function goodbye(s) {
    s.mode = 'ended';
    const n = s.callerName ? ', ' + firstName(s.callerName) : '';
    return result(s, 'goodbye', `Thank you for calling ${KB.clinic.name}${n}. Have a great day!`, { end: true });
  }

  // ---------- booking flow ----------

  const ORDER = ['name', 'phone', 'service', 'date', 'time'];

  function question(s) {
    const b = s.booking;
    const q = {
      name: 'May I have your name, please?',
      phone: 'What is your 10-digit mobile number?',
      service: 'What would you like to come in for? For example a check-up, cleaning, root canal, or something else.',
      date: 'Which day would you prefer? We are open Monday to Saturday.',
      time: `What time would suit you${b.date ? ' on ' + WEEKDAYS[b.date.getDay()].replace(/^./, c => c.toUpperCase()) : ''}? We see patients from 9 AM to 6:30 PM.`,
      which: 'Which detail should I change: the name, phone number, service, day or time?',
      esc_name: 'May I have your name, please?',
      esc_phone: 'What is the best 10-digit number to reach you on?',
    };
    return q[s.pending] || '';
  }

  // Pulls every booking detail it can find from one utterance.
  function extractInto(s, text) {
    const b = s.booking, filled = [], notes = [];
    const svc = matchService(text);
    if (svc && (!b.service || b.service.id !== svc.id) && !(svc.id === 'consult' && b.service && s.pending !== 'service')) { b.service = svc; filled.push('service'); }
    else if (s.pending === 'service' && /not sure|don'?t know|no idea|anything|general|just (a )?check|regular/.test(text)) { b.service = KB.services[0]; filled.push('service'); }

    const ph = extractPhone(text);
    if (ph && ph.phone) { b.phone = ph.phone; filled.push('phone'); }
    else if (ph && ph.partial && (s.pending === 'phone' || s.pending === 'esc_phone')) notes.push(`I heard only ${ph.partial} digits.`);
    else if (!ph && s.pending === 'phone' && /\d/.test(text)) notes.push('That does not look like a 10-digit mobile number.');

    const d = parseDate(text, s.now());
    if (d) {
      const p = dateProblem(d, s);
      if (p) { notes.push(p); }
      else { b.date = d; filled.push('date'); }
    }
    const t = parseTime(text);
    if (t) {
      const p = timeProblem(t, s);
      if (p) notes.push(p);
      else { b.time = t; filled.push('time'); }
    }
    const name = extractName(text, s.pending === 'name' && !filled.length && !notes.length && !yesNo(text) && !faqAnswers(s, text).length && !svc);
    if (name) { b.name = name; s.callerName = name; filled.push('name'); }

    // Re-check combinations that only become invalid together.
    if (b.date && b.service) {
      const p = dateProblem(b.date, s);
      if (p) { notes.push(p); delete b.date; }
    }
    if (b.time) {
      const p = timeProblem(b.time, s);
      if (p) { notes.push(p); delete b.time; }
    }
    return { filled: filled.filter(f => b[f]), notes };
  }

  function startBooking(s, text) {
    s.mode = 'booking';
    s.booking = { name: s.callerName || undefined };
    s.pending = null;
    s.slotFails = 0;
    s.offer = null;
    const r = extractInto(s, text);
    let pre = 'Sure, I can help you book an appointment.';
    const faqs = faqAnswers(s, text).filter(f => f.intent === 'faq_service_price');
    if (faqs.length) pre = faqs[0].answer + ' I can book that for you.';
    if (r.notes.length) pre += ' ' + r.notes.join(' ');
    return askNext(s, pre, 'booking_start');
  }

  function askNext(s, pre, intent) {
    const b = s.booking;
    const missing = ORDER.find(k => !b[k]);
    if (missing) {
      const ackName = s.pending === 'name' && b.name ? `Thank you, ${firstName(b.name)}. ` : '';
      s.pending = missing;
      return result(s, intent || 'booking_' + missing, [pre, ackName + question(s)].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim());
    }
    s.mode = 'confirm_booking';
    s.pending = null;
    return result(s, intent || 'booking_confirm', `${pre ? pre.trim() + ' ' : ''}Just to confirm: ${b.service.name.toLowerCase()} on ${dayLabel(b.date)} at ${timeLabel(b.time.min, b.time.approx)}, for ${b.name}, mobile ${formatPhone(b.phone)}. Is that correct?`.trim());
  }

  const SLOT_WORDS = { name: ['name', 'naam'], phone: ['phone', 'number', 'mobile', 'contact'], service: ['service', 'treatment', 'procedure'], date: ['day', 'date', 'din'], time: ['time', 'timing', 'slot'] };
  function slotMentioned(text) { return ORDER.find(k => has(text, SLOT_WORDS[k])); }

  function bookingTurn(s, text) {
    if (has(text, V.cancelFlow) && !has(text, ['cancel my appointment'])) {
      s.mode = 'idle'; s.booking = {}; s.pending = null; s.offer = 'anything_else';
      return result(s, 'booking_cancelled', 'No problem, I have not booked anything. Is there anything else I can help you with?');
    }
    const esc = escalationTrigger(text);
    if (esc && esc.category !== 'Reschedule / cancel existing booking') { s.mode = 'idle'; s.booking = {}; return startEscalation(s, esc, text, text); }

    if (s.pending === 'which') {
      const r = extractInto(s, text);
      if (r.filled.length) return askNext(s, r.notes.join(' '), 'booking_corrected');
      const slot = slotMentioned(text);
      if (slot) { delete s.booking[slot]; s.pending = slot; return result(s, 'booking_change_' + slot, 'Sure. ' + question(s)); }
    }

    // A question in the middle of booking: answer it, then continue where we left off.
    const isQuestion = /^(what|where|when|how|do|does|is|are|can|which|who|will|should)\b/.test(text);
    const faqs = isQuestion ? faqAnswers(s, text) : [];
    if (faqs.length) return result(s, faqs[0].intent, faqs.map(f => f.answer).join(' ') + ' ' + question(s));

    const r = extractInto(s, text);
    if (r.filled.length) { s.slotFails = 0; return askNext(s, r.notes.join(' ')); }
    if (r.notes.length) return result(s, 'booking_invalid_' + s.pending, r.notes.join(' ') + ' ' + question(s));

    const other = faqAnswers(s, text);
    if (other.length) return result(s, other[0].intent, other.map(f => f.answer).join(' ') + ' ' + question(s));

    s.slotFails += 1;
    if (s.slotFails >= 3) {
      const partial = s.booking;
      s.mode = 'idle'; s.booking = {};
      return startEscalation(s, { category: 'Repeated misunderstanding', priority: 'Normal', empathy: "I'm sorry, I'm having trouble getting the details. Let me have a staff member call you back to complete the booking." }, 'Could not complete booking' + (partial.service ? ' for ' + partial.service.name : ''), '', partial);
    }
    const hint = { phone: ' Please say the 10 digits one by one.', date: ' For example, "tomorrow" or "Friday".', time: ' For example, "11 AM" or "evening".' }[s.pending] || '';
    return result(s, 'booking_reprompt', `Sorry, I didn't catch that. ${question(s)}${hint}`);
  }

  function confirmBookingTurn(s, text) {
    if (has(text, V.cancelFlow) && !has(text, ['correct'])) return bookingTurn(s, text);
    const yn = yesNo(text);
    const r = extractInto(s, text);
    if (r.filled.length) { s.mode = 'booking'; return askNext(s, 'Okay, I have updated that. ' + r.notes.join(' '), 'booking_corrected'); }
    if (yn === 'yes') return saveBooking(s);
    if (yn === 'no' || r.notes.length) {
      s.mode = 'booking';
      const slot = slotMentioned(text);
      if (slot) { delete s.booking[slot]; s.pending = slot; return result(s, 'booking_change_' + slot, `${r.notes.join(' ')} No problem. ${question(s)}`.trim()); }
      s.pending = 'which';
      return result(s, 'booking_change', `${r.notes.join(' ')} No problem. ${question(s)}`.trim());
    }
    return result(s, 'booking_confirm_reprompt', 'Sorry, should I go ahead with these details? Please say yes or no.');
  }

  function saveBooking(s) {
    const b = s.booking;
    const rec = {
      id: s.nextId(),
      type: 'Appointment',
      status: 'New request',
      name: b.name,
      phone: b.phone,
      service: b.service.name,
      preferred_date: isoDate(b.date),
      preferred_day: dayLabel(b.date),
      preferred_time: timeLabel(b.time.min, b.time.approx),
      doctor: b.service.doctor,
      issue: '',
      priority: 'Normal',
      created_at: s.now().toISOString(),
      engine: s.engine,
    };
    s.mode = 'idle'; s.booking = {}; s.pending = null; s.offer = 'anything_else';
    return result(s, 'booking_saved', `Thank you, ${firstName(rec.name)}. Your appointment request is recorded with reference number ${rec.id}. Our team will call you to confirm the exact slot. Is there anything else I can help you with?`, {
      save: rec,
      saveFailReply: `I'm sorry, I couldn't save your request because of a technical problem. Please call us on ${KB.clinic.phone} to book.`,
    });
  }

  // ---------- escalation flow ----------

  function summariseIssue(raw) {
    const ws = String(raw).replace(/\s+/g, ' ').trim().split(' ');
    return ws.length > 18 ? ws.slice(0, 18).join(' ') + '…' : ws.join(' ');
  }

  function startEscalation(s, trig, issueRaw, text, partial) {
    s.mode = 'escalation';
    s.offer = null;
    s.escalation = { category: trig.category, priority: trig.priority, issue: summariseIssue(issueRaw), name: s.callerName || (partial && partial.name), phone: partial && partial.phone };
    if (text) {
      const ph = extractPhone(text);
      if (ph && ph.phone) s.escalation.phone = ph.phone;
      const n = extractName(text, false);
      if (n) { s.escalation.name = n; s.callerName = n; }
    }
    s.pending = null;
    return askEscalation(s, trig.empathy, 'escalation_' + trig.category.toLowerCase().replace(/[^a-z]+/g, '_').replace(/_$/, ''));
  }

  function askEscalation(s, pre, intent, gotName) {
    const e = s.escalation;
    if (!e.name) { s.pending = 'esc_name'; return result(s, intent || 'escalation_name', `${pre ? pre + ' ' : ''}${question(s)}`); }
    if (!e.phone) {
      const ack = s.pending === 'esc_name' || gotName ? `Thank you, ${firstName(e.name)}. ` : '';
      s.pending = 'esc_phone';
      return result(s, intent || 'escalation_phone', `${pre ? pre + ' ' : ''}${ack}${question(s)}`);
    }
    s.mode = 'confirm_escalation';
    s.pending = null;
    return result(s, intent || 'escalation_confirm', `${pre ? pre + ' ' : ''}Just to confirm, our team will call ${e.name} on ${formatPhone(e.phone)} about this. Is that correct?`);
  }

  function escalationTurn(s, text) {
    const e = s.escalation;
    const yn = yesNo(text);
    if ((s.pending === 'esc_name' && yn === 'no' && words(text).length <= 4) || has(text, ['never mind', 'nevermind', 'forget it', 'leave it', 'no need', "don't call", 'dont call'])) {
      s.mode = 'idle'; s.escalation = null; s.pending = null; s.offer = 'anything_else';
      return result(s, 'escalation_declined', `No problem. You can also reach our front desk directly on ${KB.clinic.phone}. Is there anything else I can help you with?`);
    }
    const isQuestion = /^(what|where|when|how|do|does|is|are|can|which|who)\b/.test(text);
    const faqs = isQuestion ? faqAnswers(s, text) : [];
    if (faqs.length) return result(s, faqs[0].intent, faqs.map(f => f.answer).join(' ') + ' ' + question(s));

    let got = false, note = '';
    const ph = extractPhone(text);
    if (ph && ph.phone) { e.phone = ph.phone; got = true; }
    else if (s.pending === 'esc_phone') note = ph && ph.partial ? `I heard only ${ph.partial} digits.` : (/\d/.test(text) ? 'That does not look like a 10-digit mobile number.' : '');
    const n = extractName(text, s.pending === 'esc_name' && !yn);
    if (n) { e.name = n; s.callerName = n; got = true; }
    if (got) return askEscalation(s, '', undefined, !!n);
    s.slotFails += 1;
    return result(s, 'escalation_reprompt', `${note || "Sorry, I didn't catch that."} ${question(s)}`);
  }

  function confirmEscalationTurn(s, text, raw) {
    const e = s.escalation;
    const yn = yesNo(text);
    const ph = extractPhone(text);
    if (ph && ph.phone) { e.phone = ph.phone; return askEscalation(s, 'Okay, I have updated the number.'); }
    if (yn === 'yes') {
      const rec = {
        id: s.nextId(),
        type: 'Escalation',
        status: 'Needs callback',
        name: e.name,
        phone: e.phone,
        service: '',
        preferred_date: '',
        preferred_day: '',
        preferred_time: '',
        doctor: '',
        issue: `${e.category}: ${e.issue}`,
        priority: e.priority,
        created_at: s.now().toISOString(),
        engine: s.engine,
      };
      s.mode = 'idle'; s.escalation = null; s.pending = null; s.offer = 'anything_else';
      const when = e.priority === 'Urgent' ? 'as soon as possible' : KB.callbackPromise;
      return result(s, 'escalation_saved', `Thank you, ${firstName(rec.name)}. I've passed this to our team with reference number ${rec.id}, and they will call you back ${when}. Is there anything else I can help you with?`, {
        save: rec,
        saveFailReply: `I'm sorry, I couldn't record your request because of a technical problem. Please call our front desk directly on ${KB.clinic.phone}.`,
      });
    }
    if (yn === 'no') {
      const slot = has(text, ['number', 'phone', 'mobile']) ? 'phone' : has(text, ['name']) ? 'name' : null;
      if (slot === 'phone' || !slot) { delete e.phone; s.mode = 'escalation'; s.pending = 'esc_phone'; return result(s, 'escalation_change', 'No problem. ' + (slot ? '' : 'Let me take your details again. ') + question(s)); }
      delete e.name; s.mode = 'escalation'; s.pending = 'esc_name';
      return result(s, 'escalation_change', 'No problem. ' + question(s));
    }
    return result(s, 'escalation_confirm_reprompt', 'Sorry, should I pass this to our team? Please say yes or no.');
  }

  // ---------- records & summaries ----------

  // Used to check requests produced by an LLM before they are saved.
  function validateRecord(rec, s) {
    const errors = [];
    const out = Object.assign({}, rec);
    const ph = extractPhone(norm(String(rec.phone || '')));
    if (!ph || !ph.phone) errors.push('a valid 10-digit mobile number');
    else out.phone = ph.phone;
    if (!rec.name || String(rec.name).trim().length < 2) errors.push('the caller\'s name');
    if (rec.type === 'Appointment') {
      if (!rec.service) errors.push('the service');
      const d = rec.preferred_date ? new Date(rec.preferred_date + 'T00:00:00') : null;
      if (!d || isNaN(d)) errors.push('the preferred date');
      else {
        const p = dateProblem(d, Object.assign({}, s, { booking: {} }));
        if (p) errors.push('a valid day (' + p + ')');
        else out.preferred_day = dayLabel(d);
      }
      if (!rec.preferred_time) errors.push('the preferred time');
    }
    return { ok: errors.length === 0, errors, record: out };
  }

  function summarize(s) {
    const end = s.now();
    const agentTurns = s.log.filter(l => l.role === 'agent').length;
    const callerTurns = s.log.filter(l => l.role === 'caller').length;
    const uniq = [...new Set(s.intents)];
    const appts = s.saved.filter(r => r.type === 'Appointment');
    const escs = s.saved.filter(r => r.type === 'Escalation');
    const outcome = [];
    if (appts.length) outcome.push('Appointment request recorded');
    if (escs.length) outcome.push('Escalated to staff');
    if (!outcome.length) outcome.push(uniq.some(i => i.startsWith('faq')) ? 'Questions answered' : 'No action taken');
    return {
      caller: s.callerName || 'Unknown',
      startedAt: s.startedAt.toISOString(),
      durationSec: Math.max(0, Math.round((end - s.startedAt) / 1000)),
      callerTurns, agentTurns,
      topics: uniq,
      outcome: outcome.join(' + '),
      sentiment: s.sentiment < 0 ? 'Negative' : s.sentiment > 0 ? 'Positive' : 'Neutral',
      references: s.saved.map(r => r.id),
    };
  }

  return {
    KB, createSession, greet, handle, guard: (s, raw) => guard(s, norm(raw)), validateRecord, summarize,
    // exported for tests
    _: { norm, has, extractPhone, parseDate, parseTime, extractName, matchService, yesNo, faqAnswers, timeLabel, isoDate },
  };
});
