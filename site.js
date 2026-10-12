/* Nexora - behaviour shared by the home and explore pages.
 * Wrapped in a function so its names never collide with app.js, which loads
 * after it on the explore page and declares its own top-level variables. */
(() => {
  const $ = selector => document.querySelector(selector);
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.documentElement.classList.add('js');

  /* ---- privacy notice ---- */
  const banner = $('#privacyBanner');
  const dialog = $('#privacyDialog');
  try { if (!sessionStorage.getItem('nexora-privacy-notice')) banner.hidden = false; }
  catch { banner.hidden = false; }
  $('#privacyDismiss')?.addEventListener('click', () => {
    banner.hidden = true;
    try { sessionStorage.setItem('nexora-privacy-notice', 'seen'); } catch { /* storage can be off in private windows */ }
  });

  /* ---- language: remembered for this tab, shared with the chat requests ---- */
  const words = {
    hi: { Home: 'होम', 'How it works': 'कैसे काम करता है', 'Project helper': 'प्रोजेक्ट सहायक', 'Explore Nexora': 'Nexora खोजें' },
    es: { Home: 'Inicio', 'How it works': 'Cómo funciona', 'Project helper': 'Asistente de proyectos', 'Explore Nexora': 'Explorar Nexora' },
    fr: { Home: 'Accueil', 'How it works': 'Comment ça marche', 'Project helper': 'Assistant de projet', 'Explore Nexora': 'Découvrir Nexora' },
  };
  const select = $('#languageSelect');
  const labels = [...document.querySelectorAll('.site-nav nav a, .site-nav .btn')];
  labels.forEach(label => { label.dataset.en = label.textContent; });
  const applyLanguage = lang => {
    document.documentElement.lang = lang;
    labels.forEach(label => { label.textContent = words[lang]?.[label.dataset.en] || label.dataset.en; });
  };
  try {
    const saved = sessionStorage.getItem('nexora-lang');
    if (saved && select) { select.value = saved; applyLanguage(saved); }
  } catch { /* fall back to English */ }
  select?.addEventListener('change', () => {
    try { sessionStorage.setItem('nexora-lang', select.value); } catch { /* ignore */ }
    applyLanguage(select.value);
  });

  /* ---- hand a prompt to the chatbot on the explore page ---- */
  const openChat = (prompt, projectIncubator = false) => {
    try { sessionStorage.setItem('nexora-handoff', JSON.stringify({ prompt, projectIncubator })); } catch { /* the chat simply opens empty */ }
    window.location.href = 'explore.html?mode=chat';
  };

  /* ---- home: ask box with example questions typed into the placeholder ---- */
  const ask = $('#askForm');
  const askInput = $('#askInput');
  ask?.addEventListener('submit', event => {
    event.preventDefault();
    const question = askInput.value.trim();
    if (question) return openChat(question);
    askInput.focus();
    ask.classList.remove('nudge');
    void ask.offsetWidth; // restart the animation
    ask.classList.add('nudge');
  });
  document.querySelectorAll('.chip').forEach(chip => chip.addEventListener('click', () => openChat(chip.dataset.q)));

  if (askInput && !calm) {
    const lines = ['Why is the sky blue?', 'How do I start a science fair project?', 'Explain fractions like I’m ten', 'What makes a rainbow?'];
    let line = 0, shown = 0, step = 1;
    const type = () => {
      if (document.activeElement === askInput || askInput.value) return window.setTimeout(type, 600);
      shown += step;
      askInput.placeholder = lines[line].slice(0, shown) || ' ';
      let wait = step > 0 ? 55 : 25;
      if (step > 0 && shown === lines[line].length) { step = -1; wait = 1600; }
      else if (step < 0 && shown === 0) { step = 1; line = (line + 1) % lines.length; wait = 400; }
      window.setTimeout(type, wait);
    };
    window.setTimeout(type, 2500);
  }

  /* ---- home: the step in the middle of the screen is the one in focus ---- */
  const steps = [...document.querySelectorAll('.step')];
  if (steps.length && 'IntersectionObserver' in window) {
    const watcher = new IntersectionObserver(entries => {
      entries.forEach(entry => entry.target.classList.toggle('is-active', entry.isIntersecting));
    }, { rootMargin: '-40% 0px -40% 0px' });
    steps.forEach(step => watcher.observe(step));
  }

  /* ---- home: a line along the steps fills as you scroll through them ---- */
  const rail = $('.steps');
  if (rail) {
    const fill = () => {
      const box = rail.getBoundingClientRect();
      const done = Math.min(1, Math.max(0, (window.innerHeight * 0.5 - box.top) / box.height));
      rail.style.setProperty('--p', done.toFixed(3));
    };
    window.addEventListener('scroll', fill, { passive: true });
    window.addEventListener('resize', fill);
    fill();
  }

  /* ---- home: the nav underline follows the section you are reading ---- */
  const links = [...document.querySelectorAll('.site-nav nav a[href^="#"]')];
  if (links.length && 'IntersectionObserver' in window) {
    const spy = new IntersectionObserver(entries => entries.forEach(entry => {
      links.find(link => link.getAttribute('href') === '#' + entry.target.id)?.toggleAttribute('aria-current', entry.isIntersecting);
    }), { rootMargin: '-45% 0px -50% 0px' });
    links.forEach(link => { const target = document.getElementById(link.getAttribute('href').slice(1)); if (target) spy.observe(target); });
  }

  /* ---- home: the idea map fills in while you type ---- */
  const form = $('#projectForm');
  if (form) {
    const fields = [['projectInterest', 'mapInterest'], ['projectProblem', 'mapProblem'], ['projectOutcome', 'mapOutcome']];
    const go = $('#mapGo');
    const refresh = () => {
      fields.forEach(([inputId, nodeId]) => {
        const text = $('#' + inputId).value.trim();
        const node = $('#' + nodeId);
        node.textContent = text || node.dataset.empty;
        node.parentElement.classList.toggle('filled', Boolean(text));
      });
      go.disabled = !($('#projectInterest').value.trim() && $('#projectProblem').value.trim());
    };
    form.addEventListener('input', refresh);
    refresh();
    form.addEventListener('submit', event => {
      event.preventDefault();
      const value = id => $('#' + id).value.trim();
      const interest = value('projectInterest');
      const problem = value('projectProblem');
      const outcome = value('projectOutcome') || 'a clear presentation of what I learn';
      if (!interest || !problem) return;
      openChat(`Create a student Project Map in Markdown. My interest: ${interest}. The question or problem: ${problem}. I want to create: ${outcome}. Include: a strong project title, why it matters, a research question, 3 realistic first steps, materials or people I may need, and a simple presentation plan. Encourage me to do the investigation myself.`, true);
    });
  }

  /* ---- explore: choose between the chatbot and conversational AI ---- */
  const explore = $('[data-modes]');
  if (!explore) return;
  const picker = $('#modeSelect');
  const grid = $('.mode-grid');
  const bar = $('#modeBar');
  const panels = { chat: $('#chatPanel'), voice: $('#voicePanel') };
  const names = { chat: 'Chatbot', voice: 'Conversational AI' };

  const showMode = mode => {
    picker.hidden = true;
    bar.hidden = false;
    $('#modeLabel').textContent = names[mode];
    Object.entries(panels).forEach(([key, panel]) => { panel.hidden = key !== mode; });
    window.history.replaceState(null, '', `?mode=${mode}`);
  };

  document.querySelectorAll('.mode').forEach(button => button.addEventListener('click', () => {
    grid.classList.add('picked');
    button.classList.add('chosen');
    window.setTimeout(() => showMode(button.dataset.mode), calm ? 0 : 450);
  }));

  $('#changeMode').addEventListener('click', () => {
    // Leaving the voice mode ends the live session so the microphone is released.
    if (typeof agoraClient !== 'undefined' && agoraClient) disconnectAgora();
    bar.hidden = true;
    Object.values(panels).forEach(panel => { panel.hidden = true; });
    grid.classList.remove('picked');
    grid.querySelectorAll('.chosen').forEach(button => button.classList.remove('chosen'));
    picker.hidden = false;
    window.history.replaceState(null, '', 'explore.html');
  });

  const requested = new URLSearchParams(window.location.search).get('mode');
  if (panels[requested]) showMode(requested);
})();
