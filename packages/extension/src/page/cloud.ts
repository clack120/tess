import type { VariableStore } from '../../../vm/src/runtime/engine.ts';
import type { VariableValue } from '../../../vm/src/runtime/model.ts';

export class CloudClient implements VariableStore {
  private ws: WebSocket | null = null;
  private pingTimer: number = 0;
  private msgId: number = 0;
  private readonly projectId: string;
  private values = new Map<string, any>();
  private onRemoteChange?: () => void;
  private readonly csrfToken: string;
  private entropyIdToEntryId: Map<string, string>;
  private entryIdToEntropyId: Map<string, string>;
  private variableMongoIds: Map<string, string>;
  private readonly controller = new AbortController();

  constructor(
    projectId: string,
    csrfToken: string,
    initialVariables: any[],
    entropyIdToEntryId: Map<string, string>,
    entryIdToEntropyId: Map<string, string>,
    variableMongoIds: Map<string, string>
  ) {
    this.projectId = projectId;
    this.csrfToken = csrfToken;
    this.entropyIdToEntryId = entropyIdToEntryId;
    this.entryIdToEntropyId = entryIdToEntropyId;
    this.variableMongoIds = variableMongoIds;

    for (const v of initialVariables) {
      if (v.id) {
        const entropyId = this.entryIdToEntropyId.get(String(v.id));
        if (entropyId) {
          if (v.variableType === 'list') {
            this.values.set(entropyId, Array.isArray(v.array) ? v.array : []);
          } else {
            this.values.set(entropyId, v.value ?? 0);
          }
        }
      }
    }
  }

  async connect() {
    if (!this.entropyIdToEntryId.size || this.controller.signal.aborted || this.ws) return;
    try {
      const response = await fetch("https://playentry.org/graphql/GET_CLOUD_SERVER_INFO", {
        method: "POST",
        credentials: "include",
        signal: this.controller.signal,
        headers: {
          "content-type": "application/json",
          "csrf-token": this.csrfToken
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
          variables: { id: this.projectId }
        })
      });
      const data = await response.json();
      if (this.controller.signal.aborted) return;
      const info = data?.data?.cloudServerInfo;
      if (!info || !info.url || !info.query) return;
      
      let baseUrl = info.url.replace(/^http/, 'ws');
      if (!baseUrl.includes('/cv')) {
        baseUrl = baseUrl.replace(/\/$/, '') + '/cv';
      }
      const wsUrl = baseUrl + `/?type=undefined&q=${info.query}&EIO=3&transport=websocket`;
      
      console.log("[CloudClient] Connecting to", wsUrl);
      this.ws = new WebSocket(wsUrl);

      this.ws.onmessage = (event) => {
        const msg = String(event.data);
        console.log("[CloudClient] Recv:", msg);
        if (msg.startsWith('0')) {
          const packet = JSON.parse(msg.slice(1));
          
          // Send 40 to open the Socket.IO namespace after the Engine.IO handshake.
          console.log("[CloudClient] Sending 40 to init Socket.IO");
          this.ws?.send('40');

          if (packet.pingInterval) {
            clearInterval(this.pingTimer);
            this.pingTimer = window.setInterval(() => {
              if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send('2');
              }
            }, packet.pingInterval);
          }
        } else if (msg === '3') {
        } else if (msg.startsWith('4')) {
          const type = msg.charAt(1);
          if (type === '2') {
            const bracketIdx = msg.indexOf('[');
            if (bracketIdx !== -1) {
              const idStr = msg.slice(2, bracketIdx);
              try {
                const arr = JSON.parse(msg.slice(bracketIdx));
                if (arr[0] === 'welcome' && arr[1]) {
                  this.handleWelcome(arr[1]);
                } else if (arr[0] === 'action' && arr[1]) {
                  this.handleAction(arr[1]);
                }
                
              } catch (e) {
                console.error('Cloud parsing error', e);
              }
            }
          }
        }
      };

      this.ws.onerror = (e) => console.error("[CloudClient] Socket error", e);

