# Nexora AI

Nexora has two independent modes:

- Text chat uses Gemini through the local Python server.
- The microphone button starts and stops an Agora Conversational AI voice session. It joins the browser, starts your published Agora AI Studio pipeline, plays the agent's remote audio, and shuts the agent down when the call ends.

## One-time setup

1. Install Python 3.10 or newer, then in this folder run:

   ```powershell
   py -m pip install -r requirements.txt
   ```

2. In the Agora Console, enable an App Certificate for the same project as your Conversational AI pipeline. In the project's RESTful API area, create a Customer ID and Customer Secret. Keep the secret private.

3. Replace the contents of `.env` with your values (do not put this file online):

   ```dotenv
   GEMINI_API_KEY=your_gemini_key
   GEMINI_MODEL=gemini-2.0-flash

   AGORA_APP_ID=your_agora_app_id
   AGORA_APP_CERTIFICATE=your_app_certificate
   AGORA_CUSTOMER_ID=your_rest_customer_id
   AGORA_CUSTOMER_SECRET=your_rest_customer_secret
   AGORA_PIPELINE_ID=your_published_ai_studio_pipeline_id
   AGORA_AGENT_UID=14297
   ```

   `AGORA_AGENT_UID` must be an unused numeric UID, different from every browser user's UID. `AGORA_PIPELINE_ID` is the published pipeline ID, not an agent token. You do not need to set `AGORA_CHANNEL`: the app creates a new private channel for each visitor.

4. Start the local server:

   ```powershell
   py server.py
   ```

5. Visit `http://localhost:8000`. Allow microphone access and select the microphone button. Press it again to end the voice session.

Do not open `index.html` directly or use VS Code Live Server. Those options only serve the visual files; they do not run the `/api/chat` endpoint and will cause an `Unexpected token '<'` message.

## Deploy to Render

This project must be deployed as a **Web Service**, not a Static Site. The included `render.yaml` configures Render to install the Python dependencies, run `python server.py`, and check `/health`.

1. Push the updated project to your connected GitHub branch.
2. In Render, create a new **Blueprint** from that repository (or create a **Web Service** manually).
3. If creating it manually, use build command `pip install -r requirements.txt`, start command `python server.py`, and health check path `/health`.
4. Add the values from your local `.env` as Render environment variables. Do not upload or commit `.env`.
5. Redeploy, then open the Render Web Service URL. Do not use a separate GitHub Pages or Render Static Site URL for this app.

## What was fixed

- The browser now calls the agent-start endpoint after it joins and publishes its microphone.
- The server now creates a separate RTC token for the agent and uses HTTP Basic authentication with Agora REST credentials to start it.
- Agent audio is subscribed to and played in the browser.
- Ending the call now asks Agora to remove the agent before closing the microphone and RTC channel.
- The former `AGORA_AGENT_TOKEN` setting is no longer used. It was being incorrectly used as both a REST credential and an RTC token.

## Conversation quality

- Chat answers are now instructed to be concise and structured, with a 450-token ceiling. The app also keeps only the most recent 16 messages when sending context, which prevents long sessions from becoming slow and unfocused.
- The browser no longer runs a second speech-recognition microphone session while Agora is using the microphone. This removes a competing audio capture that can cause interruptions or duplicated captions. The unreliable live-caption panel has been removed from the voice screen.
- Set the same concise behavior in your published Agora AI Studio pipeline's system prompt, for example: `Reply conversationally in 1–3 short sentences. Answer directly, do not repeat yourself, and pause for the user after each response.` This pipeline prompt controls the voice agent's spoken answer length.
- For the clearest voice interaction, use headphones. Any voice assistant can hear its own reply again through external speakers when acoustic echo cancellation is not enough.

## Chat history

Text chat history is saved only in the browser on the current device. Messages are restored when the app is reopened and automatically removed after 30 days. The **Clear chat history** button immediately removes the saved local history. This does not save or restore Agora voice captions.

## Troubleshooting

- **Gemini request limit reached:** open [Google AI Studio rate limits](https://ai.google.dev/gemini-api/docs/rate-limits) for the Google project that created your API key. Wait for the displayed retry period, reduce requests, or enable billing/choose a model available to your quota. The model is controlled by `GEMINI_MODEL` in `.env`; restart the server after changing it.
- **401 from Agora:** verify `AGORA_CUSTOMER_ID` and `AGORA_CUSTOMER_SECRET`.
- **Agent does not join:** verify that the pipeline is published, the pipeline ID is correct, and it belongs to the same Agora project as the App ID.
- **No sound:** make sure browser microphone permission is enabled and use a secure origin or `localhost`.
- **Port 8000 already in use:** close the earlier server process or change the port consistently in `server.py`, `api-config.js`, and `app.js`.
