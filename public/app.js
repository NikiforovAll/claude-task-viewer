//#region STATE
let sessions = [];
let currentSessionId = null;
let currentTasks = [];
let viewMode = 'session';
let sessionFilter = 'active';
let sessionLimit = '20';
let filterProject = '__recent__'; // null = all, '__recent__' = last 24h, or project path
let recentProjects = new Set();
let projectsCacheDirty = true;
const collapsedProjectGroups = new Set();
let stableGroupOrder = []; // cached project path order to prevent jumping
let searchQuery = ''; // Search query for fuzzy search
let allTasksCache = []; // Cache all tasks for search
let bulkDeleteSessionId = null; // Track session for bulk delete
let ownerFilter = '';
let currentAgents = [];
let currentWaiting = null;
let lastAgentsHash = '';
let messagePanelOpen = false;
let lastMessagesHash = '';
let lastInlineMessage = '';
let currentMessages = [];
let agentDurationInterval = null;
let selectedTaskId = null;
let selectedSessionId = null;
let focusZone = 'board'; // 'board' | 'sidebar'
let selectedSessionIdx = -1;
let selectedSessionKbId = null;
let sessionJustSelected = false;

function getUrlState() {
  const params = new URLSearchParams(window.location.search);
  return {
    session: params.get('session'),
    view: params.get('view'),
    filter: params.get('filter'),
    limit: params.get('limit'),
    project: params.get('project'),
    owner: params.get('owner'),
    search: params.get('search'),
    messages: params.get('messages') === '1',
  };
}

function updateUrl() {
  const params = new URLSearchParams();
  if (viewMode === 'all') params.set('view', 'all');
  if (currentSessionId) params.set('session', currentSessionId);
  if (sessionFilter !== 'active') params.set('filter', sessionFilter);
  if (sessionLimit !== '20') params.set('limit', sessionLimit);
  if (filterProject && filterProject !== '__recent__') params.set('project', filterProject);
  if (ownerFilter) params.set('owner', ownerFilter);
  if (searchQuery) params.set('search', searchQuery);
  if (messagePanelOpen) params.set('messages', '1');
  const qs = params.toString();
  const url = qs ? `?${qs}` : window.location.pathname;
  history.replaceState(null, '', url);
}

// biome-ignore lint/correctness/noUnusedVariables: used in HTML
function resetState() {
  history.replaceState(null, '', window.location.pathname);
  sessionFilter = 'active';
  sessionLimit = '20';
  filterProject = '__recent__';
  ownerFilter = '';
  searchQuery = '';
  viewMode = 'all';
  currentSessionId = null;
  const searchInput = document.getElementById('search-input');
  if (searchInput) searchInput.value = '';
  document.getElementById('search-clear-btn')?.classList.remove('visible');
  loadPreferences();
  fetchSessions().then(() => showAllTasks());
}

//#endregion

//#region DOM
const sessionsList = document.getElementById('sessions-list');
const noSession = document.getElementById('no-session');
const sessionView = document.getElementById('session-view');
const sessionTitle = document.getElementById('session-title');
const sessionMeta = document.getElementById('session-meta');
const progressPercent = document.getElementById('progress-percent');
const progressBar = document.getElementById('progress-bar');
const pendingTasks = document.getElementById('pending-tasks');
const inProgressTasks = document.getElementById('in-progress-tasks');
const completedTasks = document.getElementById('completed-tasks');
const pendingCount = document.getElementById('pending-count');
const inProgressCount = document.getElementById('in-progress-count');
const completedCount = document.getElementById('completed-count');
const detailPanel = document.getElementById('detail-panel');
const detailContent = document.getElementById('detail-content');
const connectionStatus = document.getElementById('connection-status');
const CONTENT_TRUNCATE_MAX = 1500;
const COLUMNS = [{ el: pendingTasks }, { el: inProgressTasks }, { el: completedTasks }];

let lastSessionsHash = '';
let lastTasksHash = '';

//#endregion

//#region DATA_FETCHING
async function fetchSessions() {
  console.log('[fetchSessions] Starting...');
  try {
    const pinnedParam = pinnedSessionIds.size > 0 ? `&pinned=${[...pinnedSessionIds].join(',')}` : '';
    const res = await fetch(`/api/sessions?limit=${sessionLimit}${pinnedParam}`);
    const newSessions = await res.json();
    const tasksRes = await fetch('/api/tasks/all');
    const newTasks = await tasksRes.json();

    const sessionsHash = JSON.stringify(newSessions);
    const tasksHash = JSON.stringify(newTasks);
    if (sessionsHash === lastSessionsHash && tasksHash === lastTasksHash) {
      console.log('[fetchSessions] No changes, skipping render');
      return;
    }
    lastSessionsHash = sessionsHash;
    lastTasksHash = tasksHash;

    sessions = newSessions;
    allTasksCache = newTasks;
    console.log('[fetchSessions] Sessions loaded:', sessions.length);
    renderSessions();
    console.log('[fetchSessions] Render complete');
    renderLiveUpdatesFromCache();
  } catch (error) {
    console.error('Failed to fetch sessions:', error);
  }
}

// biome-ignore lint/correctness/noUnusedVariables: used in HTML
function handleSearch(query) {
  searchQuery = query.toLowerCase().trim();

  // Show/hide clear button
  const clearBtn = document.getElementById('search-clear-btn');
  if (searchQuery) {
    clearBtn.classList.add('visible');
  } else {
    clearBtn.classList.remove('visible');
  }

  updateUrl();
  renderSessions();
}

// biome-ignore lint/correctness/noUnusedVariables: used in HTML
function clearSearch() {
  const searchInput = document.getElementById('search-input');
  searchInput.value = '';
  searchQuery = '';
  document.getElementById('search-clear-btn').classList.remove('visible');
  updateUrl();
  renderSessions();
}

// biome-ignore lint/correctness/noUnusedVariables: used in HTML
function deleteAllSessionTasks(sessionId) {
  const session = sessions.find((s) => s.id === sessionId);
  if (!session) return;

  // When viewing a single session, currentTasks already contains only that session's tasks
  // When viewing "All Tasks", tasks have sessionId property, so we filter
  const sessionTasks =
    currentSessionId === sessionId ? currentTasks : currentTasks.filter((t) => t.sessionId === sessionId);

  if (sessionTasks.length === 0) {
    alert('No tasks to delete in this session');
    return;
  }

  bulkDeleteSessionId = sessionId;

  const displayName = session.name || sessionId;
  const message = `Delete all ${sessionTasks.length} task(s) from session "${displayName}"?`;

  document.getElementById('delete-session-tasks-message').textContent = message;

  const modal = document.getElementById('delete-session-tasks-modal');
  modal.classList.add('visible');

  // Handle ESC key
  const keyHandler = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeDeleteSessionTasksModal();
      document.removeEventListener('keydown', keyHandler);
    }
  };
  document.addEventListener('keydown', keyHandler);
}

function closeDeleteSessionTasksModal() {
  const modal = document.getElementById('delete-session-tasks-modal');
  modal.classList.remove('visible');
  bulkDeleteSessionId = null;
}

// biome-ignore lint/correctness/noUnusedVariables: used in HTML
async function confirmDeleteSessionTasks() {
  if (!bulkDeleteSessionId) return;

  const sessionId = bulkDeleteSessionId;
  closeDeleteSessionTasksModal();

  // Get tasks to delete
  const sessionTasks =
    currentSessionId === sessionId ? currentTasks : currentTasks.filter((t) => t.sessionId === sessionId);

  // Sort tasks by dependency order (blocked tasks first, then blockers)
  const sortedTasks = topologicalSort(sessionTasks);

  let successCount = 0;
  let failedCount = 0;
  const failedTasks = [];

  for (const task of sortedTasks) {
    try {
      const res = await fetch(`/api/tasks/${sessionId}/${task.id}`, {
        method: 'DELETE',
      });

      if (res.ok) {
        successCount++;
      } else {
        failedCount++;
        const error = await res.json();
        failedTasks.push({ id: task.id, subject: task.subject, error: error.error });
        console.error(`Failed to delete task ${task.id}:`, error);
      }
    } catch (error) {
      failedCount++;
      failedTasks.push({ id: task.id, subject: task.subject, error: 'Network error' });
      console.error(`Error deleting task ${task.id}:`, error);
    }
  }

  // Show result modal
  showDeleteResultModal(successCount, failedCount, failedTasks);

  // Close detail panel if open
  closeDetailPanel();

  // Refresh the view
  await refreshCurrentView();
}

//#endregion

//#region BULK_DELETE
// Topological sort for task deletion order
function topologicalSort(tasks) {
  const result = [];
  const visited = new Set();
  const visiting = new Set();
  const taskMap = new Map(tasks.map((t) => [t.id, t]));

  function visit(taskId) {
    if (visited.has(taskId)) return;
    if (visiting.has(taskId)) return; // Cycle - skip

    visiting.add(taskId);
    const task = taskMap.get(taskId);

    if (task?.blocks && task.blocks.length > 0) {
      // Visit all tasks that this task blocks (dependencies first)
      for (const blockedId of task.blocks) {
        if (taskMap.has(blockedId)) {
          visit(blockedId);
        }
      }
    }

    visiting.delete(taskId);
    visited.add(taskId);
    if (task) result.push(task);
  }

  // Visit all tasks
  for (const task of tasks) {
    visit(task.id);
  }

  return result;
}

function showDeleteResultModal(successCount, failedCount, failedTasks) {
  const modal = document.getElementById('delete-result-modal');
  const messageEl = document.getElementById('delete-result-message');
  const detailsEl = document.getElementById('delete-result-details');

  if (failedCount === 0) {
    messageEl.textContent = `Successfully deleted all ${successCount} task(s).`;
    detailsEl.style.display = 'none';
  } else {
    messageEl.textContent = `Deleted ${successCount} task(s). Failed to delete ${failedCount} task(s).`;

    const failedList = failedTasks
      .map((t) => `<li><strong>${escapeHtml(t.subject)}</strong> (#${escapeHtml(t.id)}): ${escapeHtml(t.error)}</li>`)
      .join('');
    detailsEl.innerHTML = `<ul style="margin: 8px 0 0 0; padding-left: 20px;">${failedList}</ul>`;
    detailsEl.style.display = 'block';
  }

  modal.classList.add('visible');

  // Handle ESC key
  const keyHandler = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeDeleteResultModal();
      document.removeEventListener('keydown', keyHandler);
    }
  };
  document.addEventListener('keydown', keyHandler);
}

function closeDeleteResultModal() {
  const modal = document.getElementById('delete-result-modal');
  modal.classList.remove('visible');
}

function fuzzyMatch(text, query) {
  if (!query) return true;
  if (!text) return false;

  text = text.toLowerCase();
  query = query.toLowerCase();

  // Prioritize exact substring match
  if (text.includes(query)) return true;

  // Split by common delimiters to search in individual words
  const words = text.split(/[\s\-_/.]+/);

  // Check if query matches start of any word
  for (const word of words) {
    if (word.startsWith(query)) return true;
  }

  // Check if any word contains the query
  for (const word of words) {
    if (word.includes(query)) return true;
  }

  return false;
}

//#endregion

//#region LIVE_UPDATES
function renderLiveUpdatesFromCache() {
  let activeTasks = allTasksCache.filter((t) => t.status === 'in_progress' && !isInternalTask(t));
  if (filterProject) {
    activeTasks = activeTasks.filter((t) => matchesProjectFilter(t.project));
  }
  renderLiveUpdates(activeTasks);
}

function toggleSection(containerId, chevronId) {
  const container = document.getElementById(containerId);
  const chevron = document.getElementById(chevronId);
  const collapsed = container.classList.toggle('collapsed');
  chevron.classList.toggle('rotated', collapsed);
  localStorage.setItem(`${containerId}Collapsed`, collapsed);
}

// biome-ignore lint/correctness/noUnusedVariables: used in HTML
function toggleLiveUpdates() {
  toggleSection('live-updates', 'live-updates-chevron');
}

function renderLiveUpdates(activeTasks) {
  const container = document.getElementById('live-updates');

  if (activeTasks.length === 0) {
    container.innerHTML = '<div class="live-empty">No active tasks</div>';
    return;
  }

  container.innerHTML = activeTasks
    .map(
      (task) => `
        <div class="live-item" onclick="openLiveTask('${task.sessionId}', '${task.id}')">
          <span class="pulse"></span>
          <div class="live-item-content">
            <div class="live-item-action" title="${escapeHtml(task.activeForm || task.subject)}">${escapeHtml(task.activeForm || task.subject)}</div>
            <div class="live-item-session" title="${escapeHtml(task.sessionName || task.sessionId)}">${escapeHtml(task.sessionName || task.sessionId)}</div>
          </div>
        </div>
      `,
    )
    .join('');
}

// biome-ignore lint/correctness/noUnusedVariables: used in HTML
async function openLiveTask(sessionId, taskId) {
  await fetchTasks(sessionId);
  showTaskDetail(taskId, sessionId);
}

let lastCurrentTasksHash = '';

async function fetchTasks(sessionId) {
  try {
    viewMode = 'session';
    const res = await fetch(`/api/sessions/${sessionId}`);

    let newTasks;
    if (res.ok) {
      newTasks = await res.json();
    } else if (res.status === 404) {
      newTasks = [];
    } else {
      throw new Error(`Failed to fetch tasks: ${res.status}`);
    }

    const hash = JSON.stringify(newTasks);
    if (sessionId === currentSessionId && hash === lastCurrentTasksHash) {
      console.log('[fetchTasks] No changes, skipping render');
      return;
    }
    lastCurrentTasksHash = hash;

    currentTasks = newTasks;
    currentSessionId = sessionId;
    currentPins = loadPins(sessionId);
    ownerFilter = '';
    lastMessagesHash = '';
    lastInlineMessage = '';
    document.getElementById('latest-message').classList.remove('visible');
    sessionJustSelected = true;
    updateUrl();
    renderSession();
    fetchAgents(sessionId);
    fetchMessages(sessionId);
  } catch (error) {
    console.error('Failed to fetch tasks:', error);
    currentTasks = [];
    currentSessionId = sessionId;
    lastCurrentTasksHash = '';
    updateUrl();
    renderSession();
  }
}

const _AGENT_COOLDOWN_MS = 3 * 60 * 1000;
const _AGENT_STALE_MS = 5 * 60 * 1000; // kept for reference; no longer used for force-stopping
const WAITING_TTL_MS = 30 * 60 * 1000;
const AGENT_LOG_MAX = 8;

async function fetchAgents(sessionId) {
  try {
    const res = await fetch(`/api/sessions/${sessionId}/agents`);
    if (!res.ok) {
      currentAgents = [];
      currentWaiting = null;
      renderAgentFooter();
      return;
    }
    const data = await res.json();
    const agents = Array.isArray(data) ? data : data.agents || [];
    currentWaiting = data.waitingForUser || null;
    const hash = JSON.stringify(data);
    if (hash === lastAgentsHash) return;
    lastAgentsHash = hash;
    currentAgents = agents;
    renderAgentFooter();
  } catch (e) {
    console.error('[fetchAgents]', e);
  }
}

//#endregion

//#region MESSAGE_PANEL
function toggleMessagePanel() {
  const panel = document.getElementById('message-panel');
  messagePanelOpen = !messagePanelOpen;
  panel.classList.toggle('visible', messagePanelOpen);
  document.getElementById('message-toggle')?.classList.toggle('active', messagePanelOpen);
  if (messagePanelOpen && currentSessionId) {
    if (currentMessages.length) renderMessages(currentMessages);
    fetchMessages(currentSessionId);
  }
  updateUrl();
}

// biome-ignore lint/correctness/noUnusedVariables: used in HTML
function openLiveLatestMessage() {
  if (currentMessages.length) {
    msgDetailFollowLatest = true;
    showMsgDetail(currentMessages.length - 1);
  }
}

async function fetchMessages(sessionId) {
  try {
    const res = await fetch(`/api/sessions/${sessionId}/messages?limit=15`);
    if (!res.ok) return;
    const data = await res.json();
    const hash = JSON.stringify(data.messages);
    if (hash === lastMessagesHash) return;
    lastMessagesHash = hash;
    currentMessages = data.messages;
    let agentEnriched = false;
    for (const m of data.messages) {
      if (m.agentId && m.agentPrompt) {
        const agent = currentAgents.find((a) => a.agentId === m.agentId);
        if (agent && !agent.prompt) {
          agent.prompt = m.agentPrompt;
          agentEnriched = true;
        }
      }
    }
    if (agentEnriched) renderAgentFooter();
    updateLatestMessage(data.messages);
    if (messagePanelOpen) renderMessages(data.messages);
    if (msgDetailFollowLatest && data.messages.length) {
      showMsgDetail(data.messages.length - 1);
    }
  } catch (e) {
    console.error('[fetchMessages]', e);
  }
}

function parseCommandMessage(text) {
  const nameMatch = text.match(/<command-name>([^<]+)<\/command-name>/);
  if (nameMatch) return nameMatch[1].trim();
  const msgMatch = text.match(/<command-message>([^<]+)<\/command-message>/);
  if (msgMatch) return `/${msgMatch[1].trim()}`;
  return null;
}

