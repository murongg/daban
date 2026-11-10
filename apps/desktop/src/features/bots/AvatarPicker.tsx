import type { Color } from '../../app/state';
import { Tooltip } from '../../components/controls/Tooltip';
import { type MessageKey, t, useLocale } from '../../i18n/locale';
import { Avatar } from './Avatar';
import { type AvatarExpression, avatarExpressions } from './appearance';

const palette = {
  mint: { label: 'create.mint', swatch: '#73a48d' },
  violet: { label: 'create.softViolet', swatch: '#9671dc' },
  orange: { label: 'create.warmOrange', swatch: '#d4a04b' },
  blue: { label: 'create.blue', swatch: '#6989d2' },
  teal: { label: 'create.teal', swatch: '#669da7' },
  pink: { label: 'create.pink', swatch: '#bc81a2' },
} satisfies Record<Color, { label: MessageKey; swatch: string }>;

const expressionNames: Record<AvatarExpression, MessageKey> = {
  original: 'avatar.original',
  calm: 'avatar.calm',
  smile: 'avatar.smile',
  wink: 'avatar.wink',
  surprised: 'avatar.surprised',
  sleepy: 'avatar.sleepy',
  laugh: 'avatar.laugh',
  love: 'avatar.love',
  starry: 'avatar.starry',
  puzzled: 'avatar.puzzled',
  grumpy: 'avatar.grumpy',
  cool: 'avatar.cool',
};

export function AvatarPicker({
  color,
  expression,
  disabled,
  onColorChange,
  onExpressionChange,
}: {
  color: Color;
  expression: AvatarExpression;
  disabled: boolean;
  onColorChange: (color: Color) => unknown;
  onExpressionChange: (expression: AvatarExpression) => unknown;
}) {
  useLocale();
  return (
    <div className="avatar-picker">
      <div
        className="avatar-preview"
        role="img"
        aria-label={t('avatar.preview', {
          0: t(palette[color].label),
          1: t(expressionNames[expression]),
        })}
      >
        <Avatar bot={{ color, expression }} size="large" />
      </div>
      <fieldset className="avatar-choices avatar-colors">
        <legend>{t('avatar.color')}</legend>
        {(Object.keys(palette) as Color[]).map((value) => {
          const { label, swatch } = palette[value];
          return (
            <Tooltip key={value} label={t(label)}>
              <button
                type="button"
                className="avatar-choice avatar-color"
                aria-label={t(label)}
                aria-pressed={color === value}
                disabled={disabled}
                onClick={() => onColorChange(value)}
              >
                <span className="avatar-swatch" style={{ backgroundColor: swatch }} />
              </button>
            </Tooltip>
          );
        })}
      </fieldset>
      <fieldset className="avatar-choices">
        <legend>{t('avatar.expression')}</legend>
        {avatarExpressions.map((value) => (
          <Tooltip key={value} label={t(expressionNames[value])}>
            <button
              type="button"
              className="avatar-choice"
              aria-label={t(expressionNames[value])}
              aria-pressed={expression === value}
              disabled={disabled}
              onClick={() => onExpressionChange(value)}
            >
              <Avatar bot={{ color, expression: value }} />
            </button>
          </Tooltip>
        ))}
      </fieldset>
    </div>
  );
}
