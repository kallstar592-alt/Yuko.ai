/* Yuko.ai — local-first browser app. No app-owned API server or telemetry. */
(() => {
  'use strict';

  const KEYS = {
    settings: 'yuko.ai.settings.v1',
    chats: 'yuko.ai.chats.v1'
  };
  const DEFAULT_CORE_PROMPT = "# SYSTEM PROMPT: YUKO AI WORKSPACE CORE ENGINE\n## POSITION & IDENTITY\nYou are Yuko, a privacy-focused personal AI workspace. Adapt style and actions to the capabilities actually available in this browser app.\n## PERSONAL SETTINGS & PRIVACY\nWhen prompt-level parental controls are enabled, refuse explicit sexual content, graphic violence, or age-inappropriate requests with: This action is restricted by active Parental Controls. This is model guidance, not a guaranteed backend-enforced filter.\nTreat trusted contacts as a user-entered names/handles list, not verified identities. If a recipient is not listed, ask the user to add them first. Do not claim to send or share messages; the app has no outbound messaging integration.\nUse the current conversation and explicitly provided context only. Do not infer access to other or archived conversations; only use archived material when the user explicitly provides or requests it.\n## INTEGRATIONS & CODE\nUse only integrations that are actually configured and exposed. Never invent tool calls, execution results, tests, repository changes, or successful actions. Never include API keys or credentials in tool payloads or generated examples.\nThis static browser app can call the selected Ollama or OpenRouter provider and prepare downloadable project files. It has no cloud computer sandbox and does not execute arbitrary generated code. Do not claim code was run, built, or tested unless a real execution tool verifies that.\nWhen debugging, optimizing, or reviewing code, cover Security Vulnerabilities (injection, leaked variables, hardcoded keys, race conditions); Performance (bottlenecks, memory leaks, unoptimized loops); and Syntax & Style (formatting, types, logical structure).\nFor complete project requests, provide a coherent file tree, full source files, configuration, dependencies, README, setup and validation steps. Avoid placeholders for requested core mechanics and never embed secrets. State when anything could not be verified.\nAgent mode should provide a concise high-level plan, complete the requested work, and review the result. Do not disclose hidden chain-of-thought; share useful decisions, concise plans, and checklists.\n## VOICE & DICTATION\nRead-aloud should use natural prose with Markdown/tables converted where practical, usually no more than three sentences unless detailed technical dictation is requested.\nCorrect obvious speech-to-text errors, filler, and stutters while preserving intent. Browser speech recognition may process audio remotely depending on the browser/device. Voice options and whether they run locally depend on the device.\n## OUTPUT STYLE\nGive the direct answer or action result first. Use clear, scannable headings; avoid needless preambles or fabricated claims.\n## CAPABILITY BOUNDARIES\nChats and settings are stored in this browser, not on a Yuko server. Prompts and attachments are sent to the selected provider only when submitted. Browser storage may be readable by scripts or extensions on this origin. There is no Yuko-owned backend, account system, remote execution sandbox, verified-contact database, or outbound messaging integration. Image/video generation needs a compatible model and may cost money. Never promise absolute privacy or free generation without provider terms confirming it.";

  const DEFAULTS = {
    provider: 'ollama',
    ollamaEndpoint: 'http://localhost:11434',
    ollamaModel: 'llama3.2',
    openRouterKey: '',
    openRouterModel: 'openrouter/free',
    corePrompt: DEFAULT_CORE_PROMPT,
    trustedContacts: '',
    parentalControls: false
  };
  const MAX_FILE_BYTES = 10 * 1024 * 1024;
  const MAX_TEXT_FILE_BYTES = 1024 * 1024;
  const MAX_ATTACHMENTS = 6;
  const $ = (id) => document.getElementById(id);
  const state = {
    settings: loadJSON(KEYS.settings, DEFAULTS),
    chats: loadJSON(KEYS.chats, []),
    activeChatId: null,
    pendingFiles: [],
    referenceFile: null,
    generatedImages: [],
    connection: 'unknown',
    busy: false
  };

  if (!Array.isArray(state.chats)) state.chats = [];
  state.settings = { ...DEFAULTS, ...(state.settings && typeof state.settings === 'object' ? state.settings : {}) };
  if (state.settings.provider !== 'openrouter') state.settings.provider = 'ollama';

  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
      console.warn('Yuko local data could not be read.', error);
      return fallback;
    }
  }

  function persistSettings() {
    try {
      localStorage.setItem(KEYS.settings, JSON.stringify(state.settings));
      $('saveStatus').textContent = 'Saved in this browser.';
    } catch (error) {
      $('saveStatus').textContent = 'Could not save. Browser storage may be full.';
      toast('Settings could not be saved in local storage.', 'error');
    }
  }

  function persistChats() {
    try {
      // Persist conversation text and attachment metadata only. Binary file contents stay in memory.
      const safeChats = state.chats.map((chat) => ({
        ...chat,
        messages: (chat.messages || []).map(({ attachmentPayloads, ...message }) => message)
      }));
      localStorage.setItem(KEYS.chats, JSON.stringify(safeChats));
    } catch (error) {
      toast('Chat history is too large for browser storage. Export it, then clear old chats.', 'error');
    }
  }

  function makeId() {
    return typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `yuko-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function getCurrentChat(create = true) {
    let chat = state.chats.find((item) => item.id === state.activeChatId);
    if (!chat && state.currentDraft && state.currentDraft.id === state.activeChatId) chat = state.currentDraft;
    if (!chat && create) {
      chat = { id: makeId(), title: 'New chat', createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
      state.activeChatId = chat.id;
      // Empty conversations are not persisted or listed until a message is sent.
      state.currentDraft = chat;
    }
    return chat || state.currentDraft || null;
  }

  function commitDraftIfNeeded(chat) {
    if (!chat) return;
    if (!state.chats.some((item) => item.id === chat.id)) state.chats.unshift(chat);
    state.currentDraft = null;
    chat.updatedAt = Date.now();
    state.chats.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    persistChats();
    renderHistory();
  }

  function currentProvider() {
    return state.settings.provider === 'openrouter' ? 'openrouter' : 'ollama';
  }

  function currentModel() {
    const select = $('chatModelSelect');
    return select && select.value ? select.value : (currentProvider() === 'ollama' ? state.settings.ollamaModel : state.settings.openRouterModel);
  }

  function endpointBase() {
    const raw = ($('ollamaEndpoint').value || state.settings.ollamaEndpoint || DEFAULTS.ollamaEndpoint).trim();
    return raw.replace(/\/+$/, '');
  }

  function setFeedback(message, kind = 'info') {
    const el = $('connectionFeedback');
    el.textContent = message;
    el.className = `connection-feedback ${kind}`;
    el.hidden = false;
  }

  function hideFeedback() {
    $('connectionFeedback').hidden = true;
  }

  function toast(message, kind = 'info') {
    const region = $('toastRegion');
    const item = document.createElement('div');
    item.className = `toast ${kind}`;
    item.textContent = message;
    region.appendChild(item);
    requestAnimationFrame(() => item.classList.add('show'));
    window.setTimeout(() => {
      item.classList.remove('show');
      window.setTimeout(() => item.remove(), 250);
    }, 4200);
  }

  async function fetchJSON(url, options = {}, timeoutMs = 120000) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const text = await response.text();
      let data = {};
      try { data = text ? JSON.parse(text) : {}; }
      catch { data = { message: text.slice(0, 800) }; }
      if (!response.ok) {
        const detail = data?.error?.message || data?.error || data?.message || data?.detail || `HTTP ${response.status}`;
        throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
      }
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('The request timed out. Try again or choose a smaller model.');
      if (error instanceof TypeError) {
        throw new Error(`Could not reach the endpoint. Check that it is running and that browser CORS allows this app. (${error.message})`);
      }
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
  }

  function authHeaders() {
    const key = state.settings.openRouterKey.trim();
    if (!key) throw new Error('Add your OpenRouter API key in Settings first.');
    return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  }

  function providerLabel() {
    return currentProvider() === 'ollama' ? 'Ollama' : 'OpenRouter';
  }

  function setConnection(status, text) {
    state.connection = status;
    const pill = $('connectionPill');
    pill.classList.toggle('connected', status === 'connected');
    $('connectionLabel').textContent = text;
    $('providerStatusText').textContent = status === 'connected' ? `${providerLabel()} connected` : (status === 'error' ? 'Connection needs attention' : 'Local-first mode');
  }

  function applyProviderUI() {
    const provider = currentProvider();
    $('chooseOllama').classList.toggle('active', provider === 'ollama');
    $('chooseOpenRouter').classList.toggle('active', provider === 'openrouter');
    $('ollamaSettings').hidden = provider !== 'ollama';
    $('openRouterSettings').hidden = provider !== 'openrouter';
    $('modelProviderLabel').textContent = provider === 'ollama' ? 'Ollama · Local' : 'OpenRouter';
    $('modelProviderIcon').textContent = provider === 'ollama' ? '◉' : '✳';
    $('connectionLabel').textContent = state.connection === 'connected' ? 'Connected' : 'Not connected';
    $('connectionPill').classList.toggle('connected', state.connection === 'connected');
    $('providerStatusText').textContent = state.connection === 'connected' ? `${providerLabel()} connected` : `${providerLabel()} selected`;
    updateChatModelOptions();
  }

  function setSelectOptions(select, items, chosen, fallbackLabel) {
    const previous = chosen || select.value;
    select.replaceChildren();
    const unique = [...new Set(items.filter(Boolean))];
    if (!unique.length) unique.push(previous || fallbackLabel || 'llama3.2');
    for (const item of unique) {
      const option = document.createElement('option');
      option.value = item;
      option.textContent = item;
      select.appendChild(option);
    }
    select.value = unique.includes(previous) ? previous : unique[0];
  }

  function updateChatModelOptions() {
    const provider = currentProvider();
    const defaultsSelect = provider === 'ollama' ? $('ollamaDefaultModel') : $('openRouterDefaultModel');
    const defaultValue = defaultsSelect.value || (provider === 'ollama' ? DEFAULTS.ollamaModel : DEFAULTS.openRouterModel);
    const current = $('chatModelSelect').dataset.provider === provider ? $('chatModelSelect').value : defaultValue;
    const items = [...defaultsSelect.options].map((option) => option.value).filter(Boolean);
    setSelectOptions($('chatModelSelect'), items.length ? items : [defaultValue], items.includes(current) ? current : defaultValue, defaultValue);
    $('chatModelSelect').dataset.provider = provider;
    $('modelProviderLabel').textContent = provider === 'ollama' ? 'Ollama · Local' : 'OpenRouter';
  }

  function hydrateSettings() {
    $('ollamaEndpoint').value = state.settings.ollamaEndpoint || DEFAULTS.ollamaEndpoint;
    $('ollamaDefaultModel').value = state.settings.ollamaModel || DEFAULTS.ollamaModel;
    $('openRouterKey').value = state.settings.openRouterKey || '';
    $('openRouterDefaultModel').value = state.settings.openRouterModel || DEFAULTS.openRouterModel;
    $('corePromptInput').value = state.settings.corePrompt || DEFAULT_CORE_PROMPT;
    $('trustedContactsInput').value = state.settings.trustedContacts || '';
    $('parentalControlsToggle').checked = Boolean(state.settings.parentalControls);
    updateParentalSafetyStatus();
    applyProviderUI();
  }

  function updateParentalSafetyStatus() {
    const input = $('parentalControlsToggle');
    if (!input) return;
    const enabled = Boolean(input.checked);
    input.setAttribute('aria-checked', String(enabled));
    const status = $('parentalSafetyStatus');
    if (status) {
      status.textContent = enabled ? 'ON' : 'OFF';
      status.classList.toggle('is-on', enabled);
      status.classList.toggle('is-off', !enabled);
    }
  }

  function readSettingsForm() {
    const base = $('ollamaEndpoint').value.trim().replace(/\/+$/, '');
    state.settings.ollamaEndpoint = base || DEFAULTS.ollamaEndpoint;
    state.settings.ollamaModel = $('ollamaDefaultModel').value || DEFAULTS.ollamaModel;
    state.settings.openRouterKey = $('openRouterKey').value.trim();
    state.settings.openRouterModel = $('openRouterDefaultModel').value || DEFAULTS.openRouterModel;
    state.settings.corePrompt = $('corePromptInput').value.trim() || DEFAULT_CORE_PROMPT;
    state.settings.trustedContacts = $('trustedContactsInput').value.trim();
    state.settings.parentalControls = $('parentalControlsToggle').checked;
    persistSettings();
    applyProviderUI();
  }


  function navigate(page) {
    const pages = { chat: 'Chat', agent: 'Agent', codebase: 'Codebase', images: 'Image studio', settings: 'Settings' };
    for (const name of Object.keys(pages)) {
      const active = name === page;
      const view = $(name + 'View');
      if (view) view.hidden = !active;
      const nav = document.querySelector('[data-nav="' + name + '"]');
      if (nav) nav.classList.toggle('active', active);
    }
    $('pageTitle').textContent = pages[page] || 'Chat';
    closeMobileSidebar();
  }

  function openMobileSidebar() {
    $('sidebar').classList.add('sidebar-open');
    $('mobileScrim').classList.add('visible');
  }

  function closeMobileSidebar() {
    $('sidebar').classList.remove('sidebar-open');
    $('mobileScrim').classList.remove('visible');
  }

  function newChat() {
    state.activeChatId = makeId();
    state.currentDraft = { id: state.activeChatId, title: 'New chat', createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
    state.pendingFiles = [];
    renderAttachments();
    renderMessages();
    renderHistory();
    navigate('chat');
    $('chatInput').focus();
  }

  function loadChat(id) {
    state.activeChatId = id;
    state.currentDraft = null;
    state.pendingFiles = [];
    renderAttachments();
    renderMessages();
    renderHistory();
    navigate('chat');
  }

  function chatTitle(message) {
    const cleaned = message.replace(/\s+/g, ' ').trim();
    return cleaned ? (cleaned.length > 42 ? `${cleaned.slice(0, 39)}…` : cleaned) : 'Attachment chat';
  }

  function renderHistory() {
    const list = $('historyList');
    list.replaceChildren();
    const chats = [...state.chats].filter((chat) => chat.messages?.length).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (!chats.length) {
      const empty = document.createElement('div');
      empty.className = 'history-empty';
      empty.textContent = 'Your conversations will appear here.';
      list.appendChild(empty);
      return;
    }
    for (const chat of chats.slice(0, 80)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `history-item${chat.id === state.activeChatId ? ' active' : ''}`;
      button.title = chat.title;
      const symbol = document.createElement('span');
      symbol.className = 'history-item-symbol';
      symbol.textContent = '◌';
      const label = document.createElement('span');
      label.className = 'history-item-label';
      label.textContent = chat.title || 'New chat';
      const del = document.createElement('span');
      del.className = 'history-delete';
      del.role = 'button';
      del.tabIndex = 0;
      del.setAttribute('aria-label', `Delete ${chat.title}`);
      del.title = 'Delete conversation';
      del.textContent = '×';
      del.addEventListener('click', (event) => {
        event.stopPropagation();
        deleteChat(chat.id);
      });
      del.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.stopPropagation();
          deleteChat(chat.id);
        }
      });
      button.append(symbol, label, del);
      button.addEventListener('click', () => loadChat(chat.id));
      list.appendChild(button);
    }
  }

  function deleteChat(id) {
    state.chats = state.chats.filter((chat) => chat.id !== id);
    if (state.activeChatId === id) {
      state.activeChatId = null;
      state.currentDraft = null;
    }
    persistChats();
    renderHistory();
    renderMessages();
    toast('Conversation deleted from this browser.');
  }

  function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  }

  function safeMarkdown(text) {
    // Minimal safe formatting: HTML is escaped before markdown-like decoration is added.
    let html = escapeHTML(text || '');
    html = html.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (_all, lang, body) => `<pre><code>${body.trimEnd()}</code></pre>`);
    html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^# (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    html = html.replace(/(^|\n)- (.+)/g, '$1<span class="markdown-list-line">• $2</span>');
    return html.split(/(<pre>[\s\S]*?<\/pre>)/g).map((part) => part.startsWith('<pre>') ? part : part.replace(/\n/g, '<br>')).join('');
  }

  function renderMessages() {
    const chat = getCurrentChat(false);
    const messages = chat?.messages || [];
    $('welcomeState').hidden = messages.length > 0 || state.busy;
    const container = $('messages');
    container.replaceChildren();
    for (const msg of messages) {
      const isAssistant = msg.role === 'assistant';
      const item = document.createElement('article');
      item.className = `message-row ${isAssistant ? 'assistant' : 'user'}`;
      const avatar = document.createElement('div');
      avatar.className = `message-avatar ${isAssistant ? 'assistant' : 'user'}`;
      avatar.textContent = isAssistant ? '✳' : 'Y';
      const body = document.createElement('div');
      body.className = 'message-content';
      const meta = document.createElement('div');
      meta.className = 'message-author';
      const speaker = document.createElement('strong');
      speaker.textContent = isAssistant ? 'Yuko' : 'You';
      const time = document.createElement('span');
      time.textContent = msg.createdAt ? ` · ${new Date(msg.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : '';
      meta.append(speaker, time);
      const text = document.createElement('div');
      text.className = 'message-bubble';
      text.innerHTML = safeMarkdown(msg.content || '');
      body.append(meta, text);
      if (msg.attachments?.length) {
        const tags = document.createElement('div');
        tags.className = 'message-attachments';
        for (const file of msg.attachments) {
          const tag = document.createElement('span');
          tag.className = 'message-attachment-tag';
          tag.textContent = `${file.type?.startsWith('image/') ? '▧' : '⌁'} ${file.name}`;
          tags.appendChild(tag);
        }
        body.appendChild(tags);
      }
      item.append(avatar, body);
      container.appendChild(item);
    }
    if (state.busy) {
      const item = document.createElement('article');
      item.className = 'message-row assistant loading-message';
      item.innerHTML = '<div class="message-avatar assistant">✳</div><div class="message-content"><div class="message-author"><strong>Yuko</strong><span> · Thinking…</span></div><div class="message-bubble"><div class="typing-dots"><i></i><i></i><i></i></div></div></div>';
      container.appendChild(item);
    }
    $('conversationScroll').scrollTop = $('conversationScroll').scrollHeight;
    renderHistory();
  }

  function fileMeta(file) {
    return { name: file.name, type: file.type || 'application/octet-stream', size: file.size };
  }

  function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
      reader.onload = () => resolve(String(reader.result));
      reader.readAsDataURL(file);
    });
  }

  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
      reader.onload = () => resolve(String(reader.result || ''));
      reader.readAsText(file);
    });
  }

  async function addAttachments(files) {
    const incoming = [...files];
    for (const file of incoming) {
      if (state.pendingFiles.length >= MAX_ATTACHMENTS) {
        toast(`A maximum of ${MAX_ATTACHMENTS} attachments is allowed per message.`, 'error');
        break;
      }
      const isImage = file.type.startsWith('image/');
      const isText = file.type.startsWith('text/') || /\.(md|json|csv|js|jsx|ts|tsx|py|html?|css|xml|yml|yaml|toml|log|txt|sql|sh|java|cs|cpp|h)$/i.test(file.name);
      if (!isImage && !isText) {
        toast(`${file.name} is not a supported image or text/code file.`, 'error');
        continue;
      }
      if (file.size > (isImage ? MAX_FILE_BYTES : MAX_TEXT_FILE_BYTES)) {
        toast(`${file.name} is too large. ${isImage ? 'Images must be 10 MB or less.' : 'Text/code files must be 1 MB or less.'}`, 'error');
        continue;
      }
      try {
        const data = isImage ? await readFileAsDataURL(file) : null;
        const text = isText ? await readFileAsText(file) : null;
        state.pendingFiles.push({ id: makeId(), file, ...fileMeta(file), dataUrl: data, textContent: text });
      } catch (error) {
        toast(error.message, 'error');
      }
    }
    renderAttachments();
  }

  function renderAttachments() {
    const strip = $('attachmentStrip');
    strip.replaceChildren();
    strip.hidden = state.pendingFiles.length === 0;
    for (const file of state.pendingFiles) {
      const card = document.createElement('div');
      card.className = 'attachment-card';
      if (file.type.startsWith('image/') && file.dataUrl) {
        const img = document.createElement('img');
        img.src = file.dataUrl;
        img.alt = '';
        card.appendChild(img);
      } else {
        const icon = document.createElement('span');
        icon.className = 'attachment-file-icon';
        icon.textContent = '⌁';
        card.appendChild(icon);
      }
      const label = document.createElement('span');
      label.className = 'attachment-file-name';
      label.textContent = file.name;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'attachment-remove';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `Remove ${file.name}`);
      remove.addEventListener('click', () => {
        state.pendingFiles = state.pendingFiles.filter((entry) => entry.id !== file.id);
        renderAttachments();
      });
      card.append(label, remove);
      strip.appendChild(card);
    }
  }

  function makePromptWithFiles(baseText, files) {
    const textFiles = files.filter((file) => file.type !== 'image/png' && !file.type.startsWith('image/') && file.textContent !== null);
    const textParts = textFiles.map((file) => `\n\n--- Attached file: ${file.name} ---\n${file.textContent}\n--- End of ${file.name} ---`);
    return `${baseText}${textParts.join('')}`.trim();
  }

  function imagePayloads(files) {
    return files.filter((file) => file.type.startsWith('image/') && file.dataUrl).map((file) => ({ ...fileMeta(file), dataUrl: file.dataUrl, base64: file.dataUrl.split(',')[1] || '' }));
  }

  async function sendChat(event) {
    event?.preventDefault();
    if (state.busy) return;
    readSettingsForm();
    const rawText = $('chatInput').value.trim();
    const files = [...state.pendingFiles];
    if (!rawText && !files.length) return;
    const userText = makePromptWithFiles(rawText || 'Please analyze the attached file(s).', files);
    const chat = getCurrentChat(true);
    const userMsg = {
      id: makeId(), role: 'user', content: userText, createdAt: Date.now(),
      attachments: files.map(fileMeta),
      attachmentPayloads: imagePayloads(files)
    };
    chat.messages.push(userMsg);
    if (chat.title === 'New chat') chat.title = chatTitle(rawText || files.map((f) => f.name).join(', '));
    commitDraftIfNeeded(chat);
    state.pendingFiles = [];
    renderAttachments();
    $('chatInput').value = '';
    resizeComposer();
    state.busy = true;
    renderMessages();
    $('sendButton').disabled = true;
    try {
      const reply = await getProviderCompletion(chat.messages, currentModel());
      chat.messages.push({ id: makeId(), role: 'assistant', content: reply || '(The model returned an empty response.)', createdAt: Date.now() });
      chat.updatedAt = Date.now();
      persistChats();
      setConnection('connected', 'Connected');
      const voicePrefs = loadJSON('yuko.ai.voice.v1', {});
      if (voicePrefs.autoRead) window.dispatchEvent(new CustomEvent('yuko:speak', { detail: reply }));
    } catch (error) {
      const friendly = readableProviderError(error);
      chat.messages.push({ id: makeId(), role: 'assistant', content: `**I couldn’t complete that request.**\n\n${friendly}`, createdAt: Date.now(), isError: true });
      setConnection('error', 'Connection issue');
    } finally {
      state.busy = false;
      $('sendButton').disabled = false;
      renderMessages();
    }
  }

  function readableProviderError(error) {
    let message = error?.message || String(error);
    if (/failed to fetch|networkerror|could not reach/i.test(message)) {
      if (currentProvider() === 'ollama') message += '\n\nFor Ollama, start the Ollama app and allow this site origin in `OLLAMA_ORIGINS` if CORS blocks the request.';
      else message += '\n\nCheck the OpenRouter key, model availability, account limits, and network connection.';
    }
    return message;
  }


  async function getProviderCompletion(chatMessages, model, ephemeralPrompt = null) {
    const provider = currentProvider();
    const contacts = String(state.settings.trustedContacts || '').trim();
    const guard = state.settings.parentalControls ? '\n\nPARENTAL SAFETY IS ON. Refuse explicit sexual content, graphic violence, and age-inappropriate requests. For such requests, briefly reply: This action is restricted by active Parental Controls.' : '';
    const contactsNote = contacts ? '\n\nUser-entered trusted contacts (not independently verified):\n' + contacts + '\nThis app has no outbound messaging integration; do not claim to contact anyone.' : '\n\nNo trusted contacts are configured.';
    const systemMessage = { role: 'system', content: String(state.settings.corePrompt || DEFAULT_CORE_PROMPT) + guard + contactsNote + '\n\nCapability limit: there is no remote execution sandbox. Do not claim generated code was run or tested.' };
    if (provider === 'ollama') {
      const mapped = chatMessages.map((msg, index) => {
        const images = msg.role === 'user' && index === chatMessages.length - 1 ? (msg.attachmentPayloads || []).map((image) => image.base64) : undefined;
        return { role: msg.role, content: msg.content, ...(images && images.length ? { images: images } : {}) };
      });
      const messages = [systemMessage, ...mapped];
      if (ephemeralPrompt !== null) messages.push({ role: 'user', content: ephemeralPrompt });
      const data = await fetchJSON(endpointBase() + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: model, messages: messages, stream: false, options: { temperature: 0.7 } }) });
      return data.message?.content || data.response || '';
    }
    const key = state.settings.openRouterKey.trim();
    if (!key) throw new Error('Add your OpenRouter API key in Settings first.');
    const mapped = chatMessages.map((msg, index) => {
      if (msg.role === 'user' && index === chatMessages.length - 1 && msg.attachmentPayloads && msg.attachmentPayloads.length) {
        const parts = [{ type: 'text', text: msg.content }];
        for (const image of msg.attachmentPayloads) parts.push({ type: 'image_url', image_url: { url: image.dataUrl } });
        return { role: msg.role, content: parts };
      }
      return { role: msg.role, content: msg.content };
    });
    const messages = [systemMessage, ...mapped];
    if (ephemeralPrompt !== null) messages.push({ role: 'user', content: ephemeralPrompt });
    const data = await fetchJSON('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ model: model, messages: messages, temperature: 0.7, max_tokens: 3000 }) });
    return data.choices?.[0]?.message?.content || '';
  }

  async function runPromptHelper(inputId, outputId, title) {
    const prompt = $(inputId).value.trim();
    if (!prompt) { toast('Enter a draft prompt first.', 'error'); return; }
    if (state.busy) return;
    readSettingsForm();
    const button = inputId === 'chatInput' ? $('improvePromptButton') : $('refineImagePromptButton');
    const original = button.innerHTML;
    button.disabled = true;
    button.textContent = 'Working…';
    try {
      const messages = [{ role: 'user', content: `Improve the following ${title} prompt. Preserve the user's goal. Make the result clearer, more descriptive, and ready to paste. Return only the improved prompt, with no preamble:\n\n${prompt}` }];
      const out = await getProviderCompletion(messages, currentModel());
      if (out.trim()) {
        $(outputId).value = out.trim();
        if (outputId === 'chatInput') resizeComposer();
        toast('Prompt improved. Review it before sending.');
      }
    } catch (error) {
      toast(readableProviderError(error), 'error');
    } finally {
      button.disabled = false;
      button.innerHTML = original;
    }
  }

  async function loadOllamaModels(showMessage = true) {
    const endpoint = endpointBase();
    const button = $('refreshOllamaModels');
    button.disabled = true;
    try {
      const data = await fetchJSON(`${endpoint}/api/tags`, {}, 15000);
      const names = (data.models || []).map((model) => model.name || model.model).filter(Boolean);
      if (!names.length) throw new Error('Ollama responded, but no models are installed. Run `ollama pull llama3.2` or download a model in Ollama.');
      setSelectOptions($('ollamaDefaultModel'), names, state.settings.ollamaModel, DEFAULTS.ollamaModel);
      state.settings.ollamaModel = $('ollamaDefaultModel').value;
      updateChatModelOptions();
      setConnection('connected', 'Ollama ready');
      if (showMessage) { setFeedback(`Connected. Found ${names.length} local model${names.length === 1 ? '' : 's'}.`, 'success'); toast('Ollama models loaded.'); }
    } catch (error) {
      setConnection('error', 'Ollama unavailable');
      if (showMessage) setFeedback(readableProviderError(error), 'error');
    } finally {
      button.disabled = false;
    }
  }

  async function testOllama() {
    readSettingsForm();
    $('testOllamaButton').disabled = true;
    $('testOllamaButton').textContent = 'Testing…';
    try {
      const data = await fetchJSON(`${endpointBase()}/api/tags`, {}, 15000);
      const names = (data.models || []).map((model) => model.name || model.model).filter(Boolean);
      setConnection('connected', 'Ollama ready');
      if (names.length) {
        setSelectOptions($('ollamaDefaultModel'), names, state.settings.ollamaModel, DEFAULTS.ollamaModel);
        state.settings.ollamaModel = $('ollamaDefaultModel').value;
        updateChatModelOptions();
      }
      setFeedback(`Connection successful${names.length ? ` — ${names.length} model(s) available` : ', but no models are installed yet'}.`, 'success');
    } catch (error) {
      setConnection('error', 'Ollama unavailable');
      setFeedback(readableProviderError(error), 'error');
    } finally {
      $('testOllamaButton').disabled = false;
      $('testOllamaButton').textContent = 'Test connection';
    }
  }

  async function loadOpenRouterModels() {
    readSettingsForm();
    if (!state.settings.openRouterKey) {
      setFeedback('Enter an OpenRouter API key before loading model options.', 'error');
      return;
    }
    const button = $('refreshOpenRouterModels');
    button.disabled = true;
    try {
      const data = await fetchJSON('https://openrouter.ai/api/v1/models', { headers: { Authorization: `Bearer ${state.settings.openRouterKey}` } }, 25000);
      const models = (data.data || []).filter((model) => {
        const output = model.architecture?.output_modalities;
        return !Array.isArray(output) || output.includes('text');
      });
      models.sort((a, b) => (a.id || '').localeCompare(b.id || ''));
      const ids = ['openrouter/free', ...models.map((model) => model.id)].filter(Boolean);
      setSelectOptions($('openRouterDefaultModel'), ids, state.settings.openRouterModel, 'openrouter/free');
      state.settings.openRouterModel = $('openRouterDefaultModel').value;
      updateChatModelOptions();
      setConnection('connected', 'OpenRouter ready');
      setFeedback(`Loaded ${models.length} chat model options. Free model availability and rate limits can change.`, 'success');
    } catch (error) {
      setConnection('error', 'OpenRouter error');
      setFeedback(readableProviderError(error), 'error');
    } finally {
      button.disabled = false;
    }
  }

  async function loadImageModels() {
    readSettingsForm();
    if (!state.settings.openRouterKey) {
      toast('Enter an OpenRouter API key in Settings to load image models.', 'error');
      return;
    }
    $('refreshImageModels').disabled = true;
    try {
      const data = await fetchJSON('https://openrouter.ai/api/v1/images/models', { headers: { Authorization: `Bearer ${state.settings.openRouterKey}` } }, 25000);
      const models = (data.data || []).map((model) => model.id).filter(Boolean).sort((a, b) => a.localeCompare(b));
      if (!models.length) throw new Error('OpenRouter returned no image models for this request.');
      const selected = $('imageModelSelect').value || 'bytedance-seed/seedream-4.5';
      setSelectOptions($('imageModelSelect'), models, selected, models[0]);
      toast(`Loaded ${models.length} image model options. Check pricing and capabilities before generating.`);
    } catch (error) {
      toast(readableProviderError(error), 'error');
    } finally {
      $('refreshImageModels').disabled = false;
    }
  }

  function selectedStyles() {
    return [...document.querySelectorAll('.style-tag.selected')].map((button) => button.dataset.style).filter(Boolean);
  }

  function imagePromptWithOptions() {
    const base = $('imagePrompt').value.trim();
    const styles = selectedStyles();
    const task = $('imageTask').value;
    const taskText = {
      generate: 'Create a new image based on this prompt.',
      enhance: 'Enhance the supplied reference image: improve clarity, detail, lighting, and visual polish while preserving the core subject and composition.',
      restyle: 'Restyle the supplied reference image using the requested aesthetic while preserving the main subject and important composition.',
      variation: 'Create a distinct but faithful variation of the supplied reference image, keeping the primary subject recognizable.'
    }[task];
    return [taskText, base, styles.length ? `Visual style: ${styles.join(', ')}.` : ''].filter(Boolean).join('\n\n');
  }

  function dataURLFromImageResponse(image) {
    if (image?.b64_json) return `data:image/png;base64,${image.b64_json}`;
    if (image?.url && /^https:\/\//i.test(image.url)) return image.url;
    if (image?.image_url?.url && /^(data:image\/|https:\/\/)/i.test(image.image_url.url)) return image.image_url.url;
    return null;
  }

  function renderGeneratedImages() {
    const container = $('imageResults');
    container.replaceChildren();
    if (!state.generatedImages.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-canvas';
      empty.innerHTML = '<div class="empty-canvas-art"><span class="canvas-star star-one">✦</span><span class="canvas-star star-two">✧</span><div class="canvas-mountain mountain-back"></div><div class="canvas-mountain mountain-front"></div><div class="canvas-sun"></div></div><strong>Your canvas is waiting.</strong><span>Your generated images will appear here.<br>They stay in this browser until you clear them.</span>';
      container.appendChild(empty);
    } else {
      for (const item of state.generatedImages) {
        const card = document.createElement('figure');
        card.className = 'generated-image-card';
        const img = document.createElement('img');
        img.src = item.src;
        img.alt = item.prompt || 'Image generated with Yuko.ai';
        img.loading = 'lazy';
        const caption = document.createElement('figcaption');
        const detail = document.createElement('span');
        detail.textContent = item.model;
        const link = document.createElement('a');
        link.href = item.src;
        link.download = `yuko-image-${new Date(item.createdAt).toISOString().replace(/[:.]/g, '-')}.png`;
        link.textContent = 'Download ↓';
        link.rel = 'noopener';
        caption.append(detail, link);
        card.append(img, caption);
        container.appendChild(card);
      }
    }
    $('resultCount').textContent = `${state.generatedImages.length} image${state.generatedImages.length === 1 ? '' : 's'}`;
  }

  function setGenerating(busy) {
    $('generateButton').disabled = busy;
    $('generationStatus').hidden = !busy;
    $('generationStatus').querySelector('strong').textContent = busy ? 'Creating your image' : '';
    $('generationStatus').querySelector('span:not(.loading-orbit)').textContent = 'Sending directly to OpenRouter…';
    if (busy) $('generateButton').innerHTML = '<span>✧</span> Generating…';
    else $('generateButton').innerHTML = '<span>✧</span> Generate image <span class="generate-arrow">↗</span>';
  }

  async function generateImages(event) {
    event.preventDefault();
    if (state.busy) return;
    readSettingsForm();
    if (!state.settings.openRouterKey) {
      toast('Image generation currently uses OpenRouter. Add your key in Settings first.', 'error');
      navigate('settings');
      return;
    }
    const task = $('imageTask').value;
    if (task !== 'generate' && !state.referenceFile) {
      toast('Choose a reference image for enhancement, restyling, or variation.', 'error');
      $('referenceInput').click();
      return;
    }
    const prompt = imagePromptWithOptions();
    const [, resolution] = $('imageDimensions').value.split('|');
    const [ratio] = $('imageDimensions').value.split('|');
    const payload = {
      model: $('imageModelSelect').value,
      prompt,
      n: Math.max(1, Math.min(4, Number($('imageOutputs').value) || 1)),
      aspect_ratio: ratio,
      resolution: resolution || '1K',
      output_format: 'png'
    };
    if (state.referenceFile && task !== 'generate') payload.input_references = [state.referenceFile.dataUrl];
    setGenerating(true);
    try {
      const data = await fetchJSON('https://openrouter.ai/api/v1/images', {
        method: 'POST', headers: authHeaders(), body: JSON.stringify(payload)
      }, 180000);
      const imageItems = (data.data || []).map(dataURLFromImageResponse).filter(Boolean);
      if (!imageItems.length) {
        const fromChoices = data.choices?.flatMap((choice) => choice.message?.images || []).map(dataURLFromImageResponse).filter(Boolean) || [];
        imageItems.push(...fromChoices);
      }
      if (!imageItems.length) throw new Error('The provider returned no image. Try a different image model, or check its supported size and reference-image parameters.');
      const now = Date.now();
      for (const src of imageItems) state.generatedImages.unshift({ id: makeId(), src, prompt, model: payload.model, createdAt: now });
      renderGeneratedImages();
      setConnection('connected', 'OpenRouter ready');
      toast(`${imageItems.length} image${imageItems.length === 1 ? '' : 's'} created. Check your provider pricing and usage.`);
    } catch (error) {
      toast(readableProviderError(error), 'error');
    } finally {
      setGenerating(false);
    }
  }

  function renderReferencePreview() {
    const preview = $('referencePreview');
    preview.replaceChildren();
    preview.hidden = !state.referenceFile;
    if (!state.referenceFile) return;
    const img = document.createElement('img');
    img.src = state.referenceFile.dataUrl;
    img.alt = 'Selected reference image preview';
    const meta = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = state.referenceFile.name;
    const size = document.createElement('small');
    size.textContent = `${(state.referenceFile.size / 1024 / 1024).toFixed(2)} MB · stored in this tab until you leave`;
    meta.append(name, size);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => {
      state.referenceFile = null;
      $('referenceInput').value = '';
      renderReferencePreview();
    });
    preview.append(img, meta, remove);
  }

  function downloadBlob(filename, content, type = 'application/json') {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportCurrentChat() {
    const chat = getCurrentChat(false);
    if (!chat?.messages?.length) { toast('There is no conversation to export.', 'error'); return; }
    const body = `# ${chat.title}\n\n${chat.messages.map((msg) => `## ${msg.role === 'user' ? 'You' : 'Yuko'}\n\n${msg.content}\n${msg.attachments?.length ? `\nAttachments: ${msg.attachments.map((f) => f.name).join(', ')}\n` : ''}`).join('\n---\n\n')}`;
    downloadBlob(`${(chat.title || 'yuko-chat').replace(/[^a-z0-9-_]+/gi, '-').slice(0, 48)}.md`, body, 'text/markdown');
  }

  function exportAllData() {
    const payload = {
      product: 'Yuko.ai', exportedAt: new Date().toISOString(),
      settings: { ...state.settings, openRouterKey: state.settings.openRouterKey ? '[OMITTED — export for safety]' : '' },
      chats: state.chats,
      agentHistory: loadJSON('yuko.ai.agent.v1', []),
      codeProjects: loadJSON('yuko.ai.codebase.v1', [])
    };
    downloadBlob('yuko-ai-local-data.json', JSON.stringify(payload, null, 2));
    toast('Exported local chats and settings. The API key was omitted.');
  }

  function deleteAllData() {
    if (!window.confirm('Delete all saved Yuko.ai chats, settings, and the OpenRouter key from this browser? This cannot be undone.')) return;
    localStorage.removeItem(KEYS.chats);
    localStorage.removeItem(KEYS.settings);
    localStorage.removeItem('yuko.ai.agent.v1');
    localStorage.removeItem('yuko.ai.codebase.v1');
    localStorage.removeItem('yuko.ai.voice.v1');
    state.chats = [];
    state.activeChatId = null;
    state.currentDraft = null;
    state.settings = { ...DEFAULTS };
    state.pendingFiles = [];
    state.generatedImages = [];
    state.referenceFile = null;
    hydrateSettings();
    renderAttachments();
    renderHistory();
    renderMessages();
    renderGeneratedImages();
    renderReferencePreview();
    setConnection('unknown', 'Not connected');
    toast('Local data deleted.');
  }

  function resizeComposer() {
    const area = $('chatInput');
    area.style.height = 'auto';
    area.style.height = `${Math.min(area.scrollHeight, 190)}px`;
  }

  function wireEvents() {
    document.querySelectorAll('[data-nav]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.nav)));
    $('newChatButton').addEventListener('click', newChat);
    $('sidebarSettingsShortcut').addEventListener('click', () => navigate('settings'));
    $('settingsAvatar').addEventListener('click', () => navigate('settings'));
    $('openSidebar').addEventListener('click', openMobileSidebar);
    $('closeSidebar').addEventListener('click', closeMobileSidebar);
    $('mobileScrim').addEventListener('click', closeMobileSidebar);
    $('clearHistoryButton').addEventListener('click', () => {
      if (!state.chats.length) { toast('No saved chat history to clear.'); return; }
      if (!window.confirm('Delete every saved conversation from this browser?')) return;
      state.chats = [];
      state.activeChatId = null;
      state.currentDraft = null;
      persistChats();
      renderHistory();
      renderMessages();
      toast('Chat history cleared.');
    });
    $('chatForm').addEventListener('submit', sendChat);
    $('chatInput').addEventListener('input', resizeComposer);
    $('chatInput').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        $('chatForm').requestSubmit();
      }
    });
    $('chatFileInput').addEventListener('change', async (event) => {
      await addAttachments(event.target.files);
      event.target.value = '';
    });
    $('improvePromptButton').addEventListener('click', () => runPromptHelper('chatInput', 'chatInput', 'chat'));
    $('exportChatButton').addEventListener('click', exportCurrentChat);
    $('chooseOllama').addEventListener('click', () => {
      state.settings.provider = 'ollama';
      persistSettings(); applyProviderUI(); hideFeedback();
    });
    $('chooseOpenRouter').addEventListener('click', () => {
      state.settings.provider = 'openrouter';
      persistSettings(); applyProviderUI(); hideFeedback();
    });
    $('testOllamaButton').addEventListener('click', testOllama);
    $('refreshOllamaModels').addEventListener('click', () => loadOllamaModels(true));
    $('refreshOpenRouterModels').addEventListener('click', loadOpenRouterModels);
    $('refreshImageModels').addEventListener('click', loadImageModels);
    $('ollamaDefaultModel').addEventListener('change', () => {
      state.settings.ollamaModel = $('ollamaDefaultModel').value;
      if (currentProvider() === 'ollama') setSelectOptions($('chatModelSelect'), [...$('ollamaDefaultModel').options].map((o) => o.value), state.settings.ollamaModel, state.settings.ollamaModel);
      updateChatModelOptions(); persistSettings();
    });
    $('openRouterDefaultModel').addEventListener('change', () => {
      state.settings.openRouterModel = $('openRouterDefaultModel').value;
      if (currentProvider() === 'openrouter') setSelectOptions($('chatModelSelect'), [...$('openRouterDefaultModel').options].map((o) => o.value), state.settings.openRouterModel, state.settings.openRouterModel);
      updateChatModelOptions(); persistSettings();
    });
    $('chatModelSelect').addEventListener('change', () => {
      if (currentProvider() === 'ollama') {
        state.settings.ollamaModel = currentModel();
        if ([...$('ollamaDefaultModel').options].some((o) => o.value === currentModel())) $('ollamaDefaultModel').value = currentModel();
      } else {
        state.settings.openRouterModel = currentModel();
        if ([...$('openRouterDefaultModel').options].some((o) => o.value === currentModel())) $('openRouterDefaultModel').value = currentModel();
      }
      persistSettings();
    });
    $('saveSettingsButton').addEventListener('click', () => { readSettingsForm(); updateParentalSafetyStatus(); toast('Settings saved in this browser.'); });
    $('parentalControlsToggle').addEventListener('change', () => {
      readSettingsForm();
      updateParentalSafetyStatus();
      toast(state.settings.parentalControls ? 'Parental safety ON — saved in this browser.' : 'Parental safety OFF — saved in this browser.');
    });
    $('toggleKeyVisibility').addEventListener('click', () => {
      const input = $('openRouterKey');
      input.type = input.type === 'password' ? 'text' : 'password';
      $('toggleKeyVisibility').textContent = input.type === 'password' ? 'Show' : 'Hide';
    });
    $('exportDataButton').addEventListener('click', exportAllData);
    $('deleteDataButton').addEventListener('click', deleteAllData);
    $('imageForm').addEventListener('submit', generateImages);
    $('refineImagePromptButton').addEventListener('click', () => runPromptHelper('imagePrompt', 'imagePrompt', 'image-generation'));
    $('imageTask').addEventListener('change', () => {
      $('referenceDrop').classList.toggle('reference-required', $('imageTask').value !== 'generate');
    });
    document.querySelectorAll('.style-tag').forEach((button) => button.addEventListener('click', () => button.classList.toggle('selected')));
    $('referenceInput').addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      if (!file.type.startsWith('image/')) { toast('Choose a supported image file.', 'error'); return; }
      if (file.size > MAX_FILE_BYTES) { toast('Reference images must be 10 MB or less.', 'error'); return; }
      try {
        state.referenceFile = { ...fileMeta(file), dataUrl: await readFileAsDataURL(file) };
        renderReferencePreview();
      } catch (error) { toast(error.message, 'error'); }
      event.target.value = '';
    });
    $('referenceDrop').addEventListener('dragover', (event) => { event.preventDefault(); $('referenceDrop').classList.add('drag-over'); });
    $('referenceDrop').addEventListener('dragleave', () => $('referenceDrop').classList.remove('drag-over'));
    $('referenceDrop').addEventListener('drop', async (event) => {
      event.preventDefault(); $('referenceDrop').classList.remove('drag-over');
      const file = event.dataTransfer.files?.[0];      if (!file) return;
      if (!file.type.startsWith('image/') || file.size > MAX_FILE_BYTES) { toast('Choose an image of 10 MB or less.', 'error'); return; }
      state.referenceFile = { ...fileMeta(file), dataUrl: await readFileAsDataURL(file) };
      renderReferencePreview();
    });
    $('clearImagesButton').addEventListener('click', () => { state.generatedImages = []; renderGeneratedImages(); });
    document.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); newChat(); }
      if (event.key === 'Escape') closeMobileSidebar();
    });
  }

  function startup() {
    hydrateSettings();
    wireEvents();
    renderHistory();
    renderMessages();
    renderGeneratedImages();
    renderReferencePreview();
    setConnection('unknown', 'Not connected');
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
      window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
    }
  }

  startup();
})();

