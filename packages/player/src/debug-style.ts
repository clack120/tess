// Both runtimes use these shared debug panel styles.

export const DEBUG_PANEL_STYLE = `
  :root { --debug-panel-width: 0px; }

  .debug-toggle-btn {
    font-size: 13px; border: 1px solid #0003; background: none; border-radius: 6px;
    padding: 3px 9px; cursor: pointer; color: inherit;
  }
  .debug-toggle-btn .badge { margin-left: 4px; }
  .badge {
    display: inline-block; min-width: 15px; padding: 0 4px; border-radius: 8px;
    background: #e5484d; color: #fff; font-size: 11px; line-height: 16px; text-align: center;
  }
  #debug-panel {
    --debug-accent: #376df6; --debug-line: #18233a1a; --debug-soft: #376df612;
    position: fixed; top: 0; right: 0; bottom: 0; width: min(420px, 92vw);
    min-height: 260px; box-sizing: border-box;
    background: linear-gradient(180deg, #fbfcff 0, #fff 110px); color: #16181d;
    border: 1px solid var(--debug-line); border-right: 0;
    border-radius: 12px 0 0 12px; box-shadow: -8px 0 28px #17213a24;
    transform: translateX(100%); transition: transform .15s ease-out;
    display: flex; flex-direction: column; z-index: 1000;
  }
  #debug-panel.open { transform: translateX(0); }
  @media (prefers-color-scheme: dark) {
    #debug-panel {
      --debug-line: #ffffff1c; --debug-soft: #7093ff18;
      background: linear-gradient(180deg, #20242d 0, #191c23 110px); color: #eef1f7;
      box-shadow: -8px 0 30px #0007;
    }
  }
  #debug-resize-handle {
    position: absolute; top: 0; left: -5px; width: 9px; height: 100%; cursor: col-resize; z-index: 1001;
  }
  #debug-resize-handle:hover, #debug-resize-handle.dragging { background: #4f80ff33; }
  #debug-height-handle {
    position: absolute; top: -5px; left: 0; right: 0; height: 10px;
    cursor: row-resize; z-index: 1002;
  }
  #debug-height-handle:hover { background: #4f80ff33; }
  /* Keep the width handle reachable when the panel snaps closed. */
  #debug-panel.collapsed { box-shadow: none; overflow: visible; }
  #debug-panel.collapsed > :not(#debug-resize-handle) { display: none; }
  #debug-panel.collapsed > #debug-resize-handle { width: 11px; left: -11px; background: #4f80ff33; }
  .debug-header {
    display: flex; align-items: center; gap: 4px; padding: 11px 12px 9px 15px;
    border-bottom: 1px solid var(--debug-line); flex: none;
  }
  .debug-header h2 { font-size: 15px; letter-spacing: -.01em; margin: 0; }
  .debug-header button { border: none; background: none; font-size: 18px; cursor: pointer; color: inherit; line-height: 1; }
  .debug-header .debug-inspect { margin-left: auto; }
  .debug-header #debug-close { padding-left: 10px; }
  .debug-inspect {
    display: flex; align-items: center; padding: 3px 5px; border-radius: 5px; opacity: .65;
  }
  .debug-inspect:hover { opacity: 1; background: var(--debug-soft); }
  .debug-inspect.active { opacity: 1; color: var(--debug-accent); background: var(--debug-soft); }
  #debug-close { width: 28px; height: 28px; padding: 0 !important; border-radius: 7px; opacity: .55; }
  #debug-close:hover { opacity: 1; background: var(--debug-soft); }
  .debug-inspecting, .debug-inspecting canvas { cursor: crosshair !important; }
  .debug-section {
    position: relative; border-bottom: 1px solid var(--debug-line); padding: 12px 15px 15px;
    flex: 0 0 auto; box-sizing: border-box;
    display: flex; flex-direction: column; overflow: hidden;
  }
  /* Scroll contents only so collapsed section handles cannot be clipped. */
  .debug-section-body { flex: 1 1 auto; min-height: 0; overflow: auto; }
  .debug-section-last { flex: 1 1 auto; min-height: 120px; }
  /* Leave the height handle visible when a section snaps closed. */
  .debug-section.collapsed { padding: 0; overflow: visible; border-bottom-color: #4f80ff66; }
  .debug-section.collapsed > h3, .debug-section.collapsed > .debug-section-body { display: none; }
  /* Place collapsed handles below the section so the parent's overflow cannot clip them. */
  .debug-section.collapsed > .debug-vresize {
    top: 0; bottom: auto; height: 9px; background: #4f80ff26;
  }
  .debug-section.collapsed > .debug-vresize:hover { background: #4f80ff55; }
  .debug-vresize {
    position: absolute; left: 0; right: 0; bottom: 0; height: 7px; cursor: row-resize; z-index: 2;
  }
  .debug-vresize:hover { background: #4f80ff33; }
  .debug-section h3 { font-size: 11px; margin: 0 0 9px; text-transform: uppercase; letter-spacing: .07em; opacity: .58; }
  .debug-empty { opacity: .5; font-size: 13px; margin: 4px 0; }
  .error-item { font-size: 12px; margin-bottom: 6px; border: 1px solid #e5484d55; border-radius: 6px; padding: 4px 8px; }
  .error-item summary { cursor: pointer; color: #e5484d; word-break: break-word; }
  .error-item pre { white-space: pre-wrap; word-break: break-word; font-size: 11px; opacity: .8; margin: 6px 0 0; }
  .debug-scene-title {
    display: flex; align-items: center; gap: 8px;
    font-size: 13px; font-weight: 600; margin: 8px 0 2px;
  }
  .debug-scene-go { margin-left: auto; font-weight: 400; }
  .debug-object-list { list-style: none; margin: 0; padding: 0; }
  .debug-object-btn {
    display: flex; align-items: center; gap: 8px; width: 100%; text-align: left;
    padding: 6px 8px; margin: 2px 0; border-radius: 7px;
    border: none; background: none; color: inherit; font-size: 13px; cursor: pointer;
  }
  .debug-object-btn:hover { background: var(--debug-soft); }
  .debug-object-btn.active { background: #376df619; color: var(--debug-accent); font-weight: 600; }
  .debug-object-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .debug-clone-count {
    margin-left: auto; flex: none; padding: 2px 7px; border-radius: 999px;
    background: #805ad51a; color: #7048c7; font-size: 10px; font-weight: 650;
  }
  @media (prefers-color-scheme: dark) { .debug-clone-count { color: #bca5ff; background: #a68aff20; } }
  #block-tree ul { list-style: none; margin: 0; padding-left: 14px; border-left: 1px dashed #0002; }
  #block-tree > .debug-thread > ul { padding-left: 0; border-left: none; }
  .debug-thread-label { font-size: 11px; opacity: .55; margin: 10px 0 2px; }
  .block-type { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .block-param { margin-left: 4px; }
  .block-highlight > .block-type { background: #e5484d; color: #fff; padding: 1px 5px; border-radius: 4px; }
  .block-highlight-child > .block-type { background: #e5484d33; padding: 1px 5px; border-radius: 4px; }

  .debug-tabs {
    display: flex; flex: none; border-bottom: 1px solid var(--debug-line);
    padding: 5px 8px; gap: 3px;
  }
  .debug-tab {
    border: none; background: none; color: inherit; cursor: pointer;
    font-size: 12px; padding: 6px 9px; border-radius: 7px; opacity: .58;
  }
  .debug-tab:hover { opacity: .9; background: var(--debug-soft); }
  .debug-tab[aria-selected="true"] { opacity: 1; font-weight: 650; color: var(--debug-accent); background: var(--debug-soft); }
  .debug-tab .badge { margin-left: 4px; }
  .debug-panelbody { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
  .debug-panelbody[hidden] { display: none; }


  .debug-run-state { font-size: 13px; margin: 0 0 10px; }
  .debug-run-state .dot {
    display: inline-block; width: 8px; height: 8px; border-radius: 50%;
    background: #8a8f98; margin-right: 6px; vertical-align: 1px;
  }
  .debug-run-state.state-run .dot { background: #30a46c; }
  .debug-run-state.state-pause .dot { background: #f5a524; }
  .debug-run-buttons { display: flex; gap: 8px; flex-wrap: wrap; }
  .debug-run-buttons button {
    flex: 1 1 auto; min-width: 84px; font-size: 13px; padding: 7px 10px; cursor: pointer;
    border: 1px solid #0003; border-radius: 6px; background: none; color: inherit;
  }
  .debug-run-buttons button:hover:not(:disabled) { background: #4f80ff22; }
  .debug-run-buttons button:disabled { opacity: .4; cursor: default; }
  .debug-field { display: flex; align-items: center; gap: 8px; margin: 7px 0; font-size: 13px; }
  .debug-field label { flex: 1 1 auto; }
  .debug-field select { font: inherit; font-size: 12px; padding: 3px 6px; border-radius: 5px;
                        border: 1px solid #0003; background: none; color: inherit; }
  .debug-field select option { color: initial; }
  .debug-field-input { font: inherit; font-size: 12px; padding: 3px 6px; border-radius: 5px;
                       border: 1px solid #0003; background: none; color: inherit; width: 132px; }
  .debug-field-input::placeholder { color: inherit; opacity: .4; }
  .debug-note { font-size: 12px; opacity: .55; margin: 8px 0 0; line-height: 1.6; }
  .debug-pick-hint {
    border-left: 2px solid transparent; padding-left: 8px; margin-left: -10px;
    transition: opacity .12s, border-color .12s, color .12s;
  }
  .debug-pick-hint.active {
    opacity: 1; color: #4f80ff; border-left-color: #4f80ff; font-weight: 600;
  }

  .debug-rows { list-style: none; margin: 0; padding: 0; font-size: 13px; }
  /* Apply flex only to direct rows so expanded lists and block trees stay vertical. */
  .debug-rows > li { display: flex; align-items: baseline; gap: 8px; padding: 5px 0; border-bottom: 1px solid var(--debug-line); }
  /* Explicit display rules override the browser's default hidden rule. */
  .debug-rows > li[hidden] { display: none; }
  .debug-rows > li.debug-items-row { display: block; border-bottom: none; padding: 0; }
  .debug-rows .key { flex: 0 1 auto; min-width: 0; overflow-wrap: anywhere; }
  .debug-rows .val {
    margin-left: auto; text-align: right; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px; overflow-wrap: anywhere; max-width: 60%;
  }
  .debug-rows .tag { font-size: 11px; opacity: .5; }
  .debug-send-btn {
    margin-left: auto; font-size: 11px; padding: 1px 8px; border-radius: 999px;
    border: 1px solid #0003; background: none; color: inherit; cursor: pointer;
  }
  .debug-send-btn:hover { background: #4f80ff22; }

  .debug-edit {
    margin-left: auto; text-align: right; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px; overflow-wrap: anywhere; max-width: 60%;
    border: 1px solid transparent; border-radius: 4px; background: none; color: inherit;
    cursor: text; padding: 1px 5px;
    /* Keep empty fields wide enough to click for editing. */
    min-width: 3.5em; min-height: 18px;
  }
  .debug-edit:hover { border-color: #0003; background: #4f80ff11; }
  .debug-edit.empty { opacity: .4; font-style: italic; }
  .debug-edit-input {
    margin-left: auto; width: 55%; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px; text-align: right; padding: 1px 5px; border-radius: 4px;
    border: 1px solid #4f80ff; background: none; color: inherit;
  }

  .debug-select {
    margin-left: auto; flex: none; font: inherit; font-size: 12px; max-width: 60%;
    padding: 1px 4px; border-radius: 4px; border: 1px solid #0003; background: none; color: inherit;
  }
  .debug-select option { color: initial; }
  .debug-toggle {
    flex: none; margin-left: 8px; font-size: 11px; line-height: 1; padding: 3px 9px;
    border-radius: 999px; border: 1px solid #0003; background: none; color: inherit;
    cursor: pointer; opacity: .45;
  }
  .debug-toggle.on { opacity: 1; border-color: #4f80ff88; background: #4f80ff1a; }
  .debug-toggle:hover { background: #4f80ff22; }

  .debug-list-head { display: flex; align-items: baseline; gap: 8px; }
  .debug-expand {
    border: none; background: none; color: inherit; font: inherit; cursor: pointer;
    padding: 0; text-align: left;
  }
  .debug-expand::before { content: '▸'; display: inline-block; width: 12px; opacity: .5; }
  .debug-expand.open::before { content: '▾'; }
  .debug-expand:hover { color: #4f80ff; }
  .debug-list-items { max-height: 190px; overflow: auto; margin: 4px 0 8px 12px; }
  .debug-list-ol { list-style: none; margin: 0; padding: 0; }
  .debug-list-ol > li { display: flex; align-items: center; gap: 6px; padding: 1px 0; }
  .debug-list-index { flex: none; font-size: 11px; opacity: .45; min-width: 22px; text-align: right; }
  /* Let values use the remaining width so long list items stay readable. */
  .debug-list-ol .debug-edit,
  .debug-list-ol .debug-edit-input {
    flex: 1 1 auto; width: auto; max-width: none; margin-left: 0; text-align: left; min-width: 0;
  }
  .debug-list-ol .debug-mini-btn { flex: none; }
  .debug-mini-btn {
    font-size: 11px; line-height: 1; padding: 3px 7px; border-radius: 5px;
    border: 1px solid #0003; background: none; color: inherit; cursor: pointer;
  }
  .debug-mini-btn:hover { background: #4f80ff22; }
  .debug-add-btn { margin: 0 0 6px; }
  .debug-func-code { font-size: 12px; }
  .debug-func-code ul { list-style: none; margin: 0; padding-left: 12px; border-left: 1px dashed #0002; }
  .debug-func-code > ul { padding-left: 0; border-left: none; }

  #object-info .key { opacity: .7; }
  #object-info .val { margin-left: auto; text-align: right; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
`;
