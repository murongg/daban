import { validAgentId } from '@daban/protocol';

export interface Section {
  id: string;
  name: string;
  collapsed: boolean;
}
export interface AttentionEvent {
  key: string;
  bot?: string;
}
export interface Organization {
  pins: string[];
  sections: Section[];
  placements: Record<string, string>;
  attention: { initialized: boolean; seen: string[]; unread: string[] };
}
export type OrganizationAction =
  | { type: 'bot-pin'; bot: string; pinned: boolean }
  | { type: 'bot-section'; bot: string; section?: string }
  | { type: 'bot-read'; bot: string; unread: boolean }
  | { type: 'section-create' | 'section-rename'; id: string; name: string }
  | { type: 'section-remove'; id: string }
  | { type: 'section-collapse'; id: string; collapsed: boolean }
  | { type: 'section-move'; id: string; direction: -1 | 1 }
  | { type: 'attention'; events: AttentionEvent[]; visible?: string };

const sectionLimit = 32;
const seenLimit = 4096;
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const nameValid = (name: string) => name.trim().length > 0 && name.trim().length <= 40;
const eventValid = (key: unknown): key is string =>
  typeof key === 'string' && key.length > 0 && key.length <= 500;

export function organization(): Organization {
  return {
    pins: [],
    sections: [],
    placements: {},
    attention: { initialized: false, seen: [], unread: [] },
  };
}

export function restoreOrganization(value: unknown, bots: string[]): Organization {
  const empty = organization();
  if (!record(value)) return empty;
  const known = new Set(bots);
  const botList = (input: unknown) =>
    Array.isArray(input)
      ? [...new Set(input.filter((id): id is string => typeof id === 'string' && known.has(id)))]
      : [];
  const sections: Section[] = [];
  if (Array.isArray(value.sections))
    for (const section of value.sections) {
      if (sections.length >= sectionLimit) break;
      if (
        !record(section) ||
        !validAgentId(section.id) ||
        typeof section.name !== 'string' ||
        !nameValid(section.name) ||
        typeof section.collapsed !== 'boolean' ||
        sections.some((item) => item.id === section.id)
      )
        continue;
      sections.push({ id: section.id, name: section.name.trim(), collapsed: section.collapsed });
    }
  const sectionIds = new Set(sections.map((section) => section.id));
  const attention = record(value.attention) ? value.attention : {};
  return {
    pins: botList(value.pins),
    sections,
    placements: Object.fromEntries(
      Object.entries(record(value.placements) ? value.placements : {}).filter(
        ([id, section]) => known.has(id) && typeof section === 'string' && sectionIds.has(section),
      ),
    ) as Record<string, string>,
    attention: {
      initialized: attention.initialized === true && Array.isArray(attention.seen),
      seen: Array.isArray(attention.seen)
        ? [...new Set(attention.seen.filter(eventValid))].slice(-seenLimit)
        : [],
      unread: botList(attention.unread),
    },
  };
}

export function organize(
  current: Organization,
  action: OrganizationAction,
  bots: string[],
): Organization {
  const known = new Set(bots);
  if ('bot' in action && !known.has(action.bot)) return current;
  switch (action.type) {
    case 'bot-pin': {
      if (current.pins.includes(action.bot) === action.pinned) return current;
      return {
        ...current,
        pins: action.pinned
          ? [...current.pins, action.bot]
          : current.pins.filter((id) => id !== action.bot),
      };
    }
    case 'bot-section': {
      if (action.section && !current.sections.some((item) => item.id === action.section))
        return current;
      const previous = Object.hasOwn(current.placements, action.bot)
        ? current.placements[action.bot]
        : undefined;
      if (previous === action.section) return current;
      const placements = { ...current.placements };
      delete placements[action.bot];
      return {
        ...current,
        placements: action.section ? { ...placements, [action.bot]: action.section } : placements,
      };
    }
    case 'bot-read': {
      if (current.attention.unread.includes(action.bot) === action.unread) return current;
      return {
        ...current,
        attention: {
          ...current.attention,
          unread: action.unread
            ? [...current.attention.unread, action.bot]
            : current.attention.unread.filter((id) => id !== action.bot),
        },
      };
    }
    case 'section-create':
    case 'section-rename': {
      const name = action.name.trim();
      if (
        !validAgentId(action.id) ||
        !nameValid(name) ||
        current.sections.some((section) => section.id !== action.id && section.name === name)
      )
        return current;
      const exists = current.sections.some((section) => section.id === action.id);
      if (action.type === 'section-create')
        return exists || current.sections.length >= sectionLimit
          ? current
          : {
              ...current,
              sections: [...current.sections, { id: action.id, name, collapsed: false }],
            };
      return exists
        ? {
            ...current,
            sections: current.sections.map((section) =>
              section.id === action.id ? { ...section, name } : section,
            ),
          }
        : current;
    }
    case 'section-collapse':
      return current.sections.some(
        (item) => item.id === action.id && item.collapsed !== action.collapsed,
      )
        ? {
            ...current,
            sections: current.sections.map((item) =>
              item.id === action.id ? { ...item, collapsed: action.collapsed } : item,
            ),
          }
        : current;
    case 'section-move': {
      const index = current.sections.findIndex((section) => section.id === action.id);
      const target = index + action.direction;
      if (index < 0 || target < 0 || target >= current.sections.length) return current;
      const sections = [...current.sections];
      [sections[index], sections[target]] = [sections[target], sections[index]];
      return { ...current, sections };
    }
    case 'section-remove': {
      if (!current.sections.some((section) => section.id === action.id)) return current;
      return {
        ...current,
        sections: current.sections.filter((section) => section.id !== action.id),
        placements: Object.fromEntries(
          Object.entries(current.placements).filter(([, id]) => id !== action.id),
        ),
      };
    }
    case 'attention': {
      const seen = new Set(current.attention.seen);
      const incoming = action.events.filter((item) => eventValid(item.key) && !seen.has(item.key));
      if (current.attention.initialized && !incoming.length) return current;
      const advertised = new Set(
        action.events.filter((event) => eventValid(event.key)).map((event) => event.key),
      );
      const unread = new Set(current.attention.unread);
      for (const item of incoming) {
        seen.add(item.key);
        if (!current.attention.initialized || !item.bot || !known.has(item.bot)) continue;
        if (item.bot === action.visible) unread.delete(item.bot);
        else unread.add(item.bot);
      }
      // Baseline old history once; seen events cannot resurrect a manually read conversation.
      return {
        ...current,
        attention: {
          initialized: true,
          // Keep still-advertised group keys when newer private windows fill the bounded cache.
          seen: [...[...seen].filter((key) => !advertised.has(key)), ...advertised].slice(
            -seenLimit,
          ),
          unread: [...unread],
        },
      };
    }
  }
}
