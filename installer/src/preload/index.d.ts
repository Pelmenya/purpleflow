import type { InstallerBridge } from '../shared/types';

declare global {
  interface Window {
    installer: InstallerBridge;
  }
}
