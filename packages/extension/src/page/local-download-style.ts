export const LOCAL_DOWNLOAD_STYLE = `
.entropy-local-download-backdrop{position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;padding:24px;box-sizing:border-box;background:rgba(18,27,45,.42)}
.entropy-local-download{box-sizing:border-box;width:min(460px,100%);padding:28px;border:1px solid #dce1eb;border-radius:14px;background:#fff;color:#252d3d;box-shadow:0 20px 70px #101a3440;font:14px/1.55 system-ui,sans-serif;outline:none;text-align:left}
.entropy-local-download .entropy-local-title{display:block;margin:0 0 8px;color:#202838;font-size:21px;font-weight:750;line-height:1.4}
.entropy-local-download .entropy-local-caption{margin:0 0 22px;color:#667085;font-size:13px;line-height:1.6}
.entropy-local-download .entropy-local-status{margin:0 0 12px;color:#303a4f;font-size:14px;font-weight:600;overflow-wrap:anywhere}
.entropy-local-download progress{display:block;width:100%;height:8px;margin:0 0 8px;border:0;border-radius:8px;overflow:hidden;appearance:none;background:#e9eef9;accent-color:#3d6ce8}
.entropy-local-download progress::-webkit-progress-bar{background:#e9eef9;border-radius:8px}
.entropy-local-download progress::-webkit-progress-value{background:#3d6ce8;border-radius:8px}
.entropy-local-download progress::-moz-progress-bar{background:#3d6ce8;border-radius:8px}
.entropy-local-download .entropy-local-error{max-height:180px;margin:0 0 12px;padding:12px 14px;overflow:auto;border:1px solid #f0c6c2;border-radius:8px;background:#fff3f1;color:#9c3029;font-size:13px;font-weight:400;white-space:pre-wrap;overflow-wrap:anywhere}
.entropy-local-download .entropy-local-hint{margin:0 0 12px;color:#667085;font-size:13px}
.entropy-local-download .entropy-local-actions{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:10px;margin-top:24px}
.entropy-local-download .entropy-local-button{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;min-width:108px;min-height:42px;margin:0;padding:10px 18px;border:1px solid #c7cfdd;border-radius:8px;background:#fff;color:#354158;font:600 14px/1.3 system-ui,sans-serif;text-align:center;text-decoration:none;white-space:nowrap;cursor:pointer;appearance:none;box-shadow:0 1px 2px #18253d0a}
.entropy-local-download .entropy-local-button:hover{border-color:#8798b5;background:#f2f5fa}
.entropy-local-download .entropy-local-button:active{background:#e6ecf6}
.entropy-local-download .entropy-local-primary{border-color:#3d6ce8;background:#3d6ce8;color:#fff}
.entropy-local-download .entropy-local-primary:hover{border-color:#2b56c7;background:#2b56c7;color:#fff}
.entropy-local-download .entropy-local-primary:active{border-color:#2249b3;background:#2249b3}
.entropy-local-download .entropy-local-button:focus-visible{outline:3px solid #9ab8ff;outline-offset:3px}
.entropy-local-download .entropy-local-button:disabled{opacity:.55;cursor:wait}
.entropy-local-download [hidden]{display:none!important}
`;
