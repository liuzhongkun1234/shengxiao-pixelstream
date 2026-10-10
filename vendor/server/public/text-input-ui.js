/* The actual player mode is the single source of truth for the switch. */
globalThis.setupPeerStreamTextInput = function (player, document, storage) {
  const button = document.getElementById('textInputButton');
  const label = document.getElementById('textInputLabel');
  const hint = document.getElementById('textInputHint');
  let storageKey = '', restoring = false, pendingChoice = false;
  function render() {
    const enabled = player.textInputMode === 'force';
    button.disabled = document.body.dataset.inputRole === 'viewer';
    button.setAttribute('aria-pressed', String(enabled));
    button.title = enabled ? '关闭中文输入' : '开启中文输入';
    label.textContent = enabled ? '中文输入：开' : '中文输入';
    hint.textContent = enabled
      ? '中文输入已开启，点击项目输入框即可输入或粘贴。场景操作时建议关闭；候选输入期间 Esc 先取消候选，再按 Esc 关闭。'
      : '中文输入已关闭。需要输入时，点击顶部“中文输入”开启；每个项目分别记忆。';
  }
  function save() {
    try { if (storageKey) storage?.setItem(storageKey, player.textInputMode === 'force' ? 'force' : 'off'); } catch { }
  }
  player.addEventListener('textInputModeChanged', () => {
    if (!restoring) { pendingChoice = !storageKey; save(); }
    render();
  });
  function loadProject(projectId) {
    if (!projectId) return;
    const key = 'peerstream.textInputMode.' + projectId;
    if (key === storageKey) return;
    const preserveChoice = !storageKey && pendingChoice;
    storageKey = key;
    if (preserveChoice) { pendingChoice = false; save(); render(); return; }
    let value;
    try { value = storage?.getItem(key); } catch { }
    restoring = true;
    try { player.setTextInputMode(value === 'force' ? 'force' : 'off'); }
    finally { restoring = false; }
    render();
  }
  button.addEventListener('pointerdown', event => event.preventDefault());
  button.addEventListener('click', () => {
    if (document.body.dataset.inputRole === 'viewer') return;
    const enabled = player.textInputMode !== 'force';
    player.setTextInputMode(enabled ? 'force' : 'off');
    if (enabled) player.focusTextInput();
    else player.stopTextInput(true);
    render();
  });
  player.addEventListener('textInputState', render);
  render();
  return { loadProject, refreshRole() {
    if (document.body.dataset.inputRole === 'viewer') player.stopTextInput();
    render();
  } };
};