      this.ws.onclose = () => {
        console.log("[CloudClient] Socket closed");
        clearInterval(this.pingTimer);
      };
    } catch (e) {
      if (!this.controller.signal.aborted) console.warn("Cloud connect error", e);
    }
  }

  setChangeListener(listener: () => void) {
    this.onRemoteChange = listener;
  }

  private handleWelcome(payload: any) {
    console.log("[CloudClient] Handling welcome", payload);
    const vars = payload.variables || [];
    for (const v of vars) {
      const entryId = String(v.id);
      const entropyId = this.entryIdToEntropyId.get(entryId);
      if (!entropyId) continue;
      
      if (v.variableType === 'list') {
        const list = (Array.isArray(v.list) ? v.list : []).map((item: any) => ({
          data: item.data,
          key: item.key || this.generateKey()
        }));
        this.values.set(entropyId, list);
      } else {
        this.values.set(entropyId, v.value);
      }
    }
    this.onRemoteChange?.();
  }

  private handleAction(action: any) {
    const entryId = String(action.id);
    const entropyId = this.entryIdToEntropyId.get(entryId);
    if (!entropyId) return;
    
    if (action.variableType === 'variable') {
      if (action.type === 'set') {
        this.values.set(entropyId, action.data);
        this.onRemoteChange?.();
      }
    } else if (action.variableType === 'list') {
      let arr = this.values.get(entropyId) as any[] | undefined;
      if (!arr) {
        arr = [];
        this.values.set(entropyId, arr);
      }
      if (action.type === 'insert') {
        arr.splice(action.index, 0, { data: action.data, key: action.key });
      } else if (action.type === 'delete') {
        arr.splice(action.index, 1);
      } else if (action.type === 'replace') {
        if (arr[action.index]) {
          arr[action.index].data = action.data;
        }
      }
      this.onRemoteChange?.();
    }
  }

  read(key: string): VariableValue | Array<{ data: VariableValue }> | undefined {
    return this.values.get(key);
  }

  private generateKey() {
    return Math.random().toString(36).substring(2) + Date.now().toString(36);
  }

  write(key: string, value: VariableValue | Array<{ data: VariableValue }>): void {
    const isList = Array.isArray(value);
    
    if (!isList) {
      if (this.values.get(key) !== value) {
        this.values.set(key, value);
        this.sendAction(key, "variable", { type: "set", data: value });
      }
      return;
    }

    let oldArr = (this.values.get(key) as any[]) || [];
    const newArr = value as any[];
    const diffs: any[] = [];

    let prefix = 0;
    while (prefix < oldArr.length && prefix < newArr.length && oldArr[prefix].data === newArr[prefix].data) {
      prefix++;
    }
    let suffix = 0;
    while (suffix < oldArr.length - prefix && suffix < newArr.length - prefix && oldArr[oldArr.length - 1 - suffix].data === newArr[newArr.length - 1 - suffix].data) {
      suffix++;
    }

    const deleteCount = oldArr.length - prefix - suffix;
    const insertCount = newArr.length - prefix - suffix;
    const replaceCount = Math.min(deleteCount, insertCount);

    for (let i = 0; i < replaceCount; i++) {
      const currentKey = oldArr[prefix + i].key;
      diffs.push({ type: 'replace', index: prefix + i, data: newArr[prefix + i].data, key: currentKey });
      oldArr[prefix + i].data = newArr[prefix + i].data;
    }

    const remainingDelete = deleteCount - replaceCount;
    const at = prefix + replaceCount;
    for (let i = 0; i < remainingDelete; i++) {
      diffs.push({ type: 'delete', index: at, key: oldArr[at + i].key });
    }
    if (remainingDelete) oldArr.splice(at, remainingDelete);

    // Rebuild once instead of shifting the suffix for every inserted item.
    const inserted = [];
    for (let i = 0; i < insertCount - replaceCount; i++) {
      const item = { data: newArr[at + i].data, key: this.generateKey() };
      diffs.push({ type: 'insert', index: at + i, ...item });
      inserted.push(item);
    }
    if (inserted.length) oldArr = oldArr.slice(0, at).concat(inserted, oldArr.slice(at));
    this.values.set(key, oldArr);

    for (const diff of diffs) {
      this.sendAction(key, "list", diff);
    }
  }

  private sendAction(entropyId: string, variableType: string, actionData: any) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      const entryId = this.entropyIdToEntryId.get(entropyId);
      const _id = this.variableMongoIds.get(entropyId);
      if (!entryId || !_id) return;

      const payload = '42' + (this.msgId++) + JSON.stringify(["action", {
        _id,
        id: entryId,
        variableType,
        ...actionData
      }]);
      console.log("[CloudClient] Send:", payload);
      this.ws.send(payload);
    }
  }

  dispose() {
    this.controller.abort();
    clearInterval(this.pingTimer);
    this.onRemoteChange = undefined;
    if (this.ws) {
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.close();
      this.ws = null;
    }
  }
}
