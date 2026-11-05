import { type ButtonHTMLAttributes, cloneElement, type ReactElement, useId } from 'react';

const paths = {
  gallery: 'M3 10h18M4 10v10h16V10M3 10l2-6h14l2 6M8 20v-6h5v6',
  search: 'M20 20l-4-4M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
  plus: 'M12 5v14M5 12h14',
  key: 'M14 9a5 5 0 1 0-5 5l3-3h3v-3h3V5h3',
  user: 'M19 20v-2a5 5 0 0 0-5-5h-4a5 5 0 0 0-5 5v2M16 6a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  arrow: 'M5 12h14M14 7l5 5-5 5',
  back: 'M19 12H5M10 7l-5 5 5 5',
  close: 'M6 6l12 12M18 6 6 18',
  download: 'M12 3v12M7 10l5 5 5-5M4 16v5h16v-5',
  package: 'M3 7l9-4 9 4v10l-9 4-9-4V7M3 7l9 4 9-4M12 11v10M7 5l10 4',
  lock: 'M5 10h14v11H5V10M8 10V6a4 4 0 0 1 8 0v4',
  exit: 'M10 4H4v16h6M13 7l5 5-5 5M9 12h12',
  file: 'M5 3h9l5 5v13H5V3M14 3v6h5M8 13h8M8 17h6',
  chevron: 'M9 5l7 7-7 7',
} as const;

export function Icon({ name }: { name: keyof typeof paths }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={paths[name]} />
    </svg>
  );
}
const colors = ['mint', 'violet', 'orange', 'blue', 'teal', 'pink'];
export function Avatar({ seed, large = false }: { seed: string; large?: boolean }) {
  // Catalog summaries omit profile colors; keep identity stable by persistent template ID.
  let hash = 0;
  for (const character of seed) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return (
    <span className={`bot-avatar ${large ? 'large' : ''}`} aria-hidden="true">
      <img
        src={`/avatars/${colors[hash % colors.length]}.png`}
        alt=""
        width={88}
        height={96}
        loading="lazy"
      />
    </span>
  );
}
export function Button({
  className = '',
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} type={type} className={`button ${className}`} />;
}
export function Field({
  title,
  children,
}: {
  title: string;
  children: ReactElement<{ id?: string }>;
}) {
  const generated = useId();
  const id = children.props.id ?? generated;
  return (
    <label className="field-label" htmlFor={id}>
      {title}
      {cloneElement(children, { id })}
    </label>
  );
}
