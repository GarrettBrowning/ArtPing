// Script for reset-password.html (kept out of the HTML so the security policy can block inline scripts)

const form = document.getElementById('reset-form');
const errorMsg = document.getElementById('error-msg');
const password = document.getElementById('password');
const repeat = document.getElementById('password-repeat');
const token = new URLSearchParams(location.search).get('token');

function showError(text) {
  errorMsg.textContent = text;
  errorMsg.style.display = 'block';
}

attachPasswordChecklist(password, document.getElementById('password-rules'));
attachMatchCheck(password, repeat, document.getElementById('match-note'));

if (!token) {
  form.style.display = 'none';
  errorMsg.innerHTML = 'Sorry, this reset link is missing or incomplete. <a href="forgot-password.html">Request a new one</a>.';
  errorMsg.style.display = 'block';
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorMsg.style.display = 'none';
  if (!passwordMeetsRules(password.value)) {
    return showError("Sorry, your password doesn't meet all the requirements yet. Check the list under the password box.");
  }
  if (password.value !== repeat.value) {
    return showError("Sorry, your passwords don't match. Please type the same password twice.");
  }

  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const res = await fetch('/api/password/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, password: password.value })
    });
    if (!res.ok) throw new Error(await res.text());
    location.href = '/login.html?reset=done';
  } catch (err) {
    showError(err.message || "Sorry, we couldn't reach the server. Please check your connection and try again.");
  } finally {
    button.disabled = false;
  }
});
