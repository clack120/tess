import type { VariableStore } from '../../../tessvm/src/runtime/engine.ts';

interface OutgoingAction {
  tessId: string;
  variableType: string;
  actionData: any;
}

export class CloudClient implements VariableStore {
  private ws: WebSocket | null = null;
  private pingTimer: number = 0;
  private msgId: number = 0;
  private readonly projectId: string;
  private values = new Map<string, any>();
  private onRemoteChange?: () => void;
  private readonly csrfToken: string;
  private tessIdToEntryId: Map<string, string>;
  private entryIdToTessId: Map<string, string>;
  private variableMongoIds: Map<string, string>;
  private pendingActions = new Map<number, OutgoingAction>();
  private pendingOutbox: OutgoingAction[] = [];
  private isConnecting: boolean = false;
  private isConnected: boolean = false;

  constructor(
    projectId: string,
    csrfToken: string,
    initialVariables: any[],
    tessIdToEntryId: Map<string, string>,
    entryIdToTessId: Map<string, string>,
    variableMongoIds: Map<string, string>,
  ) {
    this.projectId = projectId;
    this.csrfToken = csrfToken;
    this.tessIdToEntryId = tessIdToEntryId;
    this.entryIdToTessId = entryIdToTessId;
    this.variableMongoIds = variableMongoIds;

    for (const v of initialVariables) {
      if (v.id) {
        const tessId =
          this.entryIdToTessId.get(String(v.id)) ||
          (v._id ? this.entryIdToTessId.get(String(v._id)) : undefined);
        if (tessId) {
          if (v._id && !this.variableMongoIds.has(tessId)) {
            this.variableMongoIds.set(tessId, String(v._id));
            this.entryIdToTessId.set(String(v._id), tessId);
          }
          if (v.variableType === 'list') {
            const list = (Array.isArray(v.array) ? v.array : []).map((item: any) => ({
              data:
                typeof item === 'object' && item !== null && 'data' in item ? item.data : item,
              key:
                typeof item === 'object' && item !== null && (item.key || item._key)
                  ? String(item.key || item._key)
                  : this.generateKey(),
            }));
            this.values.set(tessId, list);
          } else {
            this.values.set(tessId, v.value ?? 0);
          }
        }
      }
    }
  }

  setChangeListener(listener: () => void) {
    this.onRemoteChange = listener;
  }

