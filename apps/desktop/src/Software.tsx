import type { Interaction } from '@daban/protocol';
import { useRuntime } from './Runtime';

type InstallRequest = Extract<Interaction, { tool: 'software_install' }>;
const statuses = {
  planned: '已确认，等待开始安装',
  installing: '正在安装，关闭客户端后仍会继续',
  installed: '已安装，所有 Bot 均可使用',
  failed: '安装未完成，请查看结果后再处理',
  unknown: '安装结果待核对，请勿重复安装',
};
export function Software({ request }: { request: InstallRequest }) {
  const { snapshot } = useRuntime();
  const receipt = snapshot.software?.items.find(
    (item) => item.plan.id === request.plan.id && item.plan.digest === request.plan.digest,
  );
  const approved =
    request.status === 'resolved' && request.reply?.kind === 'decision' && request.reply.allow;
  return (
    <>
      <p className="approval-description">
        安装到共享 Linux 后，所有 Bot 都能使用。仅确认以下软件和依赖，不会授予 Bot 管理员终端权限。
      </p>
      <p className="request-value">{request.purpose}</p>
      <p className="field-help">Debian 官方软件源</p>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: A long immutable package plan needs keyboard scrolling. */}
      <section className="request-arguments" aria-label="本次软件安装清单" tabIndex={0}>
        {request.plan.packages.map((item) => (
          <p className="request-value" key={item.name}>
            {item.name} · {item.version}
          </p>
        ))}
      </section>
      <p className="field-help">确认仅对本次计划有效；软件或依赖发生变化时需重新确认。</p>
      {approved && (
        <p role="status" className="inline-note">
          {receipt ? statuses[receipt.phase] : '正在核对安装结果，请勿重复安装'}
        </p>
      )}
      {approved && receipt?.error && (
        <p className="inline-note">
          {receipt.error === 'SOFTWARE_PLAN_EXPIRED'
            ? '安装计划已过期，请让 Bot 重新生成计划。'
            : receipt.error === 'SOFTWARE_PLAN_CHANGED'
              ? '依赖发生变化，请让 Bot 重新生成计划并确认。'
              : '可以让 Bot 查询软件安装结果；不要直接重复提交。'}
        </p>
      )}
    </>
  );
}