function cleanMessageText(text) {
  const cmd = parseCommandMessage(text);
  if (cmd) return cmd;
  return stripAnsi(text)
    .replace(/<[^>]+>/g, '')
    .replace(/\*\*/g, '')
    .replace(/^#+\s*/gm, '')
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function updateLatestMessage(messages) {
  const el = document.getElementById('latest-message');
  let last = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].type === 'assistant' || (messages[i].type === 'user' && !messages[i].systemLabel)) {
      last = messages[i];
      break;
    }
  }
  if (!last) {
    el.classList.remove('visible');
    lastInlineMessage = '';
    return;
  }
  const label = last.type === 'assistant' ? 'Claude' : 'User';
  const cleaned = cleanMessageText(last.text);
  const text = cleaned.length > 120 ? `${cleaned.slice(0, 120)}...` : cleaned;
  const labelCls = last.type === 'assistant' ? 'lm-label lm-label-assistant' : 'lm-label';
  const html = `<span class="${labelCls}">${escapeHtml(label)}:</span> ${escapeHtml(text)}`;
  el.innerHTML = html;
  el.classList.add('visible');
  if (lastInlineMessage !== html) {
    lastInlineMessage = html;
    renderSessions();
  }
}

function renderMsgPinBtn(m, i) {
  const pinned = isPinned(m);
  return `<button class="msg-pin-btn${pinned ? ' pinned' : ''}" onclick="event.stopPropagation();togglePin(${i})" title="${pinned ? 'Unpin' : 'Pin'} message">${PIN_SVG}</button>`;
}

function renderPinnedSection() {
  if (!currentPins.length) return '';
  const chevron =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><path d="M6 9l6 6 6-6"/></svg>';
  const items = currentPins
    .map((p, pi) => {
      const click = `onclick="showPinnedMsgDetail(${pi})" style="cursor:pointer"`;
      const unpin = `<button class="pinned-item-unpin" onclick="event.stopPropagation();unpinById(${pi})" title="Unpin">${PIN_SVG}</button>`;
      if (p.type === 'user') {
        const text = escapeHtml(cleanMessageText(p.text || ''));
        return `<div class="msg-item msg-user" ${click}>
            ${MSG_ICON_USER}
            <div class="msg-body"><div class="msg-text">${text}</div><div class="msg-time">${formatDate(p.timestamp)}</div></div>${unpin}
          </div>`;
      } else if (p.type === 'assistant') {
        return `<div class="msg-item msg-assistant" ${click}>
            ${MSG_ICON_ASSISTANT}
            <div class="msg-body"><div class="msg-text">${escapeHtml(cleanMessageText(p.text || ''))}</div><div class="msg-time">${formatDate(p.timestamp)}</div></div>${unpin}
          </div>`;
      } else if (p.type === 'tool_use') {
        const toolDetail = p.detail ? ` <span style="color:var(--text-muted)">${escapeHtml(p.detail)}</span>` : '';
        return `<div class="msg-item msg-tool" ${click}>
            ${MSG_ICON_TOOL}
            <div class="msg-body"><div class="msg-text">${escapeHtml(p.tool || '')}${toolDetail}</div><div class="msg-time">${formatDate(p.timestamp)}</div></div>${unpin}
          </div>`;
      } else if (p.type === 'agent') {
        const agentClick = `onclick="showAgentModal('${escapeHtml(p.agentId)}')" style="cursor:pointer"`;
        const msgTrunc = p.lastMessage
          ? escapeHtml(
              stripAnsi(p.lastMessage.trim())
                .replace(/[\r\n]+/g, ' ')
                .slice(0, 60),
            )
          : '';
        const agentDetail = msgTrunc ? ` <span style="color:var(--text-muted)">${msgTrunc}</span>` : '';
        return `<div class="msg-item msg-tool" ${agentClick}>
            ${MSG_ICON_TOOL}
            <div class="msg-body"><div class="msg-text">${escapeHtml(p.agentType || 'Agent')}${agentDetail}</div><div class="msg-time">${formatDate(p.timestamp)}</div></div>${unpin}
          </div>`;
      }
      return '';
    })
    .join('');
  const label = `Pinned (${currentPins.length})`;
  const hasItems = currentPins.length > 0;
  return `<div class="pinned-section">
        <div class="pinned-header${pinnedCollapsed ? ' collapsed' : ''}${hasItems ? '' : ' empty'}" ${hasItems ? 'onclick="togglePinnedCollapse()"' : ''}>
          <span>${label}</span>${hasItems ? chevron : ''}
        </div>
        ${hasItems ? `<div class="pinned-items${pinnedCollapsed ? ' collapsed' : ''}">${items}</div>` : ''}
      </div>`;
}

function renderMessages(messages) {
  const container = document.getElementById('message-panel-content');
  const pinnedContainer = document.getElementById('message-panel-pinned');
  pinnedContainer.innerHTML = renderPinnedSection();
  if (!messages.length) {
    container.innerHTML = '<div class="msg-empty">No messages found for this session</div>';
    return;
  }
  const msgsHtml = messages
    .map((m, i) => {
      const pinBtn = renderMsgPinBtn(m, i);
      const clickable = `onclick="msgDetailFollowLatest=false;showMsgDetail(${i})" style="cursor:pointer"`;
      if (m.type === 'user') {
        if (m.systemLabel) {
          return `<div class="msg-item msg-system" ${clickable}>
              ${MSG_ICON_SYSTEM}
              <div class="msg-body"><div class="msg-text"><code>${escapeHtml(m.systemLabel)}</code></div><div class="msg-time">${formatDate(m.timestamp)}</div></div>${pinBtn}
            </div>`;
        }
        const cmd = parseCommandMessage(m.text);
        const displayText = cmd ? cmd : escapeHtml(cleanMessageText(m.text));
        const isCmd = !!cmd;
        return `<div class="msg-item msg-user${isCmd ? ' msg-cmd' : ''}" ${clickable}>
            ${MSG_ICON_USER}
            <div class="msg-body"><div class="msg-text">${isCmd ? `<code>${escapeHtml(displayText)}</code>` : displayText}</div><div class="msg-time">${formatDate(m.timestamp)}</div></div>${pinBtn}
          </div>`;
      } else if (m.type === 'assistant') {
        return `<div class="msg-item msg-assistant" ${clickable}>
            ${MSG_ICON_ASSISTANT}
            <div class="msg-body"><div class="msg-text">${escapeHtml(cleanMessageText(m.text))}</div><div class="msg-time">${m.model ? `${escapeHtml(m.model)} · ` : ''}${formatDate(m.timestamp)}</div></div>${pinBtn}
          </div>`;
      } else if (m.type === 'tool_use') {
        const toolDetail = m.detail ? ` <span style="color:var(--text-muted)">${escapeHtml(m.detail)}</span>` : '';
        const agentLink =
          m.tool === 'Agent' && m.agentId
            ? ` <span class="msg-agent-link" title="View agent" onclick="event.stopPropagation();showAgentModal('${escapeHtml(m.agentId)}')">⇗</span>`
            : '';
        const itemClick =
          m.tool === 'Agent' && m.agentId
            ? `onclick="showAgentModal('${escapeHtml(m.agentId)}')" style="cursor:pointer"`
            : clickable;
        return `<div class="msg-item msg-tool" ${itemClick}>
            ${MSG_ICON_TOOL}
            <div class="msg-body"><div class="msg-text">${escapeHtml(m.tool)}${toolDetail}${agentLink}</div><div class="msg-time">${formatDate(m.timestamp)}</div></div>${pinBtn}
          </div>`;
      }
      return '';
    })
    .join('');
  container.innerHTML = msgsHtml;
  container.scrollTop = container.scrollHeight;
}

let currentMsgDetailIdx = null;
let msgDetailFollowLatest = false;
let currentPins = [];
let pinnedCollapsed = false;

const PIN_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>';
const MSG_ICON_USER =
  '<svg class="msg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
const MSG_ICON_ASSISTANT =
  '<svg class="msg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="9" cy="16" r="1.5"/><circle cx="15" cy="16" r="1.5"/><path d="M12 2v4M8 7h8"/></svg>';
const MSG_ICON_TOOL =
  '<svg class="msg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>';
const MSG_ICON_SYSTEM =
  '<svg class="msg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';

function getPinId(m) {
  const content = m.type === 'tool_use' ? `${m.tool}:${(m.detail || '').slice(0, 100)}` : (m.text || '').slice(0, 100);
  return `${m.type}|${m.timestamp}|${content}`;
}

function loadPins(sessionId) {
  try {
    return JSON.parse(localStorage.getItem(`pinned-messages-${sessionId}`)) || [];
  } catch {
    return [];
  }
}

function savePins(sessionId, pins) {
  localStorage.setItem(`pinned-messages-${sessionId}`, JSON.stringify(pins));
}

function isPinned(m) {
  return currentPins.some((p) => p.id === getPinId(m));
}

function isAgentPinned(agentId) {
  return currentPins.some((p) => p.id === `agent|${agentId}`);
}

function toggleAgentPin(agentId) {
  const agent = currentAgents.find((a) => a.agentId === agentId);
  if (!agent || !currentSessionId) return;
  const id = `agent|${agentId}`;
  const idx = currentPins.findIndex((p) => p.id === id);
  if (idx >= 0) {
    currentPins.splice(idx, 1);
  } else {
    pinnedCollapsed = false;
    currentPins.push({
      id,
      type: 'agent',
      agentId: agent.agentId,
      agentType: agent.type || 'unknown',
      lastMessage: agent.lastMessage || null,
      timestamp: agent.startedAt || agent.updatedAt,
      pinnedAt: new Date().toISOString(),
    });
  }
  savePins(currentSessionId, currentPins);
  renderMessages(currentMessages);
  renderAgentFooter();
}

function togglePin(msgIndex) {
  const m = currentMessages[msgIndex];
  if (!m || !currentSessionId) return;
  const id = getPinId(m);
  const idx = currentPins.findIndex((p) => p.id === id);
  if (idx >= 0) {
    currentPins.splice(idx, 1);
  } else {
    pinnedCollapsed = false;
    currentPins.push({
      id,
      type: m.type,
      text: m.text || null,
      fullText: m.fullText || null,
      tool: m.tool || null,
      detail: m.detail || null,
      fullDetail: m.fullDetail || null,
      description: m.description || null,
      timestamp: m.timestamp,
      model: m.model || null,
      agentId: m.agentId || null,
      agentPrompt: m.agentPrompt || null,
      agentLastMessage: m.agentLastMessage || null,
      pinnedAt: new Date().toISOString(),
    });
  }
  savePins(currentSessionId, currentPins);
  renderMessages(currentMessages);
  updateMsgDetailPinState();
}

function unpinById(pinIdx) {
  if (!currentSessionId || pinIdx < 0 || pinIdx >= currentPins.length) return;
  const wasAgent = currentPins[pinIdx].type === 'agent';
  currentPins.splice(pinIdx, 1);
  savePins(currentSessionId, currentPins);
  renderMessages(currentMessages);
  if (wasAgent) renderAgentFooter();
  updateMsgDetailPinState();
}

// biome-ignore lint/correctness/noUnusedVariables: used in HTML
function togglePinFromModal() {
  if (currentMsgDetailIdx != null && currentMessages[currentMsgDetailIdx]) {
    togglePin(currentMsgDetailIdx);
  } else if (currentPinDetailId != null) {
    const pinIdx = currentPins.findIndex((p) => p.id === currentPinDetailId);
    if (pinIdx >= 0) unpinById(pinIdx);
    currentPinDetailId = null;
    closeMsgDetailModal();
  }
}

let currentPinDetailId = null;

// biome-ignore lint/correctness/noUnusedVariables: used in HTML
function showPinnedMsgDetail(pinIdx) {
  const pin = currentPins[pinIdx];
  if (!pin) return;
  const idx = currentMessages.findIndex((m) => getPinId(m) === pin.id);
  if (idx >= 0) {
    currentPinDetailId = null;
    showMsgDetail(idx);
    return;
  }
  currentMsgDetailIdx = null;
  currentPinDetailId = pin.id;
  const body = document.getElementById('msg-detail-body');
  const agentBtn = document.getElementById('msg-detail-agent-btn');
  if (pin.type === 'tool_use') {
    document.getElementById('msg-detail-title').textContent = pin.tool || 'Tool';
    const fullText = pin.fullDetail || pin.detail || '';
    const pinParamsHtml = renderToolParamsHtml(pin.params);
    const pinResultHtml = renderToolResultHtml(pin.toolResult, pin.toolResultTruncated, pin.toolResultFull);
    const pinDetailEscaped = escapeHtml(fullText);
    const pinDetailRendered = pin.tool === 'Bash' ? highlightBash(pinDetailEscaped) : pinDetailEscaped;
    body.innerHTML =
      (fullText ? `<pre class="msg-detail-pre">${pinDetailRendered}</pre>` : '<em>No details</em>') +
      pinParamsHtml +
      pinResultHtml;
    agentBtn.style.display = 'none';
  } else {
    const text = stripAnsi(pin.fullText || pin.text || '');
    document.getElementById('msg-detail-title').textContent = pin.type === 'assistant' ? 'Claude' : 'User';
    agentBtn.style.display = 'none';
    body.innerHTML = renderMarkdown(text);
  }
  document.getElementById('msg-detail-meta').textContent = formatDate(pin.timestamp);
  const pinModal = document.getElementById('msg-detail-modal').querySelector('.modal');
  autoSizeModal(pinModal, body);
  const pinBtn = document.getElementById('msg-detail-pin-btn');
  if (pinBtn) pinBtn.classList.add('active');
  document.getElementById('msg-detail-modal').classList.add('visible');
}

function updateMsgDetailPinState() {
  const pinBtn = document.getElementById('msg-detail-pin-btn');
  if (!pinBtn) return;
  if (currentMsgDetailIdx != null && currentMessages[currentMsgDetailIdx]) {
    pinBtn.classList.toggle('active', isPinned(currentMessages[currentMsgDetailIdx]));
  } else if (currentPinDetailId) {
    pinBtn.classList.toggle(
      'active',
      currentPins.some((p) => p.id === currentPinDetailId),
    );
  }
}

// biome-ignore lint/correctness/noUnusedVariables: used in HTML
function togglePinnedCollapse() {
  pinnedCollapsed = !pinnedCollapsed;
  const header = document.querySelector('.pinned-header');
  const items = document.querySelector('.pinned-items');
  if (header) header.classList.toggle('collapsed', pinnedCollapsed);
  if (items) items.classList.toggle('collapsed', pinnedCollapsed);
}

//#endregion

//#region PINNING
let pinnedSessionIds = new Set();

function loadPinnedSessions() {
  try {
    return new Set(JSON.parse(localStorage.getItem('pinned-sessions')) || []);
  } catch {
    return new Set();
  }
}

function savePinnedSessions() {
  localStorage.setItem('pinned-sessions', JSON.stringify([...pinnedSessionIds]));
}

// biome-ignore lint/correctness/noUnusedVariables: used in HTML
function toggleSessionPin(sessionId) {
  if (pinnedSessionIds.has(sessionId)) pinnedSessionIds.delete(sessionId);
  else pinnedSessionIds.add(sessionId);
  savePinnedSessions();
  renderSessions();
}

const SESSION_PIN_SVG = PIN_SVG.replace('width="14" height="14"', 'width="12" height="12"');

//#endregion

//#region MODALS
function showMsgDetail(idx) {
  currentMsgDetailIdx = idx;
  const m = currentMessages[idx];
  if (!m) return;
  const body = document.getElementById('msg-detail-body');
  if (m.type === 'tool_use') {
    document.getElementById('msg-detail-title').textContent = m.tool;
    const fullText = m.fullDetail || m.detail || '';
    const descHtml =
      m.description && m.description !== fullText
        ? `<div style="margin-bottom:8px;color:var(--text-secondary);font-size:0.85rem">${escapeHtml(m.description)}</div>`
        : '';
    let agentExtraHtml = '';
    const agentBtn = document.getElementById('msg-detail-agent-btn');
    if (m.tool === 'Agent' && m.agentId) {
      const agentRespText = m.agentLastMessage ? stripAnsi(m.agentLastMessage.trim()) : null;
      const agentPromptText = m.agentPrompt || null;
      const respHtml = agentRespText ? renderMarkdown(agentRespText) : null;
      const promptHtml = agentPromptText ? renderMarkdown(agentPromptText) : null;
      agentExtraHtml += renderAgentTabs(promptHtml, respHtml, agentPromptText, agentRespText);
      agentBtn.style.display = '';
      agentBtn.dataset.agentId = m.agentId;
    } else {
      agentBtn.style.display = 'none';
    }
    const toolParamsHtml = renderToolParamsHtml(m.params);
    const toolResultHtml = renderToolResultHtml(m.toolResult, m.toolResultTruncated, m.toolResultFull);
    const hasAgentTabs = m.tool === 'Agent' && m.agentId && (m.agentLastMessage || m.agentPrompt);
    let mainHtml;
    if (hasAgentTabs) {
      mainHtml = descHtml || '';
    } else if (fullText) {
      const detailEscaped = escapeHtml(fullText);
      const detailRendered = m.tool === 'Bash' ? highlightBash(detailEscaped) : detailEscaped;
      mainHtml = `${descHtml}<pre class="msg-detail-pre">${detailRendered}</pre>`;
    } else {
      mainHtml = '<em>No details</em>';
    }
    body.innerHTML = mainHtml + toolParamsHtml + (hasAgentTabs ? '' : toolResultHtml) + agentExtraHtml;
  } else {
    const text = stripAnsi(m.fullText || m.text);
    document.getElementById('msg-detail-title').textContent =
      m.type === 'assistant' ? 'Claude' : m.systemLabel ? 'System' : 'User';
    document.getElementById('msg-detail-agent-btn').style.display = 'none';
    if (m.compactSummary) {
      body.innerHTML = renderMarkdown(m.compactSummary);
    } else {
      body.innerHTML = renderMarkdown(text);
    }
  }
  const modal = document.getElementById('msg-detail-modal').querySelector('.modal');
  autoSizeModal(modal, body);
  modal.classList.toggle('live', msgDetailFollowLatest);
  const overlay = document.getElementById('msg-detail-modal');
  overlay.classList.toggle('live-overlay', msgDetailFollowLatest);

  const meta = [formatDate(m.timestamp)];
  if (m.model) meta.unshift(m.model);
  meta.push(`${idx + 1} of ${currentMessages.length}`);
  document.getElementById('msg-detail-meta').textContent = meta.join(' · ');
  currentPinDetailId = null;
  updateMsgDetailPinState();
  overlay.classList.add('visible');
}