  async connect(): Promise<void> {
    if (this.tessIdToEntryId.size === 0) {
      return;
    }
    if (this.isConnecting || this.isConnected) {
      return;
    }
    this.isConnecting = true;

    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          this.isConnecting = false;
          resolve();
        }
      };
      // Timeout fallback so boot doesn't hang indefinitely if network/server is slow
      const timeoutId = window.setTimeout(done, 3500);

      (async () => {
        try {
          console.log(`[Tess Cloud] Requesting cloud server info for project ${this.projectId}...`);
          const endpoint =
            (typeof location !== 'undefined' && location.origin ? location.origin : 'https://playentry.org') +
            '/graphql/GET_CLOUD_SERVER_INFO';

          const response = await fetch(endpoint, {
            method: 'POST',
            credentials: 'include',
            headers: {
              'content-type': 'application/json',
              'csrf-token': this.csrfToken,
            },
            body: JSON.stringify({
              query: `
                query GET_CLOUD_SERVER_INFO($id: ID!) {
                    cloudServerInfo(id: $id) {
                        url
                        query
                    }
                }
              `,
              variables: { id: this.projectId },
            }),
          });
          if (!response.ok) {
            console.warn(`[Tess Cloud] GET_CLOUD_SERVER_INFO response not ok: ${response.status}`);
            clearTimeout(timeoutId);
            done();
            return;
          }
          const data = await response.json();
          const info = data?.data?.cloudServerInfo;
          if (!info || !info.url || !info.query) {
            console.warn('[Tess Cloud] Invalid cloudServerInfo received:', data);
            clearTimeout(timeoutId);
            done();
            return;
          }

          let baseUrl = info.url;
          if (/^http:/i.test(baseUrl)) {
            baseUrl = baseUrl.replace(/^http:/i, 'ws:');
          } else if (/^https:/i.test(baseUrl)) {
            baseUrl = baseUrl.replace(/^https:/i, 'wss:');
          } else if (!/^wss?:/i.test(baseUrl)) {
            const proto =
              typeof location !== 'undefined' && location.protocol === 'https:' ? 'wss:' : 'ws:';
            baseUrl = `${proto}//${baseUrl.replace(/^\/\//, '')}`;
          }
          if (!baseUrl.includes('/cv')) {
            baseUrl = baseUrl.replace(/\/$/, '') + '/cv';
          }
          const wsUrl = `${baseUrl}/?type=undefined&q=${info.query}&EIO=3&transport=websocket`;

          console.log('[Tess Cloud] Connecting WebSocket to', wsUrl);
          this.ws = new WebSocket(wsUrl);

          this.ws.onopen = () => {
            console.log('[Tess Cloud] WebSocket opened');
          };

          this.ws.onmessage = (event) => {
            const msg = String(event.data);
            this.handleSocketMessage(msg, () => {
              clearTimeout(timeoutId);
              done();
            });
          };

          this.ws.onerror = (e) => {
            console.warn('[Tess Cloud] WebSocket error:', e);
            clearTimeout(timeoutId);
            done();
          };

          this.ws.onclose = (e) => {
            console.log('[Tess Cloud] WebSocket closed:', e.code, e.reason);
            this.cleanup();
            clearTimeout(timeoutId);
            done();
          };
        } catch (err) {
          console.warn('[Tess Cloud] Cloud connect error:', err);
          clearTimeout(timeoutId);
          done();
        }
      })();
    });
  }

  handleSocketMessage(msg: string, onReady?: () => void) {
    if (msg.startsWith('0')) {
      // Engine.IO open frame
      try {
        const packet = JSON.parse(msg.slice(1));
        if (packet.pingInterval) {
          if (this.pingTimer) {
            clearInterval(this.pingTimer);
          }
          this.pingTimer = window.setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
              this.sendRaw('2');
            }
          }, packet.pingInterval);
        }
      } catch {
        // ignore parse error
      }
    } else if (msg === '2') {
      // Heartbeat ping from server -> reply with pong
      this.sendRaw('3');
    } else if (msg === '3') {
      // Heartbeat pong from server
    } else if (msg.startsWith('4')) {
      // Socket.IO message
      const subType = msg.charAt(1);
      if (subType === '0') {
        // Connected to namespace
        console.log('[Tess Cloud] Socket.IO namespace connected');
        this.isConnected = true;
        this.flushPendingOutbox();
      } else if (subType === '2') {
        // Event packet: 42[id]["event", payload] or 42["event", payload]
        const bracketIdx = msg.indexOf('[');
        if (bracketIdx !== -1) {
          try {
            const arr = JSON.parse(msg.slice(bracketIdx));
            const eventName = arr[0];
            const eventPayload = arr[1];

            if (eventName === 'welcome' && eventPayload) {
              console.log('[Tess Cloud] Welcome packet received:', eventPayload);
              this.handleWelcome(eventPayload);
              this.isConnected = true;
              this.flushPendingOutbox();
              onReady?.();
              if (eventPayload.isOffline) {
                this.dispose();
              }
            } else if (eventName === 'action' && eventPayload) {
              console.log('[Tess Cloud] Action received:', eventPayload);
              this.handleAction(eventPayload);
            } else if (eventName === 'reset' && eventPayload) {
              console.log('[Tess Cloud] Reset received:', eventPayload);
              this.handleWelcome({ variables: eventPayload });
            } else if (eventName === 'check') {
              this.sendRaw('42' + JSON.stringify(['imAlive', eventPayload]));
            } else if (eventName === 'changeMode') {
              if (eventPayload === 'offline') {
                this.dispose();
              }
            }
          } catch {
            // ignore parse error
          }
        }
      } else if (subType === '3') {
        // ACK packet: 43<ackId>[isUpdate, confirmedOp]
        const bracketIdx = msg.indexOf('[');
        if (bracketIdx !== -1) {
          const ackId = Number(msg.slice(2, bracketIdx));
          try {
            const [isUpdate, operation] = JSON.parse(msg.slice(bracketIdx));
            this.handleAck(ackId, isUpdate, operation);
          } catch {
            // ignore parse error
          }
        }
      }
    }
  }

  private handleWelcome(payload: any) {
    let vars: any[] = [];
    if (Array.isArray(payload.variables)) {
      vars = payload.variables;
    } else if (payload.variables && typeof payload.variables === 'object') {
      const vObj = payload.variables;
      if (vObj.variable && typeof vObj.variable === 'object') {
        vars.push(...Object.values(vObj.variable));
      }
      if (vObj.slide && typeof vObj.slide === 'object') {
        vars.push(...Object.values(vObj.slide));
      }
      if (vObj.list && typeof vObj.list === 'object') {
        vars.push(...Object.values(vObj.list));
      }
    }
    for (const v of vars) {
      const entryId = String(v.id);
      const entryMongoId = v._id ? String(v._id) : undefined;
      const tessId =
        this.entryIdToTessId.get(entryId) ||
        (entryMongoId ? this.entryIdToTessId.get(entryMongoId) : undefined);
      if (!tessId) continue;

      if (entryMongoId && !this.variableMongoIds.has(tessId)) {
        this.variableMongoIds.set(tessId, entryMongoId);
        this.entryIdToTessId.set(entryMongoId, tessId);
      }

      if (v.variableType === 'list') {
        let list: Array<{ data: any; key: string }> = [];
        if (Array.isArray(v.array)) {
          list = v.array.map((item: any) => ({
            data:
              typeof item === 'object' && item !== null && 'data' in item ? item.data : item,
            key:
              typeof item === 'object' && item !== null && (item.key || item._key)
                ? String(item.key || item._key)
                : this.generateKey(),
          }));
        } else if (Array.isArray(v.list)) {
          if (v.value && typeof v.value === 'object' && !Array.isArray(v.value)) {
            list = v.list.map((key: any) => ({
              data: v.value[key] !== undefined ? v.value[key] : key,
              key: String(key),
            }));
          } else {
            list = v.list.map((item: any) => {
              if (typeof item === 'object' && item !== null && 'data' in item) {
                return {
                  data: item.data,
                  key: item.key ? String(item.key) : this.generateKey(),
                };
              }
              return { data: item, key: this.generateKey() };
            });
          }
        }
        this.values.set(tessId, list);
      } else {
        const val = v.value !== undefined ? v.value : v.data;
        this.values.set(tessId, val ?? 0);
      }
    }
    this.onRemoteChange?.();
  }

  private handleAction(action: any) {
    const entryId = String(action.id);
    const entryMongoId = action._id ? String(action._id) : undefined;
    const tessId =
      this.entryIdToTessId.get(entryId) ||
      (entryMongoId ? this.entryIdToTessId.get(entryMongoId) : undefined);
    if (!tessId) return;

    if (entryMongoId && !this.variableMongoIds.has(tessId)) {
      this.variableMongoIds.set(tessId, entryMongoId);
      this.entryIdToTessId.set(entryMongoId, tessId);
    }

    if (action.variableType === 'variable' || action.variableType === 'slide') {
      if (action.type === 'set') {
        const val = action.value !== undefined ? action.value : action.data;
        this.values.set(tessId, val);
        this.onRemoteChange?.();
      }
    } else if (action.variableType === 'list') {
      let arr = this.values.get(tessId) as Array<{ data: any; key: string }> | undefined;
      if (!Array.isArray(arr)) {
        arr = [];
        this.values.set(tessId, arr);
      }

      if (action.type === 'insert') {
        const idx = typeof action.index === 'number' ? action.index : arr.length;
        arr.splice(idx, 0, {
          data: action.data,
          key: action.key ? String(action.key) : this.generateKey(),
        });
        this.onRemoteChange?.();
      } else if (action.type === 'append') {
        arr.push({
          data: action.data,
          key: action.key ? String(action.key) : this.generateKey(),
        });
        this.onRemoteChange?.();
      } else if (action.type === 'delete') {
        let targetIdx = action.index;
        if (action.key) {
          const idxByKey = arr.findIndex((item) => item.key === action.key);
          if (idxByKey !== -1) targetIdx = idxByKey;
        }
        if (typeof targetIdx === 'number' && targetIdx >= 0 && targetIdx < arr.length) {
          arr.splice(targetIdx, 1);
          this.onRemoteChange?.();
        }
      } else if (action.type === 'replace') {
        let targetIdx = action.index;
        if (action.key) {
          const idxByKey = arr.findIndex((item) => item.key === action.key);
          if (idxByKey !== -1) targetIdx = idxByKey;
        }
        if (typeof targetIdx === 'number' && targetIdx >= 0 && targetIdx < arr.length) {
          arr[targetIdx].data = action.data;
          if (action.newKey) {
            arr[targetIdx].key = String(action.newKey);
          }
          this.onRemoteChange?.();
        }
      }
    }
  }

  private handleAck(ackId: number, isUpdate: boolean, confirmedOp: any) {
    const pending = this.pendingActions.get(ackId);
    if (!pending) return;
    this.pendingActions.delete(ackId);

    if (isUpdate && confirmedOp && confirmedOp.variableType === 'list') {
      const arr = this.values.get(pending.tessId);
      if (Array.isArray(arr) && confirmedOp.key) {
        if (typeof confirmedOp.index === 'number' && arr[confirmedOp.index]) {
          arr[confirmedOp.index].key = String(confirmedOp.key);
        } else {
          const found = arr.find(
            (item) => item.key === pending.actionData.key || item.data === confirmedOp.data,
          );
          if (found) {
            found.key = String(confirmedOp.key);
          }
        }
      }
    }
  }

  read(key: string): string | number | Array<{ data: string | number }> | undefined {
    return this.values.get(key);
  }

  write(key: string, value: string | number | Array<{ data: string | number }>): void {
    const isList = Array.isArray(value);

    if (!isList) {
      if (this.values.get(key) !== value) {
        this.values.set(key, value);
        this.sendAction(key, 'variable', { type: 'set', value, data: value });
      }
      return;
    }

    let oldArr = this.values.get(key) as Array<{ data: any; key: string }> | undefined;
    if (!oldArr) {
      oldArr = [];
      this.values.set(key, oldArr);
    }
    const newArr = value as Array<{ data: string | number }>;
    const diffs: any[] = [];

    let prefix = 0;
    while (
      prefix < oldArr.length &&
      prefix < newArr.length &&
      (oldArr[prefix]!.data === newArr[prefix]!.data ||
        String(oldArr[prefix]!.data) === String(newArr[prefix]!.data))
    ) {
      prefix++;
    }

    let suffix = 0;
    while (
      suffix < oldArr.length - prefix &&
      suffix < newArr.length - prefix &&
      (oldArr[oldArr.length - 1 - suffix]!.data === newArr[newArr.length - 1 - suffix]!.data ||
        String(oldArr[oldArr.length - 1 - suffix]!.data) ===
          String(newArr[newArr.length - 1 - suffix]!.data))
    ) {
      suffix++;
    }

    const deleteCount = oldArr.length - prefix - suffix;
    const insertCount = newArr.length - prefix - suffix;
    const replaceCount = Math.min(deleteCount, insertCount);

    for (let i = 0; i < replaceCount; i++) {
      const currentKey = oldArr[prefix + i]!.key;
      const newKey = this.generateKey();
      diffs.push({
        type: 'replace',
        index: prefix + i,
        key: currentKey,
        data: newArr[prefix + i]!.data,
        newKey,
      });
      oldArr[prefix + i]!.data = newArr[prefix + i]!.data;
      oldArr[prefix + i]!.key = newKey;
    }

    const remainingDelete = deleteCount - replaceCount;
    for (let i = 0; i < remainingDelete; i++) {
      const deletedKey = oldArr[prefix + replaceCount]!.key;
      diffs.push({
        type: 'delete',
        index: prefix + replaceCount,
        key: deletedKey,
      });
      oldArr.splice(prefix + replaceCount, 1);
    }

    const remainingInsert = insertCount - replaceCount;
    for (let i = 0; i < remainingInsert; i++) {
      const tempKey = this.generateKey();
      diffs.push({
        type: 'insert',
        index: prefix + replaceCount + i,
        data: newArr[prefix + replaceCount + i]!.data,
      });
      oldArr.splice(prefix + replaceCount + i, 0, {
        data: newArr[prefix + replaceCount + i]!.data,
        key: tempKey,
      });
    }

    for (const diff of diffs) {
      this.sendAction(key, 'list', diff);
    }
  }

  private sendAction(tessId: string, variableType: string, actionData: any) {
    const entryId = this.tessIdToEntryId.get(tessId);
    if (!entryId) return;

    const actionItem: OutgoingAction = { tessId, variableType, actionData };

    if (this.ws?.readyState === WebSocket.OPEN && this.isConnected) {
      this.dispatchAction(actionItem);
    } else {
      this.pendingOutbox.push(actionItem);
    }
  }

  private dispatchAction(item: OutgoingAction) {
    const entryId = this.tessIdToEntryId.get(item.tessId);
    if (!entryId) return;

    const currentId = this.msgId++;
    this.pendingActions.set(currentId, item);

    const _id = this.variableMongoIds.get(item.tessId);
    const actionPayload = {
      ...(_id ? { _id } : {}),
      id: entryId,
      variableType: item.variableType,
      ...item.actionData,
    };

    console.log('[Tess Cloud] Sending action:', actionPayload);
    const payload = '42' + currentId + JSON.stringify(['action', actionPayload]);
    this.sendRaw(payload);
  }

  private sendRaw(data: string) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  private flushPendingOutbox() {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    while (this.pendingOutbox.length > 0) {
      const item = this.pendingOutbox.shift();
      if (item) {
        this.dispatchAction(item);
      }
    }
  }

  private generateKey(): string {
    return (
      Math.random().toString(36).slice(2, 10) +
      Date.now().toString(36) +
      Math.random().toString(36).slice(2, 8)
    );
  }

  dispose(): void {
    this.cleanup();
  }

  private cleanup(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = 0;
    }
    if (this.ws) {
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      if (typeof this.ws.close === 'function') {
        this.ws.close();
      }
      this.ws = null;
    }
    this.isConnected = false;
    this.isConnecting = false;
    this.pendingActions.clear();
    this.pendingOutbox = [];
  }
}
