import { ChevronDown } from 'lucide-react';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { t, useLocale } from '../../i18n/locale';

export function SkillDescription({ name, description }: { name: string; description: string }) {
  useLocale();
  const id = useId(),
    paragraph = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false),
    [overflowing, setOverflowing] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: New text can overflow without changing the clamped element's observed size.
  useLayoutEffect(() => {
    const element = paragraph.current;
    if (!element) return;
    const measure = () => {
      // Expanded text fits its own height; measure only when clamped so the collapse control stays available.
      if (!expanded) setOverflowing(element.scrollHeight > element.clientHeight + 1);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [description, expanded]);

  return (
    <div className="skill-description">
      <p id={id} ref={paragraph} className="skill-description-text" data-expanded={expanded}>
        {description}
      </p>
      {(overflowing || expanded) && (
        <button
          type="button"
          className="text-button skill-description-toggle"
          aria-controls={id}
          aria-expanded={expanded}
          aria-label={t(expanded ? 'skills.collapseDescription' : 'skills.expandDescription', {
            0: name,
          })}
          onClick={() => setExpanded((value) => !value)}
        >
          {t(expanded ? 'common.collapse' : 'common.expand')}
          <ChevronDown aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
