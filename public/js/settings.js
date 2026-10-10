// Script for settings.html (kept out of the HTML so the security policy can block inline scripts)

const form = document.getElementById('password-form');
const current = document.getElementById('current-password');
const newPassword = document.getElementById('new-password');
const repeat = document.getElementById('repeat-password');
const errorMsg = document.getElementById('password-error');
const successMsg = document.getElementById('password-success');

attachPasswordChecklist(newPassword, document.getElementById('password-rules'));
attachMatchCheck(newPassword, repeat, document.getElementById('match-note'));

function showError(text) {
  successMsg.style.display = 'none';
  errorMsg.textContent = text;
  errorMsg.style.display = 'block';
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorMsg.style.display = 'none';
  successMsg.style.display = 'none';
  if (!passwordMeetsRules(newPassword.value)) {
    return showError("Sorry, your new password doesn't meet all the requirements yet. Check the list under the box.");
  }
  if (newPassword.value !== repeat.value) {
    return showError("Sorry, your new passwords don't match. Please type the same password twice.");
  }

  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const res = await fetch('/api/account/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: current.value, newPassword: newPassword.value })
    });
    if (!res.ok) throw new Error(await res.text());
    form.reset();
    newPassword.dispatchEvent(new Event('input')); // reset the checklist
    repeat.dispatchEvent(new Event('input'));
    successMsg.textContent = 'Your password has been changed. Any other devices have been logged out.';
    successMsg.style.display = 'block';
  } catch (err) {
    showError(err.message || "Sorry, we couldn't reach the server. Please check your connection and try again.");
  } finally {
    button.disabled = false;
  }
});

// ===== Delete account =====
const deleteForm = document.getElementById('delete-form');
const deleteError = document.getElementById('delete-error');

deleteForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  deleteError.style.display = 'none';
  const ok = await confirmAction({
    title: 'Delete your account?',
    message: 'Your account, profile, posts, images, comments, likes and follows will be permanently deleted. This can\'t be undone.',
    confirmLabel: 'Delete my account',
  });
  if (!ok) return;

  const button = deleteForm.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const res = await fetch('/api/account/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: document.getElementById('delete-password').value })
    });
    if (!res.ok) throw new Error(await res.text());
    location.href = '/index.html?deleted=1';
  } catch (err) {
    deleteError.textContent = err.message || "Sorry, we couldn't reach the server. Please check your connection and try again.";
    deleteError.style.display = 'block';
  } finally {
    button.disabled = false;
  }
});
