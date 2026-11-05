import { expect, it } from 'vitest';
import { cloudConfiguration } from './cloud.ts';

it('requires an explicit encrypted signaling target and an absolute private cloud profile', () => {
  expect(() =>
    cloudConfiguration({
      DABAN_CONNECT_SERVER: 'http://outside.example.test',
      DABAN_CLOUD_DATA: '/synthetic/data',
    }),
  ).toThrow();
  expect(() =>
    cloudConfiguration({
      DABAN_CONNECT_SERVER: 'https://connect.example.test',
      DABAN_CLOUD_DATA: 'relative',
    }),
  ).toThrow();
  expect(
    cloudConfiguration({
      DABAN_CONNECT_SERVER: 'https://connect.example.test',
      DABAN_CLOUD_DATA: '/synthetic/data',
    }),
  ).toEqual({ server: 'https://connect.example.test', directory: '/synthetic/data' });
});
