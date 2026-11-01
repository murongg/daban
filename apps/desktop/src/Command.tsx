import type { Interaction } from '@daban/protocol';
import { t, useLocale } from './locale';
export function Command({ request }: { request: Extract<Interaction, { tool: 'vm_command' }> }) {
  useLocale();
  return (
    <>
      <p className="approval-description">
        {t(
          '只在 Linux 执行虚拟机中运行，可以使用 sudo；不会在宿主机执行，也不会授予宿主机文件访问权限。',
        )}
      </p>
      <p className="request-value">{request.purpose}</p>
      <p className="field-help">{t('执行目录')}</p>
      <p className="request-value">{request.cwd}</p>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: Long reviewed commands require keyboard scrolling. */}
      <section className="request-arguments" aria-label={t('本次虚拟机命令')} tabIndex={0}>
        <pre className="request-value">{request.command}</pre>
      </section>
      <p className="field-help">
        {t('仅允许这一次完整命令；确认后请继续查看执行过程，确认权限不代表执行成功。')}
      </p>
    </>
  );
}
