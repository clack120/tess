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

interface TessLogItem {
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
    tessSourceMap?: Record<string, any>;

    // Use the supplied runtime adapter, or fall back to window.Entry.
    tessRuntime?: any;

    // Replay errors that arrived before the panel registered its callback.
    tessDebugSink(receive: (item: TessLogItem) => void): void;
    tessReportError(kind: string, error: unknown): void;

    tessPatchEnvironmentBlocks(): void;
    tessRenderProjectDebug(project: any): void;
    tessWatchStagePicks(): void;
    tessLayoutCanvas(): void;
    tessHighlightBlock(blockId: string): void;
    tessSelectObjectById(id: string): void;
    tessBlockDataById: Map<string, any>;
    tessCollectParamIds(node: any, out?: string[]): string[];
    // Return null for unrelated errors; otherwise add the list name and length.
    tessDescribeListIndexError(reportedBlockId: string, error: any): string | null;
  }
}

export {};
