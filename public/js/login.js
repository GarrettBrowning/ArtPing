// Script for login.html (kept out of the HTML so the security policy can block inline scripts)

// Coming back from resetting a password
if (new URLSearchParams(location.search).get('reset') === 'done') {
  const success = document.getElementById('success-msg');
  success.textContent = 'Your password has been reset. Please log in with your new password.';
  success.style.display = 'block';
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const username = document.getElementById('username').value;
  const password = document.getElementById('password').value;
  const errorMsg = document.getElementById('error-msg');
  document.getElementById('success-msg').style.display = 'none';

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    if (res.ok) {
      const data = await res.json();
      location.href = '/index.html';
    } else {
      errorMsg.textContent = await res.text();
      errorMsg.style.display = 'block';
    }
  } catch (err) {
    errorMsg.textContent = "Sorry, we couldn't reach the server. Please check your connection and try again.";
    errorMsg.style.display = 'block';
  }
});
