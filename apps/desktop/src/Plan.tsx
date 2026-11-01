import type { TaskPlan } from '@daban/protocol';
import { Check, Circle, LoaderCircle } from 'lucide-react';
import { t, useLocale } from './locale';

export function Plan({ items }: { items: TaskPlan }) {
  useLocale();
  if (!items.length) return null;
  return (
    <details className="task-plan" open>
      <summary>
        {t('任务计划 ·')}
        {items.filter((item) => item.status === 'completed').length}/{items.length}
      </summary>
      <ol>
        {items.map((item) => (
          <li key={item.content}>
            {item.status === 'completed' ? (
              <Check />
            ) : item.status === 'in_progress' ? (
              <LoaderCircle />
            ) : (
              <Circle />
            )}
            <span>{item.content}</span>
            <span className="inline-note">
              {item.status === 'completed'
                ? t('已完成')
                : item.status === 'in_progress'
                  ? t('进行中')
                  : t('待处理')}
            </span>
          </li>
        ))}
      </ol>
    </details>
  );
}
