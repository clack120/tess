interface EntryRuntime {
  block?: Record<string, any>;
  container?: any;
  engine?: any;
  options?: any;
  scene?: any;
  stage?: any;
  variableContainer?: any;
  requestUpdate?: boolean;
  requestUpdateTwice?: boolean;
  [key: string]: any;
}

interface EntropyLogItem {
  kind: string;
  message: string;
  stack?: string;
  time: number;
}

declare global {
  // Entry may not be initialized yet, so callers must check this global.
  const Entry: EntryRuntime;

  const h: (type: any, props: any, ...children: any[]) => any;
  const render: (vnode: any, parent: Element) => void;

  interface Window {
    Entry?: EntryRuntime;
    EntryPaint?: any;
    EntrySoundEditor?: any;
    createjs?: any;

    // Set before the debug panel loads so early errors can retain block positions.
    entropySourceMap?: Record<string, any>;

    // Use the supplied runtime adapter, or fall back to window.Entry.
    entropyRuntime?: any;

    // Replay errors that arrived before the panel registered its callback.
    entropyDebugSink(receive: (item: EntropyLogItem) => void): void;
    entropyReportError(kind: string, error: unknown): void;

    entropyPatchEnvironmentBlocks(): void;
    entropyRenderProjectDebug(project: any): void;
    entropyWatchStagePicks(): void;
    entropyLayoutCanvas(): void;
    entropyHighlightBlock(blockId: string): void;
    entropySelectObjectById(id: string): void;
    entropyBlockDataById: Map<string, any>;
    entropyCollectParamIds(node: any, out?: string[]): string[];
    // Return null for unrelated errors; otherwise add the list name and length.
    entropyDescribeListIndexError(reportedBlockId: string, error: any): string | null;
  }
}

export {};
