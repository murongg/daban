import type { Bot, Color } from './state';

export const colors: Record<Color, string> = {
  mint: '#73a48d',
  violet: '#9671dc',
  orange: '#d4a04b',
  blue: '#6989d2',
  teal: '#669da7',
  pink: '#bc81a2',
};
export function Avatar({
  bot,
  size = '',
  human = false,
}: {
  bot: Pick<Bot, 'color' | 'members'>;
  size?: 'small' | 'large' | '';
  human?: boolean;
}) {
  if (bot.members)
    return (
      <span className="avatar-group" aria-hidden="true">
        <Avatar bot={{ color: 'mint' }} />
        <Avatar bot={{ color: 'blue' }} />
        <Avatar bot={{ color: 'violet' }} />
      </span>
    );
  return (
    <span className={`bot-avatar ${size}`} aria-hidden="true">
      <svg aria-hidden="true" viewBox="0 0 40 43" fill="none">
        <path
          d="M6 7C10 2 19 1 27 4c8 3 12 12 11 21-1 9-10 16-20 16C8 41 1 35 2 26 3 20 2 12 6 7Z"
          fill={colors[bot.color]}
        />
        <path d="m15 13 1.5 7M23 12l1.5 7" stroke="white" strokeWidth="3.3" strokeLinecap="round" />
      </svg>
      {human && <span className="owner-dot" />}
    </span>
  );
}
export function Brand() {
  return (
    <svg className="brand-mark" viewBox="0 0 40 40" fill="none" aria-hidden="true">
      <path
        d="M8 14v17h8c6 0 10-4 10-9s-4-9-10-9H8m8 0V5m0 17h12c4 0 6 2 6 5s-2 5-6 5H16"
        stroke="currentColor"
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
