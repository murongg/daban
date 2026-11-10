import { useId } from 'react';
import type { Bot } from '../../app/state';
import type { AvatarExpression } from './appearance';

const faces: Record<Exclude<AvatarExpression, 'original'>, string> = {
  calm: 'M91 163v13 M165 163v13',
  smile: 'M91 160v10 M165 160v10 M110 181q18 23 36 0',
  wink: 'M91 159v17 M154 170h22 M114 186q14 14 28 0',
  surprised: 'M91 165h.1 M165 165h.1 M128 179a7 8 0 1 0 0 16a7 8 0 1 0 0-16',
  sleepy: 'M79 169q12 13 24 0 M153 169q12 13 24 0 M121 190h14',
  laugh: 'M79 168q12-14 24 0 M153 168q12-14 24 0 M109 181h38q-2 17-19 17t-19-17Z',
  love: 'M91 176q-26-14-13-22q7-4 13 3q6-7 13-3q13 8-13 22Z M165 176q-26-14-13-22q7-4 13 3q6-7 13-3q13 8-13 22Z M116 188q12 11 24 0',
  starry:
    'M91 151q2 12 14 14q-12 2-14 14q-2-12-14-14q12-2 14-14Z M165 151q2 12 14 14q-12 2-14 14q-2-12-14-14q12-2 14-14Z M114 185q14 15 28 0',
  puzzled: 'M91 157v17 M165 170h.1 M115 189l26-6',
  grumpy: 'M79 158l23 12 M177 158l-23 12 M115 190q13-13 26 0',
  cool: 'M77 156h31v11q0 9-9 9H86q-9 0-9-9Z M148 156h31v11q0 9-9 9h-13q-9 0-9-9Z M109 161h38 M118 189q11 8 22-2',
};

function AvatarFace({
  src,
  expression,
}: {
  src: string;
  expression: Exclude<AvatarExpression, 'original'>;
}) {
  const id = useId();
  return (
    <svg viewBox="0 0 256 256" aria-hidden="true" focusable="false">
      <defs>
        <filter id={`${id}-edge`}>
          <feGaussianBlur stdDeviation="2.5" />
        </filter>
        <mask id={id} maskUnits="userSpaceOnUse" x="58" y="139" width="140" height="70">
          <rect
            x="67"
            y="148"
            width="122"
            height="53"
            rx="8"
            fill="white"
            filter={`url(#${id}-edge)`}
          />
        </mask>
      </defs>
      <image href={src} width="256" height="256" />
      {/* Sample the empty screen above the baked-in face so the patch retains each PNG's shading. */}
      <g mask={`url(#${id})`}>
        <svg
          x="58"
          y="139"
          width="140"
          height="70"
          viewBox="68 126 120 24"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <image href={src} width="256" height="256" />
        </svg>
      </g>
      <path
        className="avatar-face"
        d={faces[expression]}
        fill="none"
        stroke="#fff2da"
        strokeWidth="9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Avatar({
  bot,
  size = '',
  human = false,
  working = false,
}: {
  bot: Pick<Bot, 'color' | 'expression' | 'members'>;
  size?: 'small' | 'large' | '';
  human?: boolean;
  working?: boolean;
}) {
  if (bot.members)
    return (
      <span className="avatar-group" aria-hidden="true">
        <Avatar bot={{ color: 'mint' }} />
        <Avatar bot={{ color: 'blue' }} />
        <Avatar bot={{ color: 'violet' }} />
      </span>
    );
  const src = `${import.meta.env.BASE_URL}avatars/${bot.color}.png`;
  return (
    <span className={`bot-avatar ${size}`} aria-hidden="true" data-working={working || undefined}>
      {bot.expression && bot.expression !== 'original' ? (
        <AvatarFace src={src} expression={bot.expression} />
      ) : (
        <img src={src} alt="" />
      )}
      {human && <span className="owner-dot" />}
    </span>
  );
}

export function Brand() {
  return (
    <img
      className="brand-mark"
      src={`${import.meta.env.BASE_URL}favicon.png`}
      alt=""
      aria-hidden="true"
    />
  );
}
