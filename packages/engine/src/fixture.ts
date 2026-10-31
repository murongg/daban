export {};

const identity = document.querySelector<HTMLElement>('#identity')!;
const login = document.querySelector<HTMLButtonElement>('#login')!;
const logout = document.querySelector<HTMLButtonElement>('#logout')!;
const increment = document.querySelector<HTMLButtonElement>('#increment')!;
const description = document.querySelector<HTMLElement>('#account-description')!;
let count = 0;
let polling = false;
async function session() {
  if (polling) return;
  polling = true;
  try {
    const response = await fetch('/fixture/session');
    if (!response.ok) throw new Error('session unavailable');
    const { user } = await response.json();
    identity.textContent = user || '尚未登录';
    identity.dataset.ready = 'true';
    login.hidden = Boolean(user);
    login.disabled = false;
    logout.hidden = !user;
    increment.disabled = !user;
    description.textContent = user
      ? '已登录示例团队，可在另一页直接复用。'
      : '登录一次，另一位 Bot 的页面会自动识别。';
  } catch {
    description.textContent = '会话读取失败，正在重试。';
  } finally {
    polling = false;
  }
}
login.addEventListener('click', async () => {
  login.disabled = true;
  await fetch('/fixture/login', { method: 'POST' });
  await session();
});
logout.addEventListener('click', async () => {
  await fetch('/fixture/logout', { method: 'POST' });
  await session();
});
increment.addEventListener('click', () => {
  document.querySelector('#count')!.textContent = String(++count);
});
await session();
setInterval(session, 400);
