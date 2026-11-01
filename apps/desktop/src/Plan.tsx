import type { TaskPlan } from '@daban/protocol';
import { Check, Circle, LoaderCircle } from 'lucide-react';
import { t, useLocale } from './locale';

export function Plan({ items, active = false }: { items: TaskPlan; active?: boolean }) {
  useLocale();
  if (!items.length) return null;
  return (
    <details className="task-plan" open>
      <summary>
        {t('plan.taskPlan')}
        {items.filter((item) => item.status === 'completed').length}/{items.length}
      </summary>
      <ol>
        {items.map((item) => (
          <li key={item.content}>
            {item.status === 'completed' ? (
              <Check />
            ) : item.status === 'in_progress' ? (
              // Saved plans can outlive a run; motion must follow live work rather than the saved step status.
              <LoaderCircle className={active ? 'plan-spinner' : undefined} />
            ) : (
              <Circle />
            )}
            <span>{item.content}</span>
            <span className="inline-note">
              {item.status === 'completed'
                ? t('common.completed')
                : item.status === 'in_progress'
                  ? t('common.progress')
                  : t('common.do')}
            </span>
          </li>
        ))}
      </ol>
    </details>
  );
}
