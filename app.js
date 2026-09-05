const config = window.NEXORA_CONFIG || {};
const AGORA_SERVER = window.location.origin;
const AGORA_CHANNEL = `nexora-${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
const AGORA_UID = Math.floor(Math.random() * 1_000_000) + 1;
let agoraClient = null, microphoneTrack = null, agoraAgentId = null, isConnectingAgora = false;
let chatRequest = null, isSendingChat = false;
const remoteAudioTracks = new Map();
const history = [];
const HISTORY_STORAGE_KEY = 'nexora-chat-history-v1';
const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const chat = document.querySelector('#chat');
const form = document.querySelector('#chatForm');
const input = document.querySelector('#promptInput');
const voiceButton = document.querySelector('#voiceButton');
const voiceButtonText = document.querySelector('#voiceButtonText');
const voiceState = document.querySelector('#voiceState');
const statusText = document.querySelector('#statusText');
const modePicker = document.querySelector('#modePicker');
const chatMode = document.querySelector('#chatMode');
const voiceMode = document.querySelector('#voiceMode');
const clearHistoryButton = document.createElement('button');
clearHistoryButton.type = 'button';
clearHistoryButton.className = 'clear-history-button';
clearHistoryButton.textContent = 'Clear chat history';
document.querySelector('#chatMode .screen-heading').append(clearHistoryButton);

function selectMode(mode) {
  modePicker.hidden = true;
  chatMode.hidden = mode !== 'chat';
  voiceMode.hidden = mode !== 'voice';
  statusText.textContent = mode === 'chat' ? 'Gemini chat' : 'Voice mode ready';
  if (mode === 'chat') input.focus();
}

async function returnHome() {
  if (agoraClient) await disconnectAgora();
  chatMode.hidden = true;
  voiceMode.hidden = true;
  modePicker.hidden = false;
  statusText.textContent = 'Choose a mode';
}

document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => selectMode(button.dataset.mode)));
document.querySelectorAll('[data-back]').forEach(button => button.addEventListener('click', returnHome));
document.querySelector('#homeButton').addEventListener('click', event => { event.preventDefault(); returnHome(); });

function addMessage(content, role = 'assistant', extra = '', shouldScroll = true) {
  const message = document.createElement('article');
  message.className = `message ${role} ${extra}`;
  message.innerHTML = role === 'assistant' ? '<div class="avatar">N</div><div class="bubble"></div>' : '<div class="bubble"></div>';
  message.querySelector('.bubble').textContent = content;
  chat.append(message);
  if (shouldScroll) message.scrollIntoView({ behavior: 'smooth', block: 'end' });
  return message;
}

function showWelcomeMessage() {
  addMessage('Welcome to Nexora. What would you like to explore?', 'assistant', '', false);
}

function saveHistory() {
  try {
    const cutoff = Date.now() - HISTORY_RETENTION_MS;
    const activeHistory = history.filter(message => message.createdAt >= cutoff);
    history.splice(0, history.length, ...activeHistory);
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(activeHistory));
  } catch (error) {
    console.warn('Could not save chat history:', error);
  }
}

function restoreHistory() {
  try {
    const storedHistory = JSON.parse(localStorage.getItem(HISTORY_STORAGE_KEY) || '[]');
    const cutoff = Date.now() - HISTORY_RETENTION_MS;
    const activeHistory = Array.isArray(storedHistory) ? storedHistory.filter(message =>
      (message.role === 'user' || message.role === 'assistant') &&
      typeof message.content === 'string' &&
      Number.isFinite(message.createdAt) && message.createdAt >= cutoff,
    ) : [];
    history.push(...activeHistory);
    chat.replaceChildren();
    if (history.length) history.forEach(message => addMessage(message.content, message.role, '', false));
    else showWelcomeMessage();
    saveHistory();
  } catch (error) {
    console.warn('Could not restore chat history:', error);
    chat.replaceChildren();
    showWelcomeMessage();
  }
}

function clearHistory() {
  history.splice(0, history.length);
  localStorage.removeItem(HISTORY_STORAGE_KEY);
  chat.replaceChildren();
  showWelcomeMessage();
}

restoreHistory();
clearHistoryButton.addEventListener('click', clearHistory);

async function getReply(prompt) {
  if (!config.endpoint) return `I’m in demo mode. Connect your endpoint in api-config.js to send: “${prompt}”.`;
  chatRequest = new AbortController();
  const response = await fetch(config.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: chatRequest.signal, body: JSON.stringify({ model: config.model, messages: history.slice(-16) }) });
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const responseText = await response.text();
    if (responseText.trimStart().startsWith('<')) {
      throw new Error('The AI server is not running here. Start server.py, then open http://localhost:8000 — not Live Server or the HTML file directly.');
    }
    throw new Error('The AI server returned an unexpected response. Open http://localhost:8000 after starting server.py.');
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Your AI endpoint returned an error.');
  return data.reply || data.message || data.choices?.[0]?.message?.content || 'Your endpoint returned no reply.';
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (isSendingChat) return;
  const prompt = input.value.trim();
  if (!prompt) return;
  isSendingChat = true;
  addMessage(prompt, 'user');
  history.push({ role: 'user', content: prompt, createdAt: Date.now() });
  saveHistory();
  input.value = '';
  input.style.height = 'auto';
  const pending = addMessage('Thinking', 'assistant', 'thinking');
  statusText.textContent = 'Gemini is thinking';
  try {
    const reply = await getReply(prompt);
    pending.remove();
    addMessage(reply);
    history.push({ role: 'assistant', content: reply, createdAt: Date.now() });
    saveHistory();
  } catch (error) {
    pending.remove();
    if (error.name !== 'AbortError') addMessage(error.message || 'Something went wrong. Please try again.');
  } finally {
    chatRequest = null;
    isSendingChat = false;
    statusText.textContent = 'Gemini chat';
  }
});

input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 130)}px`; });
document.querySelectorAll('.suggestion').forEach(button => button.addEventListener('click', () => { input.value = button.textContent; input.focus(); }));

