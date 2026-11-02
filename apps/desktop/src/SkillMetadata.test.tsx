import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { SkillMetadata } from './SkillMetadata';

it('shows factual author, license and runtime requirements from a standard skill', () => {
  render(
    <SkillMetadata
      content={
        '---\nname: mock-facts\ndescription: Synthetic facts\nlicense: MIT\ncompatibility: Python 3\nmetadata:\n  author: synthetic-author\n---\nSynthetic body.'
      }
      revision={3}
      updatedAt="2026-01-01T00:00:00Z"
    />,
  );
  expect(screen.getByText('synthetic-author')).toBeVisible();
  expect(screen.getByText('MIT')).toBeVisible();
  expect(screen.getByText('Python 3')).toBeVisible();
  expect(screen.getByText('3')).toBeVisible();
});
