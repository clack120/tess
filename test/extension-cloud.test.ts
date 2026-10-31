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

test('works without shared variables do not request or wait for a cloud connection', async t => {
  let requests = 0;
  stub(t, globalThis, 'fetch', () => {
    requests++;
    return Promise.resolve(new Response('{}'));
  });
  const cloud = new CloudClient('work', '', [{ id: 'local', value: 0 }], new Map(), new Map(), new Map());
  await cloud.connect();
  cloud.dispose();
  assert.equal(requests, 0);
});

test('cloud list writes retain local values before a list arrives from the server', t => {
  stub(t, console, 'log', () => {});
  const { cloud, actions } = client(t, null);
  cloud.write('list', [{ data: 'a' }, { data: 'b' }]);
  assert.deepEqual((cloud.read('list') as any[]).map(item => item.data), ['a', 'b']);
  cloud.write('list', [{ data: 'a' }, { data: 'b' }]);
  assert.equal(actions.length, 2, 'a repeated write sends no duplicate inserts');
});

test('scalar writes send the Entry value field even before a database ID is known', t => {
  const { cloud, actions } = client(t, null);
  (cloud as any).variableMongoIds.clear();
  cloud.write('list', false);
  assert.deepEqual(actions, [{ id: 'list', variableType: 'variable', type: 'set', value: false, data: false }]);
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
        server[action.index]!.key = action.newKey;
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

test('Entry cloud checks, reset and keyed updates follow the server messages', async t => {
  class Socket {
    static OPEN = 1;
    readyState = 1;
    sent: string[] = [];
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(_url: string) {}
    send(data: string) { this.sent.push(data); }
    close() { this.readyState = 3; }
  }
  stub(t, globalThis, 'WebSocket', Socket);
  stub(t, globalThis, 'window', { setInterval });
  stub(t, globalThis, 'fetch', async () => new Response(JSON.stringify({ data: { cloudServerInfo: { url: 'https://example.test', query: 'token' } } })));
  const cloud = new CloudClient('work', '', [], new Map([['local', 'entry']]), new Map([['entry', 'local']]), new Map());
  await cloud.connect();
  const socket = (cloud as any).ws as Socket;
  const message = (event: string, data: unknown) => socket.onmessage!({ data: '42' + JSON.stringify([event, data]) });
  message('check', 'token');
  assert.equal(socket.sent.at(-1), '42["imAlive","token"]');
  socket.onmessage!({ data: '2' });
  assert.equal(socket.sent.at(-1), '3');
  message('welcome', { variables: [{ id: 'entry', _id: 'mongo', variableType: 'list', list: ['a', 'b'], value: { a: 'one', b: 'two' } }] });
  assert.deepEqual(cloud.read('local'), [{ key: 'a', data: 'one' }, { key: 'b', data: 'two' }]);
  message('action', { _id: 'mongo', variableType: 'list', type: 'replace', index: 0, key: 'b', data: 'changed' });
  assert.deepEqual(cloud.read('local'), [{ key: 'a', data: 'one' }, { key: 'b', data: 'changed' }]);
  message('action', { id: 'entry', variableType: 'list', type: 'delete', index: 0, key: 'missing' });
  assert.equal((cloud.read('local') as any[]).length, 2);
  message('reset', [{ id: 'entry', variableType: 'slide', value: 0 }]);
  assert.equal(cloud.read('local'), 0);
  message('changeMode', 'offline');
  assert.equal(socket.readyState, 3);
});