function setVoiceUi(live) {
  voiceButton.classList.toggle('listening', live);
  voiceButtonText.textContent = live ? 'End conversation' : 'Start conversation';
  voiceState.textContent = live ? 'Listening and connected' : 'Ready when you are';
  statusText.textContent = live ? 'Voice conversation live' : 'Voice mode ready';
}

async function getJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'The server returned an error.');
  return data;
}

async function playRemoteAudio(user, mediaType) {
  if (mediaType !== 'audio') return;
  await agoraClient.subscribe(user, mediaType);
  const track = user.audioTrack;
  if (!track || remoteAudioTracks.get(user.uid) === track) return;
  remoteAudioTracks.get(user.uid)?.stop();
  track.play();
  remoteAudioTracks.set(user.uid, track);
}

function stopRemoteAudio(user) {
  const track = remoteAudioTracks.get(user.uid) || user.audioTrack;
  track?.stop();
  remoteAudioTracks.delete(user.uid);
}

async function connectAgora() {
  if (isConnectingAgora || agoraClient) return;
  isConnectingAgora = true;
  voiceButton.disabled = true;
  try {
    voiceState.textContent = 'Connecting to Agora…';
    const tokenData = await getJson(`${AGORA_SERVER}/agora/token?channel=${encodeURIComponent(AGORA_CHANNEL)}&uid=${AGORA_UID}`);
    agoraClient = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
    agoraClient.on('user-published', (user, mediaType) => playRemoteAudio(user, mediaType).catch(error => console.error('Remote audio error:', error)));
    agoraClient.on('user-unpublished', (user, mediaType) => { if (mediaType === 'audio') stopRemoteAudio(user); });
    agoraClient.on('user-left', stopRemoteAudio);
    await agoraClient.join(tokenData.appId, tokenData.channel, tokenData.token, tokenData.uid);
    microphoneTrack = await AgoraRTC.createMicrophoneAudioTrack({ AEC: true, AGC: true, ANS: true });
    await agoraClient.publish([microphoneTrack]);
    const agentResult = await getJson(`${AGORA_SERVER}/api/ai/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: tokenData.channel, uid: tokenData.uid }) });
    agoraAgentId = agentResult.agent?.agent_id || agentResult.agent?.agentId;
    if (!agoraAgentId) throw new Error('Agora started an agent but did not return its ID.');
    setVoiceUi(true);
  } catch (error) {
    console.error('Agora connection error:', error);
    voiceState.textContent = `Connection failed: ${error.message}`;
    await disconnectAgora(false);
  } finally {
    isConnectingAgora = false;
    voiceButton.disabled = false;
  }
}

async function disconnectAgora(stopAgent = true) {
  const agentId = agoraAgentId;
  agoraAgentId = null;
  if (stopAgent && agentId) { try { await getJson(`${AGORA_SERVER}/api/ai/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId }) }); } catch (error) { console.warn('Could not stop Agora agent:', error); } }
  if (microphoneTrack) { microphoneTrack.stop(); microphoneTrack.close(); microphoneTrack = null; }
  for (const track of remoteAudioTracks.values()) track.stop();
  remoteAudioTracks.clear();
  if (agoraClient) { try { await agoraClient.leave(); } catch (error) { console.warn('Could not leave Agora channel:', error); } agoraClient.removeAllListeners(); agoraClient = null; }
  setVoiceUi(false);
}

voiceButton.addEventListener('click', () => agoraClient ? disconnectAgora() : connectAgora());
window.addEventListener('beforeunload', () => { microphoneTrack?.close(); agoraClient?.leave(); });
