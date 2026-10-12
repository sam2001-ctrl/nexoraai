/* Age bands: picks the look of the site. Only the band (kids/teen/adult) is kept, per tab, never the age. */
(() => {
  const KEY = 'nexora-band';
  const root = document.documentElement;
  const fonts = { kids: 'Fredoka:wght@400;500;600;700', teen: 'Space+Grotesk:wght@400;500;700' };
  const copy = {
    kids: 'Hi, explorer! Ask me anything, build something cool, or talk it out loud. I help, and you do the amazing thinking!',
    teen: 'Ask sharper questions, plan real projects, talk it through. Nexora explains, you do the thinking.',
  };
  const api = window.NexoraTheme = {
    band: age => (age < 13 ? 'kids' : age < 18 ? 'teen' : 'adult'),
    apply(band) {
      root.dataset.theme = band;
      if (fonts[band] && !document.getElementById('theme-font')) {
        const link = document.createElement('link');
        link.id = 'theme-font'; link.rel = 'stylesheet';
        link.href = `https://fonts.googleapis.com/css2?family=${fonts[band]}&display=swap`;
        document.head.append(link);
      }
    },
    save(band) { try { sessionStorage.setItem(KEY, band); return true; } catch { return false; } },
    clear() { try { sessionStorage.removeItem(KEY); } catch { /* storage can be off */ } },
  };
  const facts = [
    'A group of flamingos is called a flamboyance. 🦩',
    'An octopus has three hearts. 🐙',
    'Honey can stay good for thousands of years. 🍯',
    'A day on Venus is longer than its year. 🪐',
    'Bananas are berries, but strawberries are not. 🍌',
    'Sharks are older than trees. 🦈',
    'Butterflies taste with their feet. 🦋',
  ];
  /* Under-18s confirm a parent, guardian or teacher is OK with chat and voice before the explore page works. */
  function gate() {
    if (!band || band === 'adult' || !/explore\.html$/.test(location.pathname)) return;
    try { if (sessionStorage.getItem('nexora-consent') === 'yes') return; } catch { /* ask again */ }
    const box = document.createElement('dialog');
    box.className = 'consent-dialog'; box.setAttribute('aria-labelledby', 'consentTitle');
    box.innerHTML = '<h2 id="consentTitle">Ask a grown-up first</h2><p>Nexora sends what you type, and your voice in a live classroom, to online services that write the replies. Please check with a parent, guardian or teacher before you start.</p><label class="consent-line"><input type="checkbox" id="consentBox" /><span>A parent, guardian or teacher says it’s OK for me to use Nexora.</span></label><p><a href="privacy.html">Read the privacy policy</a></p><div class="consent-actions"><button class="btn" id="consentGo" type="button" disabled>Continue</button><a class="btn" href="index.html">Go back</a></div>';
    document.body.append(box);
    const go = box.querySelector('#consentGo');
    box.querySelector('#consentBox').addEventListener('change', event => { go.disabled = !event.target.checked; });
    go.addEventListener('click', () => { try { sessionStorage.setItem('nexora-consent', 'yes'); } catch { /* memory only */ } box.close(); });
    box.addEventListener('cancel', event => event.preventDefault());
    box.showModal();
  }
  function playful() {
    const hero = document.querySelector('.hero-bg');
    if (!hero) return;
    [['⭐', '9%', '12%'], ['🪐', '3%', '46%'], ['🧪', '92%', '9%'], ['✏️', '2%', '82%'], ['💡', '94%', '60%'], ['📐', '50%', '86%'], ['☄️', '47%', '7%']].forEach(([emoji, x, y], i) => {
      const sticker = document.createElement('span');
      sticker.className = 'sticker'; sticker.setAttribute('aria-hidden', 'true');
      sticker.textContent = emoji; sticker.style.cssText = `left:${x};top:${y};animation-delay:${i * -0.6}s`;
      hero.append(sticker);
    });
    const buddy = document.createElement('div');
    buddy.className = 'buddy';
    buddy.innerHTML = '<button type="button" aria-label="Show a fun fact">🤖</button><p aria-live="polite">Tap me for a fun fact!</p>';
    let n = Math.floor(Math.random() * facts.length);
    buddy.querySelector('button').addEventListener('click', () => { buddy.querySelector('p').textContent = facts[n++ % facts.length]; });
    document.body.append(buddy);
  }
  let band = null;
  try { band = sessionStorage.getItem(KEY); } catch { /* fall through */ }
  band = band || (location.hash.match(/b=(kids|teen|adult)/) || [])[1];
  if (band) api.apply(band);
  else if (!/(welcome|privacy|terms|cookies|refunds|delete-data|licenses)\.html$/.test(location.pathname)) {
    const page = (location.pathname.split('/').pop() || 'index.html') + location.search;
    location.replace('welcome.html?next=' + encodeURIComponent(page));
  }
  document.addEventListener('DOMContentLoaded', () => {
    if (band === 'kids') playful();
    gate();
    document.addEventListener('click', event => {
      const tick = document.getElementById('voiceConsent');
      if (!event.target.closest('#voiceButton') || !tick || tick.checked) return;
      event.preventDefault(); event.stopImmediatePropagation();
      document.getElementById('voiceConsentHint')?.removeAttribute('hidden');
      tick.focus();
    }, true);

    const lede = document.querySelector('.hero .lede');
    if (lede && copy[band]) lede.textContent = copy[band];
    const wrap = document.querySelector('footer .wrap');
    if (!wrap) return;
    const again = document.createElement('button');
    again.type = 'button'; again.className = 'privacy-link'; again.textContent = 'Change age';
    again.addEventListener('click', () => { api.clear(); location.href = 'welcome.html'; });
    wrap.append(again);
  });
})();