function closeMsgDetailModal() {
  resetModalFullscreen('msg-detail-modal');
  msgDetailFollowLatest = false;
}

// biome-ignore lint/correctness/noUnusedVariables: used in HTML
function toggleModalFullscreen(modalId) {
  const modal = document.querySelector(`#${modalId} .modal`);
  const isFs = modal.classList.toggle('fullscreen');
  updateFullscreenBtnIcon(`${modalId}-fullscreen-btn`, isFs);
}

function resetModalFullscreen(modalId) {
  const modal = document.getElementById(modalId);
  modal.classList.remove('visible');
  modal.querySelector('.modal').classList.remove('fullscreen');
  updateFullscreenBtnIcon(`${modalId}-fullscreen-btn`, false);
  return modal;
}

function updateFullscreenBtnIcon(btnId, isFullscreen) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.innerHTML = isFullscreen
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
}

let _toastTimer = null;
//#endregion

//#region TOAST
function showToast(msg) {
  const el = document.getElementById('toast');
  clearTimeout(_toastTimer);
  el.style.transition = 'none';
  el.classList.remove('visible');
  void el.offsetHeight;
  el.style.transition = '';
  el.textContent = msg;
  el.classList.add('visible');
  _toastTimer = setTimeout(() => el.classList.remove('visible'), 2000);
}

async function copyWithFeedback(text, btn) {
  if (btn.dataset.copying) return;
  try {
    await navigator.clipboard.writeText(text);
    btn.dataset.copying = '1';
    const svg = btn.innerHTML;
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M20 6L9 17l-5-5"/></svg>';
    setTimeout(() => {
      btn.innerHTML = svg;
      delete btn.dataset.copying;
    }, 1500);
  } catch (e) {
    console.error('Failed to copy:', e);
  }
}

//#endregion

//#region TOOL_RENDERING
function renderToolParamsHtml(params) {
  if (!params) return '';
  const BLOCK_KEYS = new Set(['old_string', 'new_string', 'content']);
  const badges = [],
    blocks = [];
  for (const [k, v] of Object.entries(params)) {
    if (BLOCK_KEYS.has(k)) continue;
    const display = typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v);
    if (display.length > 60) {
      blocks.push({ k, display });
    } else {
      badges.push(
        `<span style="display:inline-flex;align-items:center;gap:3px;padding:1px 6px;border-radius:3px;background:var(--bg-secondary);font-size:0.75rem"><span style="color:var(--text-muted)">${escapeHtml(k)}:</span> ${escapeHtml(display)}</span>`,
      );
    }
  }
  let html = '';
  if (badges.length) html += `<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px">${badges.join('')}</div>`;
  for (const { k, display } of blocks) {
    html += `<div style="margin-top:6px;font-size:0.75rem"><span style="color:var(--text-muted)">${escapeHtml(k)}:</span> <span style="word-break:break-all">${escapeHtml(display)}</span></div>`;
  }
  if (params.old_string || params.new_string) {
    html += `<div style="margin-top:8px;padding-top:6px;border-top:1px solid var(--border)">`;
    if (params.old_string) {
      html += `<div style="font-size:0.75rem;color:var(--text-muted);margin-bottom:2px">old_string</div>
            <pre class="msg-detail-pre" style="max-height:200px;overflow:auto;border-left:3px solid #e55;padding-left:8px">${escapeHtml(params.old_string)}</pre>`;
    }
    if (params.new_string) {
      html += `<div style="font-size:0.75rem;color:var(--text-muted);margin-bottom:2px;margin-top:6px">new_string</div>
            <pre class="msg-detail-pre" style="max-height:200px;overflow:auto;border-left:3px solid #5b5;padding-left:8px">${escapeHtml(params.new_string)}</pre>`;
    }
    html += `</div>`;
  }
  if (params.content) {
    const contentTruncated = params.content.length > CONTENT_TRUNCATE_MAX;
    const truncContent = contentTruncated
      ? `${params.content.slice(0, CONTENT_TRUNCATE_MAX)}\n... (truncated)`
      : params.content;
    let writeMoreBtn = '',
      fullBlock = '';
    if (contentTruncated) {
      const toggle = makeExpandToggle(escapeHtml(truncContent), escapeHtml(params.content), {
        fontSize: '0.75rem',
        maxHeight: '500px',
      });
      writeMoreBtn = ` ${toggle.btn}`;
      fullBlock = toggle.full;
    }
    html += `<div style="margin-top:8px;padding-top:6px;border-top:1px solid var(--border)">
          <div style="font-size:0.75rem;color:var(--text-muted);margin-bottom:2px">content${writeMoreBtn}</div>
          <pre class="msg-detail-pre" style="max-height:300px;overflow:auto">${escapeHtml(truncContent)}</pre>
          ${fullBlock}
        </div>`;
  }
  return html;
}

// Strip cat -n style line number prefix (e.g. "   1→" or "   1\t") from tool output
function stripLineNumbers(text) {
  return text.replace(/^ *\d+[→\t]/gm, '');
}

function highlightBash(escaped) {
  return escaped
    .replace(/^(\s*)(#.*)$/gm, '$1<span style="color:#6a9955">$2</span>')
    .replace(/(&#x27;[\s\S]*?&#x27;|&quot;[\s\S]*?&quot;)/g, '<span style="color:#ce9178">$1</span>')
    .replace(
      /\b(if|then|else|elif|fi|for|do|done|while|until|case|esac|function|return|in|select)\b/g,
      '<span style="color:#c586c0">$1</span>',
    )
    .replace(
      /\b(echo|cd|ls|cat|grep|awk|sed|rm|cp|mv|mkdir|chmod|chown|export|source|exit|test|read|printf|set|unset|eval|exec|trap|wait|kill|sudo|apt|npm|npx|git|docker|curl|wget|pip|python|node|make|dotnet)\b/g,
      '<span style="color:#569cd6">$1</span>',
    )
    .replace(/(\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*)/g, '<span style="color:#9cdcfe">$1</span>')
    .replace(/((?:^|\s)(?:&amp;&amp;|\|\||[|;])(?:\s|$))/g, '<span style="color:#d4d4d4;font-weight:bold">$1</span>');
}

let _expandIdCounter = 0;
function makeExpandToggle(_truncatedHtml, fullHtml, opts = {}) {
  const id = `expand-${++_expandIdCounter}`;
  const fontSize = opts.fontSize || '0.8rem';
  const maxHeight = opts.maxHeight || '';
  const btn = `<button onclick="var f=document.getElementById('${id}'),t=this.parentElement.nextElementSibling,expand=f.style.display==='none';f.style.display=expand?'block':'none';t.style.display=expand?'none':'block';this.textContent=expand?'Show less':'Show more'" style="background:none;border:none;color:var(--accent);cursor:pointer;font-size:${fontSize};text-decoration:underline;margin-left:6px">Show more</button>`;
  const mhStyle = maxHeight ? `max-height:${maxHeight};` : '';
  const full = `<pre id="${id}" class="msg-detail-pre" style="${mhStyle}overflow:auto;display:none">${fullHtml}</pre>`;
  return { btn, full };
}

function autoSizeModal(modal, body) {
  const hasTable = body.querySelector('table') !== null;
  const hasPre = body.querySelector('pre') !== null;
  const desired = hasTable ? 1100 : body.textContent.length > 2000 || hasPre ? 960 : 860;
  const current = parseFloat(getComputedStyle(modal).maxWidth) || 0;
  if (desired > current) modal.style.maxWidth = `${desired}px`;
}

function renderToolResultHtml(toolResult, isTruncated, fullResult) {
  if (!toolResult) return '';
  const stripped = stripLineNumbers(toolResult);
  const escaped = escapeHtml(stripped);
  let truncLabel = '',
    fullBlock = '';
  if (isTruncated && fullResult) {
    const toggle = makeExpandToggle(escaped, escapeHtml(stripLineNumbers(fullResult)));
    truncLabel = toggle.btn;
    fullBlock = toggle.full;
  } else if (isTruncated) {
    truncLabel = '<span style="color:var(--text-muted);font-size:0.8rem;margin-left:6px">(truncated)</span>';
  }
  return `<div style="margin-top:10px;padding-top:8px;border-top:1px solid var(--border)">
        <div style="font-size:0.8rem;color:var(--text-muted);margin-bottom:4px">Output${truncLabel}</div>
        <pre class="msg-detail-pre" style="overflow:auto">${escaped}</pre>
        ${fullBlock}
      </div>`;
}

function buildToolContent(m) {
  let content = m.fullDetail || m.detail || '';
  if (m.toolResult) content += `\n\n--- Output ---\n\n${m.toolResultFull || m.toolResult}`;
  return content;
}

function getDetailMsg() {
  if (currentMsgDetailIdx != null) return currentMessages[currentMsgDetailIdx];
  if (currentPinDetailId) return currentPins.find((p) => p.id === currentPinDetailId);
  return null;
}

// biome-ignore lint/correctness/noUnusedVariables: used in HTML
async function copyMsgToClipboard(btn) {
  const m = getDetailMsg();
  if (!m) return;
  const content = m.type === 'tool_use' ? buildToolContent(m) : stripAnsi(m.fullText || m.text);
  copyWithFeedback(content, btn);
}

async function postAndToast(url, body, label) {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    showToast(r.ok ? `Opened ${label}` : `Failed to open ${label}`);
  } catch (_e) {
    showToast(`Failed to open ${label}`);
  }
}

// biome-ignore lint/correctness/noUnusedVariables: used in HTML
async function openMsgInEditor() {
  const m = getDetailMsg();
  if (!m) return;
  const content = m.type === 'tool_use' ? buildToolContent(m) : stripAnsi(m.fullText || m.text);
  const title = m.type === 'tool_use' ? m.tool : m.type;
  postAndToast('/api/open-in-editor', { content, title }, 'in editor');
}

function formatDuration(ms) {
  if (!ms) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

//#endregion

//#region AGENTS
function renderAgentFooter() {
  const footer = document.getElementById('agent-footer');
  const content = document.getElementById('agent-footer-content');
  const label = document.getElementById('agent-footer-label');
  const now = Date.now();

  const agents = currentAgents;
  // Filter shutdown ghosts: for same-type agents, keep if they overlapped (parallel)
  // or started >30s after previous stopped (legitimate re-spawn). Filter the rest.
  const byType = {};
  for (const a of agents) {
    if (!byType[a.type]) byType[a.type] = [];
    byType[a.type].push(a);
  }
  const filtered = [];
  for (const group of Object.values(byType)) {
    group.sort((a, b) => new Date(a.startedAt || 0) - new Date(b.startedAt || 0));
    filtered.push(group[0]);
    for (let i = 1; i < group.length; i++) {
      const prev = group[i - 1];
      const prevStop = prev.stoppedAt ? new Date(prev.stoppedAt).getTime() : Infinity;
      const curStart = new Date(group[i].startedAt || 0).getTime();
      const overlapped = curStart < prevStop;
      const reSpawn = curStart - prevStop > 30000;
      const isActive = group[i].status === 'active' || group[i].status === 'idle';
      if (overlapped || reSpawn || isActive) filtered.push(group[i]);
    }
  }
  // Sort by updatedAt desc, keep up to 7 most recent
  const visible = filtered
    .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))
    .slice(0, AGENT_LOG_MAX);

  const permFresh = currentWaiting?.timestamp && now - new Date(currentWaiting.timestamp).getTime() < WAITING_TTL_MS;

  if (visible.length === 0 && !permFresh) {
    footer.classList.remove('visible');
    clearInterval(agentDurationInterval);
    agentDurationInterval = null;
    return;
  }

  footer.classList.add('visible');
  label.textContent = `Agents Log (${visible.length})`;

  const collapsed = localStorage.getItem('agentFooterCollapsed') === 'true';
  footer.classList.toggle('collapsed', collapsed);
  document.getElementById('agent-footer-toggle').innerHTML = collapsed ? '&#x25B4;' : '&#x25BE;';

  const permHtml = permFresh
    ? `<div class="permission-badge">${currentWaiting.kind === 'question' ? '❓ Question pending' : `⏳ Awaiting: ${escapeHtml(currentWaiting.toolName || 'unknown')}`}</div>`
    : '';

  content.innerHTML =
    permHtml +
    visible
      .map((a) => {
        const elapsed =
          a.status === 'stopped' && a.stoppedAt
            ? new Date(a.stoppedAt).getTime() - new Date(a.startedAt || a.stoppedAt).getTime()
            : now - new Date(a.startedAt || a.updatedAt).getTime();
        const statusText =
          a.status === 'stopped'
            ? `stopped · ${formatDuration(elapsed)}`
            : a.status === 'idle'
              ? `idle · ${formatDuration(elapsed)}`
              : `active · ${formatDuration(elapsed)}`;
        const promptTrimmed = stripAnsi((a.prompt || '').trim()).replace(/[\r\n]+/g, ' ');
        const promptTrunc = promptTrimmed.length > 60 ? `${promptTrimmed.substring(0, 60)}…` : promptTrimmed;
        const msgHtml = promptTrunc
          ? `<div class="agent-message" title="${escapeHtml(promptTrimmed)}">${escapeHtml(promptTrunc)}</div>`
          : '';
        const rawType = a.type || 'unknown';
        const colonIdx = rawType.indexOf(':');
        const typeNs = colonIdx > 0 ? rawType.substring(0, colonIdx + 1) : '';
        const typeName = colonIdx > 0 ? rawType.substring(colonIdx + 1) : rawType;
        return `<div class="agent-card" onclick="showAgentModal('${a.agentId}')">
          <div class="agent-type-row">${typeNs ? `<span class="agent-type-ns">${escapeHtml(typeNs)}</span>` : ''}<span class="agent-type-name">${escapeHtml(typeName)}</span></div>
          <div class="agent-status-row"><span class="agent-dot ${a.status}"></span><span class="agent-status">${statusText}</span></div>
          ${msgHtml}
        </div>`;
      })
      .join('');

  clearInterval(agentDurationInterval);
  if (visible.some((a) => a.status === 'active' || a.status === 'idle')) {
    agentDurationInterval = setInterval(() => renderAgentFooter(), 1000);
  } else {
    agentDurationInterval = setInterval(() => renderAgentFooter(), 10000);
  }
}

// biome-ignore lint/correctness/noUnusedVariables: used in HTML
function toggleAgentFooter() {
  const footer = document.getElementById('agent-footer');
  const collapsed = !footer.classList.contains('collapsed');
  footer.classList.toggle('collapsed', collapsed);
  localStorage.setItem('agentFooterCollapsed', collapsed);
  document.getElementById('agent-footer-toggle').innerHTML = collapsed ? '&#x25B4;' : '&#x25BE;';
}

let _agentModalPromptText = null;
let _agentModalResponseText = null;

// biome-ignore lint/correctness/noUnusedVariables: used in HTML
async function copyAgentModalAll(btn) {
  const parts = [];
  if (_agentModalPromptText) parts.push(`## Prompt\n${_agentModalPromptText}`);
  if (_agentModalResponseText) parts.push(`## Response\n${_agentModalResponseText}`);
  if (!parts.length) return;
  copyWithFeedback(parts.join('\n\n'), btn);
}

let currentAgentModalId = null;

function updateAgentModalPinState() {
  const btn = document.getElementById('agent-modal-pin-btn');
  if (!btn || !currentAgentModalId) return;
  btn.classList.toggle('active', isAgentPinned(currentAgentModalId));
}

// biome-ignore lint/correctness/noUnusedVariables: used in HTML
function togglePinFromAgentModal() {
  if (!currentAgentModalId) return;
  toggleAgentPin(currentAgentModalId);
  updateAgentModalPinState();
}

// biome-ignore lint/correctness/noUnusedVariables: used in HTML
async function dismissAgent(agentId) {
  if (!currentSessionId || !agentId) return;
  try {
    const res = await fetch(`/api/sessions/${currentSessionId}/agents/${agentId}/stop`, { method: 'POST' });
    if (res.ok) {
      currentWaiting = null;
      fetchAgents(currentSessionId);
    }
  } catch (e) {
    console.error('[dismissAgent]', e);
  }
}

// biome-ignore lint/correctness/noUnusedVariables: used in HTML
function showAgentModal(agentId) {
  const agent = currentAgents.find((a) => a.agentId === agentId);
  if (!agent) return;
  currentAgentModalId = agentId;
  const modal = document.getElementById('agent-modal');
  const title = document.getElementById('agent-modal-title');
  const body = document.getElementById('agent-modal-body');
  const now = Date.now();
  const started = agent.startedAt ? new Date(agent.startedAt) : null;
  const stopped = agent.stoppedAt ? new Date(agent.stoppedAt) : null;
  const elapsed = stopped && started ? stopped.getTime() - started.getTime() : started ? now - started.getTime() : 0;

  const statusDot = `<span class="agent-dot ${agent.status}" style="display:inline-block;vertical-align:middle;margin-right:6px;"></span>`;
  title.innerHTML = `${statusDot} ${escapeHtml(agent.type || 'unknown')}`;

  const rows = [
    ['Status', agent.status],
    ['Agent ID', `<code style="font-size:12px;color:var(--text-tertiary)">${escapeHtml(agent.agentId)}</code>`],
    ['Duration', formatDuration(elapsed)],
  ];
  if (started) rows.push(['Started', started.toLocaleTimeString()]);
  if (stopped) rows.push(['Stopped', stopped.toLocaleTimeString()]);

  const agentMsg = currentMessages.find((m) => m.tool === 'Agent' && m.agentId === agentId);

  let html =
    `<table style="width:100%;border-collapse:collapse;">` +
    rows
      .map(
        ([k, v]) =>
          `<tr><td style="padding:6px 12px 6px 0;color:var(--text-tertiary);white-space:nowrap;vertical-align:top;">${k}</td><td style="padding:6px 0;color:var(--text-primary);">${v}</td></tr>`,
      )
      .join('') +
    `</table>`;

  const promptText = agentMsg?.agentPrompt || agent.prompt || null;
  const responseText = agent.lastMessage ? stripAnsi(agent.lastMessage.trim()) : null;
  _agentModalPromptText = promptText;
  _agentModalResponseText = responseText;
  const promptHtml = promptText ? renderMarkdown(promptText) : null;
  const responseHtml = responseText ? renderMarkdown(responseText) : null;
  html += renderAgentTabs(promptHtml, responseHtml, promptText, responseText);

  body.innerHTML = html;
  updateAgentModalPinState();
  autoSizeModal(modal.querySelector('.modal'), body);
  const dismissBtn = document.getElementById('agent-modal-dismiss-btn');
  dismissBtn.style.display = agent.status === 'active' || agent.status === 'idle' ? '' : 'none';
  modal.classList.add('visible');
  const keyHandler = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeAgentModal();
      document.removeEventListener('keydown', keyHandler);
    }
  };
  document.addEventListener('keydown', keyHandler);
}

