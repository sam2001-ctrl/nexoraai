# Nexora AI

One page, two live modes, no mode-switching required:

- A landing section introduces Nexora (content pulled from the nexoraai200
  site, restyled).
- A **console** section near the bottom holds two always-visible windows:
  a text chat window and a live voice window. Both talk to the same local
  Python server.
- Text chat calls Groq (or Gemini) through the local server.
- The voice window starts and stops an Agora Conversational AI session:
  it joins the browser, starts your published Agora AI Studio pipeline,
  plays the agent's remote audio, and shuts the agent down when the call
  ends. It shows a small draggable 3D globe instead of a caption panel -
  a proper live transcript would need Agora's conversation-transcript
  API wired up separately, which this project doesn't do, so it isn't
  faked here.

## Before anything else: rotate your keys

The `.env` you were using had real credentials in it (Groq API key, Agora
App Certificate, Customer ID/Secret). Treat all of those as compromised -
rotate them in the Groq and Agora dashboards before deploying this again.
`.env` is git-ignored for a reason; keep it off of shared drives, chats,
and screenshots too.

## One-time setup

1. Install Python 3.10 or newer, then in this folder run:

   ```powershell
   py -m pip install -r requirements.txt
   ```

2. In the Agora Console, enable an App Certificate for the same project as
   your Conversational AI pipeline. In the project's RESTful API area,
   create a Customer ID and Customer Secret. Keep the secret private.

3. Copy `.env.example` to `.env` and fill in your own values (don't put
   this file online):

   ```dotenv
   # Text chat (Groq free tier)
   CHAT_PROVIDER=groq
   GROQ_API_KEY=your_groq_key
   GROQ_MODEL=openai/gpt-oss-20b

   # Optional Gemini fallback
   GEMINI_API_KEY=your_gemini_key
   GEMINI_MODEL=gemini-2.5-flash

   AGORA_APP_ID=your_agora_app_id
   AGORA_APP_CERTIFICATE=your_app_certificate
   AGORA_CUSTOMER_ID=your_rest_customer_id
   AGORA_CUSTOMER_SECRET=your_rest_customer_secret
   AGORA_PIPELINE_ID=your_published_ai_studio_pipeline_id
   AGORA_AGENT_UID=14297
   ```

   `AGORA_AGENT_UID` must be an unused numeric UID, different from every
   browser user's UID. `AGORA_PIPELINE_ID` is the published pipeline ID,
   not an agent token. You don't need to set `AGORA_CHANNEL`: the app
   creates a new private channel for each visitor.

   Gemini's model names change often - if `GEMINI_MODEL` ever 404s, check
   the current list at ai.google.dev/gemini-api/docs/models and update it.

4. Start the local server:

   ```powershell
   py server.py
   ```

5. Visit `http://localhost:8000`. Scroll to the console section (or click
   "Launch console" in the nav) to try chat or voice. For voice, allow
   microphone access and select "Start conversation"; select it again to
   end the call.

Do not open `index.html` directly or use VS Code Live Server. Those
options only serve the visual files; they don't run the `/api/chat`
endpoint and will cause an `Unexpected token '<'` message.

The browser defaults to `/api/chat` on the same deployed site.
`api-config.js` is optional and only needed when you deliberately use a
different endpoint.

## What was fixed this pass

- **Weather, time, and date questions now get real answers.** Previously
  these went to the language model, which has no clock and no internet
  access, so it either refused or made something up. The server now
  answers these itself: time/date comes from the browser's own time
  zone, and weather comes from Open-Meteo (no API key needed) using
  either the location the browser shares or a city name you mention in
  the message ("weather in Lucknow").
- **Straightforward answers.** The system prompt was rewritten to answer
  the actual question in the first sentence instead of hedging,
  restating the question, or padding with disclaimers.
- **Every button does something.** The old build had a full-page mode
  picker that swapped screens; the redesign keeps both the chat and
  voice windows on screen at once, and every nav link, suggestion chip,
  and CTA button is wired to a real action (smooth scroll, send, clear
  history, start/stop voice, drag the globe).
- **`GEMINI_MODEL` pointed at a retired model** (`gemini-3.6-flash`
  isn't a real model ID). Default is now `gemini-2.5-flash`.
- The former `AGORA_AGENT_TOKEN` setting is unused - it was being used
  incorrectly as both a REST credential and an RTC token.
- The browser no longer runs a second speech-recognition microphone
  session while Agora is using the microphone, which used to cause
  interruptions or duplicated audio capture.

## Conversation quality

- Chat answers are capped at 450 tokens and instructed to stay concise
  (2-6 sentences by default). The app also keeps only the most recent 16
  messages when sending context, so long sessions stay fast and focused.
- Set the same concise behavior in your published Agora AI Studio
  pipeline's system prompt, for example: `Reply conversationally in 1-3
  short sentences. Answer directly, do not repeat yourself, and pause
  for the user after each response.` This pipeline prompt controls the
  voice agent's spoken answer length.
- For the clearest voice interaction, use headphones. Any voice
  assistant can hear its own reply again through external speakers when
  acoustic echo cancellation isn't enough.

## Chat history

Text chat is cleared automatically whenever the page is refreshed or opened,
so each visit begins with a new conversation. The **Clear chat history**
button immediately clears the current conversation too.

## Deploy to Render

This project must be deployed as a **Web Service**, not a Static Site.
The included `render.yaml` configures Render to install the Python
dependencies, run `python server.py`, and check `/health`.

1. Push the updated project to your connected GitHub branch.
2. In Render, create a new **Blueprint** from that repository (or create
   a **Web Service** manually).
3. If creating it manually, use build command `pip install -r
   requirements.txt`, start command `python server.py`, and health check
   path `/health`.
4. Add the values from your local `.env` as Render environment
   variables. Do not upload or commit `.env`.
5. Redeploy, then open the Render Web Service URL. Do not use a separate
   GitHub Pages or Render Static Site URL for this app.

### Add the Groq key in Render

In your Render service, open **Environment** and add these variables:

```text
CHAT_PROVIDER=groq
GROQ_API_KEY=your_actual_groq_key
GROQ_MODEL=openai/gpt-oss-20b
```

Save the variables and choose **Manual Deploy → Deploy latest commit**.
Keep the key in Render only; never add it to `api-config.js`, commit it
to GitHub, or send it in chat.

## Troubleshooting

- **Gemini request limit reached:** open [Google AI Studio rate
  limits](https://ai.google.dev/gemini-api/docs/rate-limits) for the
  Google project that created your API key. Wait for the displayed retry
  period, reduce requests, or enable billing/choose a model available to
  your quota. Restart the server after changing `GEMINI_MODEL`.
- **401 from Agora:** verify `AGORA_CUSTOMER_ID` and
  `AGORA_CUSTOMER_SECRET`.
- **Agent does not join:** verify that the pipeline is published, the
  pipeline ID is correct, and it belongs to the same Agora project as
  the App ID.
- **No sound:** make sure browser microphone permission is enabled and
  use a secure origin or `localhost`.
- **Weather answers ask for a city:** the browser's location permission
  was denied or timed out - either allow it, or just name a city in your
  message ("what's the weather in Pune").
- **Port 8000 already in use:** close the earlier server process or
  change the port consistently in `server.py` and `api-config.js`.

## Legacy files

`server.js` and `package.json` are left over from an earlier Node-based
version of this project. The active backend is `server.py` - you don't
need to run `npm install` or Node for anything described above.
