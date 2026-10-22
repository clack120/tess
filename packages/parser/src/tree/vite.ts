import runtime from 'web-tree-sitter/web-tree-sitter.wasm?url';
import language from '../../tree-sitter/tree-sitter-tess.wasm?url';
import { initTreeSitter } from './index.ts';

export function initTreeSitterForVite(): Promise<boolean> {
  return initTreeSitter({ runtime, language });
}
