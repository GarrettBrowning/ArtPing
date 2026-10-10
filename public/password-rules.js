// Password rules shown live while typing, on register, reset and settings pages.
// The server checks the same rules (passwordProblem() in server.js); keep them in sync.
const PASSWORD_RULES = [
  { label: 'At least 8 characters', test: pw => pw.length >= 8 },
  { label: 'An uppercase letter (A–Z)', test: pw => /[A-Z]/.test(pw) },
  { label: 'A lowercase letter (a–z)', test: pw => /[a-z]/.test(pw) },
  { label: 'A number (0–9)', test: pw => /[0-9]/.test(pw) },
  { label: 'A special character (like ! @ # $)', test: pw => /[^A-Za-z0-9]/.test(pw) },
];

function passwordMeetsRules(password) {
  return PASSWORD_RULES.every(rule => rule.test(password));
}

// Fills `list` (a <ul>) with the rules and ticks them off as the user types in `input`
function attachPasswordChecklist(input, list) {
  list.classList.add('password-rules');
  list.innerHTML = PASSWORD_RULES.map(rule =>
    `<li><span class="rule-mark" aria-hidden="true"></span><span class="rule-text">${rule.label}</span></li>`
  ).join('');
  const items = [...list.children];
  const update = () => {
    PASSWORD_RULES.forEach((rule, i) => {
      const met = rule.test(input.value);
      items[i].classList.toggle('met', met);
      items[i].querySelector('.rule-text').setAttribute('aria-label', `${rule.label}: ${met ? 'done' : 'not yet'}`);
    });
  };
  input.addEventListener('input', update);
  update();
}

// Shows/hides the "passwords don't match" note under a confirm field
function attachMatchCheck(input, confirmInput, note) {
  const update = () => {
    const show = confirmInput.value.length > 0 && confirmInput.value !== input.value;
    note.textContent = show ? 'Passwords don\'t match yet.' : '';
  };
  input.addEventListener('input', update);
  confirmInput.addEventListener('input', update);
}
