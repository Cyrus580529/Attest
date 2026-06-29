import type { PageSnapshot } from '../types';
import { parseContract } from '../contract/parseContract';

export interface DomHostAdapterOptions {
  /** 解析根，默认 document.body */
  root?: ParentNode;
  /** url 提供器，默认 location.href */
  getUrl?: () => string;
}

export interface HostAdapter {
  snapshot(): PageSnapshot;
}

export function createDomHostAdapter(options: DomHostAdapterOptions = {}): HostAdapter {
  const getUrl = options.getUrl ?? (() => location.href);
  return {
    snapshot(): PageSnapshot {
      const root = options.root ?? document.body;
      return parseContract(root, getUrl());
    },
  };
}