function closeAgentModal() {
  resetModalFullscreen('agent-modal');
  currentAgentModalId = null;
}

//#endregion

//#region RENDERING
async function showAllTasks() {
  try {
    viewMode = 'all';
    currentSessionId = null;
    ownerFilter = '';
    currentAgents = [];
    currentWaiting = null;
    lastAgentsHash = '';
    renderAgentFooter();
    const res = await fetch('/api/tasks/all');
    allTasksCache = await res.json();
    let tasks = allTasksCache;
    if (filterProject) {
      tasks = tasks.filter((t) => matchesProjectFilter(t.project));
    }
    currentTasks = tasks;
    updateUrl();
    renderAllTasks();
    renderSessions();
    renderLiveUpdatesFromCache();
  } catch (error) {
    console.error('Failed to fetch all tasks:', error);
  }
}

function renderAllTasks() {
  noSession.style.display = 'none';
  sessionView.classList.add('visible');
  document.getElementById('owner-filter-bar').classList.remove('visible');

  const visibleTasks = currentTasks.filter((t) => !isInternalTask(t));
  const totalTasks = visibleTasks.length;
  const completed = visibleTasks.filter((t) => t.status === 'completed').length;
  const percent = totalTasks > 0 ? Math.round((completed / totalTasks) * 100) : 0;

  const isFiltered = filterProject && filterProject !== '__recent__';
  const projectName = isFiltered ? filterProject.split(/[/\\]/).pop() : null;
  sessionTitle.textContent = isFiltered
    ? `Tasks: ${projectName}`
    : filterProject === '__recent__'
      ? 'Recent Tasks'
      : 'All Tasks';
  sessionMeta.textContent = isFiltered
    ? `${totalTasks} tasks in this project`
    : `${totalTasks} tasks across ${sessions.length} sessions`;
  progressPercent.textContent = `${percent}%`;
  progressBar.style.width = `${percent}%`;

  renderKanban();
}

function renderSessions() {
  // Update project dropdown
  updateProjectDropdown();

  const LIVE_INDICATOR_MS = 10 * 1000;
  let filteredSessions = sessions;
  if (sessionFilter === 'active') {
    const ACTIVE_PLAN_MS = 15 * 60 * 1000;
    const RECENTLY_MODIFIED_MS = 5 * 60 * 1000;
    const now = Date.now();
    const activeSessionIds = new Set();
    filteredSessions = filteredSessions.filter((s) => {
      const isActive =
        s.hasMessages &&
        (s.pending > 0 ||
          s.inProgress > 0 ||
          s.hasActiveAgents ||
          s.hasWaitingForUser ||
          s.hasRecentLog ||
          (s.hasPlan && !s.planImplementationSessionId && now - new Date(s.modifiedAt).getTime() <= ACTIVE_PLAN_MS) ||
          now - new Date(s.modifiedAt).getTime() <= RECENTLY_MODIFIED_MS);
      if (isActive) activeSessionIds.add(s.id);
      return isActive;
    });
    // Include plan sessions whose implementation is active
    const planSessions = sessions.filter(
      (s) =>
        s.planImplementationSessionId &&
        activeSessionIds.has(s.planImplementationSessionId) &&
        !activeSessionIds.has(s.id),
    );
    if (planSessions.length) {
      filteredSessions = filteredSessions.concat(planSessions);
      filteredSessions.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
    }
  }
  if (filterProject) {
    filteredSessions = filteredSessions.filter((s) => matchesProjectFilter(s.project));
  }

  // Apply search filter
  if (searchQuery) {
    filteredSessions = filteredSessions.filter((session) => {
      // Search in session name and ID
      if (session.name && fuzzyMatch(session.name, searchQuery)) return true;
      if (session.id && fuzzyMatch(session.id, searchQuery)) return true;

      // Search in project path
      if (session.project && fuzzyMatch(session.project, searchQuery)) return true;

      // Search in description
      if (session.description && fuzzyMatch(session.description, searchQuery)) return true;

      // Search in tasks for this session
      const sessionTasks = allTasksCache.filter((t) => t.sessionId === session.id);
      return sessionTasks.some(
        (task) =>
          (task.subject && fuzzyMatch(task.subject, searchQuery)) ||
          (task.description && fuzzyMatch(task.description, searchQuery)) ||
          (task.activeForm && fuzzyMatch(task.activeForm, searchQuery)),
      );
    });
  }

  // Always include pinned sessions even if they don't match filters
  if (pinnedSessionIds.size > 0 && !searchQuery) {
    const filteredIds = new Set(filteredSessions.map((s) => s.id));
    const missingPinned = sessions.filter((s) => pinnedSessionIds.has(s.id) && !filteredIds.has(s.id));
    if (missingPinned.length) filteredSessions = [...missingPinned, ...filteredSessions];
  }

  if (filteredSessions.length === 0) {
    let emptyMsg = 'No sessions found';
    let emptyHint = 'Tasks appear when you use Claude Code';

    if (searchQuery) {
      emptyMsg = `No results for "${searchQuery}"`;
      emptyHint = 'Try a different search term or clear the search';
    } else if (filterProject && sessionFilter === 'active') {
      emptyMsg = 'No active sessions for this project';
      emptyHint = 'Try "All Sessions" or "All Projects"';
    } else if (filterProject) {
      emptyMsg = 'No sessions for this project';
      emptyHint = 'Select "All Projects" to see all';
    } else if (sessionFilter === 'active') {
      emptyMsg = 'No active sessions';
      emptyHint = 'Select "All Sessions" to see all';
    }
    sessionsList.innerHTML = `
          <div style="padding: 24px 12px; text-align: center; color: var(--text-muted); font-size: 12px;">
            <p>${emptyMsg}</p>
            <p style="margin-top: 8px; font-size: 11px;">${emptyHint}</p>
          </div>
        `;
    return;
  }

  // Helper to render a single session card
  const renderSessionCard = (session) => {
    const total = session.taskCount;
    const percent = total > 0 ? Math.round((session.completed / total) * 100) : 0;
    const isActive = session.id === currentSessionId && viewMode === 'session';
    const hasInProgress = session.inProgress > 0;
    const isLive =
      hasInProgress || (session.modifiedAt && Date.now() - new Date(session.modifiedAt).getTime() <= LIVE_INDICATOR_MS);
    const sessionName = session.name || session.id;
    const useGrouped = sessionFilter === 'active' && session.project;
    const primaryName = useGrouped ? sessionName : session.project ? session.project.split('/').pop() : sessionName;
    const secondaryName = useGrouped ? null : session.project ? sessionName : null;

    const gitBranch = session.gitBranch ? escapeHtml(session.gitBranch) : null;
    const createdDisplay = session.createdAt ? formatDate(session.createdAt) : '';
    const modifiedDisplay = formatDate(session.modifiedAt);
    const timeDisplay =
      session.createdAt && createdDisplay !== modifiedDisplay
        ? `Created ${createdDisplay} · Modified ${modifiedDisplay}`
        : modifiedDisplay;
    const tooltip = [session.id, timeDisplay, gitBranch ? `Branch: ${gitBranch}` : ''].filter(Boolean).join(' | ');
    const isTeam = session.isTeam;
    const memberCount = session.memberCount || 0;

    const isSessionPinned = pinnedSessionIds.has(session.id);
    const showCtx = !!session.contextStatus;
    return `
          <button onclick="fetchTasks('${session.id}')" data-session-id="${session.id}" class="session-item ${isActive ? 'active' : ''} ${session.hasWaitingForUser ? 'permission-pending' : ''} ${!session.hasRecentLog && !session.inProgress && !session.hasWaitingForUser ? 'stale' : ''} ${showCtx ? 'has-context' : ''}" title="${tooltip}">
            <span class="session-pin-btn${isSessionPinned ? ' pinned' : ''}" onclick="event.stopPropagation();toggleSessionPin('${escapeHtml(session.id)}')" title="${isSessionPinned ? 'Unpin' : 'Pin'} session">${SESSION_PIN_SVG}</span>
            <div class="session-name">${escapeHtml(primaryName)}</div>
            ${secondaryName ? `<div class="session-secondary">${escapeHtml(secondaryName)}</div>` : ''}
            ${gitBranch ? `<div class="session-branch">${gitBranch}</div>` : ''}
            ${session.planTitle ? `<div class="session-plan">${escapeHtml(session.planTitle)}</div>` : ''}
            <div class="session-progress">
              <span class="session-indicators">
                ${isTeam ? `<span class="team-badge" title="${memberCount} team members"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>${memberCount}</span>` : ''}
                ${isTeam || session.project || showCtx ? `<span class="team-info-btn" onclick="event.stopPropagation(); showSessionInfoModal('${session.id}')" title="View session info">ℹ</span>` : ''}
                ${session.hasPlan ? `<span class="plan-indicator" onclick="event.stopPropagation(); openPlanForSession('${session.id}')" title="View plan"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg></span>` : ''}
                ${session.hasRunningAgents ? '<span class="agent-badge" title="Active agents">🤖</span>' : ''}
                ${session.planSourceSessionId ? `<span class="plan-indicator" title="Implements plan — click to view plan session" onclick="event.stopPropagation(); fetchTasks('${escapeHtml(session.planSourceSessionId)}')">📋</span>` : ''}
                ${session.hasWaitingForUser ? '<span class="agent-badge" title="Waiting for user">❓</span>' : ''}
                ${isLive ? '<span class="pulse"></span>' : ''}
              </span>
              <div class="progress-bar"><div class="progress-fill" style="width: ${percent}%"></div></div>
              <span class="progress-text">${session.completed}/${total}</span>
            </div>
            ${showCtx ? renderContextBar(session.contextStatus) : ''}
            <div class="session-time">${formatDate(session.modifiedAt)}</div>
          </button>
        `;
  };

  // Group active sessions by project
  if (sessionFilter === 'active') {
    const groups = new Map();
    const ungrouped = [];
    for (const session of filteredSessions) {
      if (session.project) {
        if (!groups.has(session.project)) groups.set(session.project, []);
        groups.get(session.project).push(session);
      } else {
        ungrouped.push(session);
      }
    }
    if (pinnedSessionIds.size > 0) {
      const pinSort = (a, b) => (pinnedSessionIds.has(b.id) ? 1 : 0) - (pinnedSessionIds.has(a.id) ? 1 : 0);
      for (const [, arr] of groups) arr.sort(pinSort);
      ungrouped.sort(pinSort);
    }

    // Stable group order: preserve existing order, append new groups sorted by recency
    const currentPaths = new Set(groups.keys());
    const knownPaths = new Set(stableGroupOrder);
    const keptOrder = stableGroupOrder.filter((p) => currentPaths.has(p));
    const newPaths = [...currentPaths].filter((p) => !knownPaths.has(p));
    if (newPaths.length > 1) {
      const maxTime = new Map(
        newPaths.map((p) => [p, Math.max(...groups.get(p).map((s) => new Date(s.modifiedAt).getTime()))]),
      );
      newPaths.sort((a, b) => maxTime.get(b) - maxTime.get(a));
    }
    stableGroupOrder = [...keptOrder, ...newPaths];
    const sortedGroups = stableGroupOrder.map((p) => [p, groups.get(p)]);

    let html = '';
    for (const [projectPath, projectSessions] of sortedGroups) {
      const folderName = projectPath.split(/[/\\]/).pop();
      const isCollapsed = collapsedProjectGroups.has(projectPath);
      const escapedPath = escapeHtml(projectPath);
      const breadcrumbParts = projectPath
        .replace(/^\/home\/[^/]+/, '~')
        .split(/[/\\]/)
        .filter(Boolean);
      const breadcrumbHtml = breadcrumbParts
        .map((p, i) => (i < breadcrumbParts.length - 1 ? `${escapeHtml(p)}<span class="sep">/</span>` : escapeHtml(p)))
        .join('');

      html += `
            <div class="project-group-header${isCollapsed ? ' collapsed' : ''}" data-group-path="${escapedPath}">
              <svg class="group-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
              <span class="group-name">${escapeHtml(folderName)}</span>
              <span class="group-count">${projectSessions.length}</span>
              <span class="group-path-toggle" data-group-action="toggle-path" title="Show full path">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
              </span>
            </div>
            <div class="project-group-breadcrumb" data-full-path="${escapedPath}" title="Click to copy path">${breadcrumbHtml}</div>
            <div class="project-group-sessions${isCollapsed ? ' collapsed' : ''}">
              ${projectSessions.map(renderSessionCard).join('')}
            </div>
          `;
    }

    if (ungrouped.length > 0 && sortedGroups.length > 0) {
      const isCollapsed = collapsedProjectGroups.has('__ungrouped__');
      html += `
            <div class="project-group-header${isCollapsed ? ' collapsed' : ''}" data-group-path="__ungrouped__">
              <svg class="group-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
              <span class="group-name">Ungrouped</span>
              <span class="group-count">${ungrouped.length}</span>
            </div>
            <div class="project-group-sessions${isCollapsed ? ' collapsed' : ''}">
              ${ungrouped.map(renderSessionCard).join('')}
            </div>
          `;
    } else {
      html += ungrouped.map(renderSessionCard).join('');
    }

    sessionsList.innerHTML = html;
  } else {
    const pinned = filteredSessions.filter((s) => pinnedSessionIds.has(s.id));
    const rest = filteredSessions.filter((s) => !pinnedSessionIds.has(s.id));
    let html = '';
    if (pinned.length > 0) {
      const isCollapsed = collapsedProjectGroups.has('__pinned__');
      html += `
            <div class="project-group-header${isCollapsed ? ' collapsed' : ''}" data-group-path="__pinned__">
              <svg class="group-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
              <span class="group-name">Pinned</span>
              <span class="group-count">${pinned.length}</span>
            </div>
            <div class="project-group-sessions${isCollapsed ? ' collapsed' : ''}">
              ${pinned.map(renderSessionCard).join('')}
            </div>
          `;
    }
    html += rest.map(renderSessionCard).join('');
    sessionsList.innerHTML = html;
  }

  const navItems = getNavigableItems();
  const allSessions = getSessionItems();
  const activeIdx = allSessions.findIndex((el) => el.classList.contains('active'));
  if (activeIdx >= 0 && (selectedSessionIdx < 0 || sessionJustSelected)) {
    const navIdx = navItems.indexOf(allSessions[activeIdx]);
    selectedSessionIdx = navIdx >= 0 ? navIdx : 0;
    selectedSessionKbId = allSessions[activeIdx].dataset.sessionId || null;
    sessionJustSelected = false;
  }

  if (selectedSessionKbId && focusZone === 'sidebar') {
    const restoredIdx = navItems.findIndex((el) => getKbId(el) === selectedSessionKbId);
    if (restoredIdx >= 0) {
      selectedSessionIdx = restoredIdx;
      navItems[restoredIdx].classList.add('kb-selected');
    } else {
      selectedSessionIdx = -1;
      selectedSessionKbId = null;
    }
  } else if (focusZone === 'sidebar' && selectedSessionIdx >= 0) {
    if (navItems.length > 0) {
      const clamped = Math.min(selectedSessionIdx, navItems.length - 1);
      selectedSessionIdx = clamped;
      const el = navItems[clamped];
      selectedSessionKbId = getKbId(el);
      el.classList.add('kb-selected');
    } else {
      selectedSessionIdx = -1;
      selectedSessionKbId = null;
    }
  }
}

