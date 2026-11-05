import type { DesktopApi } from '../../../../packages/domain/src';

declare global {
  interface Window { jinggong: DesktopApi }
}

export {};
