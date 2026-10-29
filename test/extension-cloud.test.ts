/**
 * Real-time cloud variables and lists synchronization tests for CloudClient.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudClient } from '../packages/extension/src/page/cloud.ts';

function createClient(initialVars: any[] = []) {
  const tessIdToEntryId = new Map<string, string>([
    ['v_score', 'ent_score'],
    ['v_inventory', 'ent_inv'],
  ]);
  const entryIdToTessId = new Map<string, string>([
    ['ent_score', 'v_score'],
    ['ent_inv', 'v_inventory'],
    ['mongo_score', 'v_score'],
    ['mongo_inv', 'v_inventory'],
  ]);
  const variableMongoIds = new Map<string, string>([
    ['v_score', 'mongo_score'],
    ['v_inventory', 'mongo_inv'],
  ]);

  const client = new CloudClient(
    'dummy_project',
    'dummy_csrf',
    initialVars,
    tessIdToEntryId,
    entryIdToTessId,
    variableMongoIds,
  );
  return { client, tessIdToEntryId, entryIdToTessId, variableMongoIds };
}

test('CloudClient: initializes variables and lists correctly', () => {
  const initialVars = [
    { id: 'ent_score', _id: 'mongo_score', variableType: 'variable', value: 10 },
    {
      id: 'ent_inv',
      _id: 'mongo_inv',
      variableType: 'list',
      array: [{ data: 'Sword' }, { data: 'Shield' }],
    },
  ];
  const { client } = createClient(initialVars);

  assert.equal(client.read('v_score'), 10);
  const inv = client.read('v_inventory') as any[];
  assert.equal(inv.length, 2);
  assert.equal(inv[0].data, 'Sword');
  assert.equal(inv[1].data, 'Shield');
  assert.ok(inv[0].key, 'items should have generated keys');
  assert.ok(inv[1].key, 'items should have generated keys');
});

test('CloudClient: processes welcome payload with dictionary value map', () => {
  const { client } = createClient();
  let changed = false;
  client.setChangeListener(() => {
    changed = true;
  });

  // Entry sends list as array of keys and value as key -> data map
  client.handleSocketMessage(
    '42' +
      JSON.stringify([
        'welcome',
        {
          variables: [
            {
              id: 'ent_score',
              _id: 'mongo_score',
              variableType: 'variable',
              value: 100,
            },
            {
              id: 'ent_inv',
              _id: 'mongo_inv',
              variableType: 'list',
              list: ['k1', 'k2'],
              value: { k1: 'Potion', k2: 'Elixir' },
            },
          ],
        },
      ]),
  );

  assert.equal(changed, true);
  assert.equal(client.read('v_score'), 100);
  const inv = client.read('v_inventory') as any[];
  assert.equal(inv.length, 2);
  assert.equal(inv[0].data, 'Potion');
  assert.equal(inv[0].key, 'k1');
  assert.equal(inv[1].data, 'Elixir');
  assert.equal(inv[1].key, 'k2');
});

test('CloudClient: processes incoming action packets', () => {
  const { client } = createClient();
  client.handleSocketMessage(
    '42' +
      JSON.stringify([
        'welcome',
        {
          variables: [
            { id: 'ent_score', variableType: 'variable', value: 0 },
            { id: 'ent_inv', variableType: 'list', list: [], value: {} },
          ],
        },
      ]),
  );

  // Incoming variable set
  client.handleSocketMessage(
    '42' +
      JSON.stringify([
        'action',
        {
          id: 'ent_score',
          variableType: 'variable',
          type: 'set',
          value: 777,
        },
      ]),
  );
  assert.equal(client.read('v_score'), 777);

  // Incoming list insert
  client.handleSocketMessage(
    '42' +
      JSON.stringify([
        'action',
        {
          id: 'ent_inv',
          variableType: 'list',
          type: 'insert',
          index: 0,
          data: 'ItemA',
          key: 'key_a',
        },
      ]),
  );
  let inv = client.read('v_inventory') as any[];
  assert.equal(inv.length, 1);
  assert.equal(inv[0].data, 'ItemA');
  assert.equal(inv[0].key, 'key_a');

  // Incoming list append
  client.handleSocketMessage(
    '42' +
      JSON.stringify([
        'action',
        {
          id: 'ent_inv',
          variableType: 'list',
          type: 'append',
          data: 'ItemB',
          key: 'key_b',
        },
      ]),
  );
  inv = client.read('v_inventory') as any[];
  assert.equal(inv.length, 2);
  assert.equal(inv[1].data, 'ItemB');
  assert.equal(inv[1].key, 'key_b');

  // Incoming list replace
  client.handleSocketMessage(
    '42' +
      JSON.stringify([
        'action',
        {
          id: 'ent_inv',
          variableType: 'list',
          type: 'replace',
          key: 'key_b',
          data: 'ItemB_Updated',
          newKey: 'key_b_new',
        },
      ]),
  );
  inv = client.read('v_inventory') as any[];
  assert.equal(inv[1].data, 'ItemB_Updated');
  assert.equal(inv[1].key, 'key_b_new');

  // Incoming list delete
  client.handleSocketMessage(
    '42' +
      JSON.stringify([
        'action',
        {
          id: 'ent_inv',
          variableType: 'list',
          type: 'delete',
          key: 'key_a',
        },
      ]),
  );
  inv = client.read('v_inventory') as any[];
  assert.equal(inv.length, 1);
  assert.equal(inv[0].data, 'ItemB_Updated');
});

test('CloudClient: heartbeat and check/imAlive protocol', () => {
  const { client } = createClient();
  const sent: string[] = [];

  (client as any).ws = {
    readyState: 1, // OPEN
    send: (data: string) => sent.push(data),
    close: () => {},
  };

  // Engine.IO open frame (server initiates pingInterval)
  client.handleSocketMessage('0{"sid":"xyz","upgrades":[],"pingInterval":25000,"pingTimeout":20000}');
  // Server namespace connect frame
  client.handleSocketMessage('40');
  assert.equal((client as any).isConnected, true, 'Namespace 40 should mark client as connected');

  // Server ping frame '2'
  client.handleSocketMessage('2');
  assert.equal(sent[sent.length - 1], '3', 'Should reply with pong 3 on server ping');

  // Server application check frame
  client.handleSocketMessage('42["check","check_id_999"]');
  assert.equal(
    sent[sent.length - 1],
    '42' + JSON.stringify(['imAlive', 'check_id_999']),
    'Should reply with imAlive',
  );

  client.dispose();
});

test('CloudClient: write generates and sends correct diff actions', () => {
  const { client } = createClient();
  const sent: string[] = [];

  (client as any).ws = {
    readyState: 1, // OPEN
    send: (data: string) => sent.push(data),
    close: () => {},
  };
  (client as any).isConnected = true;

  // Set initial variable
  client.write('v_score', 50);
  assert.equal(sent.length, 1);
  assert.match(
    sent[0]!,
    /^420\["action",\{"_id":"mongo_score","id":"ent_score","variableType":"variable","type":"set","value":50,"data":50\}\]$/,
  );

  // Set initial list (inserting 2 items)
  client.write('v_inventory', [{ data: 'Hello' }, { data: 'World' }]);
  assert.equal(sent.length, 3);
  const action1 = JSON.parse(sent[1]!.replace(/^42\d+/, ''));
  const action2 = JSON.parse(sent[2]!.replace(/^42\d+/, ''));
  assert.deepEqual(action1, [
    'action',
    {
      _id: 'mongo_inv',
      id: 'ent_inv',
      variableType: 'list',
      type: 'insert',
      index: 0,
      data: 'Hello',
    },
  ]);
  assert.deepEqual(action2, [
    'action',
    {
      _id: 'mongo_inv',
      id: 'ent_inv',
      variableType: 'list',
      type: 'insert',
      index: 1,
      data: 'World',
    },
  ]);

  // Server sends ACK for action 1 with generated key
  client.handleSocketMessage(
    '431' +
      JSON.stringify([
        true,
        {
          _id: 'mongo_inv',
          id: 'ent_inv',
          variableType: 'list',
          type: 'insert',
          index: 0,
          data: 'Hello',
          key: 'server_key_0',
        },
      ]),
  );

  const inv = client.read('v_inventory') as any[];
  assert.equal(inv[0].key, 'server_key_0', 'Key should be updated from ACK');

  // Replace second item
  client.write('v_inventory', [{ data: 'Hello' }, { data: 'Entry' }]);
  assert.equal(sent.length, 4);
  const replaceAction = JSON.parse(sent[3]!.replace(/^42\d+/, ''));
  assert.equal(replaceAction[1].type, 'replace');
  assert.equal(replaceAction[1].index, 1);
  assert.equal(replaceAction[1].data, 'Entry');
  assert.ok(replaceAction[1].newKey, 'replace should have newKey');

  // Delete first item
  client.write('v_inventory', [{ data: 'Entry' }]);
  assert.equal(sent.length, 5);
  const deleteAction = JSON.parse(sent[4]!.replace(/^42\d+/, ''));
  assert.equal(deleteAction[1].type, 'delete');
  assert.equal(deleteAction[1].index, 0);
  assert.equal(deleteAction[1].key, 'server_key_0');

  client.dispose();
});

test('CloudClient: outbox buffering when disconnected', () => {
  const { client } = createClient();
  const sent: string[] = [];

  // Write while disconnected
  client.write('v_score', 123);
  assert.equal(sent.length, 0);

  // Now connect
  (client as any).ws = {
    readyState: 1, // OPEN
    send: (data: string) => sent.push(data),
    close: () => {},
  };

  // Socket.IO namespace connected frame 40
  client.handleSocketMessage('40');
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /"value":123/);

  client.dispose();
});

test('CloudClient: connect skips when no cloud variables exist', async () => {
  const emptyClient = new CloudClient(
    'dummy_project',
    'dummy_csrf',
    [],
    new Map(),
    new Map(),
    new Map(),
  );
  // Should resolve immediately without touching fetch or websockets
  await emptyClient.connect();
  emptyClient.dispose();
});