function renderSession() {
  noSession.style.display = 'none';
  sessionView.classList.add('visible');

  const session = sessions.find((s) => s.id === currentSessionId);
  if (!session) return;

  const displayName =
    session.customTitle || session.name || session.gitBranch || session.description || currentSessionId;

  sessionTitle.textContent = displayName;

  // Build meta text with project path and description
  const projectName = session.project ? session.project.split('/').pop() : null;
  const metaParts = [`${currentTasks.length} tasks`];
  if (projectName) {
    metaParts.push(projectName);
  }
  if (session.description && session.gitBranch) {
    metaParts.push(session.description);
  }
  metaParts.push(formatDate(session.modifiedAt));
  sessionMeta.textContent = metaParts.join(' · ');

  const completed = currentTasks.filter((t) => t.status === 'completed').length;
  const percent = currentTasks.length > 0 ? Math.round((completed / currentTasks.length) * 100) : 0;

  progressPercent.textContent = `${percent}%`;
  progressBar.style.width = `${percent}%`;
  const hasInProgress = currentTasks.some((t) => t.status === 'in_progress');
  progressBar.classList.toggle('shimmer', hasInProgress && percent < 100);

  updateOwnerFilter();
  renderKanban();
  renderSessions();
}

function renderTaskCard(task) {
  const isBlocked = task.blockedBy && task.blockedBy.length > 0;
  const taskId = viewMode === 'all' ? `${task.sessionId?.slice(0, 4)}-${task.id}` : task.id;
  const sessionLabel = viewMode === 'all' && task.sessionName ? task.sessionName : null;
  const statusClass = task.status.replace('_', '-');
  const actualSessionId = task.sessionId || currentSessionId;

  return `
        <div
          role="listitem"
          tabindex="0"
          data-task-id="${task.id}"
          data-session-id="${actualSessionId}"
          onclick="showTaskDetail('${task.id}', '${actualSessionId}')"
          draggable="true"
          ondragstart="onCardDragStart(event)"
          ondragend="onCardDragEnd(event)"
          class="task-card ${statusClass} ${isBlocked ? 'blocked' : ''}"
          aria-label="${escapeHtml(task.subject)} — ${task.status.replace('_', ' ')}">
          <div class="task-id">
            <span>#${taskId}</span>
            ${isBlocked ? '<span class="task-badge blocked">Blocked</span>' : ''}
            ${
              task.owner
                ? (
                    () => {
                      const c = getOwnerColor(task.owner);
                      return `<span class="task-owner-badge" style="background:${c.bg};color:${c.color}">${escapeHtml(task.owner)}</span>`;
                    }
                  )()
                : ''
            }
          </div>
          <div class="task-title">${escapeHtml(task.subject)}</div>
          ${sessionLabel ? `<div class="task-session">${escapeHtml(sessionLabel)}</div>` : ''}
          ${task.status === 'in_progress' && task.activeForm ? `<div class="task-active">${escapeHtml(task.activeForm)}</div>` : ''}
          ${isBlocked ? `<div class="task-blocked">Waiting on ${task.blockedBy.map((id) => `#${id}`).join(', ')}</div>` : ''}
          ${task.description ? `<div class="task-desc">${escapeHtml(task.description.split('\n')[0])}</div>` : ''}
        </div>
      `;
}

//#endregion

//#region KANBAN
function renderKanban() {
  let filtered = currentTasks.filter((t) => !isInternalTask(t));
  if (ownerFilter) {
    filtered = filtered.filter((t) => t.owner === ownerFilter);
  }
  const pending = filtered.filter((t) => t.status === 'pending');
  const inProgress = filtered.filter((t) => t.status === 'in_progress');
  const completed = filtered.filter((t) => t.status === 'completed');

  pendingCount.textContent = pending.length;
  inProgressCount.textContent = inProgress.length;
  completedCount.textContent = completed.length;

  const emptyIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/></svg>`;

  pendingTasks.innerHTML =
    pending.length > 0
      ? pending.map(renderTaskCard).join('')
      : `<div class="column-empty">${emptyIcon}<div>No pending tasks</div></div>`;

  inProgressTasks.innerHTML =
    inProgress.length > 0
      ? inProgress.map(renderTaskCard).join('')
      : `<div class="column-empty">${emptyIcon}<div>No active tasks</div></div>`;

  completedTasks.innerHTML =
    completed.length > 0
      ? completed.map(renderTaskCard).join('')
      : `<div class="column-empty">${emptyIcon}<div>No completed tasks</div></div>`;

  if (selectedTaskId) {
    const card =
      document.querySelector(`.task-card[data-task-id="${selectedTaskId}"][data-session-id="${selectedSessionId}"]`) ||
      document.querySelector(`.task-card[data-task-id="${selectedTaskId}"]`);
    if (card) {
      if (focusZone === 'board') card.classList.add('selected');
    } else {
      selectedTaskId = null;
      selectedSessionId = null;
    }
    if (selectedTaskId && detailPanel.classList.contains('visible')) {
      showTaskDetail(selectedTaskId, selectedSessionId);
    }
  }
}

//#endregion

//#region DRAG_DROP
// biome-ignore lint/correctness/noUnusedVariables: used in HTML
function onCardDragStart(e) {
  const card = e.target.closest('.task-card');
  if (!card) return;
  card.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData(
    'text/plain',
    JSON.stringify({
      taskId: card.dataset.taskId,
      sessionId: card.dataset.sessionId,
    }),
  );
}

// biome-ignore lint/correctness/noUnusedVariables: used in HTML
function onCardDragEnd(e) {
  const card = e.target.closest('.task-card');
  if (card) card.classList.remove('dragging');
  // biome-ignore lint/suspicious/useIterableCallbackReturn: forEach side-effect
  document.querySelectorAll('.column-tasks.drag-over').forEach((el) => el.classList.remove('drag-over'));
}

// biome-ignore lint/correctness/noUnusedVariables: used in HTML
function onColumnDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  e.currentTarget.classList.add('drag-over');
}

// biome-ignore lint/correctness/noUnusedVariables: used in HTML
function onColumnDragLeave(e) {
  if (!e.currentTarget.contains(e.relatedTarget)) {
    e.currentTarget.classList.remove('drag-over');
  }
}

// biome-ignore lint/correctness/noUnusedVariables: used in HTML
async function onColumnDrop(e) {
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');
  const newStatus = e.currentTarget.dataset.status;
  let data;
  try {
    data = JSON.parse(e.dataTransfer.getData('text/plain'));
  } catch (_) {
    return;
  }
  const { taskId, sessionId } = data;
  const task = currentTasks.find((t) => t.id === taskId && (t.sessionId || currentSessionId) === sessionId);
  if (!task || task.status === newStatus) return;
  try {
    const res = await fetch(`/api/tasks/${sessionId}/${taskId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus }),
    });
    if (res.ok) {
      task.status = newStatus;
      renderKanban();
    }
  } catch (_) {}
}

//#endregion

//#region KEYBOARD_NAV
function selectTask(taskId, sessionId) {
  const prev = document.querySelector('.task-card.selected');
  if (prev) prev.classList.remove('selected');
  selectedTaskId = taskId;
  selectedSessionId = sessionId;
  if (!taskId) return;
  const card =
    document.querySelector(`.task-card[data-task-id="${taskId}"][data-session-id="${sessionId}"]`) ||
    document.querySelector(`.task-card[data-task-id="${taskId}"]`);
  if (card) {
    card.classList.add('selected');
    card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function getSelectedCardInfo() {
  if (!selectedTaskId) return null;
  for (let ci = 0; ci < COLUMNS.length; ci++) {
    const cards = Array.from(COLUMNS[ci].el.querySelectorAll('.task-card'));
    for (let i = 0; i < cards.length; i++) {
      if (cards[i].dataset.taskId === selectedTaskId) {
        return { colIndex: ci, cardIndex: i, card: cards[i] };
      }
    }
  }
  return null;
}

function navigateVertical(direction) {
  const info = getSelectedCardInfo();
  if (!info) {
    for (const col of COLUMNS) {
      const cards = Array.from(col.el.querySelectorAll('.task-card'));
      if (cards.length > 0) {
        selectTask(cards[0].dataset.taskId, cards[0].dataset.sessionId);
        return;
      }
    }
    return;
  }
  const cards = Array.from(COLUMNS[info.colIndex].el.querySelectorAll('.task-card'));
  const newIndex = info.cardIndex + direction;
  if (newIndex >= 0 && newIndex < cards.length) {
    selectTask(cards[newIndex].dataset.taskId, cards[newIndex].dataset.sessionId);
  }
}

function navigateHorizontal(direction) {
  const info = getSelectedCardInfo();
  if (!info) {
    navigateVertical(1);
    return;
  }
  let newColIndex = info.colIndex + direction;
  while (newColIndex >= 0 && newColIndex < COLUMNS.length) {
    const cards = Array.from(COLUMNS[newColIndex].el.querySelectorAll('.task-card'));
    if (cards.length > 0) {
      const clampedIndex = Math.min(info.cardIndex, cards.length - 1);
      selectTask(cards[clampedIndex].dataset.taskId, cards[clampedIndex].dataset.sessionId);
      return;
    }
    newColIndex += direction;
  }
}

function getKbId(el) {
  return el.dataset.sessionId || el.dataset.groupPath || null;
}

function getGroupSessionsContainer(header) {
  let el = header.nextElementSibling;
  while (el && !el.classList.contains('project-group-sessions')) el = el.nextElementSibling;
  return el;
}

function getNavigableItems() {
  const items = [];
  for (const el of sessionsList.children) {
    if (el.classList.contains('project-group-header')) {
      items.push(el);
      if (!collapsedProjectGroups.has(el.dataset.groupPath)) {
        const container = getGroupSessionsContainer(el);
        if (container) {
          for (const s of container.querySelectorAll('.session-item')) items.push(s);
        }
      }
    } else if (el.classList.contains('session-item')) {
      items.push(el);
    }
  }
  return items;
}

function getSessionItems() {
  return Array.from(sessionsList.querySelectorAll('.session-item'));
}

function clearKbSelection() {
  const prev = sessionsList.querySelector('.kb-selected');
  if (prev) prev.classList.remove('kb-selected');
}

function selectSessionByIndex(idx, items) {
  items = items || getNavigableItems();
  if (items.length === 0) return;
  clearKbSelection();
  selectedSessionIdx = Math.max(0, Math.min(idx, items.length - 1));
  const el = items[selectedSessionIdx];
  selectedSessionKbId = getKbId(el);
  el.classList.add('kb-selected');
  el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function navigateSession(direction, items) {
  items = items || getNavigableItems();
  if (items.length === 0) return;
  if (selectedSessionIdx < 0) {
    selectSessionByIndex(0, items);
    return;
  }
  const currentEl = items[selectedSessionIdx];
  let newIdx = selectedSessionIdx + direction;
  if (!currentEl || !currentEl.isConnected) {
    const restoredIdx = selectedSessionKbId ? items.findIndex((el) => getKbId(el) === selectedSessionKbId) : -1;
    newIdx = restoredIdx >= 0 ? restoredIdx : 0;
  }
  if (newIdx >= 0 && newIdx < items.length) {
    selectSessionByIndex(newIdx, items);
  }
}

function setGroupCollapsed(header, collapsed) {
  if (!header) return;
  const projectPath = header.dataset.groupPath;
  if (collapsed === collapsedProjectGroups.has(projectPath)) return;
  if (collapsed) collapsedProjectGroups.add(projectPath);
  else collapsedProjectGroups.delete(projectPath);
  header.classList.toggle('collapsed', collapsed);
  const container = getGroupSessionsContainer(header);
  if (container) container.classList.toggle('collapsed', collapsed);
  try {
    localStorage.setItem('collapsedGroups', JSON.stringify([...collapsedProjectGroups]));
  } catch (_) {}
}

function handleSidebarHorizontal(direction) {
  const items = getNavigableItems();
  if (selectedSessionIdx < 0 || selectedSessionIdx >= items.length) return;
  const el = items[selectedSessionIdx];
  const isHeader = el.classList.contains('project-group-header');
  const collapse = direction < 0;

  if (isHeader) {
    const groupPath = el.dataset.groupPath;
    const isCollapsed = collapsedProjectGroups.has(groupPath);
    if (collapse) {
      if (!isCollapsed) setGroupCollapsed(el, true);
    } else {
      if (isCollapsed) {
        setGroupCollapsed(el, false);
      } else {
        navigateSession(1);
      }
    }
  } else {
    if (collapse) {
      const container = el.closest('.project-group-sessions');
      if (container) {
        let header = container.previousElementSibling;
        while (header && !header.classList.contains('project-group-header')) header = header.previousElementSibling;
        if (header) {
          const headerIdx = items.indexOf(header);
          if (headerIdx >= 0) selectSessionByIndex(headerIdx, items);
        }
      }
    } else {
      activateSelectedSession(items);
    }
  }
}

function activateSelectedSession(items) {
  items = items || getNavigableItems();
  if (selectedSessionIdx < 0 || selectedSessionIdx >= items.length) return;
  const el = items[selectedSessionIdx];
  if (el.classList.contains('project-group-header')) {
    const groupPath = el.dataset.groupPath;
    setGroupCollapsed(el, !collapsedProjectGroups.has(groupPath));
  } else {
    el.click();
  }
}

function setFocusZone(zone) {
  const sidebar = document.querySelector('.sidebar');
  // Clear all zone visuals
  sidebar.classList.remove('sidebar-focused');
  clearKbSelection();
  const selCard = document.querySelector('.task-card.selected');
  if (selCard) selCard.classList.remove('selected');

  focusZone = zone;
  if (zone === 'sidebar') {
    if (sidebar.classList.contains('collapsed')) {
      sidebar.classList.remove('collapsed');
      localStorage.setItem('sidebar-collapsed', false);
    }
    sidebar.classList.add('sidebar-focused');
    const items = getNavigableItems();
    if (items.length > 0) {
      const activeIdx = items.findIndex((el) => el.classList.contains('active'));
      if (activeIdx >= 0) {
        selectSessionByIndex(activeIdx);
      } else if (selectedSessionKbId) {
        const restoredIdx = items.findIndex((el) => getKbId(el) === selectedSessionKbId);
        selectSessionByIndex(restoredIdx >= 0 ? restoredIdx : 0);
      } else {
        selectSessionByIndex(0);
      }
    }
  } else {
    // Session changed while in sidebar — reset stale selection
    if (selectedSessionId && selectedSessionId !== currentSessionId) {
      selectedTaskId = null;
      selectedSessionId = null;
    }
    if (selectedTaskId) {
      const card = document.querySelector(
        `.task-card[data-task-id="${selectedTaskId}"][data-session-id="${selectedSessionId}"]`,
      );
      if (card) card.classList.add('selected');
    } else {
      navigateVertical(1);
    }
    if (selectedTaskId && detailPanel.classList.contains('visible')) {
      showTaskDetail(selectedTaskId, selectedSessionId);
    }
  }
}

// biome-ignore lint/correctness/noUnusedVariables: used in HTML
function getAvailableTasksOptions(currentTaskId = null) {
  const pending = currentTasks.filter((t) => t.status === 'pending' && t.id !== currentTaskId);
  const inProgress = currentTasks.filter((t) => t.status === 'in_progress' && t.id !== currentTaskId);
  const completed = currentTasks.filter((t) => t.status === 'completed' && t.id !== currentTaskId);

  // Build options grouped by status
  let options = '';

  if (pending.length > 0) {
    options += '<optgroup label="Pending">';
    pending.forEach((t, _idx) => {
      options += `<option value="${t.id}">#${t.id} - ${escapeHtml(t.subject)}</option>`;
    });
    options += '</optgroup>';
  }

  if (inProgress.length > 0) {
    options += '<optgroup label="In Progress">';
    inProgress.forEach((t, _idx) => {
      options += `<option value="${t.id}">#${t.id} - ${escapeHtml(t.subject)}</option>`;
    });
    options += '</optgroup>';
  }

  if (completed.length > 0) {
    options += '<optgroup label="Completed">';
    completed.forEach((t, _idx) => {
      options += `<option value="${t.id}">#${t.id} - ${escapeHtml(t.subject)}</option>`;
    });
    options += '</optgroup>';
  }

  return options;
}

//#endregion

//#region TASK_DETAIL
async function showTaskDetail(taskId, sessionId = null) {
  let task = currentTasks.find((t) => t.id === taskId && (!sessionId || t.sessionId === sessionId));

  // If task not found in currentTasks, fetch it from the session
  if (!task && sessionId && sessionId !== 'undefined') {
    try {
      const res = await fetch(`/api/sessions/${sessionId}`);
      const tasks = await res.json();
      task = tasks.find((t) => t.id === taskId);
      if (!task) return;
    } catch (error) {
      console.error('Failed to fetch task:', error);
      return;
    }
  }

  if (!task) return;

  const actualSid = task.sessionId || sessionId || currentSessionId;
  selectTask(taskId, actualSid);
  detailPanel.classList.add('visible');

  const statusLabels = {
    completed: '<span class="detail-status completed"><span class="dot"></span>Completed</span>',
    in_progress: '<span class="detail-status in_progress"><span class="dot"></span>In Progress</span>',
    pending: '<span class="detail-status pending"><span class="dot"></span>Pending</span>',
  };

  const isBlocked = task.blockedBy && task.blockedBy.length > 0;
  const actualSessionId = task.sessionId || sessionId || currentSessionId;

  detailContent.innerHTML = `
        <div class="detail-section">
          <div class="detail-label">Task #${task.id}</div>
          <h2 class="detail-title">${escapeHtml(task.subject)}</h2>
        </div>

        <div class="detail-section" style="display: flex; gap: 12px; align-items: center;">
          <div>${statusLabels[task.status] || ''}</div>
          ${task.owner ? `<div style="font-size: 13px; color: ${getOwnerColor(task.owner).color}; font-weight: 500;">${escapeHtml(task.owner)}</div>` : ''}
          ${isBlocked && task.status !== 'in_progress' ? '<div style="font-size: 10px; color: var(--warning);">Blocked</div>' : ''}
        </div>

        <div class="detail-section">
          <div class="detail-label">Description</div>
          <div class="detail-desc">${task.description ? renderMarkdown(task.description) : '<em style="color: var(--text-muted);">No description</em>'}</div>
        </div>

        ${
          task.activeForm && task.status === 'in_progress'
            ? `
          <div class="detail-section">
            <div class="detail-box active">
              <strong>Currently:</strong> ${escapeHtml(task.activeForm)}
            </div>
          </div>
        `
            : ''
        }

        ${
          task.blockedBy && task.blockedBy.length > 0
            ? `
        <div class="detail-section">
          <div class="detail-label">Blocked By</div>
          <div class="detail-deps">
            <div class="detail-box blocked"><strong>Blocked by:</strong> ${task.blockedBy.map((id) => `#${id}`).join(', ')}</div>
          </div>
        </div>`
            : ''
        }

        ${
          task.blocks && task.blocks.length > 0
            ? `
        <div class="detail-section">
          <div class="detail-label">Blocks</div>
          <div class="detail-deps">
            <div class="detail-box blocks"><strong>Blocks:</strong> ${task.blocks.map((id) => `#${id}`).join(', ')}</div>
          </div>
        </div>`
            : ''
        }

        <div class="detail-section note-section">
          <label for="note-input" class="detail-label">Add Note</label>
          <form class="note-form" onsubmit="addNote(event, '${task.id}', '${actualSessionId}')">
            <textarea id="note-input" class="note-input" placeholder="Add a note for Claude..." rows="3"></textarea>
            <button type="submit" class="note-submit">Add Note</button>
          </form>
        </div>
      `;

  // Setup button handlers
  const deleteBtn = document.getElementById('delete-task-btn');
  deleteBtn.style.display = '';
  deleteBtn.onclick = () => deleteTask(task.id, actualSessionId);

  // Setup inline editing
  const titleEl = detailContent.querySelector('.detail-title');
  if (titleEl) {
    titleEl.onclick = () => editTitle(titleEl, task, actualSessionId);
  }

  const descEl = detailContent.querySelector('.detail-desc');
  if (descEl) {
    descEl.onclick = () => editDescription(descEl, task, actualSessionId);
  }
}

function editTitle(titleEl, task, sessionId) {
  if (titleEl.querySelector('input')) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'detail-title-input';
  input.value = task.subject;

  titleEl.replaceWith(input);
  input.focus();
  input.select();

  const save = async () => {
    const val = input.value.trim();
    if (val && val !== task.subject) {
      await saveTaskField(task.id, sessionId, 'subject', val);
    } else {
      showTaskDetail(task.id, sessionId);
    }
  };

  input.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      save();
    }
    if (e.key === 'Escape') showTaskDetail(task.id, sessionId);
  };
  input.onblur = () => save();
}

function editDescription(descEl, task, sessionId) {
  if (descEl.querySelector('textarea')) return;
  const wrapper = document.createElement('div');
  const textarea = document.createElement('textarea');
  textarea.className = 'detail-desc-textarea';
  textarea.value = task.description || '';
  textarea.rows = Math.max(5, (task.description || '').split('\n').length + 2);

  const actions = document.createElement('div');
  actions.className = 'edit-actions';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'edit-save';
  saveBtn.textContent = 'Save';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'edit-cancel';
  cancelBtn.textContent = 'Cancel';

  actions.append(cancelBtn, saveBtn);
  wrapper.append(textarea, actions);
  descEl.replaceWith(wrapper);
  textarea.focus();

  const save = async () => {
    const val = textarea.value;
    if (val !== (task.description || '')) {
      await saveTaskField(task.id, sessionId, 'description', val);
    } else {
      showTaskDetail(task.id, sessionId);
    }
  };

  saveBtn.onclick = save;
  cancelBtn.onclick = () => showTaskDetail(task.id, sessionId);
  textarea.onkeydown = (e) => {
    if (e.key === 'Escape') showTaskDetail(task.id, sessionId);
  };
}

async function saveTaskField(taskId, sessionId, field, value) {
  try {
    const res = await fetch(`/api/tasks/${sessionId}/${taskId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: value }),
    });

    if (res.ok) {
      lastCurrentTasksHash = null;
      if (viewMode === 'all') {
        const tasksRes = await fetch('/api/tasks/all');
        currentTasks = await tasksRes.json();
        renderKanban();
      } else {
        await fetchTasks(sessionId);
      }
      showTaskDetail(taskId, sessionId);
    }
  } catch (error) {
    console.error('Failed to update task:', error);
  }
}

// biome-ignore lint/correctness/noUnusedVariables: used in HTML
async function addNote(event, taskId, sessionId) {
  event.preventDefault();
  const input = document.getElementById('note-input');
  const note = input.value.trim();
  if (!note) return;

  try {
    const res = await fetch(`/api/tasks/${sessionId}/${taskId}/note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note }),
    });

    if (res.ok) {
      input.value = '';
      // Refresh to show updated description
      if (viewMode === 'all') {
        const tasksRes = await fetch('/api/tasks/all');
        currentTasks = await tasksRes.json();
      } else {
        await fetchTasks(sessionId);
      }
      showTaskDetail(taskId, sessionId);
    }
  } catch (error) {
    console.error('Failed to add note:', error);
  }
}

