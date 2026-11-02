import type { ModelConnection } from '@daban/protocol';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { expect, it, vi } from 'vitest';
import { Select } from '../../components/controls/Select';
import { selectControl } from '../../test/select.fixture.ts';
import { ModelInputs } from './ModelInputs';
import { modelChoices, modelIcon } from './model-options';

it('shows only declared inputs and honors the saved image override', () => {
  const { rerender } = render(
    <ModelInputs input={['text', 'image', 'audio', 'video', 'pdf']} vision />,
  );
  expect(screen.getByRole('img', { name: '输入：文本、图片、音频、视频、PDF' })).toBeVisible();
  rerender(<ModelInputs input={['text', 'image', 'pdf']} vision={false} />);
  expect(screen.getByRole('img', { name: '输入：文本、PDF' })).toBeVisible();
  rerender(<ModelInputs vision={false} />);
  expect(screen.getByRole('img', { name: '输入：文本' })).toBeVisible();
});

function Editor({ save }: { save: () => unknown }) {
  const [vision, setVision] = useState(false);
  return (
    <form onSubmit={save}>
      <ModelInputs
        input={['text', 'pdf']}
        vision={vision}
        onVisionChange={setVision}
        label="模型 1 支持图片"
      />
    </form>
  );
}
it('uses a keyboard accessible image icon toggle without submitting or changing other modalities', async () => {
  const save = vi.fn();
  render(<Editor save={save} />);
  const toggle = screen.getByRole('button', { name: '模型 1 支持图片' });
  expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await userEvent.click(toggle);
  expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await userEvent.keyboard(' ');
  expect(toggle).toHaveAttribute('aria-pressed', 'false');
  expect(save).not.toHaveBeenCalled();
});

it('keeps an unknown or unconfigured model neutral instead of claiming a supplier brand', () => {
  const { container } = render(modelIcon(undefined));
  expect(container.querySelector('[data-model-brand="custom"] .lucide-cpu')).toBeInTheDocument();
});

it('shows the model family mark and capabilities for a custom supplier in the selection and popup', async () => {
  const connections: ModelConnection[] = [
    {
      id: 'mock-relay',
      name: 'Synthetic relay',
      baseURL: 'https://models.example.test/v1',
      models: [
        {
          id: 'openai/gpt-synthetic',
          name: 'Synthetic GPT',
          vision: true,
          contextWindow: 128000,
          maxTokens: 8192,
          capabilities: { input: ['text', 'image', 'pdf'] },
        },
      ],
    },
  ];
  const value = 'provider:mock-relay:openai/gpt-synthetic';
  render(
    <Select
      label="Synthetic model"
      value={value}
      options={modelChoices(connections, value)}
      onValueChange={() => {}}
    />,
  );
  const trigger = selectControl('Synthetic model');
  expect(trigger.querySelector('[data-provider="openai"] img')).toBeInTheDocument();
  expect(within(trigger).getByRole('img', { name: '输入：文本、图片、PDF' })).toBeVisible();
  await userEvent.click(trigger);
  const list = screen.getByRole('listbox');
  expect(list.querySelector('[data-provider="openai"] img')).toBeInTheDocument();
  expect(within(list).getByRole('img', { name: '输入：文本、图片、PDF' })).toBeVisible();
});
