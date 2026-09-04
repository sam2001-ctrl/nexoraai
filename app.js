const config = window.NEXORA_CONFIG || {};
const AGORA_SERVER = window.location.origin;
const AGORA_CHANNEL = `nexora-${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
const AGORA_UID = Math.floor(Math.random() * 1_000_000) + 1;
let agoraClient = null, microphoneTrack = null, agoraAgentId = null, isConnectingAgora = false, speechRecognition = null, usingAgoraCaptions = false;
const remoteAudioTracks = new Map();
const captionItems = new Map();
const history = [];

const chat = document.querySelector('#chat');
const form = document.querySelector('#chatForm');
const input = document.querySelector('#promptInput');
const voiceButton = document.querySelector('#voiceButton');
const voiceButtonText = document.querySelector('#voiceButtonText');
const voiceState = document.querySelector('#voiceState');
const captions = document.querySelector('#voiceCaptions');
const captionIndicator = document.querySelector('#captionIndicator');
const statusText = document.querySelector('#statusText');
const modePicker = document.querySelector('#modePicker');
const chatMode = document.querySelector('#chatMode');
const voiceMode = document.querySelector('#voiceMode');

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

function addMessage(content, role = 'assistant', extra = '') {
  const message = document.createElement('article');
  message.className = `message ${role} ${extra}`;
  message.innerHTML = role === 'assistant' ? '<div class="avatar">N</div><div class="bubble"></div>' : '<div class="bubble"></div>';
  message.querySelector('.bubble').textContent = content;
  chat.append(message);
  message.scrollIntoView({ behavior: 'smooth', block: 'end' });
  return message;
}

async function getReply(prompt) {
  if (!config.endpoint) return `I’m in demo mode. Connect your endpoint in api-config.js to send: “${prompt}”.`;
  const response = await fetch(config.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: config.model, messages: history }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Your AI endpoint returned an error.');
  return data.reply || data.message || data.choices?.[0]?.message?.content || 'Your endpoint returned no reply.';
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const prompt = input.value.trim();
  if (!prompt) return;
  addMessage(prompt, 'user');
  history.push({ role: 'user', content: prompt });
  input.value = '';
  input.style.height = 'auto';
  const pending = addMessage('Thinking', 'assistant', 'thinking');
  statusText.textContent = 'Gemini is thinking';
  try {
    const reply = await getReply(prompt);
    pending.remove();
    addMessage(reply);
    history.push({ role: 'assistant', content: reply });
  } catch (error) {
    pending.remove();
    addMessage(error.message || 'Something went wrong. Please try again.');
  }
  statusText.textContent = 'Gemini chat';
});

input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 130)}px`; });
document.querySelectorAll('.suggestion').forEach(button => button.addEventListener('click', () => { input.value = button.textContent; input.focus(); }));

function addCaption(role, content) {
  if (!content?.trim()) return;
  const item = document.createElement('div');
  item.className = `caption ${role}`;
  const label = role === 'user' ? 'You' : role === 'assistant' ? 'Nexora' : 'System';
  item.innerHTML = `<span>${label}</span><p></p>`;
  item.querySelector('p').textContent = content.trim();
  captions.append(item);
  captions.scrollTop = captions.scrollHeight;
  return item;
}

function setVoiceUi(live) {
  voiceButton.classList.toggle('listening', live);
  voiceButtonText.textContent = live ? 'End conversation' : 'Start conversation';
  voiceState.textContent = live ? 'Listening and connected' : 'Ready when you are';
  captionIndicator.textContent = live ? 'LIVE' : 'WAITING';
  statusText.textContent = live ? 'Voice conversation live' : 'Voice mode ready';
}

function startSpeechCaptions() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition || speechRecognition) return;
  speechRecognition = new Recognition();
  speechRecognition.continuous = true;
  speechRecognition.interimResults = false;
  speechRecognition.lang = navigator.language || 'en-US';
  speechRecognition.onresult = event => {
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      if (event.results[index].isFinal) addCaption('user', event.results[index][0].transcript);
    }
  };
  speechRecognition.onend = () => { if (agoraClient) speechRecognition?.start(); };
  speechRecognition.onerror = event => { if (event.error !== 'no-speech' && event.error !== 'aborted') console.warn('Captioning error:', event.error); };
  speechRecognition.start();
}

function stopSpeechCaptions() {
  if (!speechRecognition) return;
  speechRecognition.onend = null;
  speechRecognition.stop();
  speechRecognition = null;
}

function handleAgentCaption(uid, data) {
  const raw = new TextDecoder().decode(data);
  try {
    const message = JSON.parse(raw);
    const text = message.text || message.content || message.message || message.transcript;
    if (!text) return;
    if (message.object?.endsWith('.transcription')) {
      usingAgoraCaptions = true;
      stopSpeechCaptions();
      const role = message.object.startsWith('user.') ? 'user' : 'assistant';
      const key = message.message_id || `${message.object}-${message.turn_id || Date.now()}`;
      const existing = captionItems.get(key);
      if (existing) {
        existing.querySelector('p').textContent = text;
      } else {
        captionItems.set(key, addCaption(role, text));
      }
      captions.scrollTop = captions.scrollHeight;
      return;
    }
    addCaption(message.role === 'user' ? 'user' : 'assistant', text);
  } catch { addCaption('assistant', raw); }
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
    agoraClient.on('stream-message', handleAgentCaption);
    await agoraClient.join(tokenData.appId, tokenData.channel, tokenData.token, tokenData.uid);
    microphoneTrack = await AgoraRTC.createMicrophoneAudioTrack({ AEC: true, AGC: true, ANS: true });
    await agoraClient.publish([microphoneTrack]);
    const agentResult = await getJson(`${AGORA_SERVER}/api/ai/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: tokenData.channel, uid: tokenData.uid }) });
    agoraAgentId = agentResult.agent?.agent_id || agentResult.agent?.agentId;
    if (!agoraAgentId) throw new Error('Agora started an agent but did not return its ID.');
    usingAgoraCaptions = false;
    addCaption('system', 'Connected to Agora. Speak naturally to begin.');
    setVoiceUi(true);
    startSpeechCaptions();
  } catch (error) {
    console.error('Agora connection error:', error);
    addCaption('system', `Voice connection failed: ${error.message}`);
    await disconnectAgora(false);
  } finally {
    isConnectingAgora = false;
    voiceButton.disabled = false;
  }
}

async function disconnectAgora(stopAgent = true) {
  const agentId = agoraAgentId;
  agoraAgentId = null;
  stopSpeechCaptions();
  usingAgoraCaptions = false;
  if (stopAgent && agentId) { try { await getJson(`${AGORA_SERVER}/api/ai/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId }) }); } catch (error) { console.warn('Could not stop Agora agent:', error); } }
  if (microphoneTrack) { microphoneTrack.stop(); microphoneTrack.close(); microphoneTrack = null; }
  for (const track of remoteAudioTracks.values()) track.stop();
  remoteAudioTracks.clear();
  if (agoraClient) { try { await agoraClient.leave(); } catch (error) { console.warn('Could not leave Agora channel:', error); } agoraClient.removeAllListeners(); agoraClient = null; }
  setVoiceUi(false);
}

voiceButton.addEventListener('click', () => agoraClient ? disconnectAgora() : connectAgora());
window.addEventListener('beforeunload', () => { stopSpeechCaptions(); microphoneTrack?.close(); agoraClient?.leave(); });