function closeDetailPanel() {
  detailPanel.classList.remove('visible');
  document.getElementById('delete-task-btn').style.display = 'none';
}

let deleteTaskId = null;
let deleteSessionId = null;
let deleteModalKeyHandler = null;

// biome-ignore lint/correctness/noUnusedVariables: used in HTML
function showBlockedTaskModal(task) {
  const messageDiv = document.getElementById('blocked-task-message');

  const blockedByList = task.blockedBy
    .map((id) => {
      const blockingTask = currentTasks.find((t) => t.id === id);
      if (blockingTask) {
        return `<li><strong>#${blockingTask.id}</strong> - ${escapeHtml(blockingTask.subject)}</li>`;
      }
      return `<li><strong>#${id}</strong></li>`;
    })
    .join('');

  messageDiv.innerHTML = `
        <p style="margin-bottom: 12px;">Task <strong>#${task.id}</strong> - ${escapeHtml(task.subject)} is currently blocked by:</p>
        <ul style="margin: 0 0 16px 20px; padding: 0;">${blockedByList}</ul>
        <p style="margin: 0; color: var(--text-secondary); font-size: 13px;">
          Please resolve these dependencies before moving this task to <strong>In Progress</strong>.
        </p>
      `;

  const modal = document.getElementById('blocked-task-modal');
  modal.classList.add('visible');

  // Handle ESC key
  const keyHandler = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeBlockedTaskModal();
      document.removeEventListener('keydown', keyHandler);
    }
  };
  document.addEventListener('keydown', keyHandler);
}

function closeBlockedTaskModal() {
  const modal = document.getElementById('blocked-task-modal');
  modal.classList.remove('visible');
}

//#endregion

//#region DELETE_TASK
function deleteTask(taskId, sessionId) {
  const task = currentTasks.find((t) => t.id === taskId);
  if (!task) return;

  deleteTaskId = taskId;
  deleteSessionId = sessionId;

  const message = document.getElementById('delete-confirm-message');
  message.textContent = `Delete task "${task.subject}"? This cannot be undone.`;

  const modal = document.getElementById('delete-confirm-modal');
  modal.classList.add('visible');

  const buttons = [document.getElementById('delete-cancel-btn'), document.getElementById('delete-confirm-btn')];
  let focusIdx = 1;
  buttons[focusIdx].focus();

  deleteModalKeyHandler = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeDeleteConfirmModal();
    } else if (matchKey(e, 'ArrowLeft', 'KeyH')) {
      e.preventDefault();
      focusIdx = 0;
      buttons[focusIdx].focus();
    } else if (matchKey(e, 'ArrowRight', 'KeyL')) {
      e.preventDefault();
      focusIdx = 1;
      buttons[focusIdx].focus();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      buttons[focusIdx].click();
    }
  };
  document.addEventListener('keydown', deleteModalKeyHandler);
}

function closeDeleteConfirmModal() {
  const modal = document.getElementById('delete-confirm-modal');
  modal.classList.remove('visible');
  deleteTaskId = null;
  deleteSessionId = null;
  if (deleteModalKeyHandler) {
    document.removeEventListener('keydown', deleteModalKeyHandler);
    deleteModalKeyHandler = null;
  }
}

// biome-ignore lint/correctness/noUnusedVariables: used in HTML
async function confirmDelete() {
  if (!deleteTaskId || !deleteSessionId) return;

  const taskId = deleteTaskId;
  const sessionId = deleteSessionId;

  closeDeleteConfirmModal();

  try {
    const res = await fetch(`/api/tasks/${sessionId}/${taskId}`, {
      method: 'DELETE',
    });

    if (res.ok) {
      closeDetailPanel();
      await refreshCurrentView();
    } else {
      const error = await res.json();
      alert(`Failed to delete task: ${error.error || 'Unknown error'}`);
    }
  } catch (error) {
    console.error('Failed to delete task:', error);
    alert('Failed to delete task');
  }
}

//#endregion

//#region HELP
function showHelpModal() {
  const modal = document.getElementById('help-modal');
  modal.classList.add('visible');

  // Handle keyboard shortcuts
  const keyHandler = (e) => {
    if (e.key === 'Escape' || e.key === '?') {
      e.preventDefault();
      closeHelpModal();
      document.removeEventListener('keydown', keyHandler);
    }
  };
  document.addEventListener('keydown', keyHandler);
}

function closeHelpModal() {
  const modal = document.getElementById('help-modal');
  modal.classList.remove('visible');
}

async function refreshCurrentView() {
  if (viewMode === 'all') {
    await showAllTasks();
  } else if (currentSessionId) {
    await fetchTasks(currentSessionId);
    renderLiveUpdatesFromCache();
  } else {
    await fetchSessions();
  }
}

document.getElementById('close-detail').onclick = closeDetailPanel;

//#endregion

//#region KEYBOARD_SHORTCUTS
function matchKey(e, ...keys) {
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return false;
  return keys.some((k) => e.key === k || e.code === k);
}

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
    return;
  }

  // Modal guard — only Escape, Shift+M, and msg-detail J/K navigation pass through
  if (document.querySelector('.modal-overlay.visible')) {
    if (e.key === 'Escape') {
      // biome-ignore lint/suspicious/useIterableCallbackReturn: forEach side-effect
      document.querySelectorAll('.modal-overlay.visible').forEach((m) => m.classList.remove('visible'));
      msgDetailFollowLatest = false;
    } else if (
      e.code === 'KeyM' &&
      e.shiftKey &&
      document.getElementById('msg-detail-modal').classList.contains('visible')
    ) {
      e.preventDefault();
      closeMsgDetailModal();
    } else if (document.getElementById('msg-detail-modal').classList.contains('visible')) {
      if (matchKey(e, 'ArrowDown', 'KeyJ')) {
        e.preventDefault();
        if (currentMsgDetailIdx < currentMessages.length - 1) {
          msgDetailFollowLatest = false;
          showMsgDetail(currentMsgDetailIdx + 1);
        } else if (currentMsgDetailIdx === currentMessages.length - 1) {
          msgDetailFollowLatest = true;
          showMsgDetail(currentMsgDetailIdx);
        }
      } else if (matchKey(e, 'ArrowUp', 'KeyK')) {
        e.preventDefault();
        if (currentMsgDetailIdx > 0) {
          msgDetailFollowLatest = false;
          showMsgDetail(currentMsgDetailIdx - 1);
        }
      }
    }
    return;
  }

  // Global shortcuts
  if (e.key === '[') {
    e.preventDefault();
    toggleSidebar();
    return;
  }
  if (e.code === 'KeyL' && e.shiftKey) {
    e.preventDefault();
    toggleMessagePanel();
    return;
  }
  if (e.code === 'KeyM' && e.shiftKey) {
    e.preventDefault();
    const msgDetailModal = document.getElementById('msg-detail-modal');
    if (msgDetailModal.classList.contains('visible')) {
      closeMsgDetailModal();
    } else if (currentMessages.length) {
      msgDetailFollowLatest = true;
      showMsgDetail(currentMessages.length - 1);
    }
    return;
  }

  // Tab toggles focus zone
  if (e.key === 'Tab') {
    e.preventDefault();
    if (focusZone === 'sidebar') {
      const hasCards = document.querySelector('.task-card');
      if (!hasCards) return;
    }
    setFocusZone(focusZone === 'board' ? 'sidebar' : 'board');
    return;
  }

  // Sidebar navigation
  if (focusZone === 'sidebar') {
    if (matchKey(e, 'ArrowDown', 'KeyJ')) {
      e.preventDefault();
      navigateSession(1);
      return;
    }
    if (matchKey(e, 'ArrowUp', 'KeyK')) {
      e.preventDefault();
      navigateSession(-1);
      return;
    }
    if (matchKey(e, 'ArrowLeft', 'KeyH')) {
      e.preventDefault();
      handleSidebarHorizontal(-1);
      return;
    }
    if (matchKey(e, 'ArrowRight', 'KeyL')) {
      e.preventDefault();
      handleSidebarHorizontal(1);
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activateSelectedSession();
      return;
    }
    if (e.key === 'Escape') {
      setFocusZone('board');
      return;
    }
  }

  // Board navigation
  if (focusZone === 'board') {
    if (matchKey(e, 'ArrowDown', 'KeyJ', 'ArrowUp', 'KeyK', 'ArrowLeft', 'KeyH', 'ArrowRight', 'KeyL')) {
      e.preventDefault();
      if (!selectedTaskId && !document.querySelector('.task-card.selected')) {
        setFocusZone('sidebar');
        return;
      }
      if (matchKey(e, 'ArrowDown', 'KeyJ')) navigateVertical(1);
      else if (matchKey(e, 'ArrowUp', 'KeyK')) navigateVertical(-1);
      else if (matchKey(e, 'ArrowLeft', 'KeyH')) navigateHorizontal(-1);
      else if (matchKey(e, 'ArrowRight', 'KeyL')) navigateHorizontal(1);

      if (selectedTaskId && detailPanel.classList.contains('visible')) {
        showTaskDetail(selectedTaskId, selectedSessionId);
      }
      return;
    }

    if ((e.key === 'Enter' || e.key === ' ') && selectedTaskId && e.target.tagName !== 'BUTTON') {
      e.preventDefault();
      if (detailPanel.classList.contains('visible')) {
        const labelEl = document.querySelector('.detail-label');
        const shownId = labelEl?.textContent.match(/\d+/)?.[0];
        if (shownId === selectedTaskId) {
          closeDetailPanel();
        } else {
          showTaskDetail(selectedTaskId, selectedSessionId);
        }
      } else {
        showTaskDetail(selectedTaskId, selectedSessionId);
      }
      return;
    }

    if (matchKey(e, 'KeyD') && selectedTaskId) {
      e.preventDefault();
      deleteTask(selectedTaskId, selectedSessionId || currentSessionId);
      return;
    }
  }

  if (e.key === 'Escape') {
    if (detailPanel.classList.contains('visible')) closeDetailPanel();
    else if (messagePanelOpen) toggleMessagePanel();
    return;
  }

  // Shared actions — work in both sidebar and board
  const contextSid =
    focusZone === 'sidebar'
      ? sessionsList.querySelector('.kb-selected')?.dataset.sessionId || currentSessionId
      : selectedSessionId || currentSessionId;
  if (matchKey(e, 'KeyP') && !e.shiftKey) {
    e.preventDefault();
    if (contextSid) openPlanForSession(contextSid);
    return;
  }
  if (matchKey(e, 'KeyI') && !e.shiftKey) {
    e.preventDefault();
    if (contextSid) showSessionInfoModal(contextSid);
    return;
  }
  if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
    e.preventDefault();
    showHelpModal();
  }
});

//#endregion

//#region SSE
function setupEventSource() {
  let retryDelay = 1000;
  let eventSource;
  let wasConnected = false;
  let failCount = 0;
  const offlineOverlay = document.getElementById('offline-overlay');
  const offlineStatus = document.getElementById('offline-status');

  function showOffline() {
    offlineOverlay.classList.add('visible');
    offlineStatus.textContent = 'Attempting to reconnect...';
  }

  function hideOffline() {
    offlineOverlay.classList.remove('visible');
    failCount = 0;
  }

  function connect() {
    eventSource = new EventSource('/api/events');

    eventSource.onopen = () => {
      if (wasConnected) {
        console.warn('[SSE] Reconnected after drop — forcing full refresh');
        fetchSessions().catch(() => {});
        if (currentSessionId) fetchTasks(currentSessionId);
      }
      wasConnected = true;
      retryDelay = 1000;
      hideOffline();
      connectionStatus.innerHTML = `
            <span class="connection-dot live"></span>
            <span>Connected</span>
          `;
    };

    eventSource.onerror = () => {
      eventSource.close();
      failCount++;
      console.warn('[SSE] Connection lost, retrying in', retryDelay, 'ms');
      connectionStatus.innerHTML = `
            <span class="connection-dot error"></span>
            <span>Reconnecting...</span>
          `;
      if (failCount >= 2) showOffline();
      setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 30000);
    };

    let taskRefreshTimer = null;
    let metadataRefreshTimer = null;
    const pendingTaskSessionIds = new Set();

    function debouncedRefresh(sessionId, isMetadata) {
      if (isMetadata) {
        clearTimeout(metadataRefreshTimer);
        metadataRefreshTimer = setTimeout(() => {
          fetchSessions().catch((err) => console.error('[SSE] fetchSessions failed:', err));
          if (currentSessionId) fetchMessages(currentSessionId);
        }, 2000);
      } else {
        pendingTaskSessionIds.add(sessionId);
        clearTimeout(taskRefreshTimer);
        taskRefreshTimer = setTimeout(async () => {
          await fetchSessions().catch((err) => console.error('[SSE] fetchSessions failed:', err));
          if (viewMode === 'all') {
            currentTasks = filterProject ? allTasksCache.filter((t) => matchesProjectFilter(t.project)) : allTasksCache;
            renderAllTasks();
            renderLiveUpdatesFromCache();
          } else if (currentSessionId && pendingTaskSessionIds.has(currentSessionId)) {
            fetchTasks(currentSessionId);
          }
          pendingTaskSessionIds.clear();
        }, 500);
      }
    }

    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      console.log('[SSE] Event received:', data);
      if (data.type === 'update' || data.type === 'metadata-update') {
        if (data.type === 'metadata-update') projectsCacheDirty = true;
        debouncedRefresh(data.sessionId, data.type === 'metadata-update');
      }

      if (data.type === 'plan-update') {
        refreshOpenPlan();
      }

      if (data.type === 'agent-update') {
        fetchSessions().catch((err) => console.error('[SSE] fetchSessions failed:', err));
        if (currentSessionId && data.sessionId === currentSessionId) {
          fetchAgents(currentSessionId);
        }
      }

      if (data.type === 'context-update') {
        debouncedRefresh(data.sessionId, true);
      }

      if (data.type === 'team-update') {
        console.log('[SSE] Team update:', data.teamName);
        debouncedRefresh(data.teamName, false);
      }
    };
  }

  // Fallback poll every 30s in case SSE silently drops
  setInterval(() => {
    fetchSessions().catch(() => {});
  }, 30000);

  connect();
}

