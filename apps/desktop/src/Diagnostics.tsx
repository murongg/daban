import {
  type DiagnosticCheck,
  type DiagnosticId,
  type DiagnosticReport,
  isDiagnosticReport,
} from '@daban/protocol';
import { useEffect, useRef, useState } from 'react';
import { runtimeError, useRuntime } from './Runtime';

const labels: Record<DiagnosticId, string> = {
  configuration: '本机配置',
  vm: 'Linux 虚拟机',
  tunnel: '客户端通道',
  service: 'Linux 服务',
  agent: 'Agent 接口',
  dsh: 'DSH SDK 文件',
  model: '模型配置',
  profiles: 'Bot 资料',
  knowledge: '资料库',
  attachments: '附件存储',
  interactions: '问题与审批',
  schedules: '定时任务',
  groups: '群聊',
  skills: '技能库',
  mcp: '外部工具配置',
  computers: '电脑记录',
  graphics: '桌面命令依赖',
};
const states = {
  ready: '就绪',
  degraded: '需要处理',
  unavailable: '未就绪',
  unconfigured: '未配置',
  unsupported: '暂不支持',
  unchecked: '未检查',
  timeout: '检查超时',
};
function detail(row: DiagnosticCheck) {
  if (row.state === 'timeout') return '这项检查仍未返回，稍后可重新检查。';
  if (row.state === 'degraded')
    return row.id === 'computers'
      ? `${row.affected} 位 Bot 的电脑需要处理，未确认回收的资源仍占用名额。`
      : `有 ${row.affected} 份记录暂不可用，原文件仍保留。`;
  if (row.state === 'unconfigured')
    return row.id === 'model'
      ? '请先在上方配置 DeepSeek 连接。'
      : '尚未配置本地运行环境，完成配置后可重新检查。';
  if (row.state !== 'unavailable') return '';
  if (row.id === 'vm') return '无法确认虚拟机已运行。可先重试连接，再重新检查。';
  if (row.id === 'tunnel') return '客户端通道暂不可用，可先重试连接。';
  if (row.id === 'service' || row.id === 'agent')
    return '本地服务暂未就绪，可先重试连接；检查不会强制重启电脑。';
  if (row.id === 'graphics')
    return '部分桌面命令依赖未找到，电脑连接需要补齐依赖；其他能力请查看对应检查项。';
  return '此项暂不可用，请保留现有数据，修复对应服务后重新检查。';
}
function Check({ row }: { row: DiagnosticCheck }) {
  const text = detail(row);
  return (
    <div className="setting-row diagnostic-row">
      <div>
        <div className="setting-label">{labels[row.id]}</div>
        {text && <p className="setting-description">{text}</p>}
      </div>
      <span
        className={`badge ${row.state === 'degraded' || row.state === 'unavailable' || row.state === 'timeout' ? 'diagnostic-attention' : ''}`}
      >
        {row.state === 'ready' && row.id === 'model'
          ? '已保存'
          : row.state === 'ready' && ['dsh', 'graphics'].includes(row.id)
            ? '已找到'
            : states[row.state]}
      </span>
    </div>
  );
}
export function Diagnostics() {
  const runtime = useRuntime();
  const [report, setReport] = useState<DiagnosticReport>();
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true),
    working = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function inspect() {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError('');
    try {
      const value = await runtime.command<DiagnosticReport>({ type: 'runtime.inspect' });
      if (!isDiagnosticReport(value) || value.scope !== 'host')
        throw new Error('INVALID_RUNTIME_STATE');
      if (mounted.current) setReport(value);
    } catch (error) {
      if (mounted.current) setError(runtimeError(error));
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const issues =
    report?.checks.filter((row) =>
      ['degraded', 'unavailable', 'unconfigured', 'timeout'].includes(row.state),
    ) ?? [];
  return (
    <div className="diagnostics">
      <div className="setting-row">
        <div>
          <div className="setting-label">运行环境检查</div>
          <p className="setting-description">
            读取虚拟机、连接和各项服务的状态，帮助定位使用问题。
          </p>
        </div>
        <button
          type="button"
          className="secondary"
          disabled={!runtime.enabled || busy}
          onClick={inspect}
        >
          {busy ? '正在检查…' : '检查运行环境'}
        </button>
      </div>
      {busy && (
        <p className="inline-note" role="status">
          正在核对本地状态，请稍候…
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {report && (
        <section aria-label="运行环境检查结果" className="diagnostic-report">
          <p className="setting-description" role="status">
            {issues.length ? '有项目需要处理' : '本次状态检查已完成'}
            <span className="diagnostic-time">
              上次检查{' '}
              <time dateTime={report.checkedAt}>
                {new Date(report.checkedAt).toLocaleTimeString('zh-CN', { hour12: false })}
              </time>
            </span>
          </p>
          {report.checks.some((row) => row.state === 'unsupported') && (
            <p className="inline-note">当前运行环境暂不支持部分检查，已核对的连接结果仍可查看。</p>
          )}
          {report.checks.some((row) => row.state === 'unchecked') && (
            <p className="inline-note">部分项目尚未取得检查结果，可处理已显示的问题后重新检查。</p>
          )}
          {(expanded ? report.checks : issues).length > 0 && (
            <section
              className={`diagnostic-checks ${expanded ? 'expanded' : ''}`}
              aria-label="检查条目"
              tabIndex={expanded ? 0 : undefined}
            >
              {(expanded ? report.checks : issues).map((row) => (
                <Check key={row.id} row={row} />
              ))}
            </section>
          )}
          <button
            type="button"
            className="text-button diagnostic-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? '收起检查项' : `查看全部检查项（${report.checks.length}）`}
          </button>
          <p className="inline-note">
            模型项仅核对已保存的配置；API
            连通性请使用上方“检查连接”。桌面项仅检查命令依赖，完整桌面需连接后验证。
          </p>
        </section>
      )}
    </div>
  );
}
