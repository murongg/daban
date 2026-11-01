import { useLocale } from './locale';
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
  useLocale();
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
      <img src={`${import.meta.env.BASE_URL}avatars/${bot.color}.png`} alt="" />
      {human && <span className="owner-dot" />}
    </span>
  );
}
export function Brand() {
  useLocale();
  return (
    <img
      className="brand-mark"
      src={`${import.meta.env.BASE_URL}favicon.png`}
      alt=""
      aria-hidden="true"
    />
  );
}
