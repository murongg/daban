import { useEffect, useRef, useState } from 'react';
import { isNoticeStatus, type NoticeCommand, type NoticeStatus } from '../notifications';

export function noticeError(cause: unknown) {
  const code = cause instanceof Error ? cause.message : '';
  const messages: Record<string, string> = {
    NOTIFICATION_CONFIG_CHANGED: '通知设置文件已变化，未覆盖现有内容。请重新打开客户端后检查。',
    NOTIFICATION_STORE_UNAVAILABLE: '通知设置无法读取，已有内容保留。请重新打开客户端后检查。',
    NOTIFICATION_CONFLICT: '通知设置已在其他窗口更新，请重新读取后再选择。',
    NOTIFICATION_UNSUPPORTED: '当前系统暂不支持桌面提醒，收件箱仍可使用。',
    NOTIFICATION_DISABLED: '请先开启桌面提醒，再发送测试。',
    NOTIFICATION_DELIVERY_FAILED: '系统未接受提醒。请检查通知设置，或使用支持提醒的客户端版本。',
    NOTIFICATION_HISTORY_UNAVAILABLE: '系统提醒历史暂不可读取，新任务和收件箱仍可使用。',
    NOTIFICATION_LIMIT: '提醒记录已达到上限，请重新打开客户端后检查。',
    NOTIFICATION_OPEN_FAILED: '暂未打开对应提醒，请在收件箱或历史对话中查看。',
  };
  return messages[code] || '桌面提醒暂不可用，请稍后重试。';
}
export function Notifications() {
  const [bridge] = useState(() => window.daban?.notifications);
  const [status, setStatus] = useState<NoticeStatus>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [tested, setTested] = useState(false);
  const mounted = useRef(true),
    working = useRef(false);
  function accept(value: unknown) {
    if (!isNoticeStatus(value)) throw new Error('INVALID_NOTIFICATION_STATUS');
    if (mounted.current)
      setStatus((current) => (!current || value.revision >= current.revision ? value : current));
  }
  async function call(command: NoticeCommand) {
    if (!bridge) throw new Error('NOTIFICATION_UNSUPPORTED');
    const reply = await bridge.invoke(command);
    if (!reply.ok) throw new Error(reply.error);
    return reply.value;
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: This bridge belongs to the mounted desktop instance; polling never replaces the settings operation.
  useEffect(() => {
    mounted.current = true;
    if (!bridge)
      return () => {
        mounted.current = false;
      };
    const unsubscribe = bridge.subscribe((message) => {
      if (message.type === 'status') {
        try {
          accept(message.status);
        } catch (cause) {
          if (mounted.current) setError(noticeError(cause));
        }
      }
    });
    call({ type: 'status' })
      .then(accept)
      .catch((cause) => {
        if (mounted.current) setError(noticeError(cause));
      });
    return () => {
      mounted.current = false;
      unsubscribe();
    };
  }, [bridge]);
  async function perform(test = false) {
    if (working.current || !status || !bridge) return;
    working.current = true;
    setBusy(true);
    setError('');
    try {
      accept(
        await call(
          test
            ? { type: 'test' }
            : { type: 'configure', revision: status.revision, enabled: !status.enabled },
        ),
      );
      if (mounted.current && test) setTested(true);
    } catch (cause) {
      if (mounted.current) setError(noticeError(cause));
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const failure = error || (status?.error ? noticeError(new Error(status.error)) : '');
  return (
    <section className="settings-section" aria-label="桌面提醒">
      <h2>桌面提醒</h2>
      <div className="setting-row">
        <div>
          <div className="setting-label">接收桌面提醒</div>
          <p className="setting-description">
            在后台提醒任务完成、失败或等待你处理的请求。提醒只显示类型，不展示任务和问题正文。
          </p>
        </div>
        <label
          className="secondary skill-toggle"
          aria-disabled={busy || !status?.available || !status.supported}
        >
          <input
            type="checkbox"
            aria-label="接收桌面提醒"
            checked={!!status?.enabled}
            disabled={busy || !status?.available || !status.supported}
            onChange={() => perform()}
          />
          {busy ? '正在保存…' : status?.enabled ? '已开启' : '未开启'}
        </label>
      </div>
      {!bridge && (
        <p className="inline-note">请在桌面客户端中使用系统提醒，网页预览不会请求通知权限。</p>
      )}
      {bridge && !status && !failure && (
        <p className="inline-note" role="status">
          正在读取通知设置…
        </p>
      )}
      {status && !status.supported && (
        <p className="inline-note">当前系统暂不支持桌面提醒，收件箱仍可使用。</p>
      )}
      {status?.runtime === 'partial' && (
        <p className="inline-note">
          部分任务结果提醒暂不可用，请检查或更新本地运行环境。待处理事项仍可在收件箱查看。
        </p>
      )}
      {status?.runtime === 'offline' && (
        <p className="inline-note">运行环境尚未连接。系统提醒测试不需要运行 Bot 任务。</p>
      )}
      <div className="setting-row">
        <div>
          <div className="setting-label">检查系统提醒</div>
          <p className="setting-description">
            是否显示由系统通知设置和勿扰模式决定。测试不会启动任务或提交审批。
          </p>
        </div>
        <button
          type="button"
          className="secondary"
          disabled={busy || !status?.available || !status.supported || !status.enabled}
          onClick={() => perform(true)}
        >
          发送测试提醒
        </button>
      </div>
      {tested && status?.delivery === 'submitted' && !failure && (
        <p className="inline-note" role="status">
          测试提醒已提交给系统。若未收到，请检查系统通知设置，或使用支持提醒的客户端版本。
        </p>
      )}
      {failure && (
        <p className="form-error" role="alert">
          {failure}
        </p>
      )}
      <p className="setting-description">
        完整退出客户端后不会发现新的桌面提醒，Linux
        中的任务仍会继续。打开客户端可在收件箱和对话中查看结果。
      </p>
    </section>
  );
}