const CONTEXT_COLORS = { green: '#5b9a6b', yellow: '#b8a63e', orange: '#c07840', red: '#b85555' };
const COST_THRESHOLDS = { green: 0.5, yellow: 2, orange: 5 };
const MODEL_THRESHOLDS = [
  { match: /sonnet|haiku/i, yellow: 100000, orange: 130000, red: 150000 },
  { match: /opus/i, yellow: 100000, orange: 200000, red: 700000 },
];
const DEFAULT_THRESHOLDS = { yellow: 100000, orange: 130000, red: 150000 };

//#endregion

//#region CONTEXT_WINDOW
function getModelThresholds(modelName) {
  if (!modelName) return DEFAULT_THRESHOLDS;
  for (const t of MODEL_THRESHOLDS) {
    if (t.match.test(modelName)) return t;
  }
  return DEFAULT_THRESHOLDS;
}

function getContextColor(usedTokens, modelName) {
  const t = getModelThresholds(modelName);
  if (usedTokens < t.yellow) return CONTEXT_COLORS.green;
  if (usedTokens < t.orange) return CONTEXT_COLORS.yellow;
  if (usedTokens < t.red) return CONTEXT_COLORS.orange;
  return CONTEXT_COLORS.red;
}

function getCostColor(usd) {
  const val = usd || 0;
  if (val < COST_THRESHOLDS.green) return CONTEXT_COLORS.green;
  if (val < COST_THRESHOLDS.yellow) return CONTEXT_COLORS.yellow;
  if (val < COST_THRESHOLDS.orange) return CONTEXT_COLORS.orange;
  return CONTEXT_COLORS.red;
}

function renderMarkers(markers) {
  return markers
    .map(
      (m) =>
        `<div class="context-bar-marker" style="left:${m.pct}%;background:${m.color}" title="${formatTokens(m.tokens / 1000)}"></div>`,
    )
    .join('');
}

function formatTokens(k) {
  if (k >= 1000) return `${(k / 1000).toFixed(1)}M`;
  if (k < 1) return (k * 1000).toFixed(0);
  return `${Math.round(k)}K`;
}

function getCtx(raw) {
  if (!raw) return null;
  const cw = raw.context_window || {};
  const size = cw.context_window_size || 0;
  const pct = cw.used_percentage || 0;
  const model = raw.model || {};
  const modelName = model.display_name || model.id || '';
  const thresholds = getModelThresholds(modelName);
  const usedTokens = size > 0 ? (pct / 100) * size : 0;
  const markers =
    size > 0
      ? [
          { tokens: thresholds.yellow, pct: (thresholds.yellow / size) * 100, color: CONTEXT_COLORS.yellow },
          { tokens: thresholds.orange, pct: (thresholds.orange / size) * 100, color: CONTEXT_COLORS.orange },
          { tokens: thresholds.red, pct: (thresholds.red / size) * 100, color: CONTEXT_COLORS.red },
        ].filter((m) => m.pct > 0 && m.pct < 100)
      : [];
  return {
    pct,
    remaining: cw.remaining_percentage || 100 - pct,
    size,
    usedTokens,
    modelName,
    inputTokens: cw.total_input_tokens || 0,
    outputTokens: cw.total_output_tokens || 0,
    markers,
  };
}

function renderContextBar(raw) {
  const ctx = getCtx(raw);
  if (!ctx) return '';
  const color = getContextColor(ctx.usedTokens, ctx.modelName);
  return `
        <div class="context-bar" style="display:block">
          <div class="context-bar-track">
            <div class="context-bar-fill" style="width:${ctx.pct}%;background:${color}"></div>
            ${renderMarkers(ctx.markers)}
          </div>
          <div class="context-bar-labels">
            <span style="color:${color}">${Math.round(ctx.pct)}% (${formatTokens(ctx.usedTokens / 1000)})</span>
            <span>${Math.round(ctx.remaining)}% free</span>
          </div>
        </div>`;
}

function formatCost(usd) {
  if (!usd) return '$0.00';
  return `$${usd.toFixed(2)}`;
}

function renderContextDetail(raw) {
  const ctx = getCtx(raw);
  if (!ctx) return '';
  const totalK = ctx.size / 1000;
  const color = getContextColor(ctx.usedTokens, ctx.modelName);

  const cw = raw.context_window || {};
  const usage = cw.current_usage || {};
  const cost = raw.cost || {};

  return `
        <div class="detail-context">
          <div class="detail-context-title">${ctx.modelName ? escapeHtml(ctx.modelName) : 'Context Window'}</div>
          <div class="detail-context-bar">
            <div class="context-bar-track">
              <div class="context-bar-fill" style="width:${ctx.pct}%;background:${color}"></div>
              ${renderMarkers(ctx.markers)}
            </div>
          </div>
          <div class="detail-context-summary">
            <span style="color:${color}">${Math.round(ctx.pct)}% used</span>
            <span>${formatTokens((ctx.pct / 100) * totalK)} / ${formatTokens(totalK)}</span>
          </div>
          <div class="detail-context-stats">
            <div class="stat-item"><span class="stat-label">Cache read</span><span class="stat-value">${formatTokens((usage.cache_read_input_tokens || 0) / 1000)}</span></div>
            <div class="stat-item"><span class="stat-label">Cache write</span><span class="stat-value">${formatTokens((usage.cache_creation_input_tokens || 0) / 1000)}</span></div>
            <div class="stat-item"><span class="stat-label">Current input</span><span class="stat-value">${formatTokens((usage.input_tokens || 0) / 1000)}</span></div>
            <div class="stat-item"><span class="stat-label">Current output</span><span class="stat-value">${formatTokens((usage.output_tokens || 0) / 1000)}</span></div>
            <div class="stat-divider"></div>
            <div class="stat-item"><span class="stat-label">Total input</span><span class="stat-value">${formatTokens(ctx.inputTokens / 1000)}</span></div>
            <div class="stat-item"><span class="stat-label">Total output</span><span class="stat-value">${formatTokens(ctx.outputTokens / 1000)}</span></div>
            <div class="stat-divider"></div>
            <div class="stat-item"><span class="stat-label">Cost</span><span class="stat-value" style="color:${getCostColor(cost.total_cost_usd)}">${formatCost(cost.total_cost_usd)}</span></div>
            <div class="stat-item"><span class="stat-label">Duration</span><span class="stat-value">${formatDuration(cost.total_duration_ms)}</span></div>
            <div class="stat-item"><span class="stat-label">API time</span><span class="stat-value">${formatDuration(cost.total_api_duration_ms)}</span></div>
            <div class="stat-item"><span class="stat-label">Lines</span><span class="stat-value"><span style="color:${CONTEXT_COLORS.green}">+${(cost.total_lines_added || 0).toLocaleString()}</span> / <span style="color:${CONTEXT_COLORS.red}">-${(cost.total_lines_removed || 0).toLocaleString()}</span></span></div>
          </div>
        </div>`;
}

//#endregion

//#region UTILS
function formatDate(dateStr) {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now - date;

  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return date.toLocaleDateString();
}

function stripAnsi(text) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: \x1b is intentional for ANSI escape sequence stripping
  return typeof text === 'string' ? text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '') : text;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function renderMarkdown(text) {
  if (typeof DOMPurify !== 'undefined' && typeof marked !== 'undefined') {
    return DOMPurify.sanitize(marked.parse(text));
  }
  return `<pre style="white-space:pre-wrap;margin:0;">${escapeHtml(text)}</pre>`;
}

const _agentTabTexts = {};

function renderAgentTabs(promptHtml, responseHtml, promptText, responseText) {
  for (const k in _agentTabTexts) delete _agentTabTexts[k];
  const tabs = [];
  const panels = [];
  const id = `at-${Math.random().toString(36).slice(2, 8)}`;
  if (promptHtml) {
    tabs.push({ key: 'prompt', label: 'Prompt' });
    panels.push({ key: 'prompt', html: promptHtml });
    if (promptText) _agentTabTexts[`${id}-prompt`] = promptText;
  }
  if (responseHtml) {
    tabs.push({ key: 'response', label: 'Response' });
    panels.push({ key: 'response', html: responseHtml });
    if (responseText) _agentTabTexts[`${id}-response`] = responseText;
  }
  if (!tabs.length) return '';
  const defaultTab = responseHtml ? 'response' : tabs[0].key;
  const copyBtnHtml = `<button class="agent-tab-copy" title="Copy" onclick="copyAgentTabActive('${id}',this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></button>`;
  const tabsHtml = tabs
    .map(
      (t) =>
        `<div class="agent-tab${t.key === defaultTab ? ' active' : ''}" data-tab-group="${id}" data-tab-key="${t.key}" onclick="document.querySelectorAll('[data-tab-group=\\'${id}\\']').forEach(el=>{el.classList.toggle('active',el.dataset.tabKey==='${t.key}')})">${t.label}</div>`,
    )
    .join('');
  const panelsHtml = panels
    .map(
      (p) =>
        `<div class="agent-tab-panel${p.key === defaultTab ? ' active' : ''}" data-tab-group="${id}" data-tab-key="${p.key}"><div class="detail-desc rendered-md" style="font-size:13px;">${p.html}</div></div>`,
    )
    .join('');
  return `<div class="agent-tabs">${tabsHtml}${copyBtnHtml}</div>${panelsHtml}`;
}

async function copyAgentTab(key, btn) {
  const text = _agentTabTexts[key];
  if (!text) return;
  copyWithFeedback(text, btn);
}

// biome-ignore lint/correctness/noUnusedVariables: used in HTML
async function copyAgentTabActive(groupId, btn) {
  const activePanel = document.querySelector(`.agent-tab-panel.active[data-tab-group="${groupId}"]`);
  if (!activePanel) return;
  const key = `${groupId}-${activePanel.dataset.tabKey}`;
  copyAgentTab(key, btn);
}

const ownerColors = [
  { bg: 'rgba(37, 99, 235, 0.14)', color: '#1d5bbf' }, // blue
  { bg: 'rgba(168, 85, 247, 0.14)', color: '#7c3aed' }, // purple
  { bg: 'rgba(14, 165, 133, 0.14)', color: '#0d7d65' }, // teal
  { bg: 'rgba(220, 80, 30, 0.14)', color: '#c04a1a' }, // red-orange
  { bg: 'rgba(202, 138, 4, 0.14)', color: '#92700c' }, // amber
  { bg: 'rgba(219, 39, 119, 0.14)', color: '#b5246a' }, // pink
  { bg: 'rgba(22, 163, 74, 0.14)', color: '#15803d' }, // green
  { bg: 'rgba(99, 102, 241, 0.14)', color: '#4f46e5' }, // indigo
];
const ownerColorCache = {};
function isInternalTask(task) {
  return task.metadata && task.metadata._internal === true;
}

function getOwnerColor(name) {
  if (ownerColorCache[name]) return ownerColorCache[name];
  let hash = 5381;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash * 33) ^ name.charCodeAt(i)) | 0;
  }
  const c = ownerColors[Math.abs(hash) % ownerColors.length];
  ownerColorCache[name] = c;
  return c;
}

//#endregion

//#region FILTERS
// biome-ignore lint/correctness/noUnusedVariables: used in HTML
function filterBySessions(value) {
  sessionFilter = value;
  updateUrl();
  renderSessions();
}

// biome-ignore lint/correctness/noUnusedVariables: used in HTML
function changeSessionLimit(value) {
  sessionLimit = value;
  updateUrl();
  fetchSessions();
}

function matchesProjectFilter(project) {
  if (!filterProject) return true;
  if (filterProject === '__recent__') return recentProjects.has(project);
  return project === filterProject;
}

//#endregion

//#region EVENT_DELEGATION
document.addEventListener('click', (e) => {
  const pathToggle = e.target.closest('[data-group-action="toggle-path"]');
  if (pathToggle) {
    e.stopPropagation();
    const header = pathToggle.closest('.project-group-header');
    let el = header?.nextElementSibling;
    while (el && !el.classList.contains('project-group-breadcrumb')) el = el.nextElementSibling;
    if (el) el.classList.toggle('expanded');
    return;
  }

  const breadcrumb = e.target.closest('.project-group-breadcrumb');
  if (breadcrumb) {
    e.stopPropagation();
    const path = breadcrumb.dataset.fullPath;
    if (path) navigator.clipboard.writeText(path).catch(() => {});
    return;
  }

  const header = e.target.closest('.project-group-header');
  if (header) {
    setGroupCollapsed(header, !collapsedProjectGroups.has(header.dataset.groupPath));
  }
});

// biome-ignore lint/correctness/noUnusedVariables: used in HTML
function filterByProject(project) {
  filterProject = project || null;
  updateUrl();
  renderSessions();
  showAllTasks();
}

let projectsCache = null;

async function updateProjectDropdown() {
  const dropdown = document.getElementById('project-filter');

  if (!projectsCacheDirty && projectsCache) {
    renderProjectDropdown(dropdown, projectsCache);
    return;
  }

  let projects;
  try {
    const res = await fetch('/api/projects');
    projects = await res.json();
  } catch (_e) {
    projects = [...new Set(sessions.map((s) => s.project).filter(Boolean))]
      .sort()
      .map((p) => ({ path: p, modifiedAt: null }));
  }

  projectsCache = projects;
  projectsCacheDirty = false;

  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  recentProjects = new Set(
    projects.filter((p) => p.modifiedAt && new Date(p.modifiedAt).getTime() > cutoff).map((p) => p.path),
  );

  renderProjectDropdown(dropdown, projects);
}

function renderProjectDropdown(dropdown, projects) {
  const recentSelected = filterProject === '__recent__' ? ' selected' : '';
  dropdown.innerHTML =
    '<option value="">All Projects</option>' +
    `<option value="__recent__"${recentSelected}>Recent (24h)</option>` +
    projects
      .map((p) => {
        const name = p.path.split(/[/\\]/).pop();
        const selected = p.path === filterProject ? ' selected' : '';
        return `<option value="${escapeHtml(p.path)}"${selected} title="${escapeHtml(p.path)}">${escapeHtml(name)}</option>`;
      })
      .join('');
}

function updateThemeColor(isLight) {
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
    m.setAttribute('content', isLight ? '#e8e6e3' : '#101114');
  });
}

//#endregion

//#region THEME
// biome-ignore lint/correctness/noUnusedVariables: used in HTML
function toggleTheme() {
  const isCurrentlyLight = document.body.classList.contains('light');
  if (isCurrentlyLight) {
    document.body.classList.remove('light');
    document.body.classList.add('dark-forced');
    localStorage.setItem('theme', 'dark');
  } else {
    document.body.classList.add('light');
    document.body.classList.remove('dark-forced');
    localStorage.setItem('theme', 'light');
  }
  updateThemeIcon();
  updateThemeColor(!isCurrentlyLight);
  syncHljsTheme();
}

function syncHljsTheme() {
  const isLight = document.body.classList.contains('light');
  const dark = document.getElementById('hljs-theme-dark');
  const light = document.getElementById('hljs-theme-light');
  if (dark) dark.disabled = isLight;
  if (light) light.disabled = !isLight;
}

function updateThemeIcon() {
  const saved = localStorage.getItem('theme');
  const isLight =
    document.body.classList.contains('light') || (!saved && window.matchMedia('(prefers-color-scheme: light)').matches);
  document.getElementById('theme-icon-dark').style.display = isLight ? 'none' : 'block';
  document.getElementById('theme-icon-light').style.display = isLight ? 'block' : 'none';
}

function loadTheme() {
  const saved = localStorage.getItem('theme');
  if (saved === 'light') {
    document.body.classList.add('light');
    document.body.classList.remove('dark-forced');
  } else if (saved === 'dark') {
    document.body.classList.remove('light');
    document.body.classList.add('dark-forced');
  }
  // If no saved preference, system prefers-color-scheme CSS handles it
  updateThemeIcon();
  updateThemeColor(document.body.classList.contains('light'));
  syncHljsTheme();
}

//#endregion

