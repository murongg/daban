import type { ModelCapabilities } from '@daban/protocol';
import { AudioLines, FileText, Image, ImagePlus, Type, Video } from 'lucide-react';
import { IconButton } from './Button';
import { t, useLocale } from './locale';
import { Tooltip } from './Tooltip';
import './model-icons.css';

const modes = ['text', 'image', 'audio', 'video', 'pdf'] as const;
const icons = { text: Type, image: Image, audio: AudioLines, video: Video, pdf: FileText };
export function ModelInputs({
  input,
  vision,
  onVisionChange,
  label,
  disabled = false,
}: {
  input?: ModelCapabilities['input'];
  vision?: boolean;
  onVisionChange?: (value: boolean) => unknown;
  label?: string;
  disabled?: boolean;
}) {
  useLocale();
  const supported = new Set(input ?? ['text']);
  // A saved/manual image choice governs actual observation even when the catalog says otherwise.
  if (vision !== undefined) {
    if (vision) supported.add('image');
    else supported.delete('image');
  }
  const visible = modes.filter(
    (mode) => supported.has(mode) || (mode === 'image' && onVisionChange),
  );
  const children = visible.map((mode) => {
    const Icon = icons[mode];
    if (mode === 'image' && onVisionChange)
      return (
        <IconButton
          key={mode}
          label={label ?? t('models.supportsImagesDesktopObservation')}
          title={t(vision ? 'models.disableImageInput' : 'models.enableImageInput')}
          className="model-input-toggle"
          aria-pressed={!!vision}
          disabled={disabled}
          onClick={() => onVisionChange(!vision)}
        >
          {vision ? (
            <Image size={16} aria-hidden="true" />
          ) : (
            <ImagePlus size={16} aria-hidden="true" />
          )}
        </IconButton>
      );
    const description = t('models.inputIcon', { 0: t(`models.modality.${mode}`) });
    return (
      <Tooltip
        key={mode}
        label={
          mode === 'audio' || mode === 'video' || mode === 'pdf'
            ? t('models.catalogInputIcon', { 0: t(`models.modality.${mode}`) })
            : description
        }
      >
        <span
          className="model-input-icon"
          role="img"
          aria-label={description}
          aria-hidden={onVisionChange ? undefined : true}
        >
          <Icon size={14} aria-hidden="true" />
        </span>
      </Tooltip>
    );
  });
  if (onVisionChange)
    return (
      <fieldset className="model-inputs model-inputs-editable" disabled={disabled}>
        <legend className="sr-only">{t('models.inputModalities')}</legend>
        {children}
      </fieldset>
    );
  return (
    <span
      className="model-inputs"
      role="img"
      aria-label={t('models.inputIcons', {
        0: visible.map((mode) => t(`models.modality.${mode}`)).join(t('models.inputSeparator')),
      })}
    >
      {children}
    </span>
  );
}
