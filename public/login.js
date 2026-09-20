const form = document.getElementById('login-form');
const errorMsg = document.getElementById('error-msg');
const loginBtn = document.getElementById('login-btn');
const tokenField = document.getElementById('token-field');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorMsg.style.display = 'none';
  loginBtn.disabled = true;
  loginBtn.textContent = 'Signing in...';

  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  const token = document.getElementById('token').value.trim();

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, token }),
    });
    const data = await res.json().catch(() => ({}));
    if (data && data.requiresTwoFactor) {
      tokenField.style.display = '';
      document.getElementById('token').focus();
      errorMsg.textContent = 'Enter your 2FA code to continue';
      errorMsg.style.display = 'block';
      return;
    }
    if (!res.ok) {
      errorMsg.textContent = data.error || 'Login failed';
      errorMsg.style.display = 'block';
      return;
    }
    window.location.href = '/';
  } catch (e) {
    errorMsg.textContent = 'Could not reach server';
    errorMsg.style.display = 'block';
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = 'Sign In';
  }
});