//#region SIDEBAR_LAYOUT
function toggleSidebar() {
  const sidebar = document.querySelector('.sidebar');
  const collapsed = sidebar.classList.toggle('collapsed');
  localStorage.setItem('sidebar-collapsed', collapsed);
  if (collapsed) {
    sidebar.style.width = '';
    if (focusZone === 'sidebar') setFocusZone('board');
  } else {
    const w = getComputedStyle(sidebar).getPropertyValue('--sidebar-width');
    if (w) sidebar.style.width = w;
  }
}

function loadSidebarState() {
  const sidebar = document.querySelector('.sidebar');
  if (localStorage.getItem('sidebar-collapsed') === 'true') {
    sidebar.classList.add('collapsed');
  }
  const w = localStorage.getItem('sidebar-width');
  if (w) {
    sidebar.style.setProperty('--sidebar-width', w);
  }
}

function initSidebarResize() {
  const sidebar = document.querySelector('.sidebar');
  const handle = document.getElementById('sidebar-resize');
  let startX, startWidth;

  handle.addEventListener('mousedown', (e) => {
    if (sidebar.classList.contains('collapsed')) return;
    startX = e.clientX;
    startWidth = sidebar.offsetWidth;
    sidebar.classList.add('resizing');
    handle.classList.add('dragging');
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    e.preventDefault();
  });

  function onMove(e) {
    const w = Math.min(600, Math.max(200, startWidth + e.clientX - startX));
    sidebar.style.setProperty('--sidebar-width', `${w}px`);
    sidebar.style.width = `${w}px`;
  }

  function onUp() {
    sidebar.classList.remove('resizing');
    handle.classList.remove('dragging');
    document.body.style.userSelect = '';
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    localStorage.setItem('sidebar-width', sidebar.style.getPropertyValue('--sidebar-width'));
  }
}

function initPanelResize(panelId, handleId, cssVar, storageKey) {
  const panel = document.getElementById(panelId);
  const handle = document.getElementById(handleId);
  let startX, startWidth;

  handle.addEventListener('mousedown', (e) => {
    startX = e.clientX;
    startWidth = panel.offsetWidth;
    panel.classList.add('resizing');
    handle.classList.add('dragging');
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    e.preventDefault();
  });

  function onMove(e) {
    const w = Math.min(900, Math.max(320, startWidth - (e.clientX - startX)));
    panel.style.setProperty(cssVar, `${w}px`);
  }

  function onUp() {
    panel.classList.remove('resizing');
    handle.classList.remove('dragging');
    document.body.style.userSelect = '';
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    localStorage.setItem(storageKey, panel.style.getPropertyValue(cssVar));
  }
}

function loadPanelWidths() {
  [
    ['detail-panel', '--detail-panel-width'],
    ['message-panel', '--message-panel-width'],
  ].forEach(([id, cssVar]) => {
    const w = localStorage.getItem(`${id}-width`);
    if (w) document.getElementById(id).style.setProperty(cssVar, w);
  });
}

//#endregion

//#region PREFERENCES
function loadPreferences() {
  document.getElementById('session-filter').value = sessionFilter;
  document.getElementById('session-limit').value = sessionLimit;
}

//#endregion

//#region SESSION_INFO
async function showSessionInfoModal(sessionId) {
  const session = sessions.find((s) => s.id === sessionId);
  if (!session) return;

  const promises = [];

  // Fetch team config
  let teamConfig = null;
  if (session.isTeam) {
    promises.push(
      fetch(`/api/teams/${sessionId}`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
        .then((data) => {
          teamConfig = data;
        }),
    );
  }

  // Fetch plan
  let planContent = null;
  promises.push(
    fetch(`/api/sessions/${sessionId}/plan`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((data) => {
        planContent = data?.content || null;
      }),
  );

  await Promise.all(promises);

  let tasks = currentSessionId === sessionId ? currentTasks : [];
  if (tasks.length === 0) {
    try {
      const r = await fetch(`/api/sessions/${sessionId}`);
      if (r.ok) tasks = await r.json();
    } catch {}
  }
  _planSessionId = sessionId;
  showInfoModal(session, teamConfig, tasks, planContent);
}

let _pendingPlanContent = null;

function showInfoModal(session, teamConfig, tasks, planContent) {
  const modal = document.getElementById('team-modal');
  const titleEl = document.getElementById('team-modal-title');
  const bodyEl = document.getElementById('team-modal-body');

  const titleText = teamConfig
    ? `Team: ${teamConfig.team_name || teamConfig.name || 'Unknown'}`
    : session.name || session.slug || session.id;
  titleEl.innerHTML =
    escapeHtml(titleText) +
    (session.modifiedAt
      ? `<div style="font-size: 12px; font-weight: 400; color: var(--text-tertiary); margin-top: 2px;">${formatDate(session.modifiedAt)} (${new Date(session.modifiedAt).toLocaleString()})</div>`
      : '');

  let html = '';

  // Session & project details as compact key-value rows
  // Each row: [label, displayValue, { openPath?, copyValue? }]
  const infoRows = [];
  infoRows.push(['Session', session.id, { openClaudeDir: true, openFile: session.jsonlPath }]);
  if (session.slug && session.hasPlan) {
    infoRows.push(['Slug', session.slug, { openClaudeDir: true, openFile: session.planPath }]);
  }
  if (session.project) {
    const projectName = session.project.split(/[/\\]/).pop();
    infoRows.push(['Project', projectName, { openPath: session.projectDir }]);
    infoRows.push(['Path', session.project, { openPath: session.project }]);
    if (session.gitBranch) {
      infoRows.push(['Branch', session.gitBranch]);
    }
    if (session.description) {
      infoRows.push(['Description', session.description]);
    }
  }
  if (session.tasksDir) {
    infoRows.push(['Tasks Dir', session.tasksDir, { openPath: session.tasksDir }]);
  }
  const clickableStyle =
    "font-family: 'IBM Plex Mono', monospace; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; color: var(--accent-text); text-decoration: underline; text-decoration-style: dotted; text-underline-offset: 3px;";
  const plainStyle =
    "font-family: 'IBM Plex Mono', monospace; font-size: 12px; user-select: all; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
  html += `<div class="team-modal-meta" style="margin-bottom: 16px; display: grid; grid-template-columns: auto 1fr auto; gap: 6px 12px; align-items: center;">`;
  infoRows.forEach(([label, value, opts]) => {
    const copyVal = escapeHtml(value).replace(/"/g, '&quot;');
    html += `<span style="font-weight: 500; color: var(--text-secondary); font-size: 12px; white-space: nowrap;">${label}</span>`;
    if (opts?.openClaudeDir || opts?.openPath) {
      const folder = opts.openClaudeDir ? '' : escapeHtml(opts.openPath).replace(/"/g, '&quot;');
      const file = opts.openFile ? escapeHtml(opts.openFile).replace(/"/g, '&quot;') : '';
      html += `<span data-folder="${folder}" data-file="${file}" data-claude-dir="${opts.openClaudeDir ? '1' : ''}" onclick="openFolderInEditor(this.dataset.claudeDir ? undefined : this.dataset.folder, this.dataset.file || undefined)" style="${clickableStyle}" title="Open in editor">${escapeHtml(value)}</span>`;
    } else {
      html += `<span style="${plainStyle}" title="${copyVal}">${escapeHtml(value)}</span>`;
    }
    html += `<button onclick="navigator.clipboard.writeText('${copyVal.replace(/'/g, "\\'")}'); this.textContent='✓'; setTimeout(() => this.textContent='Copy', 1000)" style="padding: 2px 8px; font-size: 11px; background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 4px; color: var(--text-secondary); cursor: pointer; white-space: nowrap;">Copy</button>`;
  });
  html += `</div>`;

  if (session.contextStatus) {
    html += `<hr style="border: none; border-top: 1px solid var(--border); margin: 12px 0;">`;
    html += renderContextDetail(session.contextStatus);
  }

  if (planContent) {
    _pendingPlanContent = planContent;
    const titleMatch = planContent.match(/^#\s+(.+)$/m);
    const planTitle = titleMatch ? titleMatch[1].trim() : null;
    html += `<div onclick="openPlanModal()" style="margin-bottom: 16px; padding: 10px 14px; background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 8px; cursor: pointer; display: flex; align-items: center; gap: 10px; transition: all 0.15s ease;" onmouseover="this.style.borderColor='var(--accent)';this.style.background='var(--bg-hover)'" onmouseout="this.style.borderColor='var(--border)';this.style.background='var(--bg-elevated)'">
          <span style="font-size: 14px;">📋</span>
          <div style="flex: 1; min-width: 0;">
            <div style="font-size: 11px; font-weight: 500; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px;">Plan</div>
            ${planTitle ? `<div style="font-size: 13px; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(planTitle)}</div>` : ''}
          </div>
          <svg viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="2" style="width: 16px; height: 16px; flex-shrink: 0;"><path d="M9 18l6-6-6-6"/></svg>
        </div>`;
  }

  // Team info section
  if (teamConfig) {
    const ownerCounts = {};
    const memberDescriptions = {};
    tasks.forEach((t) => {
      if (isInternalTask(t) && t.subject) {
        memberDescriptions[t.subject] = t.description;
      } else if (t.owner) {
        ownerCounts[t.owner] = (ownerCounts[t.owner] || 0) + 1;
      }
    });

    const members = teamConfig.members || [];
    const description = teamConfig.description || '';
    const lead = members.find((m) => m.agentType === 'team-lead' || m.name === 'team-lead');

    if (description) {
      html += `<div class="team-modal-desc">"${escapeHtml(description)}"</div>`;
    }

    html += `<div style="font-size: 12px; font-weight: 500; color: var(--text-secondary); margin-bottom: 10px;">Members (${members.length})</div>`;

    members.forEach((member) => {
      const taskCount = ownerCounts[member.name] || 0;
      const memberDesc = memberDescriptions[member.name];
      html += `
            <div class="team-member-card">
              <div class="member-name">🟢 ${escapeHtml(member.name)}</div>
              <div class="member-detail">Role: ${escapeHtml(member.agentType || 'unknown')}</div>
              ${member.model ? `<div class="member-detail">Model: ${escapeHtml(member.model)}</div>` : ''}
              ${memberDesc ? `<div class="member-detail" style="margin-top: 4px; font-style: italic; color: var(--text-secondary);">${escapeHtml(memberDesc.split('\n')[0])}</div>` : ''}
              <div class="member-tasks">Tasks: ${taskCount} assigned</div>
            </div>
          `;
    });

    const metaParts = [];
    if (teamConfig.created_at) {
      metaParts.push(`Created: ${new Date(teamConfig.created_at).toLocaleString()}`);
    }
    if (lead) {
      metaParts.push(`Lead: ${lead.name}`);
    }
    if (teamConfig.working_dir) {
      metaParts.push(`Working dir: ${teamConfig.working_dir}`);
    }
    if (metaParts.length > 0) {
      html += `<div class="team-modal-meta">${metaParts.map((p) => escapeHtml(p)).join('<br>')}</div>`;
    }
  }

  bodyEl.innerHTML = html;
  modal.classList.add('visible');

  const keyHandler = (e) => {
    if (e.key === 'Escape') {
      if (document.getElementById('plan-modal').classList.contains('visible')) return;
      e.preventDefault();
      closeTeamModal();
      document.removeEventListener('keydown', keyHandler);
    }
  };
  document.addEventListener('keydown', keyHandler);
}

function closeTeamModal() {
  document.getElementById('team-modal').classList.remove('visible');
}

let _planSessionId = null;

//#endregion

//#region PLAN
function refreshOpenPlan() {
  if (!_planSessionId || !document.getElementById('plan-modal').classList.contains('visible')) return;
  fetch(`/api/sessions/${_planSessionId}/plan`)
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (data?.content) {
        _pendingPlanContent = data.content;
        const body = document.getElementById('plan-modal-body');
        body.innerHTML = renderMarkdown(_pendingPlanContent);
      }
    })
    .catch(() => {});
}

function openPlanForSession(sid) {
  fetch(`/api/sessions/${sid}/plan`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
    .then((data) => {
      if (data?.content) {
        _pendingPlanContent = data.content;
        _planSessionId = sid;
        openPlanModal();
      }
    });
}

function openPlanModal() {
  if (!_pendingPlanContent) return;
  const body = document.getElementById('plan-modal-body');
  body.innerHTML = renderMarkdown(_pendingPlanContent);
  document.getElementById('plan-modal').classList.add('visible');
  const keyHandler = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closePlanModal();
      document.removeEventListener('keydown', keyHandler, true);
    }
  };
  document.addEventListener('keydown', keyHandler, true);
}

function closePlanModal() {
  resetModalFullscreen('plan-modal');
}

// biome-ignore lint/correctness/noUnusedVariables: used in HTML
function openPlanInEditor() {
  if (!_planSessionId) return;
  postAndToast(`/api/sessions/${_planSessionId}/plan/open`, {}, 'in editor');
}

// biome-ignore lint/correctness/noUnusedVariables: used in HTML
function openFolderInEditor(folder, file) {
  const body = {};
  if (folder) body.folder = folder;
  if (file) body.file = file;
  postAndToast('/api/open-folder', body, 'folder');
}

//#endregion

//#region OWNER_FILTER
function updateOwnerFilter() {
  const bar = document.getElementById('owner-filter-bar');
  const select = document.getElementById('owner-filter');

  const session = sessions.find((s) => s.id === currentSessionId);
  if (!session || !session.isTeam) {
    bar.classList.remove('visible');
    return;
  }

  bar.classList.add('visible');
  const owners = [
    ...new Set(
      currentTasks
        .filter((t) => !isInternalTask(t))
        .map((t) => t.owner)
        .filter(Boolean),
    ),
  ].sort();
  select.innerHTML =
    '<option value="">All Members</option>' +
    owners
      .map((o) => {
        const c = getOwnerColor(o);
        return `<option value="${escapeHtml(o)}" style="color:${c.color};background:${c.bg}"${o === ownerFilter ? ' selected' : ''}>${escapeHtml(o)}</option>`;
      })
      .join('');
  const current = ownerFilter ? getOwnerColor(ownerFilter) : null;
  select.style.color = current ? current.color : '';
  select.style.backgroundColor = current ? current.bg : '';
}

// biome-ignore lint/correctness/noUnusedVariables: used in HTML
function filterByOwner(value) {
  ownerFilter = value;
  const select = document.getElementById('owner-filter');
  const c = value ? getOwnerColor(value) : null;
  select.style.color = c ? c.color : '';
  select.style.backgroundColor = c ? c.bg : '';
  updateUrl();
  renderKanban();
}

//#endregion

//#region LAYOUT_SYNC
const sidebarHeader = document.querySelector('.sidebar-header');
const viewHeader = document.querySelector('.view-header');
new ResizeObserver(() => {
  sidebarHeader.style.height = `${viewHeader.offsetHeight}px`;
}).observe(viewHeader);

//#endregion

//#region PWA
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js');
}

//#endregion

//#region INIT
loadTheme();
['live-updates', 'sessions-filters'].forEach((id) => {
  if (localStorage.getItem(`${id}Collapsed`) === 'true') {
    document.getElementById(id).classList.add('collapsed');
    document
      .getElementById(id === 'live-updates' ? 'live-updates-chevron' : 'sessions-chevron')
      .classList.add('rotated');
  }
});

document.addEventListener('DOMContentLoaded', () => {
  if (typeof marked !== 'undefined' && typeof hljs !== 'undefined') {
    const renderer = new marked.Renderer();
    renderer.code = ({ text, lang }) => {
      let highlighted;
      if (lang && hljs.getLanguage(lang)) {
        highlighted = hljs.highlight(text, { language: lang }).value;
      } else {
        highlighted = hljs.highlightAuto(text).value;
      }
      return `<pre><code class="hljs language-${escapeHtml(lang || '')}">${highlighted}</code></pre>`;
    };
    marked.use({ renderer });
  }
});

loadSidebarState();
try {
  const cg = JSON.parse(localStorage.getItem('collapsedGroups') || '[]');
  // biome-ignore lint/suspicious/useIterableCallbackReturn: forEach side-effect
  cg.forEach((p) => collapsedProjectGroups.add(p));
} catch (_) {}
initSidebarResize();
loadPanelWidths();
initPanelResize('detail-panel', 'detail-panel-resize', '--detail-panel-width', 'detail-panel-width');
initPanelResize('message-panel', 'message-panel-resize', '--message-panel-width', 'message-panel-width');
fetch('/api/version')
  .then((r) => r.json())
  .then((d) => {
    document.getElementById('sidebar-footer').textContent = `v${d.version}`;
  })
  .catch(() => {});

const urlState = getUrlState();
sessionFilter = urlState.filter || 'active';
sessionLimit = urlState.limit || '20';
filterProject = urlState.project || '__recent__';
ownerFilter = urlState.owner || '';
searchQuery = urlState.search || '';

loadPreferences();
pinnedSessionIds = loadPinnedSessions();
setupEventSource();

if (urlState.search) {
  document.getElementById('search-input').value = urlState.search;
  document.getElementById('search-clear-btn').classList.add('visible');
}

fetchSessions().then(async () => {
  if (urlState.session) {
    await fetchTasks(urlState.session);
  } else {
    showAllTasks();
  }
  if (urlState.messages && currentSessionId) {
    toggleMessagePanel();
  }
});

window.addEventListener('popstate', () => {
  const s = getUrlState();
  sessionFilter = s.filter || 'active';
  sessionLimit = s.limit || '20';
  filterProject = s.project || '__recent__';
  ownerFilter = s.owner || '';
  searchQuery = s.search || '';
  loadPreferences();
  if (s.session) fetchTasks(s.session);
  else showAllTasks();
  if (s.messages !== messagePanelOpen) toggleMessagePanel();
});
//#endregion
