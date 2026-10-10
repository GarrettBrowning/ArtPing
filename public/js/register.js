// Script for register.html (kept out of the HTML so the security policy can block inline scripts)

attachPasswordChecklist(document.getElementById('password'), document.getElementById('password-rules'));
attachMatchCheck(document.getElementById('password'), document.getElementById('password-repeat'), document.getElementById('match-note'));

document.getElementById('register-form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const username = document.getElementById('username').value;
  const password = document.getElementById('password').value;
  const passwordRepeat = document.getElementById('password-repeat').value;
  const email = document.getElementById('email').value;
  const errorMsg = document.getElementById('error-msg');

  const showError = (text) => {
    errorMsg.textContent = text;
    errorMsg.style.display = 'block';
    errorMsg.scrollIntoView({ block: 'nearest' });
  };
  if (!/^[A-Za-z0-9_]{3,30}$/.test(username.trim())) {
    return showError('Sorry, usernames must be 3–30 characters and use only letters, numbers and underscores (_).');
  }
  if (!passwordMeetsRules(password)) return showError("Sorry, your password doesn't meet all the requirements yet. Check the list under the password box.");
  if (password !== passwordRepeat) return showError("Sorry, your passwords don't match. Please type the same password twice.");

  try {
    const res = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, username, password })
    });
    if (res.ok) {
      location.href = '/index.html?welcome=1';
    } else {
      showError(await res.text());
    }
  } catch (err) {
    showError("Sorry, we couldn't reach the server. Please check your connection and try again.");
  }
});
