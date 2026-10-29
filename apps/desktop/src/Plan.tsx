import type { TaskPlan } from '@daban/protocol';
import { Check, Circle, LoaderCircle } from 'lucide-react';

export function Plan({ items }: { items: TaskPlan }) {
  if (!items.length) return null;
  return (
    <details className="task-plan" open>
      <summary>
        任务计划 · {items.filter((item) => item.status === 'completed').length}/{items.length}
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
                ? '已完成'
                : item.status === 'in_progress'
                  ? '进行中'
                  : '待处理'}
            </span>
          </li>
        ))}
      </ol>
    </details>
  );
}
