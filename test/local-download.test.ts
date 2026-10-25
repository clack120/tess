import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { isLocalDownload } from '../packages/extension/src/page/local-download.ts';

test('the native local-save action is identified by its action ID, across translated labels', t => {
  const dom = new JSDOM('<div id="common_srch"><div value="exportProjectData"><span>Save to my computer</span></div><div value="saveProject">저장하기</div></div><div value="exportProjectData">project text</div>');
  t.after(() => dom.window.close());
  const document = dom.window.document;
  assert.equal(isLocalDownload(document.querySelector('span')!), true);
  assert.equal(isLocalDownload(document.querySelector('[value="saveProject"]')!), false);
  assert.equal(isLocalDownload(document.body.lastElementChild!), false);
});
