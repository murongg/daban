import type { LegacySnapshot } from './snapshot.js';

function q<T extends HTMLElement = HTMLElement>(selector: string, root: ParentNode = document): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Missing diagnostic element ${selector}`);
  return element;
}
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const token = q<HTMLMetaElement>('meta[name=prototype-token]').content;
const screenRoot = q<HTMLElement>('#screens');
const notice = q<HTMLElement>('#notice');
const connection = q<HTMLElement>('#connection');
let state: LegacySnapshot;
let view = 'both';
let refreshing = false;
const images = new Map<string, { src: string; instance?: string; epoch?: number }>();
const fetching = new Set();
const pending = new Set();
const inputTails = new Map<string, Promise<boolean>>();
let renderedMode: boolean | undefined;

for (const id of ['a', 'b']) {
  const label = id.toUpperCase();
  const article = document.createElement('article');
  article.className = 'bot';
  article.dataset.bot = id;
  article.innerHTML = `<header class="bot-head"><span class="avatar">${label}</span><div><h2>Bot ${label}</h2><div class="phase">等待连接</div></div><div class="right"><button class="worker" disabled>开始任务</button><button class="control" disabled>接管画面</button></div></header><div class="native-apps" hidden><button data-app="terminal">终端</button><button data-app="files">文件管理器</button><button data-app="editor">编辑器</button><button data-app="browser">共享浏览器</button></div><div class="viewport" tabindex="0" role="group" aria-label="Bot ${label} 的操作画面，接管后可点击和键入"><img alt="Bot ${label} 的操作画面" draggable="false"><span class="viewport-label">只读观看</span></div><div class="bot-foot"><div class="numbers"><span><span class="count-label">页面计数</span> <strong class="count">0</strong></span><span class="identity">读取会话中</span></div><form class="typing"><input aria-label="发送到 Bot ${label} 的文字" placeholder="先接管并点击画面里的输入位置" maxlength="2000" disabled><button disabled>粘贴文字</button></form><p class="hint">接管后可点击画面并输入文字。</p></div>`;
  screenRoot.append(article);
  const modelResult = document.createElement('p');
  modelResult.className = 'model-result';
  modelResult.setAttribute('role', 'status');
  q<HTMLElement>('.bot-foot', article).append(modelResult);
  const viewport = q<HTMLElement>('.viewport', article);
  q<HTMLButtonElement>('.control', article).addEventListener('click', () =>
    perform(id, async () => {
      await inputTails.get(id);
      const lease = state.bots[id];
      await api(`/api/bots/${id}/control`, {
        epoch: lease.epoch,
        owner: lease.owner === 'human' ? 'agent' : 'human',
        ...(state.mode === 'desktop' ? { instance: lease.instance } : {}),
      });
      message(
        lease.owner === 'human'
          ? `已交还 Bot ${label}，任务可以继续。`
          : `已接管 Bot ${label}。可直接点击画面操作，另一位 Bot 不受影响。`,
      );
    }),
  );
  q<HTMLButtonElement>('.worker', article).addEventListener('click', () =>
    perform(id, async () => {
      const model = state.model?.available;
      await api(`/api/bots/${id}/${model ? 'model' : 'worker'}`, {
        running: !(model ? state.model!.bots[id].running : state.bots[id].running),
        ...(!model && state.mode === 'desktop' ? { instance: state.bots[id].instance } : {}),
      });
    }),
  );
  article.querySelectorAll<HTMLButtonElement>('[data-app]').forEach((button) => {
    button.addEventListener('click', () =>
      perform(id, () =>
        api(`/api/bots/${id}/app`, {
          epoch: state.bots[id].epoch,
          app: button.dataset.app,
          instance: state.bots[id].instance,
        }),
      ),
    );
  });
  const coordinates = (event: MouseEvent) => {
    const rect = viewport.getBoundingClientRect();
    const size = state.viewport;
    return {
      x: Math.min(
        size.width - 1,
        Math.max(0, ((event.clientX - rect.left) * size.width) / rect.width),
      ),
      y: Math.min(
        size.height - 1,
        Math.max(0, ((event.clientY - rect.top) * size.height) / rect.height),
      ),
    };
  };
  let drag: { pointerId: number; button: number; epoch: number; instance?: string } | undefined;
  let moved = 0;
  viewport.addEventListener('pointerdown', async (event) => {
    if (state?.mode !== 'desktop') return;
    if (state.bots[id].owner !== 'human') return message(`先接管 Bot ${label}，再操作桌面。`);
    if (!observed(id)) return message('请等待当前电脑的新画面后再操作。');
    // Preserve the coordinate system under the pointer when the surface gains focus.
    const point = coordinates(event);
    event.preventDefault();
    viewport.focus({ preventScroll: true });
    viewport.setPointerCapture(event.pointerId);
    drag = {
      pointerId: event.pointerId,
      button: event.button + 1,
      epoch: state.bots[id].epoch,
      instance: state.bots[id].instance,
    };
    await human(id, { type: 'pointer', phase: 'down', button: drag.button, ...point }, drag);
  });
  viewport.addEventListener('pointermove', async (event) => {
    if (!drag || Date.now() - moved < 45) return;
    moved = Date.now();
    await human(
      id,
      { type: 'pointer', phase: 'move', button: drag.button, ...coordinates(event) },
      drag,
    );
  });
  const release = async (event: PointerEvent) => {
    if (!drag) return;
    const completed = human(
      id,
      {
        type: 'pointer',
        phase: 'up',
        button: drag.button,
        ...coordinates(event),
      },
      drag,
    );
    if (viewport.hasPointerCapture(drag.pointerId)) viewport.releasePointerCapture(drag.pointerId);
    drag = undefined;
    await completed;
  };
  viewport.addEventListener('pointerup', release);
  viewport.addEventListener('pointercancel', release);
  viewport.addEventListener('contextmenu', (event) => {
    if (state?.mode === 'desktop') event.preventDefault();
  });
  viewport.addEventListener(
    'wheel',
    async (event) => {
      if (state?.mode === 'desktop' && state.bots[id].owner === 'human') {
        event.preventDefault();
        await human(id, { type: 'scroll', deltaY: event.deltaY });
      }
    },
    { passive: false },
  );
  viewport.addEventListener('click', async (event) => {
    if (state?.mode === 'desktop') return;
    if (state?.bots[id].owner !== 'human')
      return message(`先点击「接管画面」，才能操作 Bot ${label}。`);
    await human(id, { type: 'click', ...coordinates(event) });
    viewport.focus({ preventScroll: true });
  });
  viewport.addEventListener('keydown', async (event) => {
    if (state?.bots[id].owner !== 'human' || event.isComposing) return;
    const supported = [
      'Enter',
      'Tab',
      'Backspace',
      'Delete',
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'Escape',
      'Home',
      'End',
    ];
    if (
      state.mode === 'desktop' &&
      (event.ctrlKey || event.metaKey || event.altKey) &&
      /^[a-z0-9]$/i.test(event.key)
    ) {
      event.preventDefault();
      const modifiers = [
        ...(event.ctrlKey || event.metaKey ? ['ctrl'] : []),
        ...(event.altKey ? ['alt'] : []),
        ...(event.shiftKey ? ['shift'] : []),
      ];
      await human(id, { type: 'key', key: [...modifiers, event.key.toLowerCase()].join('+') });
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      await human(id, { type: 'key', key: 'ControlOrMeta+A' });
    } else if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1) {
      event.preventDefault();
      await human(id, { type: 'text', text: event.key });
    } else if (supported.includes(event.key)) {
      event.preventDefault();
      await human(id, { type: 'key', key: event.key });
    }
  });
  q<HTMLFormElement>('.typing', article).addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = q<HTMLInputElement>('input', event.currentTarget as HTMLFormElement);
    const value = input.value;
    if (!value) return;
    const ok = await human(id, { type: 'text', text: value });
    if (ok && input.value === value) input.value = '';
  });
}

function message(text: string, error = false) {
  notice.textContent = text;
  notice.classList.toggle('error', error);
}
async function api(url: string, data?: Record<string, unknown>) {
  const response = await fetch(url, {
    method: data ? 'POST' : 'GET',
    headers: {
      'x-prototype-token': token,
      ...(data ? { 'content-type': 'application/json' } : {}),
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  if (!response.ok) {
    const { error } = await response.json();
    throw new Error(
      error === 'STALE_CONTROL'
        ? '控制权已变化，旧操作已拒绝。请确认页面状态后重试。'
        : `操作失败（${error}），请重试。`,
    );
  }
  return response;
}
async function perform(id: string, action: () => Promise<unknown>) {
  if (pending.has(id)) return;
  pending.add(id);
  render();
  try {
    await action();
  } catch (error) {
    message(errorText(error), true);
  } finally {
    pending.delete(id);
    await refresh();
  }
}
function observed(id: string) {
  const lease = state.bots[id],
    frame = images.get(id);
  return (
    state.mode !== 'desktop' ||
    !!(frame && lease.instance && frame.instance === lease.instance && frame.epoch === lease.epoch)
  );
}
function human(
  id: string,
  input: Record<string, unknown>,
  binding?: { epoch: number; instance?: string },
) {
  const lease = state?.bots[id];
  if (
    lease?.owner !== 'human' ||
    pending.has(id) ||
    !observed(id) ||
    (binding && (binding.epoch !== lease.epoch || binding.instance !== lease.instance))
  ) {
    message('当前画面尚未接管或正在交接。', true);
    return Promise.resolve(false);
  }
  const epoch = binding?.epoch ?? lease.epoch;
  const instance =
    state.mode === 'desktop' ? (binding ? binding.instance : images.get(id)?.instance) : undefined;
  // Capture the lease before queueing: late packets must never inherit a newer takeover.
  const action = (inputTails.get(id) || Promise.resolve()).then(async () => {
    try {
      await api(`/api/bots/${id}/input`, {
        epoch,
        input,
        ...(instance === undefined ? {} : { instance }),
      });
      await frame(id);
      return true;
    } catch (error) {
      message(errorText(error), true);
      await refresh();
      return false;
    }
  });
  inputTails.set(id, action);
  return action;
}
function render() {
  if (!state) return;
  const agentOnly = state.mode === 'agent';
  screenRoot.hidden = agentOnly;
  for (const selector of ['.guide', '.toolbar', '.events']) q(selector).hidden = agentOnly;
  if (agentOnly) {
    document.title = 'Daban 执行环境';
    q('h1').textContent = '普通 Agent 已就绪';
    q('.title p').textContent = '电脑暂不可用，普通任务服务仍在运行。';
    q('.scope').textContent =
      '通过 Daban 客户端继续对话和处理工作区文件。电脑操作暂不可用；关闭此页不会停止任务。';
    message('桌面启动失败。已有文件和对话服务保留，请在电脑恢复后继续图形任务。');
    return;
  }
  const desktop = state.mode === 'desktop';
  if (renderedMode !== desktop) {
    renderedMode = desktop;
    q<HTMLElement>('h1').textContent = desktop ? '两个 Bot，两张 Linux 桌面' : '两个 Bot，一个登录';
    document.title = desktop ? '双 Bot Linux 桌面原型' : '双 Bot 浏览器原型';
    q<HTMLElement>('.title p').textContent = desktop
      ? '独立 Linux 图形会话 · 终端、文件与应用 · 脚本驱动'
      : '真实 Chromium 页面 · 本地模拟网站 · 确定性脚本驱动';
    q<HTMLElement>('.guide strong').textContent = desktop
      ? '各自操作整个桌面，共享浏览器登录'
      : '登录会话共享，操作和接管各自独立';
    q<HTMLElement>('.guide span').textContent = desktop
      ? '接管后可打开终端、文件管理器、编辑器和共享浏览器。演示任务会在终端输入命令并创建合成文件。'
      : '先接管完成示例登录，再同时运行两个 Bot。';
    q<HTMLElement>('.scope').textContent = desktop
      ? '真实 Linux VM · 独立 X11 桌面 · 普通用户运行。Bot 由脚本驱动，尚未接入 DSH；共享网页登录仅验证本地模拟站点。关闭页面不会关闭虚拟机。'
      : '浏览器页面原型，脚本驱动。';
    message('可分别接管两位 Bot 的画面，或运行演示任务。');
  }
  for (const id of ['a', 'b']) {
    const bot = state.bots[id];
    if (desktop && !observed(id))
      q<HTMLImageElement>(`[data-bot="${id}"] img`).removeAttribute('src');
    const model = state.model?.available ? state.model.bots[id] : undefined;
    const el = q(`[data-bot="${id}"]`);
    const busy = pending.has(id) || bot.owner === 'handoff';
    const phases: Record<string, string> = {
      idle: 'DSH 待命',
      starting: '正在启动 DSH',
      running: '模型正在执行',
      paused: '等待交还桌面',
      completed: '模型任务已通过文件校验',
      failed: '模型任务失败',
      stopped: '模型任务已停止',
    };
    q<HTMLElement>('.phase', el).textContent =
      bot.owner === 'human'
        ? '用户控制中 · 模型操作已暂停'
        : bot.owner === 'handoff'
          ? '正在等待当前操作结束'
          : model
            ? phases[model.phase] || '模型状态更新中'
            : bot.running
              ? desktop
                ? '正在执行桌面任务'
                : '脚本正在点击当前页'
              : '脚本待命';
    const control = q<HTMLButtonElement>('.control', el);
    control.textContent = bot.owner === 'human' ? '交还 Bot' : desktop ? '接管桌面' : '接管画面';
    control.classList.toggle('human', bot.owner === 'human');
    control.disabled = busy;
    const worker = q<HTMLButtonElement>('.worker', el);
    worker.textContent = model
      ? model.running
        ? '停止模型'
        : '模型验收任务'
      : bot.running
        ? '停止任务'
        : '开始任务';
    worker.disabled = busy || (!desktop && !state.sharedLogin && !bot.running);
    q<HTMLElement>('.count-label', el).textContent = model
      ? '模型工具调用'
      : desktop
        ? '桌面步骤'
        : '页面计数';
    q<HTMLElement>('.count', el).textContent = String(
      model ? model.toolCount : desktop ? bot.desktop?.steps || 0 : bot.count,
    );
    q<HTMLElement>('.identity', el).textContent = bot.identity;
    q<HTMLElement>('.viewport', el).classList.toggle(
      'controlled',
      bot.owner === 'human' && observed(id),
    );
    q<HTMLElement>('.viewport-label', el).textContent = !observed(id)
      ? '等待新画面'
      : bot.owner === 'human'
        ? '用户控制中'
        : '只读观看';
    el.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
      '.typing input,.typing button',
    ).forEach((input) => {
      input.disabled = bot.owner !== 'human' || busy || !observed(id);
    });
    q<HTMLElement>('.native-apps', el).hidden = !desktop;
    el.querySelectorAll<HTMLButtonElement>('[data-app]').forEach((button) => {
      button.disabled = bot.owner !== 'human' || busy;
    });
    q<HTMLElement>('.viewport', el).style.aspectRatio =
      `${state.viewport.width}/${state.viewport.height}`;
    q<HTMLElement>('.hint', el).textContent = desktop
      ? '支持点击、右键、滚轮、拖动窗口和常用快捷键。中文可用上方粘贴框。双击桌面窗口标题栏可最大化。'
      : '接管后可点击和键入。';
    if (bot.error) message(`Bot ${id.toUpperCase()}：${bot.error}`, true);
    q<HTMLElement>('.model-result', el).textContent = model
      ? model.error ||
        model.result ||
        (id === 'a'
          ? '模型任务：读取订单 CSV、汇总并生成报告。'
          : '模型任务：读取库存 CSV、计算补货并生成报告。')
      : '';
  }
  const login = q<HTMLElement>('#shared-login');
  login.textContent = state.sharedLogin ? '共享会话：示例用户已登录' : '共享会话：尚未登录';
  login.classList.toggle('logged-in', state.sharedLogin);
  q<HTMLButtonElement>('#run-all').disabled = !desktop && !state.sharedLogin;
  q<HTMLButtonElement>('#run-all').textContent = state.model?.available
    ? '运行两个模型 Bot'
    : '运行两个 Bot';
  q<HTMLButtonElement>('#stop-all').disabled =
    !Object.values(state.bots).some((bot) => bot.running) &&
    !Object.values(state.model?.bots || {}).some((bot) => bot.running);
  if (state.model?.available) {
    q<HTMLElement>('.title p').textContent = 'DSH · deepseek-flash · 独立 Linux 桌面';
    q<HTMLElement>('.guide span').textContent =
      '模型将读取合成业务文件、操作终端与应用并生成报告。分别接管会暂停对应 Bot 的电脑操作。';
    q<HTMLElement>('.scope').textContent =
      '模型任务使用 DeepSeek API 额度。共享网页登录仅验证本地示例；真实 Linux 桌面以普通用户运行。关闭预览不会关闭虚拟机。';
  }
  const list = q<HTMLElement>('#events');
  list.replaceChildren(
    ...state.events
      .slice(-8)
      .reverse()
      .map((event) => {
        const li = document.createElement('li');
        const time = document.createElement('time');
        time.dateTime = event.at;
        time.textContent = new Date(event.at).toLocaleTimeString('zh-CN', {
          hour12: false,
          timeZone: 'Asia/Shanghai',
        });
        const bot = document.createElement('b');
        bot.textContent = event.bot === 'system' ? '系统' : `Bot ${event.bot.toUpperCase()}`;
        const text = document.createElement('span');
        text.textContent = event.message;
        li.append(time, bot, text);
        return li;
      }),
  );
}
async function frame(id: string) {
  if (state?.mode === 'agent') return;
  if (fetching.has(id) || (view !== 'both' && view !== id)) return;
  fetching.add(id);
  try {
    const lease = state?.bots[id];
    const instance = state?.mode === 'desktop' ? lease?.instance : undefined;
    const epoch = lease?.epoch;
    const suffix = instance ? `?${new URLSearchParams({ instance, epoch: String(epoch) })}` : '';
    const response = await api(`/api/bots/${id}/frame${suffix}`);
    const blob = await response.blob();
    if (instance && (state.bots[id]?.instance !== instance || state.bots[id]?.epoch !== epoch))
      return;
    const src = URL.createObjectURL(blob);
    const img = q<HTMLImageElement>(`[data-bot="${id}"] img`);
    const previous = images.get(id);
    img.src = src;
    images.set(id, { src, instance, epoch });
    if (previous) URL.revokeObjectURL(previous.src);
    render();
  } catch (error) {
    message(`画面读取失败：${errorText(error)}`, true);
  } finally {
    fetching.delete(id);
  }
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    state = await (await api('/api/state')).json();
    connection.textContent = `${state.environment.platform} · ${state.environment.arch} · ${state.mode === 'agent' ? 'Agent 已连接 · 电脑暂不可用' : state.mode === 'desktop' ? '桌面已连接' : '浏览器已连接'}`;
    connection.classList.add('ready');
    render();
  } catch (error) {
    connection.textContent = '连接中断，正在重试';
    connection.classList.remove('ready');
    message(errorText(error), true);
  } finally {
    refreshing = false;
  }
}
document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) => {
  button.addEventListener('click', async () => {
    view = button.dataset.view || 'both';
    screenRoot.classList.toggle('single', view !== 'both');
    document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((item) => {
      item.setAttribute('aria-pressed', String(item === button));
    });
    document.querySelectorAll<HTMLElement>('[data-bot]').forEach((item) => {
      item.hidden = view !== 'both' && item.dataset.bot !== view;
    });
    await Promise.all(['a', 'b'].map(frame));
  });
});
for (const [selector, running] of [
  ['#run-all', true],
  ['#stop-all', false],
] as const)
  q(selector).addEventListener('click', () =>
    perform('all', () =>
      Promise.all(
        ['a', 'b'].map((id) =>
          api(`/api/bots/${id}/${state.model?.available ? 'model' : 'worker'}`, {
            running,
            ...(!state.model?.available && state.mode === 'desktop'
              ? { instance: state.bots[id].instance }
              : {}),
          }),
        ),
      ),
    ),
  );
const modelDialog = q<HTMLDialogElement>('#model-dialog');
q<HTMLButtonElement>('#model-settings').addEventListener('click', async () => {
  q<HTMLInputElement>('#api-key').value = '';
  q<HTMLElement>('#model-config-error').textContent = '';
  modelDialog.showModal();
  try {
    const config = await (await api('/api/model/settings')).json();
    q<HTMLElement>('#model-config-status').textContent = config.configured
      ? '密钥已保存。连接有效性将在运行任务时验证。'
      : '尚未配置模型密钥。';
  } catch (error) {
    q<HTMLElement>('#model-config-error').textContent = errorText(error);
  }
});
q<HTMLButtonElement>('#model-close').addEventListener('click', () => {
  q<HTMLInputElement>('#api-key').value = '';
  modelDialog.close();
});
q<HTMLFormElement>('#model-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const field = q<HTMLInputElement>('#api-key');
  const button = q<HTMLButtonElement>('[type=submit]', event.currentTarget as HTMLFormElement);
  button.disabled = true;
  try {
    await api('/api/model/settings', { apiKey: field.value });
    field.value = '';
    q<HTMLElement>('#model-config-status').textContent =
      '密钥已保存。连接有效性将在运行任务时验证。';
    q<HTMLElement>('#model-config-error').textContent = '';
  } catch {
    q<HTMLElement>('#model-config-error').textContent = '保存失败。请检查密钥格式并重试。';
  } finally {
    field.value = '';
    button.disabled = false;
  }
});
await refresh();
await Promise.all(['a', 'b'].map(frame));
setInterval(async () => {
  if (!document.hidden) await refresh();
}, 600);
setInterval(async () => {
  if (!document.hidden) await Promise.all(['a', 'b'].map(frame));
}, 450);
