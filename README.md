# Nexora AI

Nexora is a student-built learning companion with text chat and an optional live voice classroom. This repository is a small Python-served web app; it is intended for a supervised demo while the classroom roles and deployment setup are completed.

## Run it locally

Use Python 3.10 or newer.

```powershell
py -m pip install -r requirements.txt
Copy-Item .env.example .env
py server.py
```

Open <http://localhost:8000>. Chat needs one provider key in `.env`. Set `CHAT_PROVIDER` to `openrouter`, `groq`, or `gemini`, then add the matching API key and (optionally) model. The sample `.env.example` lists all supported settings.

Voice needs a separately configured Agora project and Conversational AI pipeline. Add the Agora values shown in `.env.example`. Keep every credential on the server; do not put keys in `api-config.js` or any browser file. If voice is not configured, text chat still works.

## What the app does

- Chat sends the current conversation to the configured AI provider. The browser keeps messages in memory for the open page only; refreshing or closing the tab clears them.
- The optional learning goal is held in memory and is included in chat requests only after you choose to save it in the chat controls.
- Location is not requested on page load. If you ask about local weather, Nexora can ask for a city; location support is only used after a user action.
- The language menu offers English, Hindi, Spanish, and French. Chat replies follow the selected language; some interface copy remains in English.
- The live voice panel connects to Agora only after you join and grant microphone access. Use the leave control to disconnect.
- There are no analytics, advertising pixels, or advertising cookies. The browser may keep two session-only settings: that the privacy notice was dismissed, and your language choice.

## Privacy and security

Never enter passwords, personal identifiers, health details, or other sensitive information. Chat text is sent to your configured AI provider; voice is handled by Agora. The provider and deployment host have their own terms, logs, and retention practices. Review those services and publish a privacy notice that identifies the actual operator and applicable policies before inviting real students.

The server applies same-origin checks, JSON body size limits, a basic per-IP request limit, and standard browser security headers. These are useful safeguards, not a substitute for a security review. Classroom roles are currently demo roles and are not backed by accounts or strong teacher authentication; anyone who knows a room code can impersonate a teacher. Classroom state is in memory and resets when the server restarts. Do not deploy the classroom for real student records until authenticated roles, room access controls, abuse monitoring, and a retention policy are implemented and reviewed.

Use HTTPS in deployment. Keep secrets in the host's environment-variable manager, rotate any credential that has been shared, and check provider terms and applicable child privacy requirements with the project owner before public use.

## Deploy

The included `render.yaml` describes a Render Python web service. Review its environment variables, add only the provider credentials you plan to use, and deploy over HTTPS. The `/health` endpoint is used for the host health check. Do not commit `.env` or provider credentials.

`server.js` is a legacy Node proxy and is not used by the current app. `railway.toml` is retained for an older deployment setup; the active server entry point is `server.py`.

## Project files

- `index.html`: the whole story on one page (ask box, how it works, project idea map, privacy promise)
- `explore.html`: mode select, then the chatbot or the live Agora classroom
- `404.html`, `favicon.svg`, `robots.txt`: error page, icon, crawler rules
- `styles.css`: one stylesheet for every page; animations respect reduced-motion settings
- `site.js`: shared behaviour (privacy notice, language, ask box, idea map, scroll effects, mode select)
- `app.js`: chat, classroom, and Agora browser client (explore page only)
- `globe.js`: the turnable globe on the home page
- `server.py`: static server (with ETag caching and a 404 page) plus the provider/Agora API proxy
- `api-config.js`: same-origin API endpoint configuration

Only the explore page is separate. Everything else lives on the home page, and moving between the two uses the browser's built-in page transition where it is supported.

Before a public launch, add a social preview image (`og:image`) and set your real domain in the page metadata.
