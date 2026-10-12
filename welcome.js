(() => {
  const theme = window.NexoraTheme;
  const input = document.querySelector('#age');
  const form = document.querySelector('#ageForm');
  const error = document.querySelector('#ageError');
  const tag = document.querySelector('#bandTag');
  const names = { kids: 'Explorer mode', teen: 'Teen mode', adult: 'Classic mode' };
  const read = () => { const v = input.value.trim(); return /^\d{1,3}$/.test(v) && +v >= 1 && +v <= 120 ? +v : null; };

  input.addEventListener('input', () => {
    error.textContent = '';
    const age = read();
    if (age === null) { tag.textContent = ''; return; }
    const band = theme.band(age);
    theme.apply(band);
    tag.textContent = names[band];
  });

  form.addEventListener('submit', event => {
    event.preventDefault();
    const age = read();
    if (age === null) { error.textContent = 'Please type your age as a number from 1 to 120.'; input.focus(); return; }
    const band = theme.band(age);
    theme.apply(band);
    const saved = theme.save(band);
    const next = new URLSearchParams(location.search).get('next') || 'index.html';
    const dest = /^[a-z]+\.html(\?[\w=&-]*)?$/.test(next) ? next : 'index.html';
    location.replace(saved ? dest : dest + '#b=' + band);
  });
  input.focus();
})();
