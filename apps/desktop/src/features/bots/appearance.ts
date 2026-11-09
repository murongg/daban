export const avatarExpressions = [
  'original',
  'calm',
  'smile',
  'wink',
  'surprised',
  'sleepy',
  'laugh',
  'love',
  'starry',
  'puzzled',
  'grumpy',
  'cool',
] as const;

export type AvatarExpression = (typeof avatarExpressions)[number];
