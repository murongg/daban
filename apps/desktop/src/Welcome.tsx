import { Brand } from './Avatar';

export function Welcome({ create, explore }: { create: () => unknown; explore: () => unknown }) {
  return (
    <section className="welcome" aria-label="空工作区">
      <Brand />
      <h2>从第一位搭档开始</h2>
      <p>创建自己的 Bot，或从广场挑选一个预设。</p>
      <div className="welcome-actions">
        <button type="button" className="primary" onClick={explore}>
          逛逛 Bot 广场
        </button>
        <button type="button" className="secondary" onClick={create}>
          自定义 Bot
        </button>
      </div>
    </section>
  );
}
