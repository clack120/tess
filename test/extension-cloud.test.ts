import test from 'node:test';
import assert from 'node:assert/strict';
import { stub } from './stub.ts';
import { CloudClient } from '../packages/extension/src/page/cloud.ts';

function client(t: any, initial: Array<{ data: string | number; key: string }> | null) {
  stub(t, globalThis, 'WebSocket', { OPEN: 1 });
  const actions: any[] = [];
  const ids = new Map([['list', 'list']]);
  const cloud = new CloudClient('work', '', initial ? [{ id: 'list', variableType: 'list', array: initial }] : [], ids, ids, new Map([['list', 'mongo']]));
  Object.assign(cloud, { ws: { readyState: 1, send(packet: string) {
    actions.push(JSON.parse(packet.slice(packet.indexOf('[')))[1]);
  } } });
  return { cloud, actions };
}

test('cloud list writes retain local values before a list arrives from the server', t => {
  stub(t, console, 'log', () => {});
  const { cloud, actions } = client(t, null);
  cloud.write('list', [{ data: 'a' }, { data: 'b' }]);
  assert.deepEqual((cloud.read('list') as any[]).map(item => item.data), ['a', 'b']);
  cloud.write('list', [{ data: 'a' }, { data: 'b' }]);
  assert.equal(actions.length, 2, 'a repeated write sends no duplicate inserts');
});

test('cloud list edits replay in order and preserve the keys of retained items', t => {
  stub(t, console, 'log', () => {});
  const initial = ['head', 'a', 'b', 'c', 'tail'].map((data, i) => ({ data, key: `key${i}` }));
  const server = structuredClone(initial);
  const { cloud, actions } = client(t, initial);
  for (const data of [
    ['head', 'x', 'tail'],
    ['head', 'y', 'z', 'w', 'tail'],
    ['first', 'head', 'y', 'z', 'w', 'tail'],
    ['first', 'head', 'y', 'z', 'w', 'tail'],
    [],
    ['new'],
  ]) {
    cloud.write('list', data.map(data => ({ data })));
    for (const action of actions.splice(0)) {
      if (action.type === 'replace') {
        assert.equal(server[action.index]!.key, action.key);
        server[action.index]!.data = action.data;
      } else if (action.type === 'delete') {
        assert.equal(server[action.index]!.key, action.key);
        server.splice(action.index, 1);
      } else {
        server.splice(action.index, 0, { data: action.data, key: action.key });
      }
    }
    assert.deepEqual(server.map(item => item.data), data);
    assert.deepEqual(cloud.read('list'), server);
  }
});
