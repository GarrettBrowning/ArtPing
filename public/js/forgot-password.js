// Script for forgot-password.html (kept out of the HTML so the security policy can block inline scripts)

const form = document.getElementById('forgot-form');
const errorMsg = document.getElementById('error-msg');
const successMsg = document.getElementById('success-msg');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const button = form.querySelector('button[type="submit"]');
  errorMsg.style.display = 'none';
  button.disabled = true;

  try {
    const res = await fetch('/api/password/forgot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: document.getElementById('email').value })
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    successMsg.textContent = data.message;
    successMsg.style.display = 'block';
    form.style.display = 'none';
  } catch (err) {
    errorMsg.textContent = err.message || "Sorry, we couldn't reach the server. Please check your connection and try again.";
    errorMsg.style.display = 'block';
  } finally {
    button.disabled = false;
  }
});
