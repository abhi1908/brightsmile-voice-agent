# BrightSmile AI Voice Agent

An AI voice receptionist for **BrightSmile Dental Clinic** (a fictional clinic in Patna), built as an IIT Patna capstone project (Project 3: AI Voice Agent for Customer Support).

Maya, the agent, talks to callers in the browser. She can:

- greet callers and answer 15+ common questions (timings, address, fees, treatments, doctors, payment, parking and more), using only the clinic's knowledge base
- record appointment requests: she collects name, mobile number, service, day and time, checks them against clinic rules, reads them back and saves them with a reference number
- escalate complaints, billing disputes, booking changes, unknown questions and repeated misunderstandings to staff
- follow safety rules: emergency guidance (call 112), no medical advice, no sharing other patients' data, and resistance to prompt injection
- produce a call summary with outcome, sentiment and transcript

## Run it

It is a static site: open `index.html` through any web server, or visit the GitHub Pages URL.

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000 in **Google Chrome or Microsoft Edge** (needed for voice input) and press **Start call**.

## How it works

```
Caller speaks → Web Speech API (speech-to-text, en-IN)
             → Guardrails (emergency / privacy / prompt-injection)
             → Brain: offline engine (rules + knowledge base)  OR  Gemini / Claude LLM
             → Reply → Speech synthesis (text-to-speech)
             → Saved request → Requests dashboard (+ optional Google Sheet) → Staff callback
```

| File | Purpose |
|---|---|
| `kb.js` | Clinic knowledge base and the LLM system prompt |
| `engine.js` | Conversation engine: intents, slot filling, validation, escalation, summaries |
| `llm.js` | Optional Gemini / Claude integration (JSON replies) |
| `app.js` | UI, speech recognition and synthesis, storage, CSV export, Google Sheets sync |
| `google-apps-script.gs` | Optional Google Sheets webhook (setup steps inside) |
| `tests/run-tests.js` | 30 automated conversation tests (`node tests/run-tests.js`) |

## Optional LLM mode

Open **Settings**, choose Gemini or Claude, paste an API key and save. The key stays in your browser. The local guardrails and record validation still run before anything is saved.

## Deploy on GitHub Pages

1. Push these files to a public GitHub repository.
2. In the repository, go to **Settings → Pages**, set **Source: Deploy from a branch**, choose **main** and **/ (root)**, then **Save**.
3. After about a minute the site is live at `https://<username>.github.io/<repository>/`.
