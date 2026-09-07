//#region STATE
// The baseline "nothing is filtered" state: what resetState() returns to, what updateUrl() omits
// from the query string, and what decides whether a control tints ember in the header summary.
const FILTER_DEFAULTS = { project: '__recent__', session: 'active', limit: '20' };

let sessions = [];
let currentSessionId = null;
let currentTasks = [];
let viewMode = 'session';
let sessionFilter = FILTER_DEFAULTS.session;
// Only meaningful while sessionFilter === 'active' (filterBySessions clears it otherwise)
const activityFilter = new Set(); // kinds: 'waiting' | 'active'
let sessionLimit = FILTER_DEFAULTS.limit;
let filterProject = FILTER_DEFAULTS.project; // null = all, '__recent__' = last 24h, or project path
let recentProjects = new Set();
let projectsCacheDirty = true;
const collapsedProjectGroups = new Set();
const SECTION_GROUPS = '__section_groups__';
const SECTION_PROJECTS = '__section_projects__';
const SECTION_SESSIONS = '__section_sessions__';
let stableGroupOrder = []; // cached project path order to prevent jumping
let sessionGroups = []; // user-named groups: [{id, name, color, members:[{type,ref}]}]
let sgDrag = null; // in-flight sidebar drag: {kind:'session'|'project'|'group', ref}
let searchQuery = ''; // Search query for fuzzy search
let allTasksCache = []; // Cache all tasks for search
let ownerFilter = '';
let currentAgents = [];
let currentWaiting = null;
let lastWaitingHash = '';
let lastAgentsHash = '';
let messagePanelOpen = false;
let lastMessagesHash = '';
let currentMessages = [];
let agentDurationInterval = null;
let agentPollInterval = null;
let selectedTaskId = null;
let selectedSessionId = null;
// Task stays selected (keyboard nav) but its white highlight is dimmed once the detail panel closes.
let taskHighlightDimmed = false;
let focusZone = 'board'; // 'board' | 'sidebar'
let appConfig = { marketplaceUrl: null, costUrl: null, memoryUrl: null, scratchAvailable: false };
let selectedSessionIdx = -1;
let selectedSessionKbId = null;
let sessionJustSelected = false;
let agentLogMode = null;
let agentLogSSE = null;
let msgHasMore = false;
let msgLoadingMore = false;
let msgUserScrolledUp = false;
const MSG_MAX_LOADED = 200;
let currentProjectPath = null;
let currentProjectSessionIds = [];
const dismissedSessionIds = new Set();

function resetMessageScrollState() {
  msgUserScrolledUp = false;
  msgHasMore = false;
  msgLoadingMore = false;
  currentMessages = [];
  lastMessagesHash = '';
  const btn = document.getElementById('msg-jump-latest');
  if (btn) btn.style.display = 'none';
}

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
    messages: params.has('messages')
      ? params.get('messages') === '1'
      : localStorage.getItem('message-panel-open') === 'true',
    projectView: params.get('projectView'),
  };
}

function updateUrl() {
  const params = new URLSearchParams();
  if (viewMode === 'all') params.set('view', 'all');
  if (viewMode === 'project' && currentProjectPath) params.set('projectView', btoa(currentProjectPath));
  if (currentSessionId) params.set('session', currentSessionId);
  if (sessionFilter !== FILTER_DEFAULTS.session) params.set('filter', sessionFilter);
  if (sessionLimit !== FILTER_DEFAULTS.limit) params.set('limit', sessionLimit);
  if (filterProject && filterProject !== FILTER_DEFAULTS.project) params.set('project', filterProject);
  if (ownerFilter) params.set('owner', ownerFilter);
  if (searchQuery) params.set('search', searchQuery);
  if (messagePanelOpen) params.set('messages', '1');
  const qs = params.toString();
  const url = qs ? `?${qs}` : window.location.pathname;
  history.replaceState(null, '', url);
  persistLastView();
}

const LAST_VIEW_KEY = 'lastView';
function persistLastView() {
  try {
    const data = {
      view: viewMode,
      session: currentSessionId,
      projectPath: viewMode === 'project' ? currentProjectPath : null,
      // The project filter also lives in the URL, but the hub recreates each iframe at the app's
      // base URL on reload, so the query string alone doesn't survive a hub refresh.
      project: filterProject,
    };
    localStorage.setItem(LAST_VIEW_KEY, JSON.stringify(data));
  } catch (_) {}
}
function loadLastView() {
  try {
    return JSON.parse(localStorage.getItem(LAST_VIEW_KEY)) || null;
  } catch (_) {
    return null;
  }
}

// biome-ignore lint/correctness/noUnusedVariables: used in HTML
function resetState() {
  history.replaceState(null, '', window.location.pathname);
  try {
    localStorage.removeItem(LAST_VIEW_KEY);
  } catch (_) {}
  sessionFilter = FILTER_DEFAULTS.session;
  sessionLimit = FILTER_DEFAULTS.limit;
  filterProject = FILTER_DEFAULTS.project;
  ownerFilter = '';
  searchQuery = '';
  viewMode = 'all';
  if (agentLogMode) exitAgentLogMode();
  currentSessionId = null;
  currentProjectPath = null;
  currentProjectSessionIds = [];
  resetMessageScrollState();
  const searchInput = document.getElementById('search-input');
  if (searchInput) searchInput.value = '';
  document.getElementById('search-clear-btn')?.classList.remove('visible');
  renderFilterState();
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
const CONTENT_TRUNCATE_MAX = 1500;
const COLUMNS = [{ el: pendingTasks }, { el: inProgressTasks }, { el: completedTasks }];

let lastSessionsHash = '';
let lastTasksHash = '';

//#endregion

//#region DATA_FETCHING
async function fetchSessions(includeTasks = true) {
  try {
    const allPinnedIds = new Set([...pinnedSessionIds, ...stickySessionIds]);
    if (revealedPlanSessionId) allPinnedIds.add(revealedPlanSessionId);
    if (revealedStorageSessionId) allPinnedIds.add(revealedStorageSessionId);
    // When server filters by activity, the focused session may not be active —
    // include it in pinned so the server still returns it.
    if (sessionFilter === 'active' && currentSessionId) allPinnedIds.add(currentSessionId);
    const pinnedParam = allPinnedIds.size > 0 ? `&pinned=${[...allPinnedIds].join(',')}` : '';
    const projectParam =
      filterProject && filterProject !== '__recent__' ? `&project=${encodeURIComponent(filterProject)}` : '';
    const filterParam = sessionFilter === 'active' ? '&filter=active' : '';
    const sessionsPromise = fetch(
      `/api/sessions?limit=${sessionLimit}${pinnedParam}${projectParam}${filterParam}`,
    ).then((r) => r.json());

    let newSessions, newTasks;
    if (includeTasks) {
      [newSessions, newTasks] = await Promise.all([sessionsPromise, fetch('/api/tasks/all').then((r) => r.json())]);
    } else {
      newSessions = await sessionsPromise;
    }

    const sessionsHash = JSON.stringify(newSessions);
    if (includeTasks) {
      const tasksHash = JSON.stringify(newTasks);
      if (sessionsHash === lastSessionsHash && tasksHash === lastTasksHash) return;
      lastTasksHash = tasksHash;
      allTasksCache = newTasks;
    } else {
      if (sessionsHash === lastSessionsHash) return;
    }
    lastSessionsHash = sessionsHash;

    sessions = newSessions;
    renderSessions();
    renderActivityChip();
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

//#endregion

//#region SEARCH
function fuzzyMatch(text, query) {
  if (!query) return true;
  if (!text) return false;

  text = text.toLowerCase();
  query = query.toLowerCase();

  // Prioritize exact substring match
  if (text.includes(query)) return true;

  // Split by common delimiters to search in individual words
  const words = text.split(/[\s\-_/.\\]+/);

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

// biome-ignore lint/correctness/noUnusedVariables: used in HTML
function toggleSection(containerId, chevronId) {
  const container = document.getElementById(containerId);
  const chevron = document.getElementById(chevronId);
  const collapsed = container.classList.toggle('collapsed');
  chevron.classList.toggle('rotated', collapsed);
  localStorage.setItem(`${containerId}Collapsed`, collapsed);
}

function isWaitingSession(s) {
  return !!s.hasWaitingForUser;
}
function isActiveSession(s) {
  return !s.hasWaitingForUser && (s.inProgress > 0 || s.hasRecentLog || s.hasRunningAgents);
}
// hasRecentLog carries the server's registry-idle correction: an open-but-idle
// terminal keeps touching its JSONL, so mtime alone is not proof of activity.
function isSessionLive(s) {
  return !!s.hasRecentLog && Date.now() - Date.parse(s.modifiedAt) <= LIVE_INDICATOR_MS;
}

const ACTIVITY_PREDICATES = {
  waiting: isWaitingSession,
  active: isActiveSession,
};

let lastChipKey = '';

function renderActivityChip() {
  const container = document.getElementById('activity-chips');
  if (!container) return;

  let waiting = 0;
  let active = 0;
  for (const s of sessions) {
    if (dismissedSessionIds.has(s.id)) continue;
    if (s.hasWaitingForUser) waiting++;
    else if (s.inProgress > 0 || s.hasRecentLog || s.hasRunningAgents) active++;
  }

  const key = `${waiting}|${active}|${dismissedSessionIds.size}|${[...activityFilter].sort().join(',')}`;
  if (key === lastChipKey) return;
  lastChipKey = key;

  const chips = [
    {
      kind: 'waiting',
      count: waiting,
      label: `${waiting} waiting`,
      title: `${waiting} session${waiting === 1 ? '' : 's'} waiting for input`,
    },
    {
      kind: 'active',
      count: active,
      label: `${active} active`,
      title: `${active} session${active === 1 ? '' : 's'} with running work or recent activity`,
    },
  ];

  container.innerHTML = chips
    .map((c) => {
      const isOn = activityFilter.has(c.kind);
      const classes = [
        'activity-chip',
        `activity-${c.kind}`,
        c.count === 0 ? 'activity-zero' : '',
        isOn ? 'activity-filter-on' : '',
      ]
        .filter(Boolean)
        .join(' ');
      const hint = isOn ? ' — click to clear filter' : ` — click to filter to ${c.kind}`;
      return `
        <button type="button"
          class="${classes}"
          onclick="setActivityFilter('${escAttrJs(c.kind)}')"
          aria-pressed="${isOn ? 'true' : 'false'}"
          title="${escapeHtml(c.title + hint)}">
          <span class="activity-dot"></span>
          <span class="activity-label">${escapeHtml(c.label)}</span>
        </button>
      `;
    })
    .join('');
}

function toggleActivityKind(kind) {
  if (activityFilter.has(kind)) activityFilter.delete(kind);
  else activityFilter.add(kind);
}

// biome-ignore lint/correctness/noUnusedVariables: used in HTML
function setActivityFilter(kind) {
  if (kind === 'active') {
    // waiting is a sub-state of active — couple them so one click covers all running sessions
    toggleActivityKind('active');
    toggleActivityKind('waiting');
    // Expand sections that have active sessions so they're visible on click
    if (activityFilter.has('active')) expandActiveGroups();
  } else {
    toggleActivityKind(kind);
  }
  localStorage.setItem('activityFilter', JSON.stringify([...activityFilter]));
  // active/waiting only make sense with the active session filter on
  const targetFilter = activityFilter.size > 0 ? 'active' : sessionFilter;
  if (targetFilter !== sessionFilter) {
    sessionFilter = targetFilter;
    const dropdown = document.getElementById('session-filter');
    if (dropdown) dropdown.value = targetFilter;
    updateUrl();
  }
  renderSessions();
  renderActivityChip();
}

let lastCurrentTasksHash = '';

async function fetchTasks(sessionId) {
  try {
    viewMode = 'session';
    document.getElementById('message-toggle')?.style.removeProperty('display');
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
      return;
    }
    lastCurrentTasksHash = hash;

    currentTasks = newTasks;
    if (agentLogMode && sessionId !== currentSessionId) exitAgentLogMode();
    if (sessionId !== currentSessionId && document.getElementById('scratchpad-modal').classList.contains('visible'))
      closeScratchpad();
    if (revealedPlanSessionId && sessionId !== revealedPlanSessionId) {
      revealedPlanSessionId = null;
    }
    if (revealedStorageSessionId && sessionId !== revealedStorageSessionId) {
      revealedStorageSessionId = null;
    }
    if (currentSessionId && currentSessionId !== sessionId) deferredPinPlacement.delete(currentSessionId);
    currentSessionId = sessionId;
    currentPins = loadPins(sessionId);
    ownerFilter = '';
    resetMessageScrollState();
    for (const k of Object.keys(ownerColorCache)) delete ownerColorCache[k];
    for (const k of Object.keys(teamColorMap)) delete teamColorMap[k];
    sessionJustSelected = true;
    resetAgentState();
    updateUrl();
    renderSession();
    renderSessions();
    fetchAgents(sessionId);
    if (!agentLogMode) fetchMessages(sessionId);
  } catch (error) {
    console.error('Failed to fetch tasks:', error);
    currentTasks = [];
    currentSessionId = sessionId;
    lastCurrentTasksHash = '';
    updateUrl();
    renderSession();
  }
}

// #region TIMINGS
const WAITING_TTL_MS = 30 * 60 * 1000;
const AGENT_LOG_MAX = 8;
const LIVE_INDICATOR_MS = 10 * 1000;
// #endregion

function resetAgentState() {
  currentAgents = [];
  currentWaiting = null;
  lastAgentsHash = '';
  lastWaitingHash = '';
  renderAgentFooter();
}

async function fetchAgents(sessionId) {
  try {
    const res = await fetch(`/api/sessions/${sessionId}/agents`);
    if (!res.ok) {
      resetAgentState();
      return;
    }
    const data = await res.json();
    const agents = Array.isArray(data) ? data : data.agents || [];
    currentWaiting = data.waitingForUser || null;
    const hash = JSON.stringify(data);
    if (hash === lastAgentsHash) return;
    lastAgentsHash = hash;
    currentAgents = agents;
    updateTeamColors(agents, data.teamColors);
    for (const k of Object.keys(ownerColorCache)) delete ownerColorCache[k];
    renderAgentFooter();
    if (currentSessionId === sessionId) renderKanban();
    const waitHash = JSON.stringify(currentWaiting);
    if (waitHash !== lastWaitingHash) {
      lastWaitingHash = waitHash;
      if (messagePanelOpen && currentMessages.length) renderMessages(currentMessages);
      maybeFollowLatest();
    }
  } catch (e) {
    console.error('[fetchAgents]', e);
  }
}

async function fetchProjectView(projectPath) {
  viewMode = 'project';
  currentProjectPath = projectPath;
  currentSessionId = null;
  currentMessages = [];
  lastMessagesHash = '';
  if (messagePanelOpen) toggleMessagePanel();
  document.getElementById('message-toggle')?.style.setProperty('display', 'none');
  const msgContent = document.getElementById('message-panel-content');
  if (msgContent) msgContent.innerHTML = '';
  const msgPinned = document.getElementById('message-panel-pinned');
  if (msgPinned) msgPinned.innerHTML = '';
  const projectSessions = sessions.filter((s) => s.project === projectPath);
  currentProjectSessionIds = projectSessions.map((s) => s.id);
  const activeSessionIds = projectSessions.filter((s) => isSessionActive(s) || isAnyPinned(s.id)).map((s) => s.id);

  const encoded = btoa(projectPath);
  const [tasksResult, agentResults] = await Promise.all([
    fetch(`/api/projects/${encodeURIComponent(encoded)}/tasks`)
      .then((r) => r.json())
      .catch((e) => {
        console.error('[fetchProjectView] tasks:', e);
        return [];
      }),
    Promise.all(
      activeSessionIds.map((id) =>
        fetch(`/api/sessions/${id}/agents`)
          .then((r) => r.json())
          .catch(() => ({ agents: [] })),
      ),
    ),
  ]);
  currentTasks = tasksResult;
  const seen = new Set();
  currentAgents = [];
  const mergedColors = {};
  let mergedWaiting = null;
  for (let i = 0; i < agentResults.length; i++) {
    const r = agentResults[i];
    const sid = activeSessionIds[i];
    const agents = r.agents || (Array.isArray(r) ? r : []);
    for (const a of agents) {
      if (a.agentId && !seen.has(a.agentId)) {
        seen.add(a.agentId);
        a._sourceSessionId = sid;
        currentAgents.push(a);
      }
    }
    if (r.teamColors) Object.assign(mergedColors, r.teamColors);
    if (r.waitingForUser && !mergedWaiting) mergedWaiting = r.waitingForUser;
  }
  currentWaiting = mergedWaiting;
  Object.assign(teamColorMap, mergedColors);

  renderProjectView();
  renderAgentFooter();
  renderKanban();
  updateUrl();
}

async function refreshProjectAgents() {
  if (!currentProjectPath) return;
  const projectSessions = sessions.filter((s) => s.project === currentProjectPath);
  const activeSessionIds = projectSessions.filter((s) => isSessionActive(s) || isAnyPinned(s.id)).map((s) => s.id);
  const agentResults = await Promise.all(
    activeSessionIds.map((id) =>
      fetch(`/api/sessions/${id}/agents`)
        .then((r) => r.json())
        .catch(() => ({ agents: [] })),
    ),
  );
  const seen = new Set();
  currentAgents = [];
  let mergedWaiting = null;
  for (let i = 0; i < agentResults.length; i++) {
    const r = agentResults[i];
    const sid = activeSessionIds[i];
    const agents = r.agents || (Array.isArray(r) ? r : []);
    for (const a of agents) {
      if (a.agentId && !seen.has(a.agentId)) {
        seen.add(a.agentId);
        a._sourceSessionId = sid;
        currentAgents.push(a);
      }
    }
    if (r.teamColors) Object.assign(teamColorMap, r.teamColors);
    if (r.waitingForUser && !mergedWaiting) mergedWaiting = r.waitingForUser;
  }
  currentWaiting = mergedWaiting;
  const hash = JSON.stringify({ agents: currentAgents, waiting: currentWaiting });
  if (hash === lastAgentsHash) return;
  lastAgentsHash = hash;
  renderAgentFooter();
}

//#region MESSAGE_PANEL
function toggleMessagePanel() {
  const panel = document.getElementById('message-panel');
  messagePanelOpen = !messagePanelOpen;
  localStorage.setItem('message-panel-open', messagePanelOpen);
  panel.classList.toggle('visible', messagePanelOpen);
  document.getElementById('message-toggle')?.classList.toggle('active', messagePanelOpen);
  if (messagePanelOpen && currentSessionId) {
    if (currentMessages.length) renderMessages(currentMessages);
    fetchMessages(currentSessionId);
  }
  updateUrl();
}

// biome-ignore lint/correctness/noUnusedVariables: used in HTML onclick
async function openSessionWithBookmarks(sessionId) {
  if (!messagePanelOpen) {
    const panel = document.getElementById('message-panel');
    messagePanelOpen = true;
    localStorage.setItem('message-panel-open', 'true');
    panel.classList.add('visible');
    document.getElementById('message-toggle')?.classList.add('active');
  }
  await fetchTasks(sessionId);
  if (currentMessages.length) renderMessages(currentMessages);
  fetchMessages(sessionId);
}

// biome-ignore lint/correctness/noUnusedVariables: used in HTML
async function viewAgentLog(agentId) {
  let agent = findAgentById(agentId);
  if (!agent && currentSessionId) {
    await fetchAgents(currentSessionId);
    agent = findAgentById(agentId);
  }
  if (!agent) {
    if (!currentSessionId) return;
    agent = { agentId: agentId, type: 'Agent', _sourceSessionId: currentSessionId };
  }
  const resolvedId = agent.agentId;
  const shortId = resolvedId.length > 8 ? resolvedId.slice(0, 8) : resolvedId;
  const agentSessionId = agent._sourceSessionId || currentSessionId;
  agentLogMode = { agentId: resolvedId, sessionId: agentSessionId, agentType: agent.type || 'unknown' };
  resetMessageScrollState();
  closeAgentModal();
  document.getElementById('message-toggle')?.style.removeProperty('display');
  if (!messagePanelOpen) toggleMessagePanel();
  const header = document.querySelector('.message-panel-header h3');
  if (header) {
    header.innerHTML = `<span class="agent-log-title"><button class="agent-log-back" onclick="exitAgentLogMode()" title="Back to session log">&larr;</button> ${escapeHtml(agent.type || 'unknown')} <code class="agent-log-id">(${escapeHtml(shortId)})</code></span>`;
  }
  fetchAgentMessages();
  if (agentLogSSE) {
    agentLogSSE.close();
    agentLogSSE = null;
  }
  agentLogSSE = new EventSource(`/api/sessions/${agentLogMode.sessionId}/agents/${resolvedId}/messages/stream`);
  agentLogSSE.addEventListener('agent-log-update', (e) => {
    if (!agentLogMode || agentLogMode.agentId !== resolvedId) return;
    try {
      const data = JSON.parse(e.data);
      currentMessages = data.messages;
      if (messagePanelOpen) renderMessages(data.messages);
      maybeFollowLatest();
    } catch (_) {}
  });
  agentLogSSE.onerror = () => {};
}

function exitAgentLogMode() {
  agentLogMode = null;
  if (agentLogSSE) {
    agentLogSSE.close();
    agentLogSSE = null;
  }
  if (viewMode === 'project') {
    if (messagePanelOpen) toggleMessagePanel();
    document.getElementById('message-toggle')?.style.setProperty('display', 'none');
    return;
  }
  const header = document.querySelector('.message-panel-header h3');
  if (header) header.textContent = 'Session Log';
  resetMessageScrollState();
  if (currentSessionId) fetchMessages(currentSessionId);
}

async function fetchAgentMessages() {
  if (!agentLogMode) return;
  const { sessionId, agentId } = agentLogMode;
  try {
    const res = await fetch(`/api/sessions/${sessionId}/agents/${agentId}/messages?limit=100`);
    if (!res.ok || !agentLogMode || agentLogMode.agentId !== agentId) return;
    const data = await res.json();
    if (!agentLogMode || agentLogMode.agentId !== agentId) return;
    currentMessages = data.messages;
    if (messagePanelOpen) renderMessages(data.messages);
    maybeFollowLatest();
  } catch (e) {
    console.error('[fetchAgentMessages]', e);
  }
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
    if (agentLogMode) return;

    if (!msgUserScrolledUp) {
      const hash = JSON.stringify(data.messages);
      if (hash === lastMessagesHash) return;
      lastMessagesHash = hash;
      msgHasMore = data.hasMore !== false;
      currentMessages = data.messages;
      if (messagePanelOpen) renderMessages(data.messages);
    } else {
      if (data.messages.length && currentMessages.length) {
        const lastKnown = currentMessages[currentMessages.length - 1].timestamp;
        const newMsgs = data.messages.filter((m) => m.timestamp > lastKnown);
        if (newMsgs.length) {
          currentMessages = [...currentMessages, ...newMsgs];
          if (currentMessages.length > MSG_MAX_LOADED) {
            currentMessages = currentMessages.slice(-MSG_MAX_LOADED);
            msgHasMore = true;
          }
          if (messagePanelOpen) renderMessages(currentMessages);
        }
      }
    }

    maybeFollowLatest();
  } catch (e) {
    console.error('[fetchMessages]', e);
  }
}

async function loadOlderMessages() {
  if (agentLogMode || msgLoadingMore || !msgHasMore || !currentMessages.length) return;
  msgLoadingMore = true;
  const container = document.getElementById('message-panel-content');
  const loader = document.createElement('div');
  loader.className = 'msg-loading-more';
  loader.textContent = 'Loading...';
  container.prepend(loader);
  try {
    const before = currentMessages[0].timestamp;
    const res = await fetch(`/api/sessions/${currentSessionId}/messages?limit=15&before=${encodeURIComponent(before)}`);
    if (!res.ok) return;
    const data = await res.json();
    msgHasMore = data.hasMore && data.messages.length > 0;
    if (data.messages.length) {
      loader.remove();
      const prevHeight = container.scrollHeight;
      currentMessages = [...data.messages, ...currentMessages];
      if (currentMessages.length > MSG_MAX_LOADED) {
        currentMessages = currentMessages.slice(0, MSG_MAX_LOADED);
      }
      renderMessages(currentMessages);
      container.scrollTop = container.scrollHeight - prevHeight;
    }
  } catch (e) {
    console.error('[loadOlderMessages]', e);
  } finally {
    if (loader.parentNode) loader.remove();
    requestAnimationFrame(() => {
      msgLoadingMore = false;
      // Chain auto-load if content still doesn't overflow
      if (msgHasMore && currentMessages.length < MSG_MAX_LOADED && container.scrollHeight <= container.clientHeight) {
        loadOlderMessages();
      }
    });
  }
}

function parseCommandMessage(text) {
  const nameMatch = text.match(/<command-name>([^<]+)<\/command-name>/);
  if (nameMatch) return nameMatch[1].trim();
  const msgMatch = text.match(/<command-message>([^<]+)<\/command-message>/);
  if (msgMatch) return `/${msgMatch[1].trim()}`;
  return null;
}

function parseCommandArgs(text) {
  const m = (text || '').match(/<command-args>([^<]*)<\/command-args>/);
  return m?.[1].trim() || '';
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

// A GFM table delimiter row (|---|:--:|): only pipes/dashes/colons/spaces, with
// at least one dash. Pairs with a preceding line that has cells to mark a table.
function isTableDelimiter(line) {
  const l = (line || '').trim();
  return l.includes('-') && /^\|?[ :|-]+\|?$/.test(l);
}

// Cut a string to at most `max` chars at a word boundary (no mid-word chops).
function truncateAtWord(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd();
}

// Build a markdown preview for an assistant message: render real markdown but
// truncate on clean structural boundaries so the feed stays compact and the
// output is always valid markdown (never cut mid code-fence or mid table-row).
// Prose is bounded by a line count AND a char budget (long single paragraphs are
// cut at a word boundary). Returns { md, remainder } where remainder is a short
// label describing what was cut (e.g. "+12 lines"), or '' when nothing was cut.
function buildAssistantPreview(text) {
  const lines = stripAnsi(text || '')
    .replace(/\r/g, '')
    .split('\n');
  const MAX_LINES = 5; // non-blank content lines kept before truncating
  const MAX_CHARS = 280; // total prose/code/table chars kept
  const MAX_ROWS = 3; // table body rows
  const MAX_CODE_LINES = 8; // lines kept inside a fenced code block
  const countRest = (idx) => {
    let c = 0;
    for (let j = idx; j < lines.length; j++) if (lines[j].trim()) c++;
    return c;
  };
  const pluralize = (n, word) => `+${n} ${word}${n > 1 ? 's' : ''}`;
  const out = [];
  let remainder = '';
  let content = 0;
  let chars = 0;
  let i = 0;

  for (; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (content >= MAX_LINES || chars >= MAX_CHARS) {
      const rest = countRest(i);
      if (rest) remainder = pluralize(rest, 'line');
      break;
    }

    // Fenced code block — copy verbatim (capped), never break the fence open.
    const fence = trimmed.match(/^(```|~~~)/);
    if (fence) {
      const marker = fence[1];
      out.push(line);
      let codeLines = 0;
      let dropped = 0;
      // Advance to the real closing fence, keeping at most MAX_CODE_LINES lines,
      // so leftover code isn't re-parsed as top-level markdown after the cap.
      for (i++; i < lines.length && !lines[i].trim().startsWith(marker); i++) {
        if (codeLines < MAX_CODE_LINES) {
          out.push(lines[i]);
          codeLines++;
          chars += lines[i].length;
        } else {
          dropped++;
        }
      }
      out.push(marker); // close the fence (covers capped / unterminated blocks)
      content++;
      if (dropped) {
        // Stop at the truncated code block rather than resuming after the gap.
        remainder = pluralize(dropped, 'code line');
        break;
      }
      continue;
    }

    // Table — keep header + separator + up to MAX_ROWS body rows.
    if (line.includes('|') && isTableDelimiter(lines[i + 1])) {
      out.push(line, lines[i + 1]);
      content++;
      chars += line.length;
      i++;
      let rows = 0;
      let droppedRows = 0;
      while (lines[i + 1]?.includes('|')) {
        if (rows >= MAX_ROWS) {
          // Skip remaining rows so they aren't re-rendered as prose lines.
          droppedRows++;
          i++;
          continue;
        }
        out.push(lines[++i]);
        rows++;
      }
      if (droppedRows) {
        // Stop at the truncated table — don't resume with later content across
        // the gap; the "+N rows" chip signals the table continues.
        remainder = pluralize(droppedRows, 'row');
        break;
      }
      continue;
    }

    // Prose / list / heading — bound by the remaining char budget, cutting a
    // long line at a word boundary rather than rendering a giant paragraph.
    const remaining = MAX_CHARS - chars;
    if (trimmed && line.length > remaining) {
      out.push(truncateAtWord(line, remaining));
      // Mid-line word cut — line counts would be misleading; count only the
      // additional full lines that follow, else just signal "more".
      const rest = countRest(i + 1);
      remainder = rest ? pluralize(rest, 'line') : 'more';
      break;
    }
    out.push(line);
    chars += line.length;
    if (trimmed) content++;
  }

  return { md: out.join('\n').trim(), remainder };
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
        const toolDetail = getToolDetail(p.tool, p.params, p.detail);
        const pinnedAgentLogBtn = resolveAgentLogBtn(p);
        return `<div class="msg-item msg-tool" ${click}>
            ${getToolIcon(p.tool)}
            <div class="msg-body"><div class="msg-text">${escapeHtml(p.tool || '')}${toolDetail}</div><div class="msg-time">${formatDate(p.timestamp)}</div></div>${pinnedAgentLogBtn}${unpin}
          </div>`;
      } else if (p.type === 'agent') {
        const agentLogBtn = agentLogButton(p.agentId);
        const msgTrunc = p.lastMessage
          ? escapeHtml(
              stripAnsi(stripTeammateWrapper(p.lastMessage.trim()))
                .replace(/[\r\n]+/g, ' ')
                .slice(0, 60),
            )
          : '';
        const agentDetail = msgTrunc ? ` <span style="color:var(--text-muted)">${msgTrunc}</span>` : '';
        return `<div class="msg-item msg-tool" ${click}>
            ${MSG_ICON_TOOL}
            <div class="msg-body"><div class="msg-text">${escapeHtml(p.agentType || 'Agent')}${agentDetail}</div><div class="msg-time">${formatDate(p.timestamp)}</div></div>${agentLogBtn}${unpin}
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

function resolveAgentLogBtn(m) {
  if (m.tool === 'Agent' && m.agentId) return agentLogButton(m.agentId);
  if (m.tool === 'SendMessage' && m.params?.to) {
    const recipient = currentAgents.find((a) => (a.type || a.name) === m.params.to);
    if (recipient) return agentLogButton(recipient.agentId);
  }
  return '';
}

function toolGroupKey(m) {
  return m.type === 'tool_use' ? `${m.tool}\0${m.detail || ''}` : null;
}

function renderToolItem(m, i, compact) {
  const toolDetail = getToolDetail(m.tool, m.params, m.detail);
  // m.agentId is resolved server-side even while the agent is still running (correlated
  // from the live agent-activity files), so the ⇗ link, agent-log button, and modal
  // click all light up DURING the run, identical to post-completion.
  const agentLink =
    m.tool === 'Agent' && m.agentId
      ? ` <span class="msg-agent-link" title="View agent" onclick="event.stopPropagation();showAgentModal('${escAttrJs(m.agentId)}')">⇗</span>`
      : '';
  // Usage chip (tokens · tools · duration) on completed Agent rows — same stats a
  // background agent shows, sourced here from the foreground toolUseResult.
  const agentUsage =
    m.tool === 'Agent' && m.agentUsage ? `<span class="msg-agent-usage">${escapeHtml(m.agentUsage)}</span>` : '';
  const agentLogBtn = resolveAgentLogBtn(m);
  const recipientColor = m.tool === 'SendMessage' && m.params?.to ? resolveNamedColor(teamColorMap[m.params.to]) : null;
  const borderStyle = recipientColor ? `border-left:3px solid ${recipientColor.color};` : '';
  const compactClass = compact ? ' msg-tool-grouped' : '';
  const combinedStyle = `style="${borderStyle}cursor:pointer"`;
  const itemClickAttr =
    m.tool === 'Agent' && m.agentId
      ? `onclick="showAgentModal('${escapeHtml(m.agentId)}')" ${combinedStyle}`
      : `onclick="msgDetailFollowLatest=false;showMsgDetail(${i})" ${combinedStyle}`;
  const pinBtn = renderMsgPinBtn(m, i);
  return `<div class="msg-item msg-tool${compactClass}" data-msg-idx="${i}" ${itemClickAttr}>
      ${getToolIcon(m.tool)}
      <div class="msg-body"><div class="msg-text">${escapeHtml(m.tool)}${toolDetail}${agentLink}${agentUsage}</div><div class="msg-time">${formatDate(m.timestamp)}</div></div>${agentLogBtn}${pinBtn}
    </div>`;
}

function renderMessageList(messages) {
  const parts = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];

    if (m.type === 'tool_use') {
      const key = toolGroupKey(m);
      let runEnd = i + 1;
      while (runEnd < messages.length && toolGroupKey(messages[runEnd]) === key) runEnd++;
      const count = runEnd - i;

      if (count >= 2) {
        const first = messages[i];
        const last = messages[runEnd - 1];
        const toolDetail = getToolDetail(first.tool, first.params, first.detail);
        const gid = `tool-group-${i}`;
        const timeRange = `${formatDate(first.timestamp)} – ${formatDate(last.timestamp)}`;
        const grpAgentLogBtn = resolveAgentLogBtn(first);
        const grpPinBtn = renderMsgPinBtn(first, i);
        parts.push(`<div class="msg-tool-group">
            <div class="msg-item msg-tool msg-tool-group-header" onclick="toggleToolGroup('${gid}')" style="cursor:pointer">
              ${getToolIcon(first.tool)}
              <div class="msg-body"><div class="msg-text">${escapeHtml(first.tool)}${toolDetail}<span class="tool-count-badge">×${count}</span></div><div class="msg-time">${timeRange}</div></div>${grpAgentLogBtn}${grpPinBtn}
            </div>
            <div class="msg-tool-group-items" id="${gid}">${Array.from({ length: count }, (_, j) => renderToolItem(messages[i + j], i + j, true)).join('')}</div>
          </div>`);
        i = runEnd;
        continue;
      }

      parts.push(renderToolItem(m, i, false));
      i++;
      continue;
    }

    // Background task-notifications: the harness writes each one twice (an enqueue
    // record + the delivered type:'user' record, same taskId). Collapse a run of
    // same-taskId notifications into one ×N group (like tool groups), prefixed with
    // the agent type joined from the loaded agents list.
    if (m.taskNotification) {
      let runEnd = i + 1;
      while (runEnd < messages.length && messages[runEnd].taskNotification && messages[runEnd].taskId === m.taskId)
        runEnd++;
      const count = runEnd - i;
      const agentType = m.taskId ? currentAgents.find((a) => a.agentId === m.taskId)?.type : null;
      const typePrefix = agentType ? `${escapeHtml(agentType)} · ` : '';
      const labelHtml = `${typePrefix}<code>${escapeHtml(m.systemLabel || 'Background task')}</code>`;
      // Shared header row for both the single notification and the ×N group header.
      const headerRow = (extraClass, onclick, badge, queuedTag) =>
        `<div class="msg-item msg-system${extraClass}" ${onclick} style="cursor:pointer">
            ${ICON_AGENT}
            <div class="msg-body"><div class="msg-text">${labelHtml}${badge}</div><div class="msg-time">${formatDate(m.timestamp)}${queuedTag}</div></div>${renderMsgPinBtn(m, i)}
          </div>`;

      if (count >= 2) {
        const gid = `task-group-${i}`;
        const items = Array.from({ length: count }, (_, j) => {
          const r = messages[i + j];
          const idx = i + j;
          return `<div class="msg-item msg-system msg-tool-grouped" data-msg-idx="${idx}" onclick="msgDetailFollowLatest=false;showMsgDetail(${idx})" style="cursor:pointer">
              ${ICON_AGENT}
              <div class="msg-body"><div class="msg-text">${r.queued ? 'queued' : 'delivered'}</div><div class="msg-time">${formatDate(r.timestamp)}</div></div>
            </div>`;
        }).join('');
        parts.push(`<div class="msg-tool-group">
            ${headerRow(' msg-tool-group-header', `onclick="toggleToolGroup('${gid}')"`, `<span class="tool-count-badge">×${count}</span>`, '')}
            <div class="msg-tool-group-items" id="${gid}">${items}</div>
          </div>`);
        i = runEnd;
        continue;
      }

      // Not collapsed (the enqueue/delivered pair wasn't consecutive): tag the queued
      // record with the same golden marker used for other queued messages.
      const queuedTag = m.queued ? '<span class="msg-queued-tag">queued</span>' : '';
      parts.push(
        headerRow('', `data-msg-idx="${i}" onclick="msgDetailFollowLatest=false;showMsgDetail(${i})"`, '', queuedTag),
      );
      i++;
      continue;
    }

    const clickable = `data-msg-idx="${i}" onclick="msgDetailFollowLatest=false;showMsgDetail(${i})" style="cursor:pointer"`;
    const pinBtn = renderMsgPinBtn(m, i);
    if (m.type === 'user') {
      if (m.systemLabel) {
        parts.push(`<div class="msg-item msg-system" ${clickable}>
            ${MSG_ICON_SYSTEM}
            <div class="msg-body"><div class="msg-text"><code>${escapeHtml(m.systemLabel)}</code></div><div class="msg-time">${formatDate(m.timestamp)}</div></div>${pinBtn}
          </div>`);
      } else {
        const cmd = parseCommandMessage(m.text);
        const cmdArgs = cmd ? parseCommandArgs(m.fullText || m.text) : '';
        const displayText = cmd ? cmd : escapeHtml(cleanMessageText(m.text));
        const isCmd = !!cmd;
        const cmdArgsHtml =
          cmd && cmdArgs ? ` <span style="color:var(--text-secondary)">${escapeHtml(cmdArgs)}</span>` : '';
        const chips = [];
        const imgCount = m.images?.length || 0;
        const trCount = m.toolResultRefs?.length || 0;
        if (imgCount) chips.push(`<span class="user-attach-chip">${imgCount} image${imgCount > 1 ? 's' : ''}</span>`);
        if (trCount)
          chips.push(`<span class="user-attach-chip">${trCount} tool result${trCount > 1 ? 's' : ''}</span>`);
        const chipsHtml = chips.length ? `<div class="user-attach-chips">${chips.join('')}</div>` : '';
        let textHtml;
        if (displayText) textHtml = isCmd ? `<code>${escapeHtml(displayText)}</code>` : displayText;
        else if (chips.length) textHtml = '<em class="msg-text-muted">(attachment)</em>';
        else textHtml = '';
        const queuedTag = m.queued ? '<span class="msg-queued-tag">queued</span>' : '';
        parts.push(`<div class="msg-item msg-user${isCmd ? ' msg-cmd' : ''}${m.queued ? ' msg-queued' : ''}" ${clickable}>
            ${MSG_ICON_USER}
            <div class="msg-body"><div class="msg-text">${textHtml}${cmdArgsHtml}</div>${chipsHtml}<div class="msg-time">${formatDate(m.timestamp)}${queuedTag}</div></div>${pinBtn}
          </div>`);
      }
    } else if (m.type === 'assistant') {
      const preview = buildAssistantPreview(m.fullText || m.text);
      const moreChip = preview.remainder ? `<div class="msg-md-more">${escapeHtml(preview.remainder)}</div>` : '';
      const bodyHtml = preview.md
        ? `<div class="msg-text msg-text-md">
            <div class="msg-md-content rendered-md${preview.remainder ? ' is-truncated' : ''}">${renderMarkdown(preview.md)}</div>${moreChip}
          </div>`
        : `<div class="msg-text">${escapeHtml(cleanMessageText(m.text))}</div>`;
      parts.push(`<div class="msg-item msg-assistant" ${clickable}>
          ${MSG_ICON_ASSISTANT}
          <div class="msg-body">${bodyHtml}<div class="msg-time">${m.model ? `${escapeHtml(m.model)} · ` : ''}${formatDate(m.timestamp)}</div></div>${pinBtn}
        </div>`);
    } else if (m.type === 'teammate') {
      if (m.teammateId && m.color && !teamColorMap[m.teammateId]) teamColorMap[m.teammateId] = m.color;
      const tmColor = m.color ? resolveNamedColor(m.color)?.color || m.color : '';
      const nameSpan = `<span class="teammate-name" style="${tmColor ? `color:${escapeHtml(tmColor)}` : ''}">${escapeHtml(m.teammateId || 'teammate')}</span>`;
      let tmLookupName = m.teammateId;
      if (m.teammateId === 'system' && m.protocolType === 'teammate_terminated' && m.protocolData?.message) {
        const shutMatch = m.protocolData.message.match(/^(.+?) has shut down/);
        if (shutMatch) tmLookupName = shutMatch[1];
      }
      const tmAgent = tmLookupName ? currentAgents.find((a) => (a.type || a.name) === tmLookupName) : null;
      const tmLogBtn = tmAgent ? agentLogButton(tmAgent.agentId) : '';
      if (m.isIdle) {
        parts.push(`<div class="msg-item msg-teammate msg-idle" ${clickable}>
            ${MSG_ICON_IDLE}
            <div class="msg-body"><div class="msg-text">${nameSpan} <span class="idle-label">${escapeHtml(m.protocolLabel || 'idle')}</span></div><div class="msg-time">${formatDate(m.timestamp)}</div></div>${tmLogBtn}
          </div>`);
      } else if (m.isProtocol) {
        parts.push(`<div class="msg-item msg-teammate msg-protocol" ${clickable}>
            ${MSG_ICON_TEAMMATE}
            <div class="msg-body"><div class="msg-text">${nameSpan} <span class="protocol-label">${escapeHtml(m.protocolLabel || m.protocolType)}</span></div><div class="msg-time">${formatDate(m.timestamp)}</div></div>${tmLogBtn}
          </div>`);
      } else {
        const summaryText = m.summary ? escapeHtml(m.summary) : escapeHtml((m.text || '').slice(0, 80));
        parts.push(`<div class="msg-item msg-teammate" ${clickable}>
            ${MSG_ICON_TEAMMATE}
            <div class="msg-body"><div class="msg-text">${nameSpan} ${summaryText}</div><div class="msg-time">${formatDate(m.timestamp)}</div></div>${tmLogBtn}${pinBtn}
          </div>`);
      }
    }
    i++;
  }
  return parts.join('');
}

// biome-ignore lint/correctness/noUnusedVariables: used in HTML onclick
function toggleToolGroup(id) {
  const el = document.getElementById(id);
  if (el) el.classList.toggle('show');
}

// Legacy markers (written before the gate minted kind:"plan") carry no kind
// for plans — the tool name is the durable signal there.
function getWaitingPill(kind, tool) {
  if (kind === 'plan' || tool === 'ExitPlanMode') return 'Plan awaiting approval';
  if (kind === 'question') return 'Question pending';
  return 'Awaiting permission';
}

function getWaitingLabel(kind, tool) {
  const pill = getWaitingPill(kind, tool);
  return pill === 'Awaiting permission' ? `${pill}: ${tool}` : pill;
}

function deriveWaitingDetail(tool, params) {
  if (!params) return '';
  const trunc = (s) => (s.length > 80 ? `${s.slice(0, 80)}...` : s);
  if (params.file_path) return params.file_path.replace(/^.*[/\\]/, '');
  if (params.command) return trunc(params.command);
  if (params.pattern) return trunc(params.pattern);
  if (params.query) return trunc(params.query);
  if (params.url) return trunc(params.url);
  if (params.skill) {
    const s = params.skill + (typeof params.args === 'string' ? ` ${params.args}` : '');
    return trunc(s);
  }
  if (tool === 'AskUserQuestion' && params.questions?.[0]?.question) return trunc(params.questions[0].question);
  if (tool === 'ExitPlanMode' && typeof params.plan === 'string') {
    const t = params.plan.match(/^#\s+(.+)/m);
    return trunc(t ? t[1] : params.plan);
  }
  if (params.description) return trunc(String(params.description));
  return '';
}

function renderWaitingBody(tool, params) {
  if (!params) return '';
  if (tool === 'AskUserQuestion' && Array.isArray(params.questions)) {
    const items = params.questions
      .map((q) => {
        const head = `<div style="font-weight:600">${escapeHtml(q.question || '')}</div>`;
        const opts = Array.isArray(q.options)
          ? `<ul style="margin:2px 0 0 16px;padding:0">${q.options
              .map(
                (o) =>
                  `<li><span style="font-weight:600">${escapeHtml(o.label || '')}</span>${o.description ? ` — <span style="color:var(--text-muted)">${escapeHtml(o.description)}</span>` : ''}</li>`,
              )
              .join('')}</ul>`
          : '';
        return `<div style="margin-top:6px">${head}${opts}</div>`;
      })
      .join('');
    return items;
  }
  return renderToolParamsHtml(params);
}

const PLAN_REJECT_MSG = 'Plan rejected from the kanban board.';

// Answerable only when the marker carries a request id (written by
// approval-gate.sh, which is polling for a decision) and the gate hasn't
// lapsed past its wait window — older or lapsed markers are only answerable
// in the terminal.
function isWaitingAnswerable() {
  return !!(currentWaiting?.id && !currentWaiting.lapsed);
}

function parseWaitingInput() {
  try {
    return JSON.parse(currentWaiting?.toolInput || '');
  } catch (_) {
    return null; /* toolInput may be truncated/non-JSON */
  }
}

// One source for the decision-button pair on every surface — Approve/Reject
// for plans, Allow/Deny for permissions; only the css class prefix differs.
// Questions return '' (answered via the form in the detail modal).
function waitingDecisionButtons(cls) {
  if (!isWaitingAnswerable() || currentWaiting.kind === 'question') return '';
  const plan = currentWaiting.kind === 'plan';
  // Code-authored call argument, not data — hence the constant-style name the
  // escaping check reads as safe.
  const DENY_ARG = plan ? "{behavior:'deny',message:PLAN_REJECT_MSG}" : "{behavior:'deny'}";
  return `<button class="${escapeHtml(cls)}-allow" onclick="event.stopPropagation();respondWaiting({behavior:'allow'})">${plan ? 'Approve' : 'Allow'}</button><button class="${escapeHtml(cls)}-deny" onclick="event.stopPropagation();respondWaiting(${DENY_ARG})">${plan ? 'Reject' : 'Deny'}</button>`;
}

function renderWaitingEntry() {
  if (!isWaitingFresh()) return '';
  const tool = currentWaiting.toolName || 'unknown';
  const params = parseWaitingInput();
  const pillText = getWaitingPill(currentWaiting.kind, tool);
  const detail = deriveWaitingDetail(tool, params);
  const detailHtml = detail ? ` <span style="color:var(--text-secondary)">${escapeHtml(detail)}</span>` : '';
  const bodyHtml = renderWaitingBody(tool, params);
  const bodyWrap = bodyHtml ? `<div class="msg-waiting-body">${bodyHtml}</div>` : '';
  const pill = `<span class="msg-waiting-pill">${escapeHtml(pillText)}</span>`;
  const discardBtn = `<button class="msg-waiting-discard" title="Discard permission prompt" onclick="event.stopPropagation();discardWaiting()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>`;
  // Questions are answered in the detail modal; plans render there too.
  const buttons = waitingDecisionButtons('msg-waiting');
  const actions = buttons ? `<span class="msg-waiting-actions">${buttons}</span>` : '';
  // Lapsed = gate stopped polling — the ask is only answerable in the terminal
  const lapsed = !!currentWaiting.lapsed;
  return `<div class="msg-item msg-waiting" onclick="msgDetailFollowLatest=false;showWaitingDetail()">${getToolIcon(tool)}<div class="msg-body"><div class="msg-text">${pill} <span style="font-weight:600">${escapeHtml(tool)}</span>${detailHtml}</div>${bodyWrap}<div class="msg-waiting-footer"><div class="msg-time">${lapsed ? 'answer in the terminal' : 'waiting…'}</div>${actions}</div></div>${discardBtn}</div>`;
}

// Shared approval controls for a fresh plan ask — the waiting-detail footer and
// the saved-plan modal offer the same decision, so they render the same row.
// Distinct input ids keep the two surfaces from shadowing each other's feedback.
function planApprovalControlsHtml(inputId) {
  return `<input id="${escapeHtml(inputId)}" class="waiting-option-input" type="text" placeholder="feedback for reject (optional)…"><button class="waiting-btn-allow" onclick="respondWaiting({behavior:'allow'})">Approve</button><button class="waiting-btn-deny" onclick="rejectWaitingPlan('${escAttrJs(inputId)}')">Reject</button>`;
}

// biome-ignore lint/correctness/noUnusedVariables: used in HTML onclick
function rejectWaitingPlan(inputId) {
  const feedback = document.getElementById(inputId)?.value?.trim();
  respondWaiting({ behavior: 'deny', message: feedback || PLAN_REJECT_MSG });
}

// UI-driven approvals: POST the decision the blocking approval-gate.sh hook is
// polling for. First writer wins (D5) — a 409/410 means the ask was answered in
// the terminal or superseded, so just drop the card.
async function respondWaiting(payload) {
  if (!currentSessionId || !currentWaiting?.id) return;
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(currentSessionId)}/waiting/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: currentWaiting.id, ...payload }),
    });
    if (res.ok || res.status === 409 || res.status === 410) {
      clearWaitingUi();
    } else {
      // Surface a respond failure — a silent console error reads as a dead button
      const text = await res.text();
      console.error('[respondWaiting]', res.status, text);
      let msg = text;
      try {
        msg = JSON.parse(text).error || text;
      } catch (_) {
        /* plain text */
      }
      showToast(msg, 'error');
    }
  } catch (e) {
    console.error('[respondWaiting]', e);
    showToast(String(e), 'error');
  }
}

// Drop the answered/discarded ask from every surface it renders on
function clearWaitingUi() {
  currentWaiting = null;
  waitingAnswerDraft = {};
  waitingCustomDraft = {};
  if (currentMsgDetailIdx === MSG_DETAIL_WAITING_IDX) {
    // In follow mode stay in the modal and swap to the latest message —
    // closing it would silently drop the user out of following.
    if (msgDetailFollowLatest && currentMessages.length) showMsgDetail(currentMessages.length - 1);
    else closeMsgDetailModal();
  }
  // The saved-plan modal stays open after a decision — only its approval row goes
  document.getElementById('plan-approval-footer')?.remove();
  renderMessages(currentMessages);
  renderAgentFooter();
}

// biome-ignore lint/correctness/noUnusedVariables: used in HTML onclick
async function discardWaiting() {
  if (!currentSessionId) return;
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(currentSessionId)}/waiting/discard`, {
      method: 'POST',
    });
    if (res.ok) clearWaitingUi();
  } catch (e) {
    console.error('[discardWaiting]', e);
  }
}

function renderMessages(messages) {
  const container = document.getElementById('message-panel-content');
  const pinnedContainer = document.getElementById('message-panel-pinned');
  pinnedContainer.innerHTML = agentLogMode ? '' : renderPinnedSection();
  if (!messages.length) {
    container.innerHTML = '<div class="msg-empty">No messages found for this session</div>';
    return;
  }
  const msgsHtml = renderMessageList(messages);
  const limitBanner =
    currentMessages.length >= MSG_MAX_LOADED
      ? `<div class="msg-limit-banner">Showing last ${MSG_MAX_LOADED} messages</div>`
      : '';
  container.innerHTML = limitBanner + msgsHtml + renderWaitingEntry();
  highlightSelectedMsg();
  if (!msgUserScrolledUp) container.scrollTop = container.scrollHeight;
  // Auto-load more if content doesn't overflow yet
  if (
    msgHasMore &&
    !msgLoadingMore &&
    currentMessages.length < MSG_MAX_LOADED &&
    container.scrollHeight <= container.clientHeight
  ) {
    loadOlderMessages();
  }
}

let currentMsgDetailIdx = null;
let msgDetailFollowLatest = false;
// Message stays tracked but its highlight is dimmed once the detail modal closes.
let msgHighlightDimmed = false;
const MSG_DETAIL_WAITING_IDX = -2;
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
const MSG_ICON_TEAMMATE =
  '<svg class="msg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';
const MSG_ICON_IDLE =
  '<svg class="msg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6"/></svg>';
const ICON_AGENT =
  '<svg class="msg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v2M15 2v2M9 20v2M15 20v2M20 9h2M20 14h2M2 9h2M2 14h2"/></svg>';
const ICON_TASK =
  '<svg class="msg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>';
const ICON_WEB =
  '<svg class="msg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>';
const ICON_OPEN_EXTERNAL =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3h7v7"/><path d="M10 14L21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/></svg>';
const ICON_COPY =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const ICON_CHECKMARK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M20 6L9 17l-5-5"/></svg>';
const ICON_PLAN =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>';
const ICON_AGENT_WAITING =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
const ICON_AGENT_ACTIVE =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" y1="16" x2="8" y2="16"/><line x1="16" y1="16" x2="16" y2="16"/></svg>';
const ICON_CHAT =
  '<svg class="msg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
const TOOL_ICONS = {
  Bash: '<svg class="msg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="18" rx="2"/><polyline points="7 10 10 13 7 16"/><line x1="13" y1="16" x2="17" y2="16"/></svg>',
  Read: '<svg class="msg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
  Write:
    '<svg class="msg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>',
  Edit: '<svg class="msg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
  Glob: '<svg class="msg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><circle cx="14" cy="14" r="3"/><line x1="16.5" y1="16.5" x2="19" y2="19"/></svg>',
  Grep: '<svg class="msg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
  Agent: ICON_AGENT,
  SendMessage:
    '<svg class="msg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
  TaskCreate: ICON_TASK,
  TaskUpdate: ICON_TASK,
  TaskGet: ICON_TASK,
  TaskList: ICON_TASK,
  ToolSearch:
    '<svg class="msg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg>',
  AskUserQuestion: ICON_CHAT,
  ExitPlanMode: ICON_CHAT,
  Skill:
    '<svg class="msg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
  WebFetch: ICON_WEB,
  WebSearch: ICON_WEB,
  NotebookEdit:
    '<svg class="msg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>',
  LSP: '<svg class="msg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
};
function getToolIcon(toolName) {
  return TOOL_ICONS[toolName] || MSG_ICON_TOOL;
}
const AGENT_LOG_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
function agentLogButton(agentId, cls = 'msg-agent-log-btn') {
  return `<button class="${escapeHtml(cls)}" onclick="event.stopPropagation();viewAgentLog('${escAttrJs(agentId)}')" title="View agent log">${AGENT_LOG_ICON}</button>`;
}

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
  renderSessions();
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
    // Strip large server-truncated `*Full` payloads (Write contentFull,
    // MCP passthrough <k>Full) before stashing in localStorage — a few
    // pinned big writes can blow past the per-origin quota. On pin
    // expand, the modal falls back to the truncated string + the lazy
    // /api/sessions/:id/tool-result/:toolUseId endpoint.
    let paramsForPin = null;
    if (m.params) {
      paramsForPin = {};
      for (const [k, v] of Object.entries(m.params)) {
        if (k === 'contentFull') continue;
        if (k.endsWith('Full') && typeof v === 'string' && typeof m.params[k.slice(0, -4)] === 'string') continue;
        paramsForPin[k] = v;
      }
    }
    currentPins.push({
      id,
      type: m.type,
      text: m.text || null,
      fullText: m.fullText || null,
      tool: m.tool || null,
      toolUseId: m.toolUseId || null,
      toolResult: m.toolResult || null,
      toolResultTruncated: m.toolResultTruncated || false,
      toolResultFull: null,
      answerPayload: m.answerPayload || null,
      params: paramsForPin,
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
  renderSessions();
  updateMsgDetailPinState();
}

function unpinById(pinIdx) {
  if (!currentSessionId || pinIdx < 0 || pinIdx >= currentPins.length) return;
  const wasAgent = currentPins[pinIdx].type === 'agent';
  currentPins.splice(pinIdx, 1);
  savePins(currentSessionId, currentPins);
  renderMessages(currentMessages);
  renderSessions();
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
  _renderPinToDetail(pin);
  const body = document.getElementById('msg-detail-body');
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
let stickySessionIds = new Set();
// Pinning the currently-selected session keeps it in place until deselected (less UI movement).
const deferredPinPlacement = new Set();

function loadPinnedSessions() {
  try {
    return new Set(JSON.parse(localStorage.getItem('pinned-sessions')) || []);
  } catch {
    return new Set();
  }
}

function loadStickySessions() {
  try {
    return new Set(JSON.parse(localStorage.getItem('sticky-sessions')) || []);
  } catch {
    return new Set();
  }
}

function savePinnedSessions() {
  localStorage.setItem('pinned-sessions', JSON.stringify([...pinnedSessionIds]));
  localStorage.setItem('sticky-sessions', JSON.stringify([...stickySessionIds]));
}

// Mirror pin state to server so it can be queried by the CLI. UI remains source of truth for itself.
function offloadSessionPin(sessionId) {
  const state = getSessionPinState(sessionId);
  fetch('/api/session/pin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: sessionId, state }),
  }).catch(() => {});
}

function toggleSessionPin(sessionId) {
  if (pinnedSessionIds.has(sessionId)) {
    pinnedSessionIds.delete(sessionId);
    stickySessionIds.delete(sessionId);
    deferredPinPlacement.delete(sessionId);
  } else {
    pinnedSessionIds.add(sessionId);
    if (sessionId === currentSessionId) deferredPinPlacement.add(sessionId);
  }
  savePinnedSessions();
  offloadSessionPin(sessionId);
  renderSessions();
}

function toggleSessionSticky(sessionId) {
  if (stickySessionIds.has(sessionId)) {
    stickySessionIds.delete(sessionId);
    pinnedSessionIds.delete(sessionId);
    deferredPinPlacement.delete(sessionId);
  } else {
    pinnedSessionIds.add(sessionId);
    stickySessionIds.add(sessionId);
    if (sessionId === currentSessionId) deferredPinPlacement.add(sessionId);
  }
  savePinnedSessions();
  offloadSessionPin(sessionId);
  renderSessions();
}

function isPlacedPinned(id) {
  return pinnedSessionIds.has(id) && !deferredPinPlacement.has(id);
}
function isPlacedSticky(id) {
  return stickySessionIds.has(id) && !deferredPinPlacement.has(id);
}

function handleSessionPinEvent({ id, state }) {
  if (!id) return;
  pinnedSessionIds.delete(id);
  stickySessionIds.delete(id);
  deferredPinPlacement.delete(id);
  if (state === 'pinned') pinnedSessionIds.add(id);
  if (state === 'sticky') {
    pinnedSessionIds.add(id);
    stickySessionIds.add(id);
  }
  savePinnedSessions();
  renderSessions();
}

function getSessionPinState(sessionId) {
  if (stickySessionIds.has(sessionId)) return 'sticky';
  if (pinnedSessionIds.has(sessionId)) return 'pinned';
  return 'none';
}

function isAnyPinned(sessionId) {
  return pinnedSessionIds.has(sessionId) || stickySessionIds.has(sessionId);
}

function _renderPinToDetail(pin) {
  const body = document.getElementById('msg-detail-body');
  const agentBtn = document.getElementById('msg-detail-agent-btn');
  agentBtn.style.display = 'none';
  if (pin.type === 'tool_use') {
    document.getElementById('msg-detail-title').textContent = pin.tool || 'Tool';
    const fullText = pin.fullDetail || pin.detail || '';
    const pinFindings = pin.tool === 'ReportFindings';
    const pinParamsHtml = pinFindings
      ? renderFindingsReport(pin.params, pin.toolResult)
      : renderToolParamsHtml(pin.params);
    const pinResultHtml = pinFindings
      ? ''
      : renderToolResultHtml(pin.toolResult, pin.toolResultTruncated, pin.toolResultFull, pin.toolUseId);
    const pinDetailEscaped = escapeHtml(stripAnsi(fullText));
    const pinDetailRendered = pin.tool === 'Bash' ? highlightBash(pinDetailEscaped) : pinDetailEscaped;
    // Tool-result images are intentionally omitted here: their URL is built from
    // the global currentSessionId, but a pin can belong to a different session,
    // so rendering them would point at the wrong session's image.
    body.innerHTML =
      (fullText
        ? `<pre class="${TINTED_PRE_CLASS}">${pinDetailRendered}</pre>`
        : pinFindings
          ? ''
          : '<em>No details</em>') +
      pinParamsHtml +
      pinResultHtml;
  } else if (pin.type === 'agent') {
    document.getElementById('msg-detail-title').textContent = pin.agentType || 'Agent';
    const lastMsg = stripAnsi(pin.lastMessage || '');
    body.innerHTML = lastMsg ? renderMarkdown(lastMsg) : '<em>No agent message</em>';
  } else {
    const text = stripAnsi(pin.fullText || pin.text || '');
    document.getElementById('msg-detail-title').textContent = pin.type === 'assistant' ? 'Claude' : 'User';
    body.innerHTML = renderMarkdown(text);
  }
  document.getElementById('msg-detail-meta').textContent = formatDate(pin.timestamp);
}

const SESSION_PIN_SVG = PIN_SVG.replace('width="14" height="14"', 'width="12" height="12"');
const SESSION_STAR_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><path d="M12 2 L15 9 L22 9 L17 14 L19 22 L12 18 L5 22 L7 14 L2 9 L9 9 Z"/></svg>';
const LINK_SVG_PATHS =
  '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>';
const linkSvg = (size) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${LINK_SVG_PATHS}</svg>`;

//#endregion

//#region MODALS
// Shared markup for an attachment image and the labeled section that holds a grid
// of them — used by both user-pasted images and agent tool-result images.
function attachImageTag(url, alt) {
  return `<img src="${escapeHtml(url)}" loading="lazy" alt="${escapeHtml(alt)}" class="user-attach-image" />`;
}
function attachImageSection(label, imgsHtml) {
  return imgsHtml
    ? `<div class="user-attach-section"><div class="user-attach-label">${label}</div><div class="user-attach-images">${imgsHtml}</div></div>`
    : '';
}

function renderUserAttachments(m) {
  const parts = [];
  if (m.images?.length && currentSessionId) {
    const sid = encodeURIComponent(currentSessionId);
    const imgs = m.images
      .map((img) => {
        // Cache-kind images live on disk (image-cache/<sessionId>/<n>.png); base64
        // images are read from the JSONL block and need the message uuid.
        if (img.kind === 'cache') return attachImageTag(`/api/sessions/${sid}/cached-image/${img.n}`, 'user image');
        if (m.uuid)
          return attachImageTag(
            `/api/sessions/${sid}/user-image/${encodeURIComponent(m.uuid)}/${img.blockIndex}`,
            'user image',
          );
        return '';
      })
      .join('');
    const section = attachImageSection('Attached images', imgs);
    if (section) parts.push(section);
  }
  if (m.toolResultRefs?.length) {
    const refs = m.toolResultRefs
      .map((ref) => {
        const safeId = escapeHtml(ref.toolUseId);
        const shortId = ref.toolUseId.length > 14 ? `${ref.toolUseId.slice(0, 14)}…` : ref.toolUseId;
        const preview = ref.preview ? sanitizeOutputHtml(ref.preview) : '<em>(no text)</em>';
        const expandId = `user-tr-${ref.toolUseId}`;
        return `<details class="user-attach-toolresult">
          <summary>Tool result <code>${escapeHtml(shortId)}</code></summary>
          <pre class="${TINTED_PRE_CLASS}" id="${expandId}">${preview}</pre>
          <button type="button" class="tool-result-expand-btn" data-expand-id="${expandId}" data-tool-use-id="${escapeHtml(safeId)}" onclick="_toggleToolResultExpand(this)">Show full</button>
        </details>`;
      })
      .join('');
    parts.push(
      `<div class="user-attach-section"><div class="user-attach-label">Tool results in this message</div>${refs}</div>`,
    );
  }
  return parts.join('');
}

// Highlight the message whose detail is open, mirroring task-card selection.
function highlightSelectedMsg() {
  const container = document.getElementById('message-panel-content');
  if (!container) return;
  for (const el of container.querySelectorAll('.msg-item.selected')) el.classList.remove('selected');
  if (msgHighlightDimmed || currentMsgDetailIdx == null || currentMsgDetailIdx < 0) return;
  const el = container.querySelector(`.msg-item[data-msg-idx="${currentMsgDetailIdx}"]`);
  if (el) el.classList.add('selected');
}

function showMsgDetail(idx) {
  currentMsgDetailIdx = idx;
  document.getElementById('msg-detail-waiting-footer').innerHTML = '';
  msgHighlightDimmed = false;
  const m = currentMessages[idx];
  if (!m) return;
  highlightSelectedMsg();
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
    const sendProto = m.tool === 'SendMessage' && m.params?.protocol;
    const isFindings = m.tool === 'ReportFindings';
    const toolParamsHtml = isFindings
      ? ''
      : renderToolParamsHtml(
          sendProto ? Object.fromEntries(Object.entries(m.params).filter(([k]) => k !== 'protocol')) : m.params,
        );
    const hideResult = m.tool === 'SendMessage' || TASK_TOOLS.has(m.tool) || isFindings;
    const taskResultHtml = TASK_TOOLS.has(m.tool) ? renderTaskResult(m.toolResult) : '';
    const findingsHtml = isFindings ? renderFindingsReport(m.params, m.toolResult) : '';
    const toolResultHtml = hideResult
      ? ''
      : renderToolResultHtml(m.toolResult, m.toolResultTruncated, m.toolResultFull, m.toolUseId);
    const hasAgentTabs = m.tool === 'Agent' && m.agentId && (m.agentLastMessage || m.agentPrompt);
    let mainHtml;
    if (sendProto) {
      mainHtml = descHtml + renderProtocolDetail(m.params.protocol);
    } else if (m.tool === 'SendMessage' && fullText) {
      mainHtml = `${descHtml}<div class="markdown-body">${renderMarkdown(fullText)}</div>`;
    } else if (hasAgentTabs) {
      mainHtml = descHtml || '';
    } else if (taskResultHtml || findingsHtml) {
      mainHtml = descHtml || '';
    } else if (fullText) {
      const detailEscaped = escapeHtml(stripAnsi(fullText));
      const detailRendered = m.tool === 'Bash' ? highlightBash(detailEscaped) : detailEscaped;
      mainHtml = `${descHtml}<pre class="${TINTED_PRE_CLASS}">${detailRendered}</pre>`;
    } else {
      mainHtml = TASK_TOOLS.has(m.tool) ? '' : '<em>No details</em>';
    }
    const answersHtml = m.answerPayload ? renderAnswerPayloadHtml(m.answerPayload) : '';
    const toolResultImagesHtml = renderToolResultImagesHtml(m.toolResultImageCount, m.toolUseId);
    body.innerHTML =
      mainHtml +
      toolParamsHtml +
      answersHtml +
      taskResultHtml +
      findingsHtml +
      (hasAgentTabs ? '' : toolResultHtml) +
      toolResultImagesHtml +
      agentExtraHtml;
  } else if (m.type === 'teammate') {
    document.getElementById('msg-detail-title').textContent = m.teammateId || 'Teammate';
    document.getElementById('msg-detail-agent-btn').style.display = 'none';
    if (m.isProtocol) {
      body.innerHTML = m.protocolData
        ? renderProtocolDetail(m.protocolData)
        : `<div class="teammate-idle-detail"><span class="protocol-label">${escapeHtml(m.protocolLabel || m.protocolType)}</span></div>`;
    } else {
      const text = stripAnsi(m.fullText || m.text || '');
      body.innerHTML = renderMarkdown(text);
    }
  } else {
    const rawText = stripAnsi(m.fullText || m.text || '');
    const cmd = m.type === 'user' ? parseCommandMessage(rawText) : null;
    document.getElementById('msg-detail-title').textContent =
      m.type === 'assistant' ? 'Claude' : m.systemLabel ? 'System' : 'User';
    document.getElementById('msg-detail-agent-btn').style.display = 'none';
    const userExtras = m.type === 'user' ? renderUserAttachments(m) : '';
    if (m.compactSummary) {
      body.innerHTML = renderMarkdown(m.compactSummary) + userExtras;
    } else if (cmd) {
      const args = parseCommandArgs(rawText) || null;
      const cleanBody = rawText
        .replace(/<command-[^>]+>[\s\S]*?<\/command-[^>]+>/g, '')
        .replace(/<local-command-[^>]+>[\s\S]*?<\/local-command-[^>]+>/g, '')
        .trim();
      let cmdHtml = `<code>${escapeHtml(cmd)}${args ? ` ${escapeHtml(args)}` : ''}</code>`;
      if (cleanBody) cmdHtml += `<div style="margin-top:10px">${renderMarkdown(cleanBody)}</div>`;
      body.innerHTML = cmdHtml + userExtras;
    } else if (rawText) {
      body.innerHTML = renderMarkdown(rawText) + userExtras;
    } else {
      body.innerHTML = userExtras || '<em>No content</em>';
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
  hideModalOverlay('msg-detail-modal');
  msgDetailFollowLatest = false;
  // Drop the message highlight on close, mirroring task-card behavior.
  msgHighlightDimmed = true;
  const container = document.getElementById('message-panel-content');
  if (container) {
    for (const el of container.querySelectorAll('.msg-item.selected')) el.classList.remove('selected');
  }
}

function _setModalWidth(modal, slot, on, maxWidth, width) {
  const mwKey = `prev${slot}MaxWidth`;
  const wKey = `prev${slot}Width`;
  if (on) {
    modal.dataset[mwKey] = modal.style.maxWidth || '';
    modal.dataset[wKey] = modal.style.width || '';
    modal.style.maxWidth = maxWidth;
    modal.style.width = width;
  } else {
    modal.style.maxWidth = modal.dataset[mwKey] || '';
    modal.style.width = modal.dataset[wKey] || '';
  }
}

function _modalEl(modalId) {
  return document.querySelector(`#${modalId} .modal`);
}

// The opt-in marker for fullscreen and drag-resize alike: the presence of a
// `<modalId>-fullscreen-btn` button in the markup.
function _forEachFullscreenModal(cb) {
  for (const btn of document.querySelectorAll('[id$="-fullscreen-btn"]')) {
    const modalId = btn.id.replace(/-fullscreen-btn$/, '');
    const modal = _modalEl(modalId);
    if (modal) cb(modalId, modal);
  }
}

function _applyModalFullscreen(modalId, on) {
  const modal = _modalEl(modalId);
  modal.classList.toggle('fullscreen', on);
  _setModalWidth(modal, 'Fs', on, '', '');
  updateFullscreenBtnIcon(`${modalId}-fullscreen-btn`, on);
}

// biome-ignore lint/correctness/noUnusedVariables: used in HTML
function toggleModalFullscreen(modalId) {
  const on = !_modalEl(modalId).classList.contains('fullscreen');
  _applyModalFullscreen(modalId, on);
  localStorage.setItem(`modal-fullscreen-${modalId}`, String(on));
}

function loadModalFullscreen() {
  _forEachFullscreenModal((modalId) => {
    if (localStorage.getItem(`modal-fullscreen-${modalId}`) === 'true') _applyModalFullscreen(modalId, true);
  });
}

// Hides the overlay only — the fullscreen state stays on the dialog, it is a
// remembered preference so the next open comes back the way it was left.
function hideModalOverlay(modalId) {
  const modal = document.getElementById(modalId);
  modal.classList.remove('visible');
  return modal;
}

function updateFullscreenBtnIcon(btnId, isFullscreen) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.innerHTML = isFullscreen
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
}

// Free-form modal resize: drag the bottom-right grip, double-click it to reset.
// The size lives in CSS custom properties + `.user-sized` (see style.css) rather
// than inline width/height, so it never collides with the inline-style stash
// that fullscreen and "Show more" do via _setModalWidth. The viewport cap lives
// only in the CSS min(); JS clamps just the minimums.
const MODAL_MIN_W = 360;
const MODAL_MIN_H = 240;

function _setModalUserSize(modal, w, h) {
  modal.style.setProperty('--user-modal-w', w);
  modal.style.setProperty('--user-modal-h', h);
}

function initModalResize() {
  _forEachFullscreenModal((modalId, modal) => {
    const wKey = `modal-width-${modalId}`;
    const hKey = `modal-height-${modalId}`;
    const savedW = localStorage.getItem(wKey);
    const savedH = localStorage.getItem(hKey);
    if (savedW && savedH) {
      _setModalUserSize(modal, savedW, savedH);
      modal.classList.add('user-sized');
    }

    const handle = document.createElement('div');
    handle.className = 'modal-resize-handle';
    handle.title = 'Drag to resize · double-click to reset';
    modal.appendChild(handle);

    let startW, startH, w, h;
    _initDragResize(handle, {
      onStart() {
        startW = modal.offsetWidth;
        startH = modal.offsetHeight;
        // autoSizeModal / "Show more" may have widened the dialog inline
        // before the first drag; inline width beats the .user-sized CSS.
        modal.style.width = '';
        modal.style.maxWidth = '';
        // Vars and class land together, so `.user-sized` never reads an
        // undefined var.
        _setModalUserSize(modal, `${startW}px`, `${startH}px`);
        modal.classList.add('user-sized');
      },
      // The overlay centers the modal, so both edges move — double the delta
      // to keep the grip under the cursor.
      onMove(dx, dy) {
        w = Math.max(MODAL_MIN_W, startW + dx * 2);
        h = Math.max(MODAL_MIN_H, startH + dy * 2);
        _setModalUserSize(modal, `${w}px`, `${h}px`);
      },
      onEnd() {
        if (w && h) {
          localStorage.setItem(wKey, `${w}px`);
          localStorage.setItem(hKey, `${h}px`);
        }
      },
    });

    handle.addEventListener('dblclick', () => {
      modal.classList.remove('user-sized');
      localStorage.removeItem(wKey);
      localStorage.removeItem(hKey);
    });
  });
}

const MODAL_ZOOM_KEY = 'modal-zoom';
const MODAL_ZOOM_MIN = 0.7;
const MODAL_ZOOM_MAX = 2.0;
let modalZoom = clampModalZoom(Number.parseFloat(localStorage.getItem(MODAL_ZOOM_KEY)) || 1);

function clampModalZoom(v) {
  return Math.min(MODAL_ZOOM_MAX, Math.max(MODAL_ZOOM_MIN, v));
}

function applyModalZoom() {
  document.documentElement.style.setProperty('--modal-zoom', String(modalZoom));
}

// delta 0 resets to 100%
function adjustModalZoom(delta) {
  const next = delta === 0 ? 1 : clampModalZoom(Math.round((modalZoom + delta) * 10) / 10);
  if (next === modalZoom && delta !== 0) return;
  modalZoom = next;
  localStorage.setItem(MODAL_ZOOM_KEY, String(modalZoom));
  applyModalZoom();
  showToast(`Text ${Math.round(modalZoom * 100)}%`);
}

// The markup decides what scales: `.modal-zoomable` marks a modal's reading
// surface, and style.css hangs the zoom on that same class. Confirm dialogs
// carry no such body — nothing there is worth enlarging.
function isZoomableModalOpen() {
  return document.querySelector('.modal-overlay.visible .modal-zoomable') !== null;
}

const ZOOM_KEYS = { '+': 0.1, '=': 0.1, NumpadAdd: 0.1, '-': -0.1, _: -0.1, NumpadSubtract: -0.1, 0: 0, Numpad0: 0 };

let _toastTimer = null;
let _manualRefreshing = false;
//#endregion

//#region TOAST
function showToast(msg, type) {
  const el = document.getElementById('toast');
  clearTimeout(_toastTimer);
  el.style.transition = 'none';
  el.classList.remove('visible', 'toast-success', 'toast-error', 'toast-info');
  void el.offsetHeight;
  el.style.transition = '';
  el.textContent = msg;
  if (type) el.classList.add(`toast-${type}`);
  el.classList.add('visible');
  _toastTimer = setTimeout(() => el.classList.remove('visible'), 2000);
}

async function copyWithFeedback(text, btn) {
  if (btn.dataset.copying) return;
  try {
    await navigator.clipboard.writeText(text);
    btn.dataset.copying = '1';
    const svg = btn.innerHTML;
    btn.innerHTML = ICON_CHECKMARK;
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
const PROTOCOL_SKIP_KEYS = new Set(['type', 'from', 'timestamp', 'paneId', 'backendType']);
function renderProtocolDetail(data) {
  if (!data || typeof data !== 'object') return '';
  const typeBadge = data.type
    ? `<span class="protocol-type-badge">${escapeHtml(data.type.replace(/_/g, ' '))}</span>`
    : '';
  const fields = Object.entries(data)
    .filter(([k]) => !PROTOCOL_SKIP_KEYS.has(k))
    .map(([k, v]) => {
      const label = escapeHtml(
        k
          .replace(/([A-Z])/g, ' $1')
          .replace(/_/g, ' ')
          .trim()
          .toLowerCase(),
      );
      let val;
      if (typeof v === 'boolean') {
        val = `<span class="protocol-bool protocol-bool-${v}">${v ? 'yes' : 'no'}</span>`;
      } else if (v == null) {
        val = `<span style="color:var(--text-muted)">null</span>`;
      } else {
        val = escapeHtml(String(v));
      }
      return `<div class="protocol-field"><span class="protocol-field-key">${label}</span>${val}</div>`;
    });
  return `<div class="protocol-detail">${typeBadge}${fields.length ? `<div class="protocol-fields">${fields.join('')}</div>` : ''}</div>`;
}

const TASK_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList']);
const TASK_STATUS_COLORS = {
  pending: 'var(--text-muted)',
  in_progress: 'var(--info)',
  completed: 'var(--success)',
  deleted: 'var(--danger)',
};
function formatTaskStatusBadge(status) {
  const color = TASK_STATUS_COLORS[status] || 'var(--text-muted)';
  return `<span style="color:${color};font-weight:600;text-transform:uppercase;font-size:0.85em">${escapeHtml(status)}</span>`;
}
function formatTaskToolDetail(params) {
  if (!params) return '';
  const parts = [];
  if (params.taskId) {
    const id = String(params.taskId).replace(/^#/, '');
    parts.push(`<span style="color:var(--text-muted)">#${escapeHtml(id)}</span>`);
  }
  if (params.status) parts.push(formatTaskStatusBadge(params.status));
  if (params.subject) parts.push(`<span style="color:var(--text-secondary)">${escapeHtml(params.subject)}</span>`);
  return parts.length ? ` ${parts.join(' ')}` : '';
}
function getToolDetail(tool, params, detail) {
  if (TASK_TOOLS.has(tool)) return formatTaskToolDetail(params);
  if (tool === 'ReportFindings') return formatFindingsToolDetail(params);
  if (!detail) return '';
  let extra = '';
  if (tool === 'Read' && params) {
    const parts = [];
    if (params.offset) parts.push(`L${params.offset}`);
    if (params.limit) parts.push(`+${params.limit}`);
    if (parts.length) extra = ` <span style="color:var(--text-muted)">${parts.join(' ')}</span>`;
  }
  return ` <span style="color:var(--text-secondary)">${escapeHtml(detail)}</span>${extra}`;
}
function renderTaskResult(toolResult) {
  if (!toolResult) return '';
  const lines = sanitizeOutput(toolResult).trim().split('\n');
  const fields = [];
  for (const line of lines) {
    const m = line.match(/^([A-Za-z #]+):\s*(.+)$/);
    if (m) fields.push([m[1].trim(), m[2].trim()]);
  }
  if (!fields.length) return '';
  const title = fields.find(([k]) => /^Task/.test(k));
  const status = fields.find(([k]) => k === 'Status');
  const rest = fields.filter(([k]) => !/^Task/.test(k) && k !== 'Status');
  let html = '<div class="protocol-detail">';
  if (title) html += `<span class="protocol-type-badge">${escapeHtml(title[1])}</span>`;
  if (status) html += `<span style="display:inline-block;margin-bottom:6px">${formatTaskStatusBadge(status[1])}</span>`;
  if (rest.length) {
    html += '<div class="protocol-fields">';
    for (const [k, v] of rest) {
      html += `<div class="protocol-field"><span class="protocol-field-key">${escapeHtml(k.toLowerCase())}</span>${escapeHtml(v)}</div>`;
    }
    html += '</div>';
  }
  return `${html}</div>`;
}

function renderAnswerPayloadHtml(answerPayload) {
  if (!answerPayload?.answers || typeof answerPayload.answers !== 'object') return '';
  const qs = Array.isArray(answerPayload.questions) ? answerPayload.questions : [];
  const findOptionDesc = (qText, label) => {
    const q = qs.find((x) => x && x.question === qText);
    if (!q || !Array.isArray(q.options)) return null;
    const opt = q.options.find((o) => o && o.label === label);
    return opt?.description ? opt.description : null;
  };
  const rows = Object.entries(answerPayload.answers)
    .map(([q, a]) => {
      const ansList = Array.isArray(a) ? a : [a];
      const items = ansList
        .map((label) => {
          const desc = findOptionDesc(q, label);
          const descHtml = desc ? ` <span style="color:var(--text-muted)">— ${escapeHtml(desc)}</span>` : '';
          return `<li><span style="font-weight:600">${escapeHtml(String(label))}</span>${descHtml}</li>`;
        })
        .join('');
      return `<div style="margin-top:6px">
      <div style="font-size:0.75rem;color:var(--text-muted);margin-bottom:2px">${escapeHtml(q)}</div>
      <ul style="margin:2px 0 0 16px;padding:0">${items}</ul>
    </div>`;
    })
    .join('');
  return `<div style="margin-top:10px;padding-top:8px;border-top:1px solid var(--border)">
    <div style="font-size:0.8rem;color:var(--text-muted);margin-bottom:4px">Answers</div>
    ${rows}
  </div>`;
}

//#region FINDINGS
const FINDING_VERDICT_COLORS = {
  CONFIRMED: 'var(--danger, #ef5350)',
  PLAUSIBLE: 'var(--warning, #f0b429)',
};
const FINDING_OUTCOME_COLORS = {
  fixed: 'var(--success, #3ecf8e)',
  no_change_needed: 'var(--info, #60a5fa)',
  skipped: 'var(--text-muted)',
};
function findingBadge(label, color) {
  return `<span class="finding-badge" style="color:${color}">${escapeHtml(label)}</span>`;
}
function formatFindingsToolDetail(params) {
  const findings = Array.isArray(params?.findings) ? params.findings : [];
  const parts = [
    `<span style="color:var(--text-secondary)">${findings.length} finding${findings.length === 1 ? '' : 's'}</span>`,
  ];
  const confirmed = findings.filter((f) => f && f.verdict === 'CONFIRMED').length;
  const plausible = findings.filter((f) => f && f.verdict === 'PLAUSIBLE').length;
  if (confirmed) parts.push(`<span style="color:${FINDING_VERDICT_COLORS.CONFIRMED}">${confirmed} confirmed</span>`);
  if (plausible) parts.push(`<span style="color:${FINDING_VERDICT_COLORS.PLAUSIBLE}">${plausible} plausible</span>`);
  if (params?.level) parts.push(findingBadge(params.level, 'var(--text-muted)'));
  return ` ${parts.join(' <span style="color:var(--text-muted)">·</span> ')}`;
}
function renderFindingsReport(params, toolResult) {
  const findings = Array.isArray(params?.findings) ? params.findings : [];
  let html = '<div class="protocol-detail findings-report">';
  html += `<span class="protocol-type-badge">${findings.length} finding${findings.length === 1 ? '' : 's'}</span>`;
  if (params?.level) html += ` ${findingBadge(`level: ${params.level}`, 'var(--text-muted)')}`;
  if (!findings.length) {
    html += '<div class="finding-scenario">No findings survived verification.</div>';
  } else {
    html += '<div class="findings-list">';
    findings.forEach((f, i) => {
      if (!f || typeof f !== 'object') return;
      const badges = [];
      if (f.verdict && FINDING_VERDICT_COLORS[f.verdict]) {
        badges.push(findingBadge(f.verdict, FINDING_VERDICT_COLORS[f.verdict]));
      }
      if (f.outcome && FINDING_OUTCOME_COLORS[f.outcome]) {
        badges.push(findingBadge(f.outcome.replace(/_/g, ' '), FINDING_OUTCOME_COLORS[f.outcome]));
      }
      const loc = f.file ? `${f.file}${f.line != null ? `:${f.line}` : ''}` : '';
      html += `<div class="finding-card">
          <span class="finding-rank">${i + 1}</span>
          <div class="finding-main">
            ${badges.length || loc ? `<div class="finding-badges">${badges.join('')}${loc ? `<span class="finding-file">${escapeHtml(loc)}</span>` : ''}</div>` : ''}
            ${f.summary ? `<div class="finding-summary">${escapeHtml(f.summary)}</div>` : ''}
            ${f.failure_scenario ? `<div class="finding-scenario">${escapeHtml(f.failure_scenario)}</div>` : ''}
          </div>
        </div>`;
    });
    html += '</div>';
  }
  if (toolResult) html += `<div class="findings-result-note">${sanitizeOutputHtml(toolResult.trim())}</div>`;
  return `${html}</div>`;
}
//#endregion

function renderToolParamsHtml(params) {
  if (!params) return '';
  const BLOCK_KEYS = new Set(['old_string', 'new_string', 'content', 'contentFull', 'plan']);
  const badges = [],
    blocks = [],
    jsonBlocks = [];
  for (const [k, v] of Object.entries(params)) {
    if (BLOCK_KEYS.has(k)) continue;
    // Skip sibling `<k>Full` entries — they're used as expand targets, not
    // rendered as their own field. Only treat it as a sibling when the
    // trimmed key holds a server-truncated string (ends with the truncation
    // marker), otherwise a real param that happens to end in "Full" would
    // disappear.
    if (k.endsWith('Full')) {
      const baseKey = k.slice(0, -4);
      const base = params[baseKey];
      if (typeof base === 'string' && base.endsWith('... (truncated)') && typeof v === 'string') {
        continue;
      }
    }
    if (v !== null && typeof v === 'object') {
      let pretty;
      try {
        pretty = JSON.stringify(v, null, 2);
      } catch (_) {
        pretty = String(v);
      }
      if (pretty.length > CONTENT_TRUNCATE_MAX) {
        pretty = `${pretty.slice(0, CONTENT_TRUNCATE_MAX)}\n... (truncated)`;
      }
      jsonBlocks.push({ k, pretty });
      continue;
    }
    const display = typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v);
    if (display.length > 60) {
      const fullKey = `${k}Full`;
      const full = typeof params[fullKey] === 'string' ? params[fullKey] : null;
      blocks.push({ k, display, full });
    } else {
      badges.push(
        `<span style="display:inline-flex;align-items:center;gap:3px;padding:1px 6px;border-radius:3px;background:var(--bg-secondary);font-size:0.75rem"><span style="color:var(--text-muted)">${escapeHtml(k)}:</span> ${escapeHtml(display)}</span>`,
      );
    }
  }
  let html = '';
  if (badges.length) html += `<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px">${badges.join('')}</div>`;
  for (const { k, display, full } of blocks) {
    let suffix = '';
    if (full && full.length > display.length) {
      const toggle = makeExpandToggle(escapeHtml(display), escapeHtml(full), { fontSize: '0.75rem' });
      suffix = ` ${toggle.btn}${toggle.full}`;
    }
    html += `<div style="margin-top:6px;font-size:0.75rem"><span style="color:var(--text-muted)">${escapeHtml(k)}:</span> <span style="word-break:break-all">${escapeHtml(display)}</span>${suffix}</div>`;
  }
  for (const { k, pretty } of jsonBlocks) {
    html += `<div style="margin-top:8px;padding-top:6px;border-top:1px solid var(--border)">
          <div style="font-size:0.75rem;color:var(--text-muted);margin-bottom:2px">${escapeHtml(k)}</div>
          <pre class="${TINTED_PRE_CLASS}" style="max-height:300px;overflow:auto;font-size:0.75rem">${escapeHtml(pretty)}</pre>
        </div>`;
  }
  if (params.old_string || params.new_string) {
    html += `<div style="margin-top:8px;padding-top:6px;border-top:1px solid var(--border)">`;
    if (params.old_string) {
      html += `<div style="font-size:0.75rem;color:var(--text-muted);margin-bottom:2px">old_string</div>
            <pre class="${TINTED_PRE_CLASS}" style="max-height:200px;overflow:auto;border-left:3px solid #e55;padding-left:8px">${escapeHtml(params.old_string)}</pre>`;
    }
    if (params.new_string) {
      html += `<div style="font-size:0.75rem;color:var(--text-muted);margin-bottom:2px;margin-top:6px">new_string</div>
            <pre class="${TINTED_PRE_CLASS}" style="max-height:200px;overflow:auto;border-left:3px solid #5b5;padding-left:8px">${escapeHtml(params.new_string)}</pre>`;
    }
    html += `</div>`;
  }
  if (params.content) {
    // params.contentFull is set by the server when the truncated `content`
    // ends with `... (truncated)`. Fall back to params.content otherwise so
    // small writes render as before.
    const fullContent = params.contentFull || params.content;
    const isTruncated = !!params.contentFull || params.content.length > CONTENT_TRUNCATE_MAX;
    const truncContent = isTruncated
      ? `${params.content.slice(0, CONTENT_TRUNCATE_MAX)}${params.content.length > CONTENT_TRUNCATE_MAX ? '\n... (truncated)' : ''}`
      : params.content;
    let writeMoreBtn = '',
      fullBlock = '';
    if (isTruncated) {
      const toggle = makeExpandToggle(escapeHtml(truncContent), escapeHtml(fullContent), {
        fontSize: '0.75rem',
        maxHeight: '500px',
        tinted: true,
      });
      writeMoreBtn = ` ${toggle.btn}`;
      fullBlock = toggle.full;
    }
    html += `<div style="margin-top:8px;padding-top:6px;border-top:1px solid var(--border)">
          <div style="font-size:0.75rem;color:var(--text-muted);margin-bottom:2px">content${writeMoreBtn}</div>
          <pre class="${TINTED_PRE_CLASS}" style="max-height:300px;overflow:auto">${escapeHtml(truncContent)}</pre>
          ${fullBlock}
        </div>`;
  }
  if (params.plan) {
    html += `<div style="margin-top:8px;padding-top:6px;border-top:1px solid var(--border)">
          <div style="font-size:0.75rem;color:var(--text-muted);margin-bottom:4px">Plan</div>
          <div class="markdown-body">${renderMarkdown(params.plan)}</div>
        </div>`;
  }
  return html;
}

// Strip cat -n style line number prefix (e.g. "   1→" or "   1\t") from tool output
function stripLineNumbers(text) {
  return text.replace(/^ *\d+[→\t]/gm, '');
}

// The two entry points for raw tool output: plain text (clipboard, field
// parsing) and HTML (any pane that renders it, where ANSI becomes colour).
function sanitizeOutput(text) {
  return typeof text === 'string' ? stripAnsi(stripLineNumbers(text)) : text;
}

function sanitizeOutputHtml(text) {
  return typeof text === 'string' ? ansiToHtml(stripLineNumbers(text)) : '';
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

const TINTED_PRE_CLASS = 'msg-detail-pre msg-detail-pre-tinted';
let _expandIdCounter = 0;
function _applyExpandToggle(btn, fullEl) {
  const truncEl = btn.parentElement.nextElementSibling;
  const expand = fullEl.style.display === 'none';
  fullEl.style.display = expand ? 'block' : 'none';
  if (truncEl) truncEl.style.display = expand ? 'none' : 'block';
  btn.textContent = expand ? 'Show less' : 'Show more';
  const panel = btn.closest('.message-panel');
  if (panel) panel.classList.toggle('msg-expanded-wide', expand);
  const modal = btn.closest('.modal');
  // A user-dragged size is an explicit choice — don't widen over it.
  if (modal && !modal.classList.contains('user-sized')) _setModalWidth(modal, 'Expand', expand, '60vw', '60vw');
}
function _toggleExpand(btn) {
  const f = document.getElementById(btn.dataset.expandId);
  if (f) _applyExpandToggle(btn, f);
}
function makeExpandToggle(_truncatedHtml, fullHtml, opts = {}) {
  const id = `expand-${++_expandIdCounter}`;
  const fontSize = opts.fontSize || '0.8rem';
  const maxHeight = opts.maxHeight || '';
  const cls = opts.tinted ? TINTED_PRE_CLASS : 'msg-detail-pre';
  const btn = `<button data-expand-id="${id}" onclick="_toggleExpand(this)" class="expand-toggle-btn" style="font-size:${fontSize}">Show more</button>`;
  const mhStyle = maxHeight ? `max-height:${maxHeight};` : '';
  const full = `<pre id="${id}" class="${cls}" style="${mhStyle}overflow:auto;display:none">${fullHtml}</pre>`;
  return { btn, full };
}

function autoSizeModal(modal, body) {
  if (modal.classList.contains('fullscreen') || modal.classList.contains('user-sized')) return;
  modal.style.maxWidth = '';
  modal.classList.remove('has-mermaid');
  const hasMermaid = body.querySelector('pre.mermaid') !== null;
  if (hasMermaid) {
    modal.classList.add('has-mermaid');
    return;
  }
  const hasTable = body.querySelector('table') !== null;
  const hasPre = body.querySelector('pre') !== null;
  // hasPre is already computed and short-circuits the textContent walk, which is
  // no longer cheap now that colourised output puts thousands of spans in there.
  const desired = hasTable ? 1100 : hasPre || body.textContent.length > 2000 ? 960 : 860;
  const current = parseFloat(getComputedStyle(modal).maxWidth) || 0;
  if (desired > current) modal.style.maxWidth = `${desired}px`;
}

function renderToolResultHtml(toolResult, isTruncated, fullResult, toolUseId) {
  if (!toolResult) return '';
  const escaped = sanitizeOutputHtml(toolResult);
  let truncLabel = '',
    fullBlock = '';
  if (isTruncated && fullResult) {
    const toggle = makeExpandToggle(escaped, sanitizeOutputHtml(fullResult));
    truncLabel = toggle.btn;
    fullBlock = toggle.full;
  } else if (isTruncated && toolUseId) {
    const id = `expand-${++_expandIdCounter}`;
    truncLabel = `<button data-expand-id="${id}" data-tool-use-id="${escapeHtml(toolUseId)}" onclick="_toggleToolResultExpand(this)" class="expand-toggle-btn" style="font-size:0.8rem">Show more</button>`;
    fullBlock = `<pre id="${id}" class="msg-detail-pre" style="overflow:auto;display:none"></pre>`;
  } else if (isTruncated) {
    truncLabel = '<span style="color:var(--text-muted);font-size:0.8rem;margin-left:6px">(truncated)</span>';
  }
  return `<div style="margin-top:10px;padding-top:8px;border-top:1px solid var(--border)">
        <div style="font-size:0.8rem;color:var(--text-muted);margin-bottom:4px">Output${truncLabel}</div>
        <pre class="msg-detail-pre" style="overflow:auto">${escaped}</pre>
        ${fullBlock}
      </div>`;
}

// Render base64 images returned by a tool (e.g. a Read on a .png) so the user
// can see what the agent saw, mirroring how user-attached images are shown.
function renderToolResultImagesHtml(count, toolUseId) {
  if (!count || !currentSessionId || !toolUseId) return '';
  const sid = encodeURIComponent(currentSessionId);
  const tid = encodeURIComponent(toolUseId);
  const imgs = Array.from({ length: count }, (_, i) =>
    attachImageTag(`/api/sessions/${sid}/tool-result-image/${tid}/${i}`, 'tool result image'),
  ).join('');
  return attachImageSection('Image output', imgs);
}

async function _toggleToolResultExpand(btn) {
  const f = document.getElementById(btn.dataset.expandId);
  if (!f) return;
  if (!btn.dataset.loaded) {
    if (!currentSessionId || !btn.dataset.toolUseId) return;
    btn.disabled = true;
    btn.textContent = 'Loading…';
    try {
      const r = await fetch(
        `/api/sessions/${encodeURIComponent(currentSessionId)}/tool-result/${encodeURIComponent(btn.dataset.toolUseId)}`,
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const { content } = await r.json();
      f.innerHTML = sanitizeOutputHtml(content);
      btn.dataset.loaded = '1';
    } catch (_e) {
      btn.textContent = 'Show more';
      btn.disabled = false;
      showToast('Failed to load full output');
      return;
    }
    btn.disabled = false;
  }
  _applyExpandToggle(btn, f);
}

function buildToolContent(m) {
  let content = m.fullDetail || m.detail || '';
  if (m.toolResult) content += `\n\n--- Output ---\n\n${sanitizeOutput(m.toolResultFull || m.toolResult)}`;
  return content;
}

function getMessageDisplayContent(m) {
  return m.type === 'tool_use' ? buildToolContent(m) : m.compactSummary || stripAnsi(m.fullText || m.text);
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
  copyWithFeedback(getMessageDisplayContent(m), btn);
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
  // Write/Edit tool calls record the source path — open that directly instead
  // of dumping the rendered modal body into a temp buffer.
  const filePath =
    m.type === 'tool_use' && (m.tool === 'Write' || m.tool === 'Edit')
      ? m.params?.file_path || m.fullDetail || null
      : null;
  if (filePath) {
    postAndToast('/api/open-in-editor', { file: filePath }, 'in editor');
    return;
  }
  const title = m.type === 'tool_use' ? m.tool : m.compactSummary ? 'compact-summary' : m.type;
  postAndToast('/api/open-in-editor', { content: getMessageDisplayContent(m), title }, 'in editor');
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
    const groupKey = a.agentName || a.type;
    if (!byType[groupKey]) byType[groupKey] = [];
    byType[groupKey].push(a);
  }
  const filtered = [];
  for (const group of Object.values(byType)) {
    group.sort((a, b) => new Date(a.startedAt || 0) - new Date(b.startedAt || 0));
    filtered.push(group[0]);
    let maxStop = group[0].stoppedAt ? new Date(group[0].stoppedAt).getTime() : Infinity;
    for (let i = 1; i < group.length; i++) {
      const cur = group[i];
      const hasContent = cur.prompt || cur.lastMessage;
      const curStart = new Date(cur.startedAt || 0).getTime();
      const overlapped = curStart < maxStop;
      const reSpawn = curStart - maxStop > 30000;
      const isActive = cur.status === 'active' || cur.status === 'idle';
      if (overlapped || reSpawn || isActive || hasContent) filtered.push(cur);
      const curStop = cur.stoppedAt ? new Date(cur.stoppedAt).getTime() : Infinity;
      if (curStop > maxStop) maxStop = curStop;
    }
  }
  // Sort: active/idle first, then by updatedAt desc
  const statusOrder = { active: 0, idle: 1, stopped: 2 };
  const visible = filtered
    .sort(
      (a, b) =>
        (statusOrder[a.status] ?? 2) - (statusOrder[b.status] ?? 2) ||
        new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0),
    )
    .slice(0, AGENT_LOG_MAX);

  const permFresh = isWaitingFresh();

  if (visible.length === 0 && !permFresh) {
    footer.classList.remove('visible');
    clearInterval(agentDurationInterval);
    agentDurationInterval = null;
    clearInterval(agentPollInterval);
    agentPollInterval = null;
    return;
  }

  footer.classList.add('visible');
  label.textContent = `Agents Log (${visible.length})`;

  const collapsed = localStorage.getItem('agentFooterCollapsed') === 'true';
  footer.classList.toggle('collapsed', collapsed);
  document.getElementById('agent-footer-toggle').innerHTML = collapsed ? '&#x25B4;' : '&#x25BE;';

  const permHtml = permFresh
    ? `<button type="button" class="permission-badge" onclick="showWaitingDetail()">${currentWaiting.kind === 'question' ? '❓ Question pending' : currentWaiting.kind === 'plan' ? '📋 Plan pending' : `⏳ Awaiting: ${escapeHtml(currentWaiting.toolName || 'unknown')}`}</button>`
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
        const descText = a.description || '';
        const promptTrimmed = stripAnsi(stripTeammateWrapper((a.prompt || '').trim())).replace(/[\r\n]+/g, ' ');
        const displayText = descText || promptTrimmed;
        const displayTrunc = displayText.length > 60 ? `${displayText.substring(0, 60)}…` : displayText;
        const msgHtml = displayTrunc
          ? `<div class="agent-message" title="${escapeHtml(displayText)}">${escapeHtml(displayTrunc)}</div>`
          : '';
        const rawType = a.type || 'unknown';
        const colonIdx = rawType.indexOf(':');
        const typeNs = colonIdx > 0 ? rawType.substring(0, colonIdx + 1) : '';
        const typeName = colonIdx > 0 ? rawType.substring(colonIdx + 1) : rawType;
        const agentNameVal = a.agentName || null;
        const nameColor = agentNameVal ? getOwnerColor(agentNameVal) : null;
        const nameBadgeHtml = nameColor
          ? `<span class="task-owner-badge task-owner-badge--compact" style="background:${nameColor.bg};color:${nameColor.color}">${escapeHtml(agentNameVal)}</span>`
          : '';
        const agentColor = resolveNamedColor(a.color);
        const colorStyle = agentColor ? ` style="border-left:3px solid ${agentColor.color}"` : '';
        const selectedClass = a.agentId === currentAgentModalId ? ' selected' : '';
        const cardModel = shortModelName(a.model);
        const modelChipHtml = cardModel
          ? `<span class="agent-card-model" title="${escapeHtml(a.model)}">${escapeHtml(cardModel)}</span>`
          : '';
        return `<div class="agent-card${selectedClass}" data-agent-id="${escapeHtml(a.agentId)}"${colorStyle} onclick="showAgentModal('${escAttrJs(a.agentId)}')">
          ${agentLogButton(a.agentId, 'agent-card-log-btn')}
          <div class="agent-type-row">${typeNs ? `<span class="agent-type-ns">${escapeHtml(typeNs)}</span>` : ''}<span class="agent-type-name">${escapeHtml(typeName)}</span>${nameBadgeHtml}</div>
          <div class="agent-status-row"><span class="agent-dot ${a.status}"></span><span class="agent-status">${statusText}</span>${modelChipHtml}</div>
          ${msgHtml}
        </div>`;
      })
      .join('');

  clearInterval(agentDurationInterval);
  if (visible.some((a) => a.status === 'active' || a.status === 'idle')) {
    agentDurationInterval = setInterval(() => renderAgentFooter(), 1000);
    if (!agentPollInterval) {
      agentPollInterval = setInterval(() => {
        if (viewMode === 'project' && currentProjectPath) {
          refreshProjectAgents();
        } else if (currentSessionId) {
          fetchAgents(currentSessionId);
        }
      }, 3000);
    }
  } else {
    agentDurationInterval = setInterval(() => renderAgentFooter(), 10000);
    clearInterval(agentPollInterval);
    agentPollInterval = null;
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

function findAgentById(agentId) {
  let agent = currentAgents.find((a) => a.agentId === agentId);
  if (!agent) {
    const atIdx = agentId.indexOf('@');
    const memberName = atIdx > 0 ? agentId.substring(0, atIdx) : null;
    if (memberName) agent = currentAgents.find((a) => a.type === memberName);
  }
  return agent || null;
}

// biome-ignore lint/correctness/noUnusedVariables: used in HTML
function showAgentModal(agentId) {
  const agent = findAgentById(agentId);
  if (!agent) return;
  currentAgentModalId = agentId;
  highlightSelectedAgent();
  const modal = document.getElementById('agent-modal');
  const title = document.getElementById('agent-modal-title');
  const body = document.getElementById('agent-modal-body');
  const now = Date.now();
  const started = agent.startedAt ? new Date(agent.startedAt) : null;
  const stopped = agent.stoppedAt ? new Date(agent.stoppedAt) : null;
  const elapsed = stopped && started ? stopped.getTime() - started.getTime() : started ? now - started.getTime() : 0;

  const statusDot = `<span class="agent-dot ${agent.status}" style="display:inline-block;vertical-align:middle;margin-right:6px;"></span>`;
  const modalNameLabel = agent.agentName ? ` · ${escapeHtml(agent.agentName)}` : '';
  title.innerHTML = `${statusDot} ${escapeHtml(agent.type || 'unknown')}${modalNameLabel}`;

  const shortModel = shortModelName(agent.model);
  const shortId = agent.agentId ? agent.agentId.slice(0, 8) : '';
  const chip = (label, value, opts = {}) => {
    const cls = opts.cls ? ` ${opts.cls}` : '';
    const style = opts.style ? ` style="${opts.style}"` : '';
    const title = opts.title ? ` title="${escapeHtml(opts.title)}"` : '';
    const labelHtml = label ? `<span class="agent-chip-label">${label}</span>` : '';
    return `<span class="agent-chip${cls}"${style}${title}>${labelHtml}<span class="agent-chip-val">${value}</span></span>`;
  };

  const agentMsg = currentMessages.find((m) => m.tool === 'Agent' && m.agentId === agentId);
  const usageStats = agent.usage || null;
  const fmtTok = fmtTokens;

  const chips = [];
  if (agent.agentId) chips.push(chip('id', escapeHtml(shortId), { cls: 'agent-chip-mono', title: agent.agentId }));
  chips.push(chip('', escapeHtml(agent.status), { cls: `agent-chip-status agent-chip-${agent.status}` }));
  chips.push(chip('⏱', formatDuration(elapsed)));
  if (usageStats?.tokens != null) chips.push(chip('tokens', fmtTok(usageStats.tokens), { cls: 'agent-chip-mono' }));
  if (usageStats?.tools != null) chips.push(chip('tools', String(usageStats.tools), { cls: 'agent-chip-mono' }));
  if (shortModel) chips.push(chip('model', escapeHtml(shortModel), { cls: 'agent-chip-mono' }));
  if (agent.agentName) {
    const c = getOwnerColor(agent.agentName);
    chips.push(
      chip('owner', escapeHtml(agent.agentName), {
        style: `background:${c.bg};color:${c.color};border-color:transparent;`,
      }),
    );
  }
  if (started) chips.push(chip('started', started.toLocaleTimeString()));
  if (stopped) chips.push(chip('stopped', stopped.toLocaleTimeString()));

  let html = `<div class="agent-chips">${chips.join('')}</div>`;

  const promptText = stripTeammateWrapper(agentMsg?.agentPrompt || agent.prompt || null);
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
  hideModalOverlay('agent-modal');
  currentAgentModalId = null;
  highlightSelectedAgent();
}

function highlightSelectedAgent() {
  const content = document.getElementById('agent-footer-content');
  if (!content) return;
  for (const el of content.querySelectorAll('.agent-card.selected')) el.classList.remove('selected');
  if (currentAgentModalId == null) return;
  const el = content.querySelector(`.agent-card[data-agent-id="${escSel(currentAgentModalId)}"]`);
  if (el) el.classList.add('selected');
}

//#endregion

//#region RENDERING
let revealedPlanSessionId = null;
let revealedStorageSessionId = null;

// Opens a session and scrolls the sidebar to it, refetching first when the id
// fell outside the session list the current filters asked for.
async function revealSession(id) {
  if (!sessions.some((s) => s.id === id)) {
    lastSessionsHash = '';
    await fetchSessions();
  }
  await fetchTasks(id);
  const el = document.querySelector(`.session-item[data-session-id="${escSel(id)}"]`);
  if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// biome-ignore lint/correctness/noUnusedVariables: used in HTML
async function revealPlanSession(planSessionId) {
  if (revealedPlanSessionId === planSessionId) {
    revealedPlanSessionId = null;
    renderSessions();
    return;
  }
  revealedPlanSessionId = planSessionId;
  await revealSession(planSessionId);
}

async function showAllTasks() {
  try {
    viewMode = 'all';
    if (agentLogMode) exitAgentLogMode();
    currentSessionId = null;
    ownerFilter = '';
    resetAgentState();
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
    renderActivityChip();
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

// Filter pipeline: active filter → force-include revealed/current (non-pinned) sessions →
// project filter → search filter → ensure pinned/sticky sessions are always included.
// Pure over module state, so the session picker can ask for the same list without a render.
function getFilteredSessions() {
  let filteredSessions = sessions;
  if (sessionFilter === 'active') {
    const activeSessionIds = new Set();
    filteredSessions = filteredSessions.filter((s) => {
      if (dismissedSessionIds.has(s.id)) return false;
      const isActive =
        s.hasMessages &&
        ((!s.sharedTaskList && (s.pending > 0 || s.inProgress > 0)) ||
          s.hasActiveAgents ||
          s.hasWaitingForUser ||
          s.hasRecentActivity);
      if (isActive) activeSessionIds.add(s.id);
      return isActive;
    });
    // Force-include revealed/current sessions that didn't pass the active filter.
    // Skip pinned sessions — they are prepended separately below (lines ~2180) to preserve stable position.
    const filteredIds = new Set(filteredSessions.map((s) => s.id));
    for (const id of [revealedPlanSessionId, revealedStorageSessionId, currentSessionId]) {
      if (id && !filteredIds.has(id) && !isAnyPinned(id)) {
        const session = sessions.find((s) => s.id === id);
        if (session) {
          const insertAt = filteredSessions.findIndex((s) => s.modifiedAt < session.modifiedAt);
          if (insertAt === -1) filteredSessions.push(session);
          else filteredSessions.splice(insertAt, 0, session);
        }
      }
    }
  }
  if (filterProject) {
    filteredSessions = filteredSessions.filter((s) => matchesProjectFilter(s.project));
  }

  if (activityFilter.size > 0) {
    const preds = [...activityFilter].map((k) => ACTIVITY_PREDICATES[k]).filter(Boolean);
    if (preds.length) filteredSessions = filteredSessions.filter((s) => preds.some((p) => p(s)));
  }

  if (searchQuery) {
    const taskMatchIds = new Set();
    for (const t of allTasksCache) {
      if (
        (t.subject && fuzzyMatch(t.subject, searchQuery)) ||
        (t.description && fuzzyMatch(t.description, searchQuery)) ||
        (t.activeForm && fuzzyMatch(t.activeForm, searchQuery))
      )
        taskMatchIds.add(t.sessionId);
    }
    const groupMatchIds = sgSearchMatchIds(searchQuery);
    const matchesSearch = (s) =>
      (s.name && fuzzyMatch(s.name, searchQuery)) ||
      (s.id && fuzzyMatch(s.id, searchQuery)) ||
      (s.project && fuzzyMatch(s.project, searchQuery)) ||
      (s.description && fuzzyMatch(s.description, searchQuery)) ||
      taskMatchIds.has(s.id) ||
      groupMatchIds.has(s.id);

    filteredSessions = filteredSessions.filter(matchesSearch);

    // Re-add pinned/sticky sessions that match the query but were excluded by active filter
    if (
      sessionFilter === 'active' &&
      activityFilter.size === 0 &&
      (pinnedSessionIds.size > 0 || stickySessionIds.size > 0)
    ) {
      const filteredIds = new Set(filteredSessions.map((s) => s.id));
      const missingPinned = sessions.filter((s) => isAnyPinned(s.id) && !filteredIds.has(s.id) && matchesSearch(s));
      if (missingPinned.length) filteredSessions = [...missingPinned, ...filteredSessions];
    }
  }

  // Include pinned/sticky sessions even if they don't match the active filter.
  // Only in the "active" view — the "all" view is a plain list with no pin prioritization.
  if (
    sessionFilter === 'active' &&
    activityFilter.size === 0 &&
    !searchQuery &&
    (pinnedSessionIds.size > 0 || stickySessionIds.size > 0)
  ) {
    const filteredIds = new Set(filteredSessions.map((s) => s.id));
    const missingPinned = sessions.filter((s) => isAnyPinned(s.id) && !filteredIds.has(s.id));
    if (missingPinned.length) filteredSessions = [...missingPinned, ...filteredSessions];
  }

  return filteredSessions;
}

function renderSessions() {
  // Rebuilding the list under the pointer cancels an in-flight drop and would swallow a
  // half-typed group name, and the SSE path can fire at any moment — defer instead.
  if (sgDrag || sgIsEditing()) return;
  // Update project dropdown
  updateProjectDropdown();

  const filteredSessions = getFilteredSessions();

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
    const isLive = isSessionLive(session);
    const sessionName = sessionDisplayName(session);
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

    const pinState = getSessionPinState(session.id);
    const pinClass = pinState === 'sticky' ? ' sticky' : pinState === 'pinned' ? ' pinned' : '';
    const pinTitle =
      pinState === 'pinned' || pinState === 'sticky' ? 'Unpin session (.)' : 'Pin session (. · > sticky)';
    const showCtx = !!session.contextStatus;
    const linkedDocsCount = getSessionPreviewPaths(session.id).length;
    const bookmarksCount = loadPins(session.id).length;
    const hasScratchpad = !!(localStorage.getItem(_sessionScratchpadKey(session.id)) || '').trim();
    const tempClass = session.hasRecentLog || session.inProgress || session.hasWaitingForUser ? 'warm' : 'stale';
    const sid = escAttrJs(session.id);
    return `
          <button onclick="fetchTasks('${sid}')" draggable="true" data-session-id="${escapeHtml(session.id)}" class="session-item ${isActive ? 'active' : ''} ${session.hasWaitingForUser ? 'permission-pending' : ''} ${tempClass} ${showCtx ? 'has-context' : ''}" title="${escapeHtml(tooltip)}">
            <span class="session-pin-btn${pinClass}" onclick="event.stopPropagation();toggleSessionPin('${sid}')" title="${pinTitle} session">${pinState === 'sticky' ? SESSION_STAR_SVG : SESSION_PIN_SVG}</span>
            <div class="session-name">${escapeHtml(primaryName)}</div>
            ${secondaryName ? `<div class="session-secondary">${escapeHtml(secondaryName)}</div>` : ''}
            ${gitBranch ? `<div class="session-branch">${gitBranch}</div>` : ''}
            ${session.planTitle ? `<div class="session-plan">${escapeHtml(session.planTitle)}</div>` : ''}
            ${renderGoalSubtitle(session)}
            <div class="session-progress">
              <span class="session-indicators">
                ${isTeam ? `<span class="team-badge" title="${memberCount} team members"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>${memberCount}</span>` : ''}
                ${isTeam || session.project || showCtx ? `<span class="team-info-btn" onclick="event.stopPropagation(); showSessionInfoModal('${sid}')" title="View session info"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg></span>` : ''}
                ${renderWorkflowBadge(session)}
                ${renderLoopBadge(session)}
                ${hasScratchpad ? `<span class="scratchpad-badge" onclick="event.stopPropagation(); openSessionScratchpad('${sid}')" title="Open scratchpad"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></span>` : ''}
                ${bookmarksCount > 0 ? `<span class="bookmarks-badge" onclick="event.stopPropagation(); openSessionWithBookmarks('${sid}')" title="${bookmarksCount} bookmarked message${bookmarksCount > 1 ? 's' : ''}"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>${bookmarksCount}</span>` : ''}
                ${linkedDocsCount > 0 ? `<span class="linked-docs-badge" onclick="event.stopPropagation(); showSessionInfoModal('${sid}')" title="${linkedDocsCount} linked document${linkedDocsCount > 1 ? 's' : ''}">${linkSvg(10)}${linkedDocsCount}</span>` : ''}
                ${session.hasPlan && !session.planSourceSessionId ? `<span class="plan-indicator" onclick="event.stopPropagation(); openPlanForSession('${sid}')" title="View plan">${ICON_PLAN}</span>` : ''}
                ${session.planSourceSessionId ? `<span class="plan-indicator" title="Implements plan — click to reveal plan session" onclick="event.stopPropagation(); revealPlanSession('${escAttrJs(session.planSourceSessionId)}')">${ICON_PLAN}</span>` : ''}
                ${session.sharedTaskList ? `<span class="shared-tasklist-badge" title="Shared task list: ${escapeHtml(session.sharedTaskList)}">${linkSvg(12)}</span>` : ''}
                ${session.hasWaitingForUser ? `<span class="agent-badge agent-badge-waiting" title="Waiting for user">${ICON_AGENT_WAITING}</span>` : ''}
                ${session.hasRunningAgents && !session.hasWaitingForUser ? `<span class="agent-badge agent-badge-active" title="Agents running">${ICON_AGENT_ACTIVE}</span>` : ''}
                ${isLive || session.hasRunningAgents ? `<span class="pulse" title="${isLive ? 'Live' : 'Active agents'}"></span>` : ''}
              </span>
              <div class="progress-bar"><div class="progress-fill" style="width: ${percent}%"></div></div>
              <span class="progress-text">${session.completed}/${total}</span>
            </div>
            ${showCtx ? renderContextBar(session.contextStatus) : ''}
            <div class="session-time">${formatDate(session.modifiedAt)}</div>
          </button>
        `;
  };

  const groupPinned = localStorage.getItem('groupPinnedSessions') !== 'false';
  const pinWeight = (s) => (isPlacedSticky(s.id) ? 2 : isPlacedPinned(s.id) && !isSessionActive(s) ? 1 : 0);
  const pinSort = (a, b) => pinWeight(b) - pinWeight(a);
  const countHtml = (arr) => {
    const active = arr.reduce((n, s) => n + (isSessionActive(s) ? 1 : 0), 0);
    return `<span class="group-count" title="${active} active / ${arr.length} total">${active > 0 ? `<span class="group-count-active">${active}</span><span class="group-count-sep">/</span>` : ''}${arr.length}</span>`;
  };
  // `ungroup` marks the label as the drop target for pulling an item out of a named group.
  const sectionHtml = (key, text, ungroup, body) => {
    const collapsed = collapsedProjectGroups.has(key);
    const escPath = escapeHtml(key);
    const title = ungroup ? 'Click to collapse — drop here to remove from a group' : 'Click to collapse';
    return `<div class="sg-section-label sg-section-toggle${ungroup ? ' sg-ungroup-zone' : ''}${collapsed ? ' collapsed' : ''}" data-group-path="${escPath}" title="${escapeHtml(title)}">${groupChevronSvg(10)}<span>${text}</span></div>
      <div class="sg-section-body${collapsed ? ' collapsed' : ''}" data-group-path="${escPath}">${body}</div>`;
  };

  const renderGroupSessions = (sessions, pinKey) => {
    if (!groupPinned || pinnedSessionIds.size === 0) return sessions.map(renderSessionCard).join('');
    const gPinned = sessions.filter((s) => isPlacedPinned(s.id) && !isPlacedSticky(s.id));
    if (gPinned.length === 0) return sessions.map(renderSessionCard).join('');
    const gIdlePinned = gPinned.filter((s) => !isSessionActive(s));
    const gUnpinned = sessions.filter((s) => !isPlacedPinned(s.id) || isSessionActive(s) || isPlacedSticky(s.id));
    const pinCollapsed = collapsedProjectGroups.has(pinKey);
    if (gIdlePinned.length === 0 && !pinCollapsed) return gUnpinned.map(renderSessionCard).join('');
    return (
      '<div class="pinned-sub-section">' +
      '<div class="pinned-sub-header' +
      (pinCollapsed ? ' collapsed' : '') +
      '" data-group-path="' +
      escapeHtml(pinKey) +
      '">' +
      groupChevronSvg(10) +
      '<span class="pinned-sub-label">Pinned</span>' +
      '<span class="group-count">' +
      gIdlePinned.length +
      '</span>' +
      '<span class="pinned-ungroup-btn" title="Ungroup pinned sessions">&times;</span>' +
      '</div>' +
      '<div class="pinned-sub-items' +
      (pinCollapsed ? ' collapsed' : '') +
      '">' +
      gIdlePinned.map(renderSessionCard).join('') +
      '</div>' +
      '</div>' +
      gUnpinned.map(renderSessionCard).join('')
    );
  };

  // Renders one project block. `nested` = it sits inside a named group, so it is indented and
  // its own drag payload still resolves to the project path.
  const projectBlock = (projectPath, projectSessions, nested) => {
    const folderName = projectPath.split(/[/\\]/).pop();
    const isCollapsed = collapsedProjectGroups.has(projectPath);
    const escapedPath = escapeHtml(projectPath);
    const nestedCls = nested ? ' sg-nested' : '';
    const breadcrumbParts = projectPath
      .replace(/^\/home\/[^/]+/, '~')
      .split(/[/\\]/)
      .filter(Boolean);
    const breadcrumbHtml = breadcrumbParts
      .map((p, i) => (i < breadcrumbParts.length - 1 ? `${escapeHtml(p)}<span class="sep">/</span>` : escapeHtml(p)))
      .join('');

    return `
            <div class="project-group-header${isCollapsed ? ' collapsed' : ''}${nestedCls}" draggable="true" data-group-path="${escapedPath}" data-project-path="${escapedPath}">
              ${groupChevronSvg()}
              <span class="group-name">${escapeHtml(folderName)}</span>
              ${countHtml(projectSessions)}
              <span class="project-view-btn" data-project-path="${escapedPath}" title="Open project view — combined tasks from all sessions">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
              </span>
            </div>
            <div class="project-group-breadcrumb${nestedCls}" data-full-path="${escapedPath}" title="Click to copy path">${breadcrumbHtml}</div>
            <div class="project-group-sessions${isCollapsed ? ' collapsed' : ''}${nestedCls}" data-project-path="${escapedPath}">
              ${renderGroupSessions(projectSessions, `__pinned_${projectPath}__`)}
            </div>
          `;
  };

  // Named groups are a pure partition of the already-filtered list: whatever they don't claim
  // falls through to the project blocks below, which look exactly as they did before groups.
  const sgBuckets = new Map();
  let sgRest = filteredSessions;
  if (sessionGroups.length > 0) {
    sgRest = [];
    for (const session of filteredSessions) {
      const group = sgGroupForSession(session);
      if (group) {
        if (!sgBuckets.has(group.id)) sgBuckets.set(group.id, []);
        sgBuckets.get(group.id).push(session);
      } else {
        sgRest.push(session);
      }
    }
  }
  // A group emptied by a filter hides its header; a group the user just created (no filters)
  // shows its drop-here state instead of vanishing.
  const sgFiltering = !!searchQuery || activityFilter.size > 0 || (!!filterProject && filterProject !== '__recent__');

  // flat = the "All sessions" view, which has no project sub-blocks.
  const sgSectionHtml = (flat) => {
    if (sessionGroups.length === 0) return '';
    let out = '';
    for (const group of sessionGroups) {
      const bucket = sgBuckets.get(group.id) || [];
      if (bucket.length === 0 && sgFiltering) continue;
      if (!groupPinned) bucket.sort(pinSort);
      const collapsed = collapsedProjectGroups.has(sgKey(group.id));
      let body = '';
      if (flat) {
        body = bucket.map(renderSessionCard).join('');
      } else {
        const loose = [];
        const byProject = new Map();
        for (const s of bucket) {
          const host = sgHostOf(group, s);
          if (host) {
            if (!byProject.has(host)) byProject.set(host, []);
            byProject.get(host).push(s);
          } else {
            loose.push(s);
          }
        }
        // Project members first (in the user's member order), then the individually placed
        // sessions — one Pinned sub-section per group instead of one per interleaved run.
        for (const m of group.members) {
          if (m.type !== 'project') continue;
          const arr = byProject.get(m.ref);
          // A member project with nothing left in it still renders: it shows the membership, and
          // it is the drop target for putting a session back under it.
          if (arr?.length || !sgFiltering) body += projectBlock(m.ref, arr || [], true);
        }
        if (loose.length) {
          // Individually placed sessions follow the order the user dragged them into.
          const slot = new Map(group.members.map((m, i) => [`${m.type}:${m.ref}`, i]));
          loose.sort((a, b) => (slot.get(`session:${a.id}`) ?? 0) - (slot.get(`session:${b.id}`) ?? 0));
          // Label them, else a card sitting under the project blocks reads as stranded.
          if (body) body += '<div class="sg-sub-label">Sessions</div>';
          body += renderGroupSessions(loose, `__pinned_group_${group.id}__`);
        }
      }
      if (!body) body = '<div class="sg-empty">Drop a session or a project here</div>';
      out += sgHeaderHtml(group, countHtml(bucket));
      out += `<div class="session-group-sessions${collapsed ? ' collapsed' : ''}" data-group-id="${escapeHtml(group.id)}">${body}</div>`;
    }
    if (!out) return '';
    return sectionHtml(SECTION_GROUPS, 'Groups', false, out);
  };

  let html = '';
  if (!groupPinned && pinnedSessionIds.size > 0 && filteredSessions.some((s) => pinnedSessionIds.has(s.id))) {
    html += `<div class="pinned-regroup-banner">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="3"/><path d="M5 10l7-7 7 7"/><line x1="4" y1="21" x2="20" y2="21"/></svg>
          Group pinned sessions
        </div>`;
  }

  // Group active sessions by project
  if (sessionFilter === 'active') {
    // Auto-expand a collapsed section when newly-active work lands in it (live refresh).
    expandActiveGroups({ onlyNew: true });
    html += sgSectionHtml(false);

    const groups = new Map();
    const ungrouped = [];
    for (const session of sgRest) {
      if (session.project) {
        if (!groups.has(session.project)) groups.set(session.project, []);
        groups.get(session.project).push(session);
      } else {
        ungrouped.push(session);
      }
    }
    if (!groupPinned && (pinnedSessionIds.size > 0 || stickySessionIds.size > 0)) {
      for (const [, arr] of groups) arr.sort(pinSort);
      ungrouped.sort(pinSort);
    }

    // Stable group order: preserve existing order, append new groups sorted by recency.
    // Grouped projects stay in the array (they are just not rendered here), so dragging one
    // back out restores its old slot instead of jumping to the top.
    const latestByPath = new Map();
    for (const s of filteredSessions) {
      if (!s.project) continue;
      const t = new Date(s.modifiedAt).getTime();
      latestByPath.set(s.project, Math.max(latestByPath.get(s.project) ?? -Infinity, t));
    }
    const knownPaths = new Set(stableGroupOrder);
    const keptOrder = stableGroupOrder.filter((p) => latestByPath.has(p));
    const newPaths = [...latestByPath.keys()].filter((p) => !knownPaths.has(p));
    if (newPaths.length > 1) newPaths.sort((a, b) => latestByPath.get(b) - latestByPath.get(a));
    stableGroupOrder = [...keptOrder, ...newPaths];
    const sortedGroups = stableGroupOrder.filter((p) => groups.has(p)).map((p) => [p, groups.get(p)]);

    // The section header is rendered even when nothing is left under it: it is the drop target
    // for ungrouping. Its body is skipped while collapsed — nothing would be visible, and this is
    // the whole project list, re-parsed on every live refresh.
    const sectioned = sessionGroups.length > 0;
    let projectsHtml = '';
    if (!sectioned || !collapsedProjectGroups.has(SECTION_PROJECTS)) {
      for (const [projectPath, projectSessions] of sortedGroups) {
        projectsHtml += projectBlock(projectPath, projectSessions, false);
      }

      if (ungrouped.length > 0 && sortedGroups.length > 0) {
        const isCollapsed = collapsedProjectGroups.has('__ungrouped__');
        projectsHtml += `
            <div class="project-group-header${isCollapsed ? ' collapsed' : ''}" data-group-path="__ungrouped__">
              ${groupChevronSvg()}
              <span class="group-name">Ungrouped</span>
              ${countHtml(ungrouped)}
            </div>
            <div class="project-group-sessions${isCollapsed ? ' collapsed' : ''}">
              ${renderGroupSessions(ungrouped, '__pinned___ungrouped__')}
            </div>
          `;
      } else {
        projectsHtml += ungrouped.map(renderSessionCard).join('');
      }
    }

    html += sectioned ? sectionHtml(SECTION_PROJECTS, 'Projects', true, projectsHtml) : projectsHtml;

    sessionsList.innerHTML = html;
  } else {
    const sectioned = sessionGroups.length > 0;
    const restHtml =
      sectioned && collapsedProjectGroups.has(SECTION_SESSIONS) ? '' : sgRest.map(renderSessionCard).join('');
    const tail = sectioned ? sectionHtml(SECTION_SESSIONS, 'Sessions', true, restHtml) : restHtml;
    sessionsList.innerHTML = html + sgSectionHtml(true) + tail;
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
  if (session.description && session.description !== displayName) {
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

function renderProjectView() {
  noSession.style.display = 'none';
  sessionView.classList.add('visible');

  const folderName = currentProjectPath ? currentProjectPath.split(/[/\\]/).pop() : 'Project';
  sessionTitle.textContent = folderName;

  const metaParts = [`${currentProjectSessionIds.length} sessions`, `${currentTasks.length} tasks`];
  if (currentProjectPath) metaParts.push(currentProjectPath);
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
  const useSlug = viewMode === 'all' || viewMode === 'project';
  const taskId = useSlug ? `${(task._taskDir || task.sessionId || '')?.slice(0, 4)}-${task.id}` : task.id;
  const sessionLabel = viewMode === 'all' && task.sessionName ? task.sessionName : null;
  const statusClass = task.status.replace('_', '-');
  const actualSessionId = task._taskDir || task.sessionId || currentSessionId || '';

  return `
        <div
          role="listitem"
          tabindex="0"
          data-task-id="${escapeHtml(task.id)}"
          data-session-id="${escapeHtml(actualSessionId)}"
          onclick="showTaskDetail('${escAttrJs(task.id)}', '${escAttrJs(actualSessionId)}')"
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
// FLIP pass around renderKanban's innerHTML rebuild (#41): the rebuild lands cards at
// their final spot instantly, so a status change reads as a full-board reload. Recording
// where each card was and animating from there makes a move glide instead.
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function cardFlipKey(el) {
  return `${el.dataset.sessionId}|${el.dataset.taskId}`;
}

function captureCardRects() {
  const rects = new Map();
  for (const el of document.querySelectorAll('.column-tasks .task-card')) {
    rects.set(cardFlipKey(el), el.getBoundingClientRect());
  }
  return rects;
}

function playCardFlip(before) {
  // An empty board before the render means a view switch, not a move — nothing to glide.
  if (reducedMotion.matches || before.size === 0) return;
  for (const el of document.querySelectorAll('.column-tasks .task-card')) {
    const prev = before.get(cardFlipKey(el));
    if (!prev) {
      el.animate(
        [
          { opacity: 0, transform: 'scale(0.97)' },
          { opacity: 1, transform: 'none' },
        ],
        { duration: 150, easing: 'ease-out' },
      );
      continue;
    }
    const now = el.getBoundingClientRect();
    const dx = prev.left - now.left;
    const dy = prev.top - now.top;
    if (dx || dy) {
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], {
        duration: 220,
        easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)',
      });
    }
  }
}

// Rewrite a column only when its markup actually changed: SSE ticks fire on any task-file
// write (updatedAt bumps, agent refreshes), and an unconditional innerHTML rebuild makes
// the whole board blink for updates with nothing visible in them (#41).
function setColumnHtml(el, html) {
  if (el._lastHtml === html) return;
  el._lastHtml = html;
  el.innerHTML = html;
}

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
  const plusIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 5v14M5 12h14"/></svg>`;

  const writes = [];
  // Adding is a live text input inside the column, so a background refresh would blow it
  // away mid-typing -- leave the column alone until the input is gone.
  if (!addingTask) {
    const addTile = canAddTask()
      ? `<button type="button" class="column-add${pending.length ? '' : ' empty'}" onclick="startAddTask(this)">${plusIcon}<span>Add task</span></button>`
      : '';
    writes.push([
      pendingTasks,
      pending.length > 0
        ? pending.map(renderTaskCard).join('') + addTile
        : addTile || `<div class="column-empty">${emptyIcon}<div>No pending tasks</div></div>`,
    ]);
  }

  writes.push([
    inProgressTasks,
    inProgress.length > 0
      ? inProgress.map(renderTaskCard).join('')
      : `<div class="column-empty">${emptyIcon}<div>No active tasks</div></div>`,
  ]);

  writes.push([
    completedTasks,
    completed.length > 0
      ? completed.map(renderTaskCard).join('')
      : `<div class="column-empty">${emptyIcon}<div>No completed tasks</div></div>`,
  ]);

  // Capture rects (a forced layout read per card) only when a column will
  // actually be rewritten — most SSE ticks change nothing and skip the FLIP.
  const willChange = writes.some(([el, html]) => el._lastHtml !== html);
  const flipRects = willChange ? captureCardRects() : null;
  for (const [el, html] of writes) setColumnHtml(el, html);
  if (flipRects) playCardFlip(flipRects);

  if (selectedTaskId) {
    const card =
      document.querySelector(
        `.task-card[data-task-id="${escSel(selectedTaskId)}"][data-session-id="${escSel(selectedSessionId)}"]`,
      ) || document.querySelector(`.task-card[data-task-id="${escSel(selectedTaskId)}"]`);
    if (card) {
      if (focusZone === 'board' && !taskHighlightDimmed) card.classList.add('selected');
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

//#region ADD_TASK
let addingTask = false;

// A task the user types is theirs to place, and the only session it can belong to is the
// one on screen -- the project and all-sessions views span many task dirs, so there is no
// single target to write into.
function canAddTask() {
  return viewMode === 'session' && !!currentSessionId;
}

// biome-ignore lint/correctness/noUnusedVariables: used in HTML
function startAddTask(tile) {
  if (addingTask) return;
  addingTask = true;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'form-input column-add-input';
  input.placeholder = 'Task subject, Enter to add';
  // The input mutates the column outside setColumnHtml — drop the cache so the
  // next render rebuilds instead of skipping on a stale match.
  pendingTasks._lastHtml = null;
  tile.replaceWith(input);
  input.focus();

  const reset = () => {
    addingTask = false;
    renderKanban();
  };

  const save = async () => {
    // Enter and blur both submit, and Enter's own save disables the input -- which blurs
    // it. Dropping both handlers first is what keeps that from posting the subject twice.
    input.onkeydown = null;
    input.onblur = null;

    const subject = input.value.trim();
    if (!subject) return reset();
    input.disabled = true;
    const sessionId = currentSessionId;
    try {
      const res = await fetch(`/api/tasks/${sessionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // The response carries the finished task, and the watcher will resend it within the
      // SSE debounce anyway -- so show it now rather than paying a session refetch for it.
      const { task } = await res.json();
      currentTasks.push({ ...task, sessionId });
      addingTask = false;
      renderKanban();
    } catch (error) {
      console.error('Failed to create task:', error);
      showToast('Failed to create task', 'error');
      reset();
    }
  };

  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      save();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      input.onblur = null;
      reset();
    }
  };
  input.onblur = () => save();
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
  // A sidebar session/project drag has nothing to do with task status — don't offer the board
  // as a drop target for it.
  if (sgDrag) return;
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
  if (sgDrag) return;
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
  const task = currentTasks.find(
    (t) => t.id === taskId && (t._taskDir === sessionId || (t.sessionId || currentSessionId) === sessionId),
  );
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

//#region SESSION_GROUPS
// User-named groups that hold whole projects and individual sessions, dragged in from the
// sidebar. They render above the project groups. Membership is a workspace preference kept in
// localStorage; an id missing from `sessions` is NOT proof the session is gone (sessionLimit
// windows the list), so membership is never garbage-collected on load.
const SESSION_GROUPS_KEY = 'sessionGroups';
const SG_ACTION_SELECTOR =
  '.session-pin-btn, .team-info-btn, .plan-indicator, .scratchpad-badge, .bookmarks-badge, .linked-docs-badge, .project-view-btn, .group-path-toggle, .pinned-ungroup-btn, .sg-action';

// Collapse state shares the existing `collapsedGroups` key; this namespace keeps it from
// colliding with a project path or the __ungrouped__ / __pinned_* sentinels.
function groupChevronSvg(size = 12) {
  return `<svg class="group-chevron" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>`;
}

function sgKey(id) {
  return `__group_${id}__`;
}

function loadSessionGroups() {
  try {
    const list = JSON.parse(localStorage.getItem(SESSION_GROUPS_KEY) || 'null')?.groups;
    sessionGroups = (Array.isArray(list) ? list : [])
      .filter((g) => g && typeof g.id === 'string')
      .map((g) => ({
        id: g.id,
        name: typeof g.name === 'string' && g.name.trim() ? g.name : 'Group',
        members: (Array.isArray(g.members) ? g.members : [])
          .filter((m) => m && (m.type === 'project' || m.type === 'session') && typeof m.ref === 'string')
          .map((m) => {
            const out = { type: m.type, ref: m.ref };
            if (typeof m.under === 'string' && m.under) out.under = m.under;
            if (m.loose === true) out.loose = true;
            return out;
          }),
      }));
  } catch (_) {
    sessionGroups = [];
  }
}

function persistSessionGroups() {
  try {
    localStorage.setItem(SESSION_GROUPS_KEY, JSON.stringify({ version: 1, groups: sessionGroups }));
  } catch (_) {}
}

function sgGroupById(id) {
  return sessionGroups.find((g) => g.id === id) || null;
}

function sgGroupOf(type, ref) {
  return sessionGroups.find((g) => g.members.some((m) => m.type === type && m.ref === ref)) || null;
}

// An individually placed session wins over the placement of its project.
function sgGroupForSession(session) {
  return sgGroupOf('session', session.id) || (session.project ? sgGroupOf('project', session.project) : null);
}

function sgDetach(type, ref) {
  for (const g of sessionGroups) {
    g.members = g.members.filter((m) => !(m.type === type && m.ref === ref));
  }
}

// Where a session renders inside a group: the project block it was moved under, its own
// project's block, or - when the user lifted it out - the group's own loose list.
function sgHostOf(group, session) {
  if (!group || !session) return null;
  const m = group.members.find((x) => x.type === 'session' && x.ref === session.id);
  const isMemberProject = (path) => !!path && group.members.some((x) => x.type === 'project' && x.ref === path);
  if (m?.under && isMemberProject(m.under)) return m.under;
  if (!m?.loose && isMemberProject(session.project)) return session.project;
  return null;
}
// `opts.under` places the session under another project block of the group; `opts.loose` lifts it
// out of its project block onto the group's own level.
function sgAssign(groupId, type, ref, opts = {}) {
  const group = sgGroupById(groupId);
  if (!group) return;
  sgDetach(type, ref);
  // Pulling a whole project in supersedes the individual placements of its sessions.
  if (type === 'project') {
    for (const s of sessions) if (s.project === ref) sgDetach('session', s.id);
  }
  const own = type === 'session' ? sessions.find((s) => s.id === ref)?.project : null;
  // Under its own project block is simply the natural placement - no override needed.
  const under = opts.under && opts.under !== own ? opts.under : null;
  const loose = !under && !!opts.loose;
  const covered =
    type === 'session' && !under && !loose && group.members.some((m) => m.type === 'project' && m.ref === own);
  // The group already holds the session's project — a separate placement would only strand
  // the card at the bottom of the group, away from its project block.
  if (!covered) {
    const member = { type, ref };
    if (under) member.under = under;
    if (loose) member.loose = true;
    group.members.push(member);
  }
  if (collapsedProjectGroups.delete(sgKey(groupId))) persistCollapsedGroups();
  persistSessionGroups();
}

function sgCreateGroup(name) {
  const group = {
    id: `g_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: (name || '').trim() || `Group ${sessionGroups.length + 1}`,
    members: [],
  };
  sessionGroups.push(group);
  persistSessionGroups();
  return group;
}

function sgDeleteGroup(id) {
  sessionGroups = sessionGroups.filter((g) => g.id !== id);
  if (collapsedProjectGroups.delete(sgKey(id))) persistCollapsedGroups();
  persistSessionGroups();
}

// Move one member of a group in front of another — the user's own order inside the group.
function sgReorderMember(groupId, drag, target) {
  const group = sgGroupById(groupId);
  if (!group) return;
  const from = group.members.findIndex((m) => m.type === drag.kind && m.ref === drag.ref);
  const to = group.members.findIndex((m) => m.type === target.type && m.ref === target.ref);
  if (from < 0 || to < 0 || from === to) return;
  const [member] = group.members.splice(from, 1);
  group.members.splice(to, 0, member);
  persistSessionGroups();
}

function sgReorderGroup(dragId, targetId) {
  const from = sessionGroups.findIndex((g) => g.id === dragId);
  const to = sessionGroups.findIndex((g) => g.id === targetId);
  if (from < 0 || to < 0 || from === to) return;
  const [g] = sessionGroups.splice(from, 1);
  sessionGroups.splice(to, 0, g);
  persistSessionGroups();
}

// Typing a group name should surface the sessions inside it.
function sgSearchMatchIds(query) {
  const ids = new Set();
  if (!query) return ids;
  const hits = sessionGroups.filter((g) => fuzzyMatch(g.name, query));
  if (hits.length === 0) return ids;
  const hitIds = new Set(hits.map((g) => g.id));
  for (const s of sessions) {
    const group = sgGroupForSession(s);
    if (group && hitIds.has(group.id)) ids.add(s.id);
  }
  return ids;
}

function sgHeaderHtml(group, countHtml) {
  const collapsed = collapsedProjectGroups.has(sgKey(group.id));
  const editing = sgEditingId === group.id;
  const nameHtml = editing
    ? `<input class="sg-name-input" type="text" value="${escapeHtml(group.name)}" aria-label="Group name" spellcheck="false">`
    : `<span class="group-name">${escapeHtml(group.name)}</span>`;
  return `
        <div class="session-group-header${collapsed ? ' collapsed' : ''}" draggable="${editing ? 'false' : 'true'}" data-group-path="${escapeHtml(sgKey(group.id))}" data-group-id="${escapeHtml(group.id)}" title="${escapeHtml(group.name)} — drop sessions or projects here">
          ${groupChevronSvg()}
          ${nameHtml}
          ${countHtml}
          <span class="sg-action sg-rename" title="Rename group"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></span>
          <span class="sg-action sg-delete" title="Delete group (members return to Projects)">&times;</span>
        </div>`;
}

//#region SESSION_GROUPS_RENAME
// The name is edited in place. While the field is live, renderSessions() defers (an SSE
// refresh would otherwise replace the input mid-keystroke) — see the guard in renderSessions.
let sgEditingId = null;

function sgIsEditing() {
  return !!sgEditingId && !!sessionsList.querySelector('.sg-name-input');
}

function sgBeginRename(id) {
  sgEditingId = id;
  renderSessions();
  const input = sessionsList.querySelector('.sg-name-input');
  if (input) input.select();
  else sgEditingId = null;
}

function sgCommitRename(input, save) {
  const group = sgGroupById(sgEditingId);
  const value = input.value.trim();
  sgEditingId = null;
  if (save && group && value && value !== group.name) {
    group.name = value;
    persistSessionGroups();
  }
  renderSessions();
}
//#endregion

//#region SESSION_GROUPS_DND
// At most one zone is lit, so the reference is enough - dragover fires many times a second.
let sgLitZone = null;

function sgClearDropTargets() {
  sgLitZone?.classList.remove('sg-drop-over');
  sgLitZone = null;
}

function sgLightDropTarget(zone) {
  if (sgLitZone === zone) return;
  sgClearDropTargets();
  zone.classList.add('sg-drop-over');
  sgLitZone = zone;
}

function sgDragPayload(el) {
  if (el.classList.contains('session-group-header')) return { kind: 'group', ref: el.dataset.groupId };
  // data-project-path is on real project headers only, so the sentinels drop out by themselves.
  if (el.classList.contains('project-group-header')) {
    return el.dataset.projectPath ? { kind: 'project', ref: el.dataset.projectPath } : null;
  }
  if (el.classList.contains('session-item')) return { kind: 'session', ref: el.dataset.sessionId };
  return null;
}

// Resolve the element under the pointer to a legal drop zone for the in-flight drag.
// Returns {zone} to ungroup, {zone, groupId} to assign, or {zone, pairWith}/{zone, pairSession}
// to stack two ungrouped items into a brand-new group.
function sgDropZone(target) {
  if (!sgDrag) return null;
  const base =
    '.sg-ungroup-zone, .session-group-header, .session-group-sessions, .project-group-header, .project-group-sessions';
  // A dragged project pairs with the project block it lands in, not with the card under the
  // pointer; a dragged session can stack onto another session.
  const zone = target.closest(sgDrag.kind === 'session' ? `.session-item, ${base}` : base);
  if (!zone) return null;
  const dragGroup = sgGroupOf(sgDrag.kind, sgDrag.ref);
  if (sgDrag.kind === 'group') {
    // A group only reorders against another group header.
    return zone.classList.contains('session-group-header') && zone.dataset.groupId !== sgDrag.ref
      ? { zone, groupId: zone.dataset.groupId }
      : null;
  }
  if (zone.classList.contains('sg-ungroup-zone')) return dragGroup ? { zone } : null;
  const dragSession = sgDrag.kind === 'session' ? sessions.find((x) => x.id === sgDrag.ref) : null;
  const fromGroup = dragSession ? sgGroupForSession(dragSession) : dragGroup;
  const fromGroupId = fromGroup?.id || null;
  // A drop that lands on the host the session already has changes nothing, and highlighting it
  // promises a move that never happens.
  const fromHost = dragSession ? sgHostOf(fromGroup, dragSession) : null;
  const groupId = zone.dataset.groupId;
  if (groupId) {
    if (!dragSession) return dragGroup?.id === groupId ? null : { zone, groupId };
    if (fromGroupId !== groupId) return { zone, groupId };
    // Already in this group: its own level is a move only out of a project block.
    return fromHost ? { zone, groupId, loose: true } : null;
  }
  const targetSessionId = zone.dataset.sessionId;
  if (targetSessionId) {
    if (targetSessionId === sgDrag.ref) return null;
    const targetSession = sessions.find((s) => s.id === targetSessionId);
    const targetGroup = targetSession ? sgGroupForSession(targetSession) : null;
    const targetGroupId = targetGroup?.id || null;
    if (targetGroup) {
      // Stacking onto a card adopts that card's placement, project block included.
      const targetHost = sgHostOf(targetGroup, targetSession);
      if (targetHost) {
        return targetHost === fromHost && fromGroupId === targetGroupId
          ? null
          : { zone, groupId: targetGroupId, under: targetHost };
      }
      // Both loose in the same group: this is a reorder, and only a member has a slot.
      if (fromGroupId === targetGroupId && !fromHost) {
        return sgGroupOf('session', targetSessionId)?.id === targetGroupId
          ? { zone, groupId: targetGroupId, reorder: { type: 'session', ref: targetSessionId } }
          : null;
      }
      return { zone, groupId: targetGroupId, loose: true };
    }
    return { zone, pairSession: targetSessionId };
  }
  const path = zone.dataset.projectPath;
  if (!path || path === sgDrag.ref) return null;
  // Dropping onto a project that already sits in a group means "join that group".
  const pathGroup = sgGroupOf('project', path);
  if (pathGroup) {
    if (!dragSession) {
      return dragGroup?.id === pathGroup.id
        ? { zone, groupId: pathGroup.id, reorder: { type: 'project', ref: path } }
        : { zone, groupId: pathGroup.id };
    }
    return fromHost === path && fromGroupId === pathGroup.id ? null : { zone, groupId: pathGroup.id, under: path };
  }
  // Stacking a session onto its own project block would only fold it back where it sits today.
  if (dragSession?.project === path) return null;
  return { zone, pairWith: path };
}

function sgOnDragStart(e) {
  const el = e.target.closest('.session-group-header, .project-group-header, .session-item');
  if (!el || e.target.closest(SG_ACTION_SELECTOR)) {
    e.preventDefault();
    return;
  }
  const payload = sgDragPayload(el);
  if (!payload?.ref) {
    e.preventDefault();
    return;
  }
  sgDrag = payload;
  el.classList.add('sg-dragging');
  sessionsList.classList.add('sg-dragging-active');
  e.dataTransfer.effectAllowed = 'move';
  try {
    e.dataTransfer.setData('text/plain', JSON.stringify(payload));
  } catch (_) {}
}

function sgOnDragOver(e) {
  const hit = sgDropZone(e.target);
  // Moving onto a spot that refuses the drop has to put the previous highlight out, or two zones
  // stay lit and the one under the pointer is not the one that would receive the drop.
  if (!hit) {
    sgClearDropTargets();
    return;
  }
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  sgLightDropTarget(hit.zone);
}

function sgOnDrop(e) {
  const hit = sgDropZone(e.target);
  if (!hit) return;
  e.preventDefault();
  e.stopPropagation();
  const drag = sgDrag;
  if (hit.pairWith || hit.pairSession) {
    // Stacked onto an ungrouped item: seed a group, then let the user name it in place.
    const target = hit.pairWith
      ? { type: 'project', ref: hit.pairWith, path: hit.pairWith }
      : { type: 'session', ref: hit.pairSession, path: sessions.find((s) => s.id === hit.pairSession)?.project };
    const group = sgCreateGroup(target.path ? target.path.split(/[/\\]/).pop() : '');
    sgAssign(group.id, target.type, target.ref);
    sgAssign(group.id, drag.kind, drag.ref);
    sgFinishDrag();
    sgBeginRename(group.id);
    return;
  }
  if (hit.groupId) {
    if (hit.reorder) sgReorderMember(hit.groupId, drag, hit.reorder);
    else if (drag.kind === 'group') sgReorderGroup(drag.ref, hit.groupId);
    else sgAssign(hit.groupId, drag.kind, drag.ref, { under: hit.under, loose: hit.loose });
  } else {
    sgDetach(drag.kind, drag.ref);
    persistSessionGroups();
  }
  sgFinishDrag();
}

function sgFinishDrag() {
  sgDrag = null;
  sgClearDropTargets();
  sessionsList.classList.remove('sg-dragging-active');
  // biome-ignore lint/suspicious/useIterableCallbackReturn: forEach side-effect
  document.querySelectorAll('.sg-dragging').forEach((el) => el.classList.remove('sg-dragging'));
  renderSessions();
}

function sgOnDragEnd() {
  if (!sgDrag) {
    sgClearDropTargets();
    sessionsList.classList.remove('sg-dragging-active');
    return;
  }
  sgFinishDrag();
}

function initSessionGroupsDnd() {
  sessionsList.addEventListener('dragstart', sgOnDragStart);
  sessionsList.addEventListener('dragover', sgOnDragOver);
  sessionsList.addEventListener('dragleave', (e) => {
    const zone = e.target.closest?.('.sg-drop-over');
    if (zone && !zone.contains(e.relatedTarget)) sgClearDropTargets();
  });
  sessionsList.addEventListener('drop', sgOnDrop);
  sessionsList.addEventListener('dragend', sgOnDragEnd);
  sessionsList.addEventListener('contextmenu', sgOnContextMenu);
  sessionsList.addEventListener('keydown', (e) => {
    const input = e.target.closest?.('.sg-name-input');
    if (!input) return;
    // Keep the sidebar's own single-key shortcuts out of the field.
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      sgCommitRename(input, true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      sgCommitRename(input, false);
    }
  });
  sessionsList.addEventListener('focusout', (e) => {
    const input = e.target.closest?.('.sg-name-input');
    if (input && sgEditingId) sgCommitRename(input, true);
  });
  // HTML5 drag-and-drop never fires on touch, and cck ships as a PWA.
  sessionsList.addEventListener('touchstart', sgOnTouchStart, { passive: true });
  sessionsList.addEventListener('touchend', sgCancelLongPress);
  sessionsList.addEventListener('touchmove', sgCancelLongPress, { passive: true });
  window.addEventListener('storage', (e) => {
    if (e.key !== SESSION_GROUPS_KEY) return;
    loadSessionGroups();
    renderSessions();
  });
}
//#endregion

//#region SESSION_GROUPS_MENU
// Non-drag path: right-click or long-press a session / project header.
let sgLongPressTimer = null;

function sgCloseMenu() {
  const menu = document.getElementById('sg-menu');
  if (menu) menu.remove();
}

function sgOpenMenu(x, y, kind, ref) {
  sgCloseMenu();
  const current = sgGroupOf(kind, ref);
  const label = kind === 'project' ? 'project' : 'session';
  const rows = sessionGroups
    .filter((g) => g.id !== current?.id)
    .map((g) => `<button class="sg-menu-item" data-sg-move="${escapeHtml(g.id)}">${escapeHtml(g.name)}</button>`)
    .join('');
  const menu = document.createElement('div');
  menu.id = 'sg-menu';
  menu.className = 'sg-menu';
  menu.dataset.sgKind = kind;
  menu.dataset.sgRef = ref;
  menu.innerHTML = `
        <div class="sg-menu-label">Move ${label} to group</div>
        ${rows}
        <button class="sg-menu-item" data-sg-move="__new__">+ New group…</button>
        ${current ? `<button class="sg-menu-item sg-menu-remove" data-sg-move="__none__">Remove from “${escapeHtml(current.name)}”</button>` : ''}`;
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;
}

function sgOnContextMenu(e) {
  const el = e.target.closest('.session-item, .project-group-header');
  if (!el) return;
  const payload = sgDragPayload(el);
  if (!payload?.ref) return;
  e.preventDefault();
  sgOpenMenu(e.clientX, e.clientY, payload.kind, payload.ref);
}

function sgCancelLongPress() {
  if (sgLongPressTimer) clearTimeout(sgLongPressTimer);
  sgLongPressTimer = null;
}

function sgOnTouchStart(e) {
  const el = e.target.closest('.session-item, .project-group-header');
  if (!el || e.target.closest(SG_ACTION_SELECTOR)) return;
  const payload = sgDragPayload(el);
  if (!payload?.ref) return;
  const touch = e.touches[0];
  sgCancelLongPress();
  sgLongPressTimer = setTimeout(() => {
    sgLongPressTimer = null;
    sgOpenMenu(touch.clientX, touch.clientY, payload.kind, payload.ref);
  }, 550);
}

document.addEventListener('click', (e) => {
  const item = e.target.closest('.sg-menu-item');
  if (!item) {
    if (!e.target.closest('.sg-menu')) sgCloseMenu();
    return;
  }
  e.stopPropagation();
  const menu = item.closest('.sg-menu');
  const { sgKind, sgRef } = menu.dataset;
  const move = item.dataset.sgMove;
  sgCloseMenu();
  if (move === '__none__') {
    sgDetach(sgKind, sgRef);
    persistSessionGroups();
  } else if (move === '__new__') {
    // Name it in place rather than through a modal prompt.
    const group = sgCreateGroup(sgKind === 'project' ? sgRef.split(/[/\\]/).pop() : '');
    sgAssign(group.id, sgKind, sgRef);
    sgBeginRename(group.id);
    return;
  } else {
    sgAssign(move, sgKind, sgRef);
  }
  renderSessions();
});
//#endregion
//#endregion

//#region KEYBOARD_NAV
function selectTask(taskId, sessionId) {
  clearTaskSelection();
  selectedTaskId = taskId;
  selectedSessionId = sessionId;
  taskHighlightDimmed = false;
  if (!taskId) return;
  const card =
    document.querySelector(`.task-card[data-task-id="${escSel(taskId)}"][data-session-id="${escSel(sessionId)}"]`) ||
    document.querySelector(`.task-card[data-task-id="${escSel(taskId)}"]`);
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
      if (
        cards[i].dataset.taskId === selectedTaskId &&
        (!selectedSessionId || cards[i].dataset.sessionId === selectedSessionId)
      ) {
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

// Every collapsible header class and the body class it opens. Order matters only in that a
// header carries exactly one of these.
const COLLAPSIBLE_BODY_CLASS = {
  'pinned-sub-header': 'pinned-sub-items',
  'session-group-header': 'session-group-sessions',
  'sg-section-toggle': 'sg-section-body',
  'project-group-header': 'project-group-sessions',
};
const COLLAPSIBLE_HEADER_SELECTOR = Object.keys(COLLAPSIBLE_BODY_CLASS)
  .map((c) => `.${c}`)
  .join(', ');

function getGroupSessionsContainer(header) {
  const cls = Object.keys(COLLAPSIBLE_BODY_CLASS).find((c) => header.classList.contains(c));
  if (!cls) return null;
  let el = header.nextElementSibling;
  const bodyCls = COLLAPSIBLE_BODY_CLASS[cls];
  while (el && !el.classList.contains(bodyCls)) el = el.nextElementSibling;
  return el;
}

function getNavigableItems() {
  const items = [];
  // A named group nests project blocks inside its body, so the walk has to recurse.
  const walkGroupContainer = (container) => {
    if (!container) return;
    for (const child of container.children) {
      if (child.classList.contains('pinned-sub-section')) {
        const subHeader = child.querySelector('.pinned-sub-header');
        if (subHeader) items.push(subHeader);
        const subItems = child.querySelector('.pinned-sub-items');
        if (subItems && !subItems.classList.contains('collapsed')) {
          for (const s of subItems.querySelectorAll(':scope > .session-item')) items.push(s);
        }
      } else if (child.classList.contains('session-item')) {
        items.push(child);
      } else if (child.classList.contains('project-group-header')) {
        items.push(child);
        if (!collapsedProjectGroups.has(child.dataset.groupPath)) {
          walkGroupContainer(getGroupSessionsContainer(child));
        }
      }
    }
  };
  // A section label sits next to its body div rather than wrapping it, so the top level walks
  // into the body to reach the blocks inside.
  const walkTopLevel = (children) => {
    for (const el of children) {
      if (
        el.classList.contains('project-group-header') ||
        el.classList.contains('session-group-header') ||
        el.classList.contains('sg-section-toggle')
      ) {
        items.push(el);
        if (!el.classList.contains('sg-section-toggle') && !collapsedProjectGroups.has(el.dataset.groupPath)) {
          walkGroupContainer(getGroupSessionsContainer(el));
        }
      } else if (el.classList.contains('session-item')) {
        items.push(el);
      } else if (el.classList.contains('sg-section-body') && !el.classList.contains('collapsed')) {
        walkTopLevel(el.children);
      }
    }
  };
  walkTopLevel(sessionsList.children);
  return items;
}

function getSessionItems() {
  return Array.from(sessionsList.querySelectorAll('.session-item'));
}

function clearKbSelection() {
  const prev = sessionsList.querySelector('.kb-selected');
  if (prev) prev.classList.remove('kb-selected');
}

function clearTaskSelection() {
  const prev = document.querySelector('.task-card.selected');
  if (prev) prev.classList.remove('selected');
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
  if (!currentEl?.isConnected) {
    const restoredIdx = selectedSessionKbId ? items.findIndex((el) => getKbId(el) === selectedSessionKbId) : -1;
    newIdx = restoredIdx >= 0 ? restoredIdx : 0;
  }
  if (newIdx < 0) newIdx = items.length - 1;
  else if (newIdx >= items.length) newIdx = 0;
  selectSessionByIndex(newIdx, items);
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
  persistCollapsedGroups();
}

function persistCollapsedGroups() {
  try {
    localStorage.setItem('collapsedGroups', JSON.stringify([...collapsedProjectGroups]));
  } catch (_) {}
}

let prevActiveSessionIds = null; // null until primed by the first onlyNew pass

// Expand collapsed project sections that contain active sessions; leave the rest collapsed.
// onlyNew: expand only for sessions that became active since the last call, so a section the
// user manually collapsed stays collapsed until NEW active work lands in it (live refresh path).
// The first onlyNew pass only primes the tracking set — it respects saved collapse state on load.
// onlyNew=false force-expands every section with active work (explicit chip click).
function expandActiveGroups({ onlyNew = false } = {}) {
  const primed = prevActiveSessionIds !== null;
  const activeIds = new Set();
  let changed = false;
  for (const s of sessions) {
    if (!isSessionActive(s)) continue;
    activeIds.add(s.id);
    if (onlyNew && (!primed || prevActiveSessionIds.has(s.id))) continue;
    if (collapsedProjectGroups.delete(s.project || '__ungrouped__')) changed = true;
    // A named group wrapping that project (or the session itself) would keep it hidden.
    const group = sgGroupForSession(s);
    if (group && collapsedProjectGroups.delete(sgKey(group.id))) changed = true;
    // Which section holds it depends on the view, so open every one rather than re-deriving it.
    for (const key of [SECTION_GROUPS, SECTION_PROJECTS, SECTION_SESSIONS]) {
      if (collapsedProjectGroups.delete(key)) changed = true;
    }
  }
  prevActiveSessionIds = activeIds;
  if (changed) persistCollapsedGroups();
  // renderSessions() re-renders headers/containers from the updated set
}

function isGroupHeader(el) {
  return el.matches(COLLAPSIBLE_HEADER_SELECTOR);
}

function findParentHeader(el) {
  const subContainer = el.closest('.pinned-sub-items');
  if (subContainer?.previousElementSibling?.classList.contains('pinned-sub-header')) {
    return subContainer.previousElementSibling;
  }
  const container = el.closest('.project-group-sessions, .session-group-sessions');
  if (!container) return null;
  let header = container.previousElementSibling;
  while (header && !isGroupHeader(header)) header = header.previousElementSibling;
  return header;
}

function handleSidebarHorizontal(direction) {
  const items = getNavigableItems();
  if (selectedSessionIdx < 0 || selectedSessionIdx >= items.length) return;
  const el = items[selectedSessionIdx];
  const collapse = direction < 0;

  if (isGroupHeader(el)) {
    const isCollapsed = collapsedProjectGroups.has(el.dataset.groupPath);
    if (collapse) {
      if (!isCollapsed) setGroupCollapsed(el, true);
      else {
        // Already closed — step out to the named group that holds this block, if any.
        const parent = findParentHeader(el);
        const parentIdx = parent ? items.indexOf(parent) : -1;
        if (parentIdx >= 0) selectSessionByIndex(parentIdx, items);
      }
    } else if (isCollapsed) {
      setGroupCollapsed(el, false);
    } else {
      navigateSession(1);
    }
    return;
  }

  if (!collapse) {
    activateSelectedSession(items);
    return;
  }

  const header = findParentHeader(el);
  if (!header) return;
  const headerIdx = items.indexOf(header);
  if (headerIdx >= 0) selectSessionByIndex(headerIdx, items);
}

function activateSelectedSession(items) {
  items = items || getNavigableItems();
  if (selectedSessionIdx < 0 || selectedSessionIdx >= items.length) return;
  const el = items[selectedSessionIdx];
  if (isGroupHeader(el)) {
    setGroupCollapsed(el, !collapsedProjectGroups.has(el.dataset.groupPath));
  } else {
    el.click();
  }
}

function setFocusZone(zone) {
  const sidebar = document.querySelector('.sidebar');
  clearKbSelection();
  clearTaskSelection();

  focusZone = zone;
  if (zone === 'sidebar') {
    if (sidebar.classList.contains('collapsed')) {
      sidebar.classList.remove('collapsed');
      localStorage.setItem('sidebar-collapsed', false);
    }
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
    // Focusing the board is an explicit nav gesture — restore the highlight.
    taskHighlightDimmed = false;
    // Session changed while in sidebar — reset stale selection
    if (selectedSessionId && selectedSessionId !== currentSessionId) {
      selectedTaskId = null;
      selectedSessionId = null;
    }
    if (selectedTaskId) {
      const card = document.querySelector(
        `.task-card[data-task-id="${escSel(selectedTaskId)}"][data-session-id="${escSel(selectedSessionId)}"]`,
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
      options += `<option value="${escapeHtml(t.id)}">#${t.id} - ${escapeHtml(t.subject)}</option>`;
    });
    options += '</optgroup>';
  }

  if (inProgress.length > 0) {
    options += '<optgroup label="In Progress">';
    inProgress.forEach((t, _idx) => {
      options += `<option value="${escapeHtml(t.id)}">#${t.id} - ${escapeHtml(t.subject)}</option>`;
    });
    options += '</optgroup>';
  }

  if (completed.length > 0) {
    options += '<optgroup label="Completed">';
    completed.forEach((t, _idx) => {
      options += `<option value="${escapeHtml(t.id)}">#${t.id} - ${escapeHtml(t.subject)}</option>`;
    });
    options += '</optgroup>';
  }

  return options;
}

//#endregion

//#region TASK_DETAIL
async function showTaskDetail(taskId, sessionId = null) {
  let task = currentTasks.find(
    (t) => t.id === taskId && (!sessionId || t.sessionId === sessionId || t._taskDir === sessionId),
  );

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
      `;

  // Setup button handlers (read-only in project view)
  const deleteBtn = document.getElementById('delete-task-btn');
  const isProjectView = viewMode === 'project';
  deleteBtn.style.display = isProjectView ? 'none' : '';
  if (!isProjectView) deleteBtn.onclick = () => deleteTask(task.id, actualSessionId);

  if (!isProjectView) {
    const titleEl = detailContent.querySelector('.detail-title');
    if (titleEl) {
      titleEl.onclick = () => editTitle(titleEl, task, actualSessionId);
    }

    const descEl = detailContent.querySelector('.detail-desc');
    if (descEl) {
      descEl.onclick = () => editDescription(descEl, task, actualSessionId);
    }
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

function closeDetailPanel() {
  detailPanel.classList.remove('visible');
  document.getElementById('delete-task-btn').style.display = 'none';
  // Keep the task selected AND highlighted after closing (no dim-off).
  taskHighlightDimmed = false;
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
// Each entry pairs a left and a right group onto the same grid rows, so their
// headings sit level and the shorter group just leaves empty rows.
// `combo` joins the keys with a plus (a chord) instead of listing them as
// alternatives; `hub` marks rows that only work inside Claude Code Hub.
const SHORTCUT_PAIRS = [
  [
    {
      title: 'Navigate',
      rows: [
        { keys: ['J', '↓'], label: 'Next item' },
        { keys: ['K', '↑'], label: 'Previous item' },
        { keys: ['H', '←'], label: 'Left column / collapse group' },
        { keys: ['L', '→'], label: 'Right column / expand group' },
        { keys: ['Tab'], label: 'Switch sidebar ↔ board' },
        { keys: ['Enter', 'Space'], label: 'Open selected item' },
      ],
    },
    {
      title: 'Session',
      rows: [
        { keys: ['P'], label: 'Open plan' },
        { keys: ['Shift', 'P'], combo: true, label: 'Session picker' },
        { keys: ['I'], label: 'Session info' },
        { keys: ['.'], label: 'Pin / unpin' },
        { keys: ['>'], label: 'Toggle sticky' },
        { keys: ['Ctrl', 'D'], combo: true, label: 'Dismiss session' },
        { keys: ['Shift', 'L'], combo: true, label: 'Toggle session log' },
        { keys: ['Shift', 'M'], combo: true, label: 'Open last message' },
        { keys: ['J', 'K'], label: 'Previous / next message in detail' },
      ],
    },
  ],
  [
    {
      title: 'Board',
      rows: [
        { keys: ['Enter'], label: 'Toggle task detail panel' },
        { keys: ['D'], label: 'Delete selected task' },
        { keys: ['N'], label: 'Toggle scratchpad' },
        { keys: ['R'], label: 'Refresh data' },
        { keys: ['Esc'], label: 'Close panel / clear selection' },
      ],
    },
    {
      title: 'View',
      rows: [
        { keys: ['['], label: 'Toggle sidebar' },
        { keys: ['T'], label: 'Toggle theme' },
        { keys: ['Shift', 'S'], combo: true, label: 'Storage manager' },
        { keys: ['Ctrl', '+'], combo: true, label: 'Larger modal text' },
        { keys: ['Ctrl', '−'], combo: true, label: 'Smaller modal text' },
        { keys: ['Ctrl', '0'], combo: true, label: 'Reset modal text size' },
        { keys: ['?'], label: 'Show this help' },
      ],
    },
  ],
  [
    {
      title: 'Copy',
      rows: [
        { keys: ['Shift', 'C'], combo: true, label: 'Session id' },
        { keys: ['Ctrl', 'Shift', 'C'], combo: true, label: 'Resume command (claude -r <id>)' },
      ],
    },
    {
      title: 'Hub',
      hub: true,
      rows: [
        { keys: ['M'], label: 'Jump to marketplace' },
        { keys: ['$'], label: 'Jump to cost' },
        { keys: ['Ctrl', 'M'], combo: true, label: 'Jump to memory' },
        { keys: ['Ctrl', 'Alt', '←/→'], combo: true, label: 'Previous / next hub app' },
        { keys: ['Alt', '1…9'], combo: true, label: 'Jump to hub app by number' },
        { keys: ['Ctrl', 'Alt', 'P'], combo: true, label: 'Project picker' },
      ],
    },
  ],
];

const EMPTY_GROUP = { title: '', rows: [] };

// Interleaves each pair's rows left-then-right so CSS grid auto-placement lands
// them on shared row tracks (see .shortcuts in style.css).
function buildHelpShortcuts() {
  const cells = [];
  SHORTCUT_PAIRS.forEach(([left, right = EMPTY_GROUP], pair) => {
    const first = pair === 0 ? ' sc-first' : '';
    const sides = [
      [left, 'sc-l'],
      [right, 'sc-r'],
    ];
    const head = (g, side) =>
      g.title ? `<div class="${escapeHtml(`sc-group ${side}${first}${g.hub ? ' sc-hub' : ''}`)}">${g.title}</div>` : '';
    cells.push(sides.map(([g, side]) => head(g, side)).join(''));
    for (let i = 0; i < Math.max(left.rows.length, right.rows.length); i++) {
      for (const [group, side] of sides) {
        const row = group.rows[i];
        if (!row) continue;
        const sep = row.combo ? '<span class="sc-plus">+</span>' : '<span class="sc-or">/</span>';
        const keys = row.keys.map((k) => `<kbd>${escapeHtml(k)}</kbd>`).join(sep);
        const cls = side + (group.hub ? ' sc-hub' : '');
        cells.push(
          `<dt class="${escapeHtml(cls)}">${keys}</dt><dd class="${escapeHtml(cls)}">${escapeHtml(row.label)}</dd>`,
        );
      }
    }
  });
  return cells.join('');
}

function showHelpModal() {
  const modal = document.getElementById('help-modal');
  const list = document.getElementById('help-shortcuts');
  if (!list.childElementCount) list.innerHTML = buildHelpShortcuts();
  list.classList.toggle('sc-standalone', !window.__HUB__?.enabled);
  modal.classList.add('visible');
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
  } else {
    await fetchSessions();
  }
}

document.getElementById('close-detail').onclick = closeDetailPanel;

//#endregion

//#region SCRATCHPAD
let _scratchpadSaveTimer = null;
const _scratchpadModal = document.getElementById('scratchpad-modal');
const _scratchpadTextarea = document.getElementById('scratchpad-textarea');
const _scratchpadCharcount = document.getElementById('scratchpad-charcount');

let _scratchpadKeyOverride = null;

function _sessionScratchpadKey(sessionId) {
  return `scratchpad-${sessionId}`;
}

function _isSessionScratchpadKey(key) {
  return key.startsWith('scratchpad-') && !key.startsWith('scratchpad-project:');
}

function _scratchpadKey() {
  if (_scratchpadKeyOverride) return _scratchpadKeyOverride;
  if (currentSessionId) return _sessionScratchpadKey(currentSessionId);
  if (currentProjectPath) return `scratchpad-project:${currentProjectPath}`;
  return null;
}

function toggleScratchpad() {
  if (_scratchpadModal.classList.contains('visible')) {
    closeScratchpad();
  } else {
    showScratchpad();
  }
}

// biome-ignore lint/correctness/noUnusedVariables: used in HTML onclick
function openSessionScratchpad(sessionId) {
  showScratchpad(_sessionScratchpadKey(sessionId));
}

function showScratchpad(keyOverride) {
  _scratchpadKeyOverride = keyOverride || null;
  const key = _scratchpadKey();
  if (!key) return;
  _scratchpadTextarea.value = localStorage.getItem(key) || '';
  _scratchpadCharcount.textContent = `${_scratchpadTextarea.value.length} chars`;
  _scratchpadModal.classList.add('visible');
  _scratchpadTextarea.focus();
}

function closeScratchpad() {
  if (_scratchpadSaveTimer) {
    clearTimeout(_scratchpadSaveTimer);
    _scratchpadSaveTimer = null;
  }
  saveScratchpad();
  _scratchpadKeyOverride = null;
  _scratchpadModal.classList.remove('visible');
}

function saveScratchpad() {
  const key = _scratchpadKey();
  if (!key) return;
  const val = _scratchpadTextarea.value;
  const had = !!(localStorage.getItem(key) || '').trim();
  const has = !!val.trim();
  if (has) {
    localStorage.setItem(key, val);
  } else {
    localStorage.removeItem(key);
  }
  if (had !== has && _isSessionScratchpadKey(key)) {
    renderSessions();
  }
}

_scratchpadTextarea.addEventListener('input', () => {
  _scratchpadCharcount.textContent = `${_scratchpadTextarea.value.length} chars`;
  if (_scratchpadSaveTimer) clearTimeout(_scratchpadSaveTimer);
  _scratchpadSaveTimer = setTimeout(() => {
    saveScratchpad();
    _scratchpadSaveTimer = null;
  }, 500);
});

//#endregion

//#region STORAGE_MANAGER

function _getStorageTotalSize() {
  let bytes = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    bytes += k.length + localStorage.getItem(k).length;
  }
  return bytes * 2; // UTF-16
}

function _updateStorageTotal() {
  const el = document.getElementById('storage-total');
  if (el) el.textContent = `${(_getStorageTotalSize() / 1024).toFixed(1)} KB`;
}

function _getKnownSessionIds() {
  return new Set(sessions.map((s) => s.id));
}

function _sessionLabel(session, id) {
  return session ? escapeHtml(session.name || session.slug || id.slice(0, 12)) : escapeHtml(id.slice(0, 12));
}

function _groupByProject(sessionIds) {
  const sessionMap = new Map(sessions.map((s) => [s.id, s]));
  const groups = new Map();
  const orphans = [];
  for (const id of sessionIds) {
    const session = sessionMap.get(id);
    if (!session) {
      orphans.push({ id, session: null });
      continue;
    }
    const project = session.project || '(no project)';
    if (!groups.has(project)) groups.set(project, []);
    groups.get(project).push({ id, session });
  }
  return { groups, orphans };
}

function _projectLabel(project) {
  if (project === '(no project)') return '(no project)';
  return project.split(/[/\\]/).pop() || project;
}

function _renderProjectGroup(label, meta, innerHtml) {
  return `<div class="storage-project-group">
    <div class="storage-project-header">
      <span>${label}</span>
      <span class="storage-item-meta">${meta}</span>
    </div>
    <div class="storage-session-group">${innerHtml}</div>
  </div>`;
}

function _renderOrphanGroup(count, innerHtml) {
  return _renderProjectGroup('Orphaned', `<span class="storage-item-badge orphan">${count}</span>`, innerHtml);
}

function showStorageManager() {
  _updateStorageTotal();
  _updateOrphanedCount();
  document.querySelectorAll('.storage-tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === 'sessions');
  });
  document.getElementById('storage-modal').classList.add('visible');
  _renderStorageTab();
}

function closeStorageManager() {
  document.getElementById('storage-modal').classList.remove('visible');
}

// biome-ignore lint/correctness/noUnusedVariables: used in HTML
function switchStorageTab(tab) {
  document.querySelectorAll('.storage-tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === tab);
  });
  _renderStorageTab();
}

function _renderStorageTab() {
  const modal = document.getElementById('storage-modal');
  if (!modal?.classList.contains('visible')) return;
  const body = document.getElementById('storage-modal-body');
  const tab = document.querySelector('.storage-tab.active')?.dataset.tab || 'sessions';
  if (tab === 'sessions') body.innerHTML = _renderStorageSessions();
  else if (tab === 'scratchpads') body.innerHTML = _renderStorageScratchpads();
  else if (tab === 'linked-docs') body.innerHTML = _renderStorageLinkedDocs();
}

function _renderStorageSessions() {
  const pinnedIds = [...new Set([...pinnedSessionIds, ...stickySessionIds])];

  const msgMap = new Map();
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key.startsWith('pinned-messages-')) continue;
    const sid = key.slice('pinned-messages-'.length);
    try {
      const pins = JSON.parse(localStorage.getItem(key)) || [];
      if (pins.length) msgMap.set(sid, { pins, key });
    } catch {}
  }

  const allIds = [...new Set([...pinnedIds, ...msgMap.keys()])];
  if (!allIds.length) return '<div class="storage-empty">No pinned sessions or messages</div>';
  const { groups, orphans } = _groupByProject(allIds);

  function renderMessageItems(id) {
    const g = msgMap.get(id);
    if (!g) return '';
    const eid = escAttrJs(id);
    const header = `<div class="storage-group-header" style="padding-left:12px;">
      <span>${g.pins.length} pinned message${g.pins.length > 1 ? 's' : ''}</span>
      <div class="storage-item-actions">
        <button class="danger" onclick="_storageClearSessionPins('${eid}')">Clear All</button>
      </div>
    </div>`;
    const items = g.pins
      .map((p) => {
        const type = escapeHtml(p.type || '?');
        const text = escapeHtml((p.text || p.tool || p.agentType || '').slice(0, 60));
        const pinId = escAttrJs(p.id || '');
        const sid = escAttrJs(id);
        return `<div class="storage-item storage-item-clickable" style="padding-left:24px;" onclick="_storagePreviewPin('${sid}','${pinId}')">
        <span class="storage-item-badge">${type}</span>
        <span class="storage-item-id">${text}</span>
        <span class="storage-item-meta">${formatDate(p.timestamp)}</span>
        <div class="storage-item-actions">
          <button onclick="event.stopPropagation();_storagePreviewPin('${sid}','${pinId}')">View</button>
          <button class="danger" onclick="event.stopPropagation();_storageUnpinMessage('${sid}','${pinId}')">Unpin</button>
        </div>
      </div>`;
      })
      .join('');
    return header + items;
  }

  function renderSessionItem({ id, session }) {
    const isPinned = isAnyPinned(id);
    const eid = escAttrJs(id);
    const actions = isPinned
      ? `<button onclick="_storageViewSession('${eid}')">View</button>
         <button class="danger" onclick="_storageUnpinSession('${eid}')">Unpin</button>`
      : `<button onclick="_storageViewSession('${eid}')">View</button>`;
    return `<div class="storage-group-header">
      <span>${_sessionLabel(session, id)}</span>
      <div class="storage-item-actions">${actions}</div>
    </div>${renderMessageItems(id)}`;
  }

  let html = '';
  for (const [project, items] of groups) {
    const count = items.length;
    html += _renderProjectGroup(
      escapeHtml(_projectLabel(project)),
      `${count} session${count > 1 ? 's' : ''}`,
      items.map(renderSessionItem).join(''),
    );
  }
  if (orphans.length) {
    html += _renderOrphanGroup(orphans.length, orphans.map(renderSessionItem).join(''));
  }
  return html;
}

async function _storageViewSession(id) {
  closeStorageManager();
  revealedStorageSessionId = id;
  await revealSession(id);
}

function _storageUnpinSession(id) {
  pinnedSessionIds.delete(id);
  stickySessionIds.delete(id);
  savePinnedSessions();
  renderSessions();
  _renderStorageTab();
  _updateStorageTotal();
}

function _storageClearSessionPins(sessionId) {
  localStorage.removeItem(`pinned-messages-${sessionId}`);
  if (currentSessionId === sessionId) {
    currentPins = [];
    const el = document.getElementById('message-panel-pinned');
    if (el) el.innerHTML = '';
  }
  _renderStorageTab();
  _updateStorageTotal();
}

function _storageUnpinMessage(sessionId, pinId) {
  const key = `pinned-messages-${sessionId}`;
  try {
    const pins = JSON.parse(localStorage.getItem(key)) || [];
    const idx = pins.findIndex((p) => p.id === pinId);
    if (idx < 0) return;
    pins.splice(idx, 1);
    if (pins.length) localStorage.setItem(key, JSON.stringify(pins));
    else localStorage.removeItem(key);
    if (currentSessionId === sessionId) {
      currentPins = pins;
      const el = document.getElementById('message-panel-pinned');
      if (el) el.innerHTML = renderPinnedSection();
    }
  } catch {}
  _renderStorageTab();
  _updateStorageTotal();
}

function _renderStorageScratchpads() {
  const allItems = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key.startsWith('scratchpad-')) continue;
    const val = localStorage.getItem(key) || '';
    const isProject = key.startsWith('scratchpad-project:');
    const id = isProject ? key.slice('scratchpad-project:'.length) : key.slice('scratchpad-'.length);
    allItems.push({ key, id, isProject, chars: val.length });
  }
  if (!allItems.length) return '<div class="storage-empty">No scratchpads</div>';

  const projectItems = allItems.filter((i) => i.isProject);
  const sessionItems = allItems.filter((i) => !i.isProject);
  const sessionIds = sessionItems.map((i) => i.id);
  const { groups: projectGroups, orphans } = _groupByProject(sessionIds);
  const scratchBySession = new Map(sessionItems.map((i) => [i.id, i]));

  function renderScratchItem(item) {
    const session = !item.isProject ? sessions.find((s) => s.id === item.id) : null;
    const typeBadge = item.isProject
      ? '<span class="storage-item-badge">project</span>'
      : '<span class="storage-item-badge">session</span>';
    const jsKey = escAttrJs(item.key);
    const label = item.isProject ? escapeHtml(_projectLabel(item.id)) : _sessionLabel(session, item.id);
    return `<div class="storage-item">
      <span class="storage-item-id" title="${escapeHtml(item.id)}">${label}</span>
      ${typeBadge}
      <span class="storage-item-meta">${item.chars} chars</span>
      <div class="storage-item-actions">
        <button onclick="_storagePreviewScratchpad('${jsKey}')">View</button>
        <button class="danger" onclick="_storageDeleteScratchpad('${jsKey}')">Delete</button>
      </div>
    </div>`;
  }

  let html = '';

  if (projectItems.length) {
    html += _renderProjectGroup(
      'Project Scratchpads',
      `${projectItems.length}`,
      projectItems.map(renderScratchItem).join(''),
    );
  }

  for (const [project, items] of projectGroups) {
    const matching = items.map((i) => scratchBySession.get(i.id)).filter(Boolean);
    if (!matching.length) continue;
    html += _renderProjectGroup(
      escapeHtml(_projectLabel(project)),
      `${matching.length} scratchpad${matching.length > 1 ? 's' : ''}`,
      matching.map(renderScratchItem).join(''),
    );
  }

  if (orphans.length) {
    const orphanItems = orphans.map((i) => scratchBySession.get(i.id)).filter(Boolean);
    if (orphanItems.length) {
      html += _renderOrphanGroup(orphanItems.length, orphanItems.map(renderScratchItem).join(''));
    }
  }
  return html;
}

function _storagePreviewScratchpad(key) {
  closeStorageManager();
  showScratchpad(key);
}

function _storagePreviewPin(sessionId, pinId) {
  closeStorageManager();
  const key = `pinned-messages-${sessionId}`;
  try {
    const pins = JSON.parse(localStorage.getItem(key)) || [];
    const pin = pins.find((p) => p.id === pinId);
    if (!pin) return;
    document.getElementById('msg-detail-pin-btn').style.display = 'none';
    currentMsgDetailIdx = null;
    currentPinDetailId = null;
    _renderPinToDetail(pin);
    document.getElementById('msg-detail-modal').classList.add('visible');
  } catch (e) {
    console.error('_storagePreviewPin error:', e);
  }
}

function _storageDeleteScratchpad(key) {
  localStorage.removeItem(key);
  _renderStorageTab();
  _updateStorageTotal();
}

function _renderStorageLinkedDocs() {
  const entries = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key.startsWith(PREVIEW_STORAGE_PREFIX)) continue;
    try {
      const arr = JSON.parse(localStorage.getItem(key)) || [];
      if (Array.isArray(arr) && arr.length) {
        entries.push({ sessionId: key.slice(PREVIEW_STORAGE_PREFIX.length), paths: arr });
      }
    } catch {}
  }
  if (!entries.length) return '<div class="storage-empty">No linked documents</div>';

  const byId = new Map(entries.map((e) => [e.sessionId, e]));
  const { groups, orphans } = _groupByProject(entries.map((e) => e.sessionId));

  function renderDocRow(sessionId, p) {
    const name = linkedDocLabel(p);
    const sid = escAttrJs(sessionId);
    const jsPath = escAttrJs(p);
    return `<div class="storage-item" style="padding-left:24px;">
      <span class="storage-item-id" title="${escapeHtml(p)}">${escapeHtml(name)}</span>
      <div class="storage-item-actions">
        <button onclick="_storagePreviewLinkedDoc('${jsPath}')">View</button>
        <button onclick="copyWithFeedback('${jsPath}', this)" title="Copy path" aria-label="Copy path">${ICON_COPY}</button>
        <button class="danger" onclick="_storageUnlinkDoc('${sid}','${jsPath}')">Unlink</button>
      </div>
    </div>`;
  }

  function renderSessionItem({ id, session }) {
    const entry = byId.get(id);
    if (!entry) return '';
    const eid = escAttrJs(id);
    const count = entry.paths.length;
    const header = `<div class="storage-group-header">
      <span>${_sessionLabel(session, id)} <span class="storage-item-badge">${count} doc${count > 1 ? 's' : ''}</span></span>
      <div class="storage-item-actions">
        <button class="danger" onclick="_storageClearLinkedDocs('${eid}')">Clear All</button>
      </div>
    </div>`;
    const rows = entry.paths.map((p) => renderDocRow(id, p)).join('');
    return header + rows;
  }

  let html = '';
  for (const [project, items] of groups) {
    const count = items.length;
    html += _renderProjectGroup(
      escapeHtml(_projectLabel(project)),
      `${count} session${count > 1 ? 's' : ''}`,
      items.map(renderSessionItem).join(''),
    );
  }
  if (orphans.length) {
    html += _renderOrphanGroup(orphans.length, orphans.map(renderSessionItem).join(''));
  }
  return html;
}

function _storagePreviewLinkedDoc(path) {
  openLinkedDoc(path);
}

function _storageUnlinkDoc(sessionId, path) {
  setSessionDocLink(sessionId, path, true);
}

function _storageClearLinkedDocs(sessionId) {
  localStorage.removeItem(PREVIEW_STORAGE_PREFIX + sessionId);
  afterLinkedDocsChanged(sessionId);
}

function _findOrphanedKeys() {
  const known = _getKnownSessionIds();
  if (!known.size) return [];
  const orphaned = [];
  for (const id of pinnedSessionIds) if (!known.has(id)) orphaned.push(`__pinned__${id}`);
  for (const id of stickySessionIds) if (!known.has(id)) orphaned.push(`__sticky__${id}`);
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key.startsWith('pinned-messages-')) {
      if (!known.has(key.slice('pinned-messages-'.length))) orphaned.push(key);
    } else if (_isSessionScratchpadKey(key)) {
      if (!known.has(key.slice('scratchpad-'.length))) orphaned.push(key);
    } else if (key.startsWith(PREVIEW_STORAGE_PREFIX)) {
      if (!known.has(key.slice(PREVIEW_STORAGE_PREFIX.length))) orphaned.push(key);
    }
  }
  return orphaned;
}

function _updateOrphanedCount() {
  const btn = document.getElementById('storage-cleanup-btn');
  if (!btn) return;
  const count = _findOrphanedKeys().length;
  btn.textContent = count ? `Clean Orphaned (${count})` : 'Clean Orphaned';
}

// biome-ignore lint/correctness/noUnusedVariables: used in HTML onclick
function cleanupOrphanedStorage() {
  if (!sessions.length) {
    showToast('Sessions not loaded yet — try again after they appear');
    return;
  }
  const orphaned = _findOrphanedKeys();
  let pinsChanged = false;
  for (const key of orphaned) {
    if (key.startsWith('__pinned__')) {
      pinnedSessionIds.delete(key.slice('__pinned__'.length));
      pinsChanged = true;
    } else if (key.startsWith('__sticky__')) {
      stickySessionIds.delete(key.slice('__sticky__'.length));
      pinsChanged = true;
    } else {
      localStorage.removeItem(key);
    }
  }
  if (pinsChanged) savePinnedSessions();
  const removed = orphaned.length;

  showToast(removed ? `Cleaned ${removed} orphaned item${removed > 1 ? 's' : ''}` : 'No orphaned items found');
  renderSessions();
  _renderStorageTab();
  _updateStorageTotal();
  _updateOrphanedCount();
}
//#endregion

//#region KEYBOARD_SHORTCUTS
function matchKey(e, ...keys) {
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return false;
  return keys.some((k) => e.key === k || e.code === k);
}

const MODAL_ESC_PRIORITY = [
  'preview-modal',
  'msg-detail-modal',
  'tool-stats-modal',
  'plan-modal',
  'loop-modal',
  'workflow-modal',
];
const MODAL_CLOSERS = {
  'preview-modal': () => closePreviewModal(),
  'msg-detail-modal': () => {
    closeMsgDetailModal();
    msgDetailFollowLatest = false;
  },
  'tool-stats-modal': () => closeToolStatsModal(),
  'plan-modal': () => closePlanModal(),
  'loop-modal': () => closeLoopModal(),
  'workflow-modal': () => closeWorkflowModal(),
  'team-modal': () => closeTeamModal(),
  'agent-modal': () => closeAgentModal(),
  'help-modal': () => closeHelpModal(),
  'session-picker-modal': () => closeSessionPicker(),
};

document.addEventListener('keydown', (e) => {
  // Scale the open modal's reading surface instead of letting the browser zoom
  // the whole page. Sits above the text-field guard so it still works with the
  // caret in a field inside the modal.
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    const delta = ZOOM_KEYS[e.key] ?? ZOOM_KEYS[e.code];
    if (delta !== undefined && isZoomableModalOpen()) {
      e.preventDefault();
      adjustModalZoom(delta);
      return;
    }
  }

  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
    return;
  }

  // Modal guard — only Escape, Shift+M, and msg-detail J/K navigation pass through
  if (document.querySelector('.modal-overlay.visible')) {
    if (e.key === 'Escape') {
      if (_scratchpadModal.classList.contains('visible')) {
        closeScratchpad();
        return;
      }
      // Close only the topmost so a child Esc doesn't also dismiss its parent.
      const visible = [...document.querySelectorAll('.modal-overlay.visible')];
      const topId = MODAL_ESC_PRIORITY.find((id) => visible.some((m) => m.id === id)) || visible[visible.length - 1].id;
      const close = MODAL_CLOSERS[topId];
      if (close) close();
      else document.getElementById(topId).classList.remove('visible');
      e.stopImmediatePropagation();
    } else if (e.key === '?' && document.getElementById('help-modal').classList.contains('visible')) {
      e.preventDefault();
      closeHelpModal();
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
        if (currentMsgDetailIdx === MSG_DETAIL_WAITING_IDX) {
          msgDetailFollowLatest = true;
          showWaitingDetail();
        } else if (currentMsgDetailIdx === currentMessages.length - 1 && isWaitingFresh()) {
          msgDetailFollowLatest = false;
          showWaitingDetail();
        } else if (currentMsgDetailIdx < currentMessages.length - 1) {
          msgDetailFollowLatest = false;
          showMsgDetail(currentMsgDetailIdx + 1);
        } else if (currentMsgDetailIdx === currentMessages.length - 1) {
          msgDetailFollowLatest = true;
          showMsgDetail(currentMsgDetailIdx);
        }
      } else if (matchKey(e, 'ArrowUp', 'KeyK')) {
        e.preventDefault();
        if (currentMsgDetailIdx === MSG_DETAIL_WAITING_IDX) {
          if (currentMessages.length) {
            msgDetailFollowLatest = false;
            showMsgDetail(currentMessages.length - 1);
          }
        } else if (currentMsgDetailIdx > 0) {
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
    } else if (isWaitingFresh()) {
      msgDetailFollowLatest = true;
      showWaitingDetail();
    } else if (currentMessages.length) {
      msgDetailFollowLatest = true;
      showMsgDetail(currentMessages.length - 1);
    }
    return;
  }
  if (e.code === 'KeyS' && e.shiftKey) {
    e.preventDefault();
    showStorageManager();
    return;
  }
  // Ctrl+Shift+P is the browser's own; only the bare chord opens the picker.
  if (e.code === 'KeyP' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
    e.preventDefault();
    openSessionPicker();
    return;
  }
  if (e.key === '.' || e.key === '>') {
    const sid = sessionsList.querySelector('.kb-selected')?.dataset.sessionId || currentSessionId;
    if (sid) {
      e.preventDefault();
      (e.shiftKey ? toggleSessionSticky : toggleSessionPin)(sid);
      return;
    }
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
      // Plain unfocus — drop the keyboard cursor without jumping into the board
      clearKbSelection();
      focusZone = 'board';
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
    else if (agentLogMode) exitAgentLogMode();
    else if (messagePanelOpen) toggleMessagePanel();
    else {
      // Nothing open — plain unfocus: drop the task-card selection highlight
      clearTaskSelection();
      selectedTaskId = null;
    }
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
  if (matchKey(e, 'KeyN') && !e.shiftKey) {
    e.preventDefault();
    toggleScratchpad();
    return;
  }
  if (e.key === '$' && !e.ctrlKey && !e.altKey && !e.metaKey) {
    e.preventDefault();
    hubNavigate('cost', contextSid ? `?view=detail&session=${encodeURIComponent(contextSid)}` : undefined);
    return;
  }
  if (matchKey(e, 'KeyM')) {
    e.preventDefault();
    const mSession = contextSid ? sessions.find((s) => s.id === contextSid) : null;
    hubNavigate('marketplace', mSession?.project ? `?project=${encodeURIComponent(mSession.project)}` : undefined);
    return;
  }
  if (e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey && e.key === 'm') {
    e.preventDefault();
    const mSession = contextSid ? sessions.find((s) => s.id === contextSid) : null;
    hubNavigate('memory', mSession?.project ? `?project=${encodeURIComponent(mSession.project)}` : undefined);
    return;
  }
  if (e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey && e.key === 'd') {
    e.preventDefault();
    if (!contextSid || dismissedSessionIds.has(contextSid)) return;
    const prevIdx = selectedSessionIdx;
    dismissedSessionIds.add(contextSid);
    updateDismissBtnState();
    renderSessions();
    renderActivityChip();
    const newItems = getNavigableItems();
    const targetIdx = newItems.length > 0 ? Math.max(0, prevIdx - 1) : -1;
    // If the dismissed session is currently open, navigate to the previous one
    if (currentSessionId === contextSid || selectedSessionId === contextSid) {
      selectedSessionId = null;
      if (targetIdx >= 0) {
        const targetSid = newItems[targetIdx]?.dataset?.sessionId;
        if (targetSid) {
          fetchTasks(targetSid).then(() => selectSessionByIndex(targetIdx, getNavigableItems()));
        } else {
          showAllTasks().then(() => selectSessionByIndex(targetIdx, getNavigableItems()));
        }
      } else {
        showAllTasks();
      }
    } else if (targetIdx >= 0) {
      selectSessionByIndex(targetIdx, newItems);
    }
    return;
  }
  if (e.code === 'KeyC' && e.shiftKey && !e.altKey && !e.metaKey) {
    e.preventDefault();
    if (!contextSid) {
      showToast('No session selected');
      return;
    }
    const text = e.ctrlKey ? `claude -r ${contextSid}` : contextSid;
    const label = e.ctrlKey ? 'resume command' : 'session id';
    navigator.clipboard
      .writeText(text)
      .then(() => showToast(`Copied ${label}: ${contextSid.slice(0, 8)}`, 'success'))
      .catch(() => showToast(`Failed to copy ${label}`));
    return;
  }
  if (matchKey(e, 'KeyR')) {
    e.preventDefault();
    if (_manualRefreshing) return;
    _manualRefreshing = true;
    lastSessionsHash = '';
    lastTasksHash = '';
    const refreshes = [fetchSessions()];
    if (currentSessionId) refreshes.push(fetchTasks(currentSessionId));
    refreshRateLimits();
    Promise.all(refreshes)
      .then(() => showToast('Data refreshed', 'success'))
      .finally(() => {
        _manualRefreshing = false;
      });
    return;
  }
  if (matchKey(e, 'KeyT')) {
    e.preventDefault();
    toggleTheme();
    return;
  }
  if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
    e.preventDefault();
    showHelpModal();
  }
});

//#endregion

//#region MARKDOWN_PREVIEW
const PREVIEW_STORAGE_PREFIX = 'preview-paths-';
let currentPreviewPath = null;

function getSessionPreviewPaths(sessionId) {
  if (!sessionId) return [];
  try {
    const raw = localStorage.getItem(PREVIEW_STORAGE_PREFIX + sessionId);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function addSessionPreviewPath(sessionId, filePath) {
  if (!sessionId || !filePath) return;
  const paths = getSessionPreviewPaths(sessionId).filter((p) => p !== filePath);
  paths.unshift(filePath);
  localStorage.setItem(PREVIEW_STORAGE_PREFIX + sessionId, JSON.stringify(paths.slice(0, 20)));
}

function removeSessionPreviewPath(sessionId, filePath) {
  if (!sessionId) return;
  const paths = getSessionPreviewPaths(sessionId).filter((p) => p !== filePath);
  if (paths.length) localStorage.setItem(PREVIEW_STORAGE_PREFIX + sessionId, JSON.stringify(paths));
  else localStorage.removeItem(PREVIEW_STORAGE_PREFIX + sessionId);
}

// Every surface that shows linked docs — info modal, session card badge, preview
// toolbar toggle, storage manager — refreshes from one place, so a new mutator
// can never forget one of them.
// The one mutator: link/unlink plus the refresh, so no caller can do half of it.
function setSessionDocLink(sessionId, filePath, unlink) {
  if (!sessionId || !filePath) return;
  if (unlink) removeSessionPreviewPath(sessionId, filePath);
  else addSessionPreviewPath(sessionId, filePath);
  afterLinkedDocsChanged(sessionId);
}

function afterLinkedDocsChanged(sessionId) {
  if (_infoModalSessionId === sessionId) refreshInfoModalLinkedDocs();
  renderSessions();
  updatePreviewLinkBtn();
  _renderStorageTab();
  _updateStorageTotal();
}

function splitFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { fm: null, body: text };
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].replace(/^['"]|['"]$/g, '');
  }
  return { fm, body: m[2] };
}

function renderFrontmatterBlock(fm) {
  const rows = Object.entries(fm)
    .map(
      ([k, v]) =>
        `<div class="fm-row"><span class="fm-k">${escapeHtml(k)}</span><span class="fm-v">${escapeHtml(String(v))}</span></div>`,
    )
    .join('');
  return `<details class="preview-fm" open><summary>frontmatter</summary><div class="fm-grid">${rows}</div></details>`;
}

// Previewed HTML is rendered as authored, not sanitized: the sandbox without
// allow-same-origin puts it on an opaque origin, so it cannot touch this app's
// storage, DOM or API. srcdoc has no base URL, so the server has already embedded
// the document's local assets (lib/inline-assets.js); remote refs load normally.
function renderHtmlPreview(bodyEl, content) {
  bodyEl.innerHTML = '';
  const frame = document.createElement('iframe');
  frame.className = 'preview-html-frame';
  frame.setAttribute('sandbox', 'allow-scripts allow-popups');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.srcdoc = content;
  bodyEl.appendChild(frame);
}

function bindPreviewRelativeLinks(bodyEl) {
  if (bodyEl.dataset.relLinkBound) return;
  bodyEl.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#')) return;
    const isAbsoluteUrl = /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//');
    const isAbsolutePath = href.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(href);
    if (isAbsoluteUrl) return;
    const cleanHref = href.replace(/#.*$/, '');
    if (!isPreviewablePath(cleanHref)) return;
    e.preventDefault();
    openPreviewByPath(cleanHref, isAbsolutePath ? undefined : currentPreviewPath);
  });
  bodyEl.dataset.relLinkBound = '1';
}

// `kind` comes from the server, which is the only place that decides what is previewable.
function openPreviewModal(filePath, content, kind) {
  currentPreviewPath = filePath;
  document.getElementById('preview-modal-title').textContent = filePath.split(/[\\/]/).pop();
  const bodyEl = document.getElementById('preview-modal-body');
  const isHtml = kind === 'html';
  document.querySelector('#preview-modal .modal').classList.toggle('preview-html', isHtml);
  bindPreviewRelativeLinks(bodyEl);
  if (isHtml) {
    renderHtmlPreview(bodyEl, content);
  } else {
    const { fm, body } = splitFrontmatter(content);
    bodyEl.innerHTML = (fm ? renderFrontmatterBlock(fm) : '') + renderMarkdown(body);
  }
  document.getElementById('preview-modal-meta').textContent = filePath;
  document.getElementById('preview-modal').classList.add('visible');
  updatePreviewLinkBtn();
}

function isPreviewLinkedToCurrentSession() {
  if (!currentPreviewPath || !currentSessionId) return false;
  return getSessionPreviewPaths(currentSessionId).includes(currentPreviewPath);
}

function updatePreviewLinkBtn() {
  const btn = document.getElementById('preview-link-btn');
  if (!btn) return;
  if (!currentSessionId) {
    btn.style.display = 'none';
    return;
  }
  btn.style.display = '';
  const linked = isPreviewLinkedToCurrentSession();
  btn.title = linked ? 'Unlink from current session' : 'Link to current session';
  btn.style.color = linked ? 'var(--accent, #5b9a6b)' : '';
}

// biome-ignore lint/correctness/noUnusedVariables: used in HTML
function togglePreviewSessionLink() {
  if (!currentPreviewPath || !currentSessionId) {
    showToast('Select a session first');
    return;
  }
  const unlink = isPreviewLinkedToCurrentSession();
  setSessionDocLink(currentSessionId, currentPreviewPath, unlink);
  showToast(unlink ? 'Unlinked from session' : 'Linked to session');
}

function refreshInfoModalLinkedDocs() {
  const bodyEl = document.getElementById('team-modal-body');
  if (!bodyEl) return;
  const existing = bodyEl.querySelector('.linked-docs-section');
  const wrap = document.createElement('div');
  wrap.innerHTML = renderLinkedDocsHtml(_infoModalSessionId);
  const node = wrap.firstElementChild;
  if (existing) {
    existing.replaceWith(node);
  } else {
    const planCard = bodyEl.querySelector('[data-plan-card]');
    if (planCard?.nextSibling) planCard.parentNode.insertBefore(node, planCard.nextSibling);
    else bodyEl.appendChild(node);
  }
  bindLinkedDocsHandlers(node, _infoModalSessionId);
}

function closePreviewModal() {
  hideModalOverlay('preview-modal');
  // Empty the body so an iframe preview is destroyed and its scripts/timers stop.
  document.getElementById('preview-modal-body').innerHTML = '';
  currentPreviewPath = null;
}

// biome-ignore lint/correctness/noUnusedVariables: used in HTML
function openPreviewInEditor() {
  if (!currentPreviewPath) return;
  postAndToast('/api/open-in-editor', { file: currentPreviewPath }, 'in editor');
}

async function openPreviewByPath(filePath, base) {
  if (!filePath) return;
  try {
    const qs = new URLSearchParams({ path: filePath });
    if (base) qs.set('base', base);
    const r = await fetch(`/api/preview?${qs}`);
    if (!r.ok) {
      showToast('Preview file unavailable');
      return;
    }
    const data = await r.json();
    openPreviewModal(data.path, data.content, data.kind);
  } catch {
    showToast('Failed to load preview');
  }
}

function handleSessionOpenEvent(data) {
  const { id } = data;
  if (!id) return;
  const target = sessions.find((s) => s.id === id);
  if (!target) {
    showToast(`Session not found: ${id.slice(0, 8)}`);
    return;
  }
  if (sessionFilter !== 'active') {
    sessionFilter = 'active';
    const sel = document.getElementById('session-filter');
    if (sel) sel.value = 'active';
    updateUrl();
  }
  if (!isSessionActive(target)) {
    stickySessionIds.add(id);
  }
  fetchTasks(id);
}

async function handlePreviewOpenEvent(data) {
  const { path: filePath, sessionId } = data;
  if (sessionId && sessionId !== currentSessionId) {
    if (sessions.find((s) => s.id === sessionId)) {
      await fetchTasks(sessionId);
    } else {
      showToast(`Preview received for unknown session ${sessionId.slice(0, 8)}`);
    }
  }
  // The broadcast carries the path only — each tab fetches the document itself.
  openPreviewByPath(filePath);
}

// Linked docs live in localStorage, so the CLI can only reach them through a tab:
// the server broadcasts the resolved path and every tab applies it idempotently.
function handleDocumentLinkEvent(data) {
  const { path: filePath, sessionId, unlink } = data;
  if (!filePath || !sessionId) return;
  setSessionDocLink(sessionId, filePath, unlink);
  showToast(`${unlink ? 'Unlinked' : 'Linked'} ${filePath.split(/[\\/]/).pop()}`);
}

function getSessionBaseDir(sessionId) {
  const s = sessions.find((x) => x.id === sessionId);
  return s?.cwd || s?.project || '';
}

// Linked paths are stored as bare strings, so previewability is re-derived from the
// extension on every render instead of being remembered alongside the path.
function isPreviewablePath(p) {
  return /\.(md|markdown|html?)$/i.test(p);
}

// A scratchpad manifest opens in the external `scratch` viewer, not the editor —
// the raw JSON is a manifest, not the document the user linked.
function isScratchpadPath(p) {
  return /(^|[\\/])scratchpad\.json$/i.test(p);
}

// `linkedDocOpener` is the only place a linked path is classified; the row's tag,
// tooltip and action are all read from here, so a new destination is one entry.
const LINKED_DOC_OPENERS = {
  preview: { tag: '', hint: '' },
  scratch: {
    tag: '(scratchpad)',
    hint: ' — opens in the scratch viewer',
    url: '/api/scratchpad/open',
    body: (p) => ({ path: p }),
    toast: 'in the scratch viewer',
  },
  editor: {
    tag: '(editor)',
    hint: ' — opens in editor',
    url: '/api/open-in-editor',
    body: (p) => ({ file: p }),
    toast: 'in editor',
  },
};

function linkedDocOpener(p) {
  if (isPreviewablePath(p)) return 'preview';
  // Without the CLI there is nothing to launch, so the manifest falls back to the editor.
  if (isScratchpadPath(p) && appConfig.scratchAvailable) return 'scratch';
  return 'editor';
}

// Every manifest is called scratchpad.json, so the pad's folder names it. Kept
// independent of the opener: the pad is still the pad when the CLI is missing.
function linkedDocLabel(p) {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return isScratchpadPath(p) ? parts[parts.length - 2] || parts[parts.length - 1] : parts[parts.length - 1];
}

function openLinkedDoc(p, baseDir) {
  const opener = linkedDocOpener(p);
  if (opener === 'preview') {
    openPreviewByPath(p, baseDir);
    return;
  }
  const { url, body, toast } = LINKED_DOC_OPENERS[opener];
  postAndToast(url, body(p), toast);
}

function renderLinkedDocsHtml(sessionId) {
  const paths = getSessionPreviewPaths(sessionId);
  const baseDir = getSessionBaseDir(sessionId);
  const items = paths
    .map((p) => {
      const opener = linkedDocOpener(p);
      const { tag, hint } = LINKED_DOC_OPENERS[opener];
      const name = linkedDocLabel(p);
      const rel = baseDir ? toRelativeIfUnder(p, baseDir) : null;
      const pathSpan = rel ? `<span class="linked-doc-path" title="${escapeHtml(p)}">${escapeHtml(rel)}</span>` : '';
      const attr = escapeHtml(p);
      return `<li class="linked-doc-item${opener === 'preview' ? '' : ' is-editor'}">
        <a href="#" class="linked-doc-link" data-path="${attr}" title="${escapeHtml(p + hint)}">${escapeHtml(name)}</a>
        ${pathSpan}${tag ? `<span class="linked-doc-path">${tag}</span>` : ''}
        <span class="row-actions linked-doc-actions">
          <button type="button" class="linked-doc-copy" data-path="${attr}" title="Copy path" aria-label="Copy path of ${escapeHtml(name)}">${ICON_COPY}</button>
          <button type="button" class="linked-doc-remove" data-path="${attr}" title="Unlink" aria-label="Unlink ${escapeHtml(name)}">&times;</button>
        </span>
      </li>`;
    })
    .join('');
  // Rendered even when empty — the add button has to stay reachable.
  const body = paths.length
    ? `<ul class="linked-doc-list">${items}</ul>`
    : '<div class="linked-docs-empty">No linked files yet</div>';
  return `<div class="linked-docs-section" style="margin-bottom:16px;font-size:12px;">
    <div style="font-size:11px;font-weight:500;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;display:flex;align-items:center;gap:6px;">
      ${linkSvg(12)}
      <span>Linked documents</span>
      <span style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:10px;padding:0 6px;font-size:10px;color:var(--text-secondary);">${paths.length}</span>
      <button type="button" class="linked-docs-add-btn" title="Link a file" aria-label="Link a file">+</button>
    </div>
    <div class="linked-doc-editor-slot"></div>
    ${body}
  </div>`;
}

// One delegated listener per section: the list is re-rendered on every change, so
// per-row handlers would only be rebound each time anyway.
function bindLinkedDocsHandlers(container, sessionId) {
  if (!container) return;
  container.addEventListener('click', (e) => {
    const hit = e.target.closest('.linked-doc-link, .linked-doc-copy, .linked-doc-remove, .linked-docs-add-btn');
    if (!hit) return;
    e.preventDefault();
    if (hit.classList.contains('linked-docs-add-btn')) {
      startLinkedDocInput(container, sessionId);
    } else if (hit.classList.contains('linked-doc-copy')) {
      copyWithFeedback(hit.dataset.path, hit);
    } else if (hit.classList.contains('linked-doc-remove')) {
      removeSessionPreviewPath(sessionId, hit.dataset.path);
      afterLinkedDocsChanged(sessionId);
    } else {
      openLinkedDoc(hit.dataset.path, getSessionBaseDir(sessionId));
    }
  });
}

function startLinkedDocInput(container, sessionId) {
  const slot = container.querySelector('.linked-doc-editor-slot');
  if (!slot) return;
  slot.innerHTML = `<input class="linked-doc-input" type="text" spellcheck="false" placeholder="Absolute path, file:// URL, or relative to the session cwd">
    <div class="linked-doc-hint">${escapeHtml(getSessionBaseDir(sessionId) || 'no session cwd — absolute paths only')}</div>
    <div class="linked-doc-error"></div>
    <div class="edit-actions">
      <button type="button" class="edit-cancel">Cancel</button>
      <button type="button" class="edit-save">Link</button>
    </div>`;
  const input = slot.querySelector('.linked-doc-input');
  const save = () => linkFileByPath(sessionId, input.value, slot);
  const cancel = () => {
    slot.innerHTML = '';
  };
  slot.querySelector('.edit-save').addEventListener('click', save);
  slot.querySelector('.edit-cancel').addEventListener('click', cancel);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      save();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  });
  input.focus();
}

async function linkFileByPath(sessionId, raw, slot) {
  // Paths pasted from Explorer or a shell often arrive quoted.
  const value = (raw || '').trim().replace(/^["']|["']$/g, '');
  // Reported inline so the input stays open and the path can be corrected in place.
  const fail = (msg) => {
    const err = slot?.querySelector('.linked-doc-error');
    if (err) err.textContent = msg;
    else showToast(msg, 'error');
  };
  if (!value) {
    fail('Enter a file path');
    return;
  }
  try {
    const qs = new URLSearchParams({ path: value });
    const base = getSessionBaseDir(sessionId);
    if (base) qs.set('base', base);
    const r = await fetch(`/api/file/resolve?${qs}`);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      fail(data.error || 'File not found');
      return;
    }
    setSessionDocLink(sessionId, data.path, false);
    showToast('Linked to session', 'success');
  } catch {
    fail('Failed to resolve file');
  }
}
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
    };

    eventSource.onerror = () => {
      eventSource.close();
      failCount++;
      console.warn('[SSE] Connection lost, retrying in', retryDelay, 'ms');
      if (failCount >= 2) showOffline();
      setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 30000);
    };

    let taskRefreshTimer = null;
    let metadataRefreshTimer = null;
    let agentRefreshTimer = null;
    const pendingTaskSessionIds = new Set();
    const pendingAgentSessionIds = new Set();

    function debouncedRefresh(sessionId, isMetadata) {
      if (isMetadata) {
        clearTimeout(metadataRefreshTimer);
        metadataRefreshTimer = setTimeout(async () => {
          fetchSessions(false).catch((err) => console.error('[SSE] fetchSessions failed:', err));
          if (currentSessionId) {
            await fetchAgents(currentSessionId);
            if (!agentLogMode) fetchMessages(currentSessionId);
          }
        }, 2000);
      } else {
        pendingTaskSessionIds.add(sessionId);
        clearTimeout(taskRefreshTimer);
        taskRefreshTimer = setTimeout(async () => {
          await fetchSessions().catch((err) => console.error('[SSE] fetchSessions failed:', err));
          if (viewMode === 'all') {
            currentTasks = filterProject ? allTasksCache.filter((t) => matchesProjectFilter(t.project)) : allTasksCache;
            renderAllTasks();
            renderActivityChip();
          } else if (viewMode === 'project' && currentProjectPath) {
            const hasUpdate = currentProjectSessionIds.some((id) => pendingTaskSessionIds.has(id));
            if (hasUpdate) fetchProjectView(currentProjectPath);
          } else if (currentSessionId && pendingTaskSessionIds.has(currentSessionId)) {
            fetchTasks(currentSessionId);
          }
          pendingTaskSessionIds.clear();
        }, 500);
      }
    }

    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'update' || data.type === 'metadata-update') {
        if (data.type === 'metadata-update') projectsCacheDirty = true;
        debouncedRefresh(data.sessionId, data.type === 'metadata-update');
      }

      if (data.type === 'plan-update') {
        refreshOpenPlan();
      }

      if (data.type === 'agent-update') {
        pendingAgentSessionIds.add(data.sessionId);
        clearTimeout(agentRefreshTimer);
        agentRefreshTimer = setTimeout(() => {
          fetchSessions(false).catch((err) => console.error('[SSE] fetchSessions failed:', err));
          if (viewMode === 'project' && currentProjectSessionIds.some((id) => pendingAgentSessionIds.has(id))) {
            refreshProjectAgents();
          } else if (currentSessionId && pendingAgentSessionIds.has(currentSessionId)) {
            fetchAgents(currentSessionId);
            // An agent starting/stopping adds its Agent tool_use + completion rows to
            // the transcript. Refresh the message log on the same signal so they appear
            // at start, not only when an unrelated metadata/context refresh coincides
            // with completion.
            if (!agentLogMode) fetchMessages(currentSessionId);
          }
          pendingAgentSessionIds.clear();
        }, 500);
      }

      if (data.type === 'context-update') {
        debouncedRefresh(data.sessionId, true);
        refreshRateLimits();
      }

      if (data.type === 'preview:open') {
        handlePreviewOpenEvent(data);
      }

      if (data.type === 'document:link') {
        handleDocumentLinkEvent(data);
      }

      if (data.type === 'session:open') {
        handleSessionOpenEvent(data);
      }

      if (data.type === 'session:pin') {
        handleSessionPinEvent(data);
      }

      if (data.type === 'team-update') {
        const teamSession = sessions.find((s) => s.isTeam && s.teamName === data.teamName);
        if (teamSession) {
          debouncedRefresh(teamSession.id, false);
        } else if (currentSessionId) {
          debouncedRefresh(currentSessionId, false);
        }
      }
    };
  }

  // When the tab becomes visible after being hidden, catch up immediately
  let _pollMissed = false;
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && _pollMissed) {
      _pollMissed = false;
      fetchSessions().catch(() => {});
      if (currentSessionId) fetchTasks(currentSessionId).catch(() => {});
    }
  });

  // Fallback poll every 30s in case SSE silently drops; skip when tab is hidden
  setInterval(() => {
    if (document.hidden) {
      _pollMissed = true;
      return;
    }
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
function maybeFollowLatest() {
  if (!msgDetailFollowLatest) return;
  if (isWaitingFresh()) {
    showWaitingDetail();
  } else if (currentMessages.length) {
    showMsgDetail(currentMessages.length - 1);
  }
}

function isWaitingFresh() {
  if (!currentWaiting?.timestamp) return false;
  return Date.now() - new Date(currentWaiting.timestamp).getTime() < WAITING_TTL_MS;
}

// Per-question selections for the AskUserQuestion form, keyed by question text
// (the shape the tool's `answers` input expects). Picks hold arrays of option
// labels (length <= 1 unless multiSelect); free text lives separately so a
// multi-select can combine both, the way the TUI's "Other" row does. Reset
// when the ask changes.
let waitingAnswerDraft = {};
let waitingCustomDraft = {};
let waitingDraftId = null;
let waitingQuestions = [];

function waitingAnswerFor(q) {
  const picks = waitingAnswerDraft[q.question] || [];
  const custom = waitingCustomDraft[q.question] || '';
  if (q.multiSelect) {
    const all = custom ? picks.concat(custom) : picks;
    return all.length ? all : null;
  }
  return picks[0] || custom || null;
}

// The action buttons live in the modal's fixed footer (#msg-detail-waiting-footer),
// not the scrollable body — long content must not push them out of reach.
function renderWaitingFooter(tool, params) {
  if (currentWaiting?.kind === 'plan') {
    return isWaitingAnswerable() ? planApprovalControlsHtml('plan-reject-feedback') : '';
  }
  if (currentWaiting?.kind !== 'question') return waitingDecisionButtons('waiting-btn');
  if (!isWaitingAnswerable()) return '';
  if (tool !== 'AskUserQuestion') return '';
  const questions = Array.isArray(params?.questions) ? params.questions : [];
  if (!questions.length) return '';
  const picked = questions.filter((q) => waitingAnswerFor(q)).length;
  const partial = picked > 0 && picked < questions.length ? ` (${picked}/${questions.length})` : '';
  return `<button id="waiting-answer-btn" class="waiting-btn-allow" ${picked > 0 ? '' : 'disabled'} onclick="submitWaitingAnswers()">Answer${partial}</button>`;
}

function renderWaitingActions(tool, params) {
  if (!isWaitingAnswerable() || currentWaiting.kind !== 'question' || tool !== 'AskUserQuestion') return '';
  waitingQuestions = Array.isArray(params?.questions) ? params.questions : [];
  if (!waitingQuestions.length) return '';
  const qs = waitingQuestions
    .map((q, idx) => {
      const picks = waitingAnswerDraft[q.question] || [];
      const opts = (q.options || [])
        .map((o) => {
          const label = typeof o === 'string' ? o : o?.label || '';
          const desc = typeof o === 'object' ? o?.description || '' : '';
          const descHtml = desc ? `<span class="waiting-option-desc">${renderMarkdown(desc)}</span>` : '';
          // The option `preview` field is the TUI's side-by-side visualization
          // pane (mockups, code snippets, diagrams) — rendered as markdown
          const preview = typeof o === 'object' ? o?.preview || '' : '';
          const previewHtml = preview ? `<span class="waiting-option-preview">${renderMarkdown(preview)}</span>` : '';
          return `<button class="waiting-option${picks.includes(label) ? ' selected' : ''}" data-label="${escapeHtml(label)}" onclick="selectWaitingAnswer(${idx}, this.dataset.label)"><span class="waiting-option-label">${escapeHtml(label)}</span>${descHtml}${previewHtml}</button>`;
        })
        .join('');
      const header = q.header ? `<span class="waiting-question-header">${escapeHtml(q.header)}</span>` : '';
      const multi = q.multiSelect ? '<span class="waiting-question-multi">multi-select</span>' : '';
      const input = `<input type="text" class="waiting-option-input" placeholder="Or type your own answer" value="${escapeHtml(waitingCustomDraft[q.question] || '')}" oninput="setWaitingCustomAnswer(${idx}, this)">`;
      return `<div class="waiting-question">${header}${multi}<div class="waiting-question-text">${renderMarkdown(q.question || '')}</div><div class="waiting-options">${opts}</div>${input}</div>`;
    })
    .join('');
  return `<div class="waiting-actions">${qs}</div>`;
}

// biome-ignore lint/correctness/noUnusedVariables: used in HTML onclick
function selectWaitingAnswer(qi, label) {
  const q = waitingQuestions[qi];
  if (!q) return;
  // Clicking a picked option unpicks it, in both modes
  const picks = waitingAnswerDraft[q.question] || [];
  if (q.multiSelect) {
    waitingAnswerDraft[q.question] = picks.includes(label) ? picks.filter((l) => l !== label) : picks.concat(label);
  } else if (picks.includes(label)) {
    delete waitingAnswerDraft[q.question];
  } else {
    waitingAnswerDraft[q.question] = [label];
    delete waitingCustomDraft[q.question];
  }
  showWaitingDetail();
}

// Free-text path — the TUI's "type your own answer". Updates the draft and the
// Answer button in place: a full re-render here would drop the input's focus
// on every keystroke.
// biome-ignore lint/correctness/noUnusedVariables: used in HTML oninput
function setWaitingCustomAnswer(qi, el) {
  const q = waitingQuestions[qi];
  if (!q) return;
  const v = el.value.trim();
  if (v) waitingCustomDraft[q.question] = v;
  else delete waitingCustomDraft[q.question];
  if (v && !q.multiSelect) {
    delete waitingAnswerDraft[q.question];
    for (const b of el.closest('.waiting-question')?.querySelectorAll('.waiting-option.selected') || []) {
      b.classList.remove('selected');
    }
  }
  const btn = document.getElementById('waiting-answer-btn');
  if (btn) {
    const picked = waitingQuestions.filter((qq) => waitingAnswerFor(qq)).length;
    btn.disabled = picked === 0;
    btn.textContent =
      picked > 0 && picked < waitingQuestions.length ? `Answer (${picked}/${waitingQuestions.length})` : 'Answer';
  }
}

// biome-ignore lint/correctness/noUnusedVariables: used in HTML onclick
function submitWaitingAnswers() {
  // Partial submits are fine — send only the questions actually answered.
  // multiSelect answers go as arrays of labels (the shape the TUI validates).
  const answers = {};
  for (const q of waitingQuestions) {
    const a = waitingAnswerFor(q);
    if (a) answers[q.question] = a;
  }
  if (!Object.keys(answers).length) return;
  respondWaiting({ answers });
}

function showWaitingDetail() {
  if (!isWaitingFresh()) return;
  currentMsgDetailIdx = MSG_DETAIL_WAITING_IDX;
  msgHighlightDimmed = false;
  highlightSelectedMsg();
  // Follow-mode poll ticks re-run this whole render — carry any typed reject
  // feedback across the rebuild, but never onto a different ask.
  const sameAsk = currentWaiting.id === waitingDraftId;
  const feedbackDraft = sameAsk ? document.getElementById('plan-reject-feedback')?.value || '' : '';
  if (!sameAsk) {
    waitingDraftId = currentWaiting.id || null;
    waitingAnswerDraft = {};
    waitingCustomDraft = {};
  }
  const tool = currentWaiting.toolName || 'unknown';
  const label = getWaitingLabel(currentWaiting.kind, tool);
  const body = document.getElementById('msg-detail-body');
  let inputHtml = '';
  const params = parseWaitingInput();
  if (currentWaiting.toolInput) {
    const pretty = params ? JSON.stringify(params, null, 2) : currentWaiting.toolInput;
    inputHtml = `<pre class="${TINTED_PRE_CLASS}">${escapeHtml(pretty)}</pre>`;
  }
  const actionsHtml = renderWaitingActions(tool, params);
  const footerHtml = renderWaitingFooter(tool, params);
  // With actions on screen the form/buttons are the content — tuck the raw
  // JSON behind a toggle, but keep what the user is approving visible: for a
  // permission ask surface the command (or description) as a one-line summary
  if ((actionsHtml || footerHtml) && inputHtml) {
    let summaryHtml = '';
    if (currentWaiting.kind === 'plan' && typeof params?.plan === 'string' && params.plan) {
      // A plan ask IS the plan — render it in full so it can be reviewed and
      // approved right here (follow mode included) instead of a JSON dump. The
      // raw tool input is dropped entirely to match the saved-plan modal.
      inputHtml = `<div class="detail-desc rendered-md">${renderMarkdown(params.plan)}</div>`;
    } else {
      if (currentWaiting.kind !== 'question' && params) {
        const gist =
          typeof params.command === 'string'
            ? params.command
            : typeof params.description === 'string'
              ? params.description
              : '';
        if (gist) summaryHtml = `<pre class="${TINTED_PRE_CLASS}">${escapeHtml(gist)}</pre>`;
      }
      inputHtml = `${summaryHtml}<details class="waiting-raw-input"><summary>Raw tool input</summary>${inputHtml}</details>`;
    }
  }
  body.innerHTML = inputHtml + actionsHtml;
  document.getElementById('msg-detail-waiting-footer').innerHTML = footerHtml;
  if (feedbackDraft) {
    const feedbackEl = document.getElementById('plan-reject-feedback');
    if (feedbackEl) feedbackEl.value = feedbackDraft;
  }
  document.getElementById('msg-detail-title').textContent = label;
  document.getElementById('msg-detail-agent-btn').style.display = 'none';
  const modal = document.getElementById('msg-detail-modal').querySelector('.modal');
  autoSizeModal(modal, body);
  modal.classList.toggle('live', msgDetailFollowLatest);
  const overlay = document.getElementById('msg-detail-modal');
  overlay.classList.toggle('live-overlay', msgDetailFollowLatest);
  const meta = [formatDate(currentWaiting.timestamp), 'waiting'];
  document.getElementById('msg-detail-meta').textContent = meta.join(' · ');
  currentPinDetailId = null;
  updateMsgDetailPinState();
  overlay.classList.add('visible');
}

function isSessionActive(s) {
  return s.hasRecentLog || s.inProgress > 0 || s.hasActiveAgents || s.hasWaitingForUser;
}

const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sessionDisplayName(session) {
  const raw = session.name || session.id;
  return SESSION_UUID_RE.test(raw) ? raw.slice(0, 8) : raw;
}

function formatDate(dateStr) {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now - date;

  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return date.toLocaleDateString();
}

// Terminal output reaches the transcript raw. A CSI-only pattern left OSC
// sequences, 8-bit CSI and bare control bytes behind, and those render as tofu.
// One ordered alternation covers every escape family, so both readers make a
// single pass: OSC, SGR (the only one worth keeping — capture group 1 holds its
// parameters), any other CSI, other two-char escapes, then whatever control
// bytes are left, lone introducers included. \t \n \r are deliberately absent.
const ANSI_TOKEN_RE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: escape and control bytes are the target
  /\x1b\][\s\S]*?(?:\x07|\x1b\\|$)|[\x1b\x9b]\[([0-9;]*)m|[\x1b\x9b]\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]|\x1b[ -/]+[0-~]|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x9b]/g;

function stripAnsi(text) {
  if (typeof text !== 'string') return text;
  return text.replace(ANSI_TOKEN_RE, '');
}

const ANSI_COLOR_NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
const XTERM_CUBE = [0, 95, 135, 175, 215, 255];

// xterm-256 index -> a colour the browser understands. 0-15 stay named so they
// follow the theme's palette; 16+ are exact and become an inline rgb().
function ansi256Color(n) {
  if (n < 8) return { name: ANSI_COLOR_NAMES[n] };
  if (n < 16) return { name: `bright-${ANSI_COLOR_NAMES[n - 8]}` };
  if (n < 232) {
    const i = n - 16;
    return {
      rgb: `rgb(${XTERM_CUBE[Math.floor(i / 36) % 6]},${XTERM_CUBE[Math.floor(i / 6) % 6]},${XTERM_CUBE[i % 6]})`,
    };
  }
  const v = 8 + (n - 232) * 10;
  return { rgb: `rgb(${v},${v},${v})` };
}

// Attribute codes that only flip a flag: code -> [field, value].
const SGR_FLAGS = {
  1: ['bold', true],
  2: ['dim', true],
  3: ['italic', true],
  4: ['underline', true],
  7: ['inverse', true],
  9: ['strike', true],
  23: ['italic', false],
  24: ['underline', false],
  27: ['inverse', false],
  29: ['strike', false],
};

// Reads one SGR parameter list into `st`. 38/48 consume their own arguments, so
// the list is walked with an index rather than a for..of.
function applySgr(params, st) {
  const codes = params === '' ? [0] : params.split(';').map((p) => (p === '' ? 0 : Number(p)));
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i];
    const flag = SGR_FLAGS[c];
    // 30-37/90-97 are foreground, 40-47/100-107 background; the low digit is the
    // colour index and 9 in that slot means "back to the default".
    const isColor = (c >= 30 && c <= 49) || (c >= 90 && c <= 107);
    if (c === 0) {
      st.fg = st.bg = null;
      st.bold = st.dim = st.italic = st.underline = st.strike = st.inverse = false;
      st.plain = true;
    } else if (flag) {
      st[flag[0]] = flag[1];
      st.plain = false;
    } else if (c === 22) {
      st.bold = st.dim = false;
    } else if (isColor && c !== 38 && c !== 48) {
      const key = (c >= 40 && c <= 49) || c >= 100 ? 'bg' : 'fg';
      const idx = c % 10;
      st[key] = idx === 9 ? null : { name: c >= 90 ? `bright-${ANSI_COLOR_NAMES[idx]}` : ANSI_COLOR_NAMES[idx] };
      if (idx !== 9) st.plain = false;
    } else if (c === 38 || c === 48) {
      st.plain = false;
      const key = c === 38 ? 'fg' : 'bg';
      if (codes[i + 1] === 5) {
        st[key] = ansi256Color(codes[i + 2] || 0);
        i += 2;
      } else if (codes[i + 1] === 2) {
        st[key] = { rgb: `rgb(${codes[i + 2] || 0},${codes[i + 3] || 0},${codes[i + 4] || 0})` };
        i += 4;
      }
    }
  }
}

function wrapAnsiChunk(chunk, st) {
  const escaped = escapeHtml(chunk);
  if (st.plain) return escaped;
  const classes = [];
  const styles = [];
  const fg = st.inverse ? st.bg : st.fg;
  const bg = st.inverse ? st.fg : st.bg;
  if (fg?.name) classes.push(`ansi-fg-${fg.name}`);
  else if (fg?.rgb) styles.push(`color:${fg.rgb}`);
  // `ansi-bg` carries the padding both background forms share; the named form
  // adds the colour class, the 256/truecolor form an inline background.
  if (bg?.name) classes.push('ansi-bg', `ansi-bg-${bg.name}`);
  else if (bg?.rgb) {
    classes.push('ansi-bg');
    styles.push(`background:${bg.rgb}`);
  }
  if (st.inverse && !fg && !bg) classes.push('ansi-inverse');
  if (st.bold) classes.push('ansi-bold');
  if (st.dim) classes.push('ansi-dim');
  if (st.italic) classes.push('ansi-italic');
  if (st.underline) classes.push('ansi-underline');
  if (st.strike) classes.push('ansi-strike');
  if (!classes.length && !styles.length) return escaped;
  // Both values are built from fixed tables and digits parsed out of the SGR
  // parameters, but they land in an attribute, so they go through the escaper.
  const cls = classes.length ? ` class="${escapeHtml(classes.join(' '))}"` : '';
  const style = styles.length ? ` style="${escapeHtml(styles.join(';'))}"` : '';
  return `<span${cls}${style}>${escaped}</span>`;
}

// Renders terminal output as HTML with its SGR colours intact. One pass over
// ANSI_TOKEN_RE: SGR tokens (capture group 1) move the state, every other token
// is noise and is dropped, and the text between them is a chunk. Returns escaped
// HTML — every chunk goes through escapeHtml before it is wrapped.
function ansiToHtml(text) {
  if (typeof text !== 'string') return '';
  const st = {
    fg: null,
    bg: null,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    strike: false,
    inverse: false,
    plain: true,
  };
  let out = '';
  let last = 0;
  ANSI_TOKEN_RE.lastIndex = 0;
  let m = ANSI_TOKEN_RE.exec(text);
  while (m) {
    if (m.index > last) out += wrapAnsiChunk(text.slice(last, m.index), st);
    if (m[1] !== undefined) applySgr(m[1], st);
    last = m.index + m[0].length;
    m = ANSI_TOKEN_RE.exec(text);
  }
  if (last === 0) return escapeHtml(text);
  if (last < text.length) out += wrapAnsiChunk(text.slice(last), st);
  return out;
}

function stripTeammateWrapper(text) {
  if (typeof text !== 'string') return text;
  const match = text.match(/^<teammate-message[^>]*>\n?([\s\S]*?)(?:<\/teammate-message>\s*)?$/);
  return match ? match[1].trim() : text;
}

// The div.textContent -> innerHTML trick escapes only & < > : innerHTML serializes
// for *text* context, where quotes are correctly left raw. That made every
// attribute interpolation breakable with a bare " . It cannot be patched, so the
// escaping is explicit here.
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

function escapeHtml(text) {
  if (text == null) return '';
  return String(text).replace(/[&<>"'`]/g, (c) => HTML_ESCAPES[c]);
}

// For a value landing inside a quoted JS string inside an HTML attribute —
// onclick="fn('${escAttrJs(x)}')". The browser HTML-decodes the attribute before
// the JS parser sees it, so the JS escape must happen first and be escaped in turn.
function escAttrJs(value) {
  const js = String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
  return escapeHtml(js);
}

// For a value inside a double-quoted CSS attribute selector: [data-x="${escSel(v)}"].
// escapeHtml is wrong here — the DOM holds the decoded value, so &quot; in the
// selector matches nothing, and a bare " would end the selector string.
function escSel(value) {
  return String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

function toRelativeIfUnder(filePath, baseDir) {
  if (!filePath || !baseDir) return null;
  const fp = filePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const bd = baseDir.replace(/\\/g, '/').replace(/\/+$/, '');
  const isWin = /^[a-zA-Z]:\//.test(fp) || /^[a-zA-Z]:\//.test(bd);
  const a = isWin ? fp.toLowerCase() : fp;
  const b = isWin ? bd.toLowerCase() : bd;
  if (a === b) return '.';
  if (!a.startsWith(`${b}/`)) return null;
  return fp.slice(bd.length + 1);
}

function renderMarkdown(text) {
  if (typeof DOMPurify !== 'undefined' && typeof marked !== 'undefined') {
    return DOMPurify.sanitize(marked.parse(text));
  }
  return `<pre style="white-space:pre-wrap;margin:0;">${escapeHtml(text)}</pre>`;
}

function isLightTheme() {
  const saved = localStorage.getItem('theme');
  return (
    document.body.classList.contains('light') || (!saved && window.matchMedia('(prefers-color-scheme: light)').matches)
  );
}

function getMermaidTheme() {
  return isLightTheme() ? 'default' : 'dark';
}

function initMermaidBlocks(container) {
  if (typeof mermaid === 'undefined') return;
  const blocks = (container || document).querySelectorAll('pre.mermaid:not([data-processed])');
  if (blocks.length) mermaid.run({ nodes: [...blocks] });
}

function reinitMermaidTheme() {
  if (typeof mermaid === 'undefined') return;
  mermaid.initialize({ startOnLoad: false, theme: getMermaidTheme() });
  document.querySelectorAll('pre.mermaid[data-processed]').forEach((el) => {
    el.removeAttribute('data-processed');
    el.innerHTML = escapeHtml(el.getAttribute('data-original') || '');
  });
  initMermaidBlocks();
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
  const copyBtnHtml = `<button class="agent-tab-copy" title="Copy" onclick="copyAgentTabActive('${id}',this)">${ICON_COPY}</button>`;
  const tabsHtml = tabs
    .map(
      (t) =>
        `<div class="agent-tab${t.key === defaultTab ? ' active' : ''}" data-tab-group="${id}" data-tab-key="${t.key}" onclick="document.querySelectorAll('[data-tab-group=\\'${id}\\']').forEach(el=>{el.classList.toggle('active',el.dataset.tabKey==='${t.key}')})">${t.label}</div>`,
    )
    .join('');
  const panelsHtml = panels
    .map(
      (p) =>
        `<div class="agent-tab-panel${p.key === defaultTab ? ' active' : ''}" data-tab-group="${id}" data-tab-key="${p.key}"><div class="detail-desc rendered-md">${p.html}</div></div>`,
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
const namedColorMap = {
  red: { bg: 'rgba(239, 68, 68, 0.14)', color: '#dc2626' },
  blue: { bg: 'rgba(37, 99, 235, 0.14)', color: '#1d5bbf' },
  green: { bg: 'rgba(22, 163, 74, 0.14)', color: '#15803d' },
  purple: { bg: 'rgba(168, 85, 247, 0.14)', color: '#7c3aed' },
  orange: { bg: 'rgba(234, 88, 12, 0.14)', color: '#c2410c' },
  pink: { bg: 'rgba(219, 39, 119, 0.14)', color: '#b5246a' },
  yellow: { bg: 'rgba(202, 138, 4, 0.14)', color: '#92700c' },
  teal: { bg: 'rgba(14, 165, 133, 0.14)', color: '#0d7d65' },
  indigo: { bg: 'rgba(99, 102, 241, 0.14)', color: '#4f46e5' },
  cyan: { bg: 'rgba(6, 182, 212, 0.14)', color: '#0891b2' },
};
const ownerColorCache = {};
const teamColorMap = {};
function isInternalTask(task) {
  return task.metadata && task.metadata._internal === true;
}

function resolveNamedColor(colorName) {
  if (!colorName) return null;
  return namedColorMap[colorName.toLowerCase()] || null;
}

function updateTeamColors(agents, colors) {
  if (colors) Object.assign(teamColorMap, colors);
  for (const a of agents) {
    const name = a.type || a.name;
    if (name && a.color) teamColorMap[name] = a.color;
  }
}

function getOwnerColor(name) {
  if (ownerColorCache[name]) return ownerColorCache[name];
  if (teamColorMap[name]) {
    const c = resolveNamedColor(teamColorMap[name]);
    if (c) {
      ownerColorCache[name] = c;
      return c;
    }
  }
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
function toggleFilterMenu(e) {
  // Stops the click reaching .section-header (which would collapse the section) *and*
  // document (which would immediately close the menu we are opening).
  e?.stopPropagation();
  if (closeFilterMenu()) return;
  document.getElementById('filter-menu').classList.add('open');
  document.getElementById('filter-menu-btn')?.setAttribute('aria-expanded', 'true');
  renderFilterState();
  document.addEventListener('click', closeFilterMenu, { once: true });
  // Capture phase: the global keydown handler bails out on SELECT targets, and every
  // focusable thing in this popover is a select — Escape would never reach it otherwise.
  document.addEventListener('keydown', filterMenuKeydown, true);
  document.getElementById('project-filter')?.focus();
}

function filterMenuKeydown(e) {
  if (e.key !== 'Escape') return;
  e.stopPropagation();
  if (closeFilterMenu()) document.getElementById('filter-menu-btn')?.focus();
}

function closeFilterMenu() {
  const menu = document.getElementById('filter-menu');
  if (!menu?.classList.contains('open')) return false;
  menu.classList.remove('open');
  document.getElementById('filter-menu-btn')?.setAttribute('aria-expanded', 'false');
  document.removeEventListener('keydown', filterMenuKeydown, true);
  return true;
}

// One row per filter control: the select it mirrors, its value, whether it differs from the
// default, and two label forms — terse tokens for the header strip (which has ~15 characters
// before the sidebar's width ellipsises it) and long form for its tooltip.
const FILTERS = [
  {
    id: 'project-filter',
    value: () => filterProject ?? '',
    active: () => filterProject !== FILTER_DEFAULTS.project,
    short: () => (filterProject ? filterProject.split(/[/\\]/).pop() : 'all proj'),
    long: () => (filterProject ? `project ${filterProject}` : 'all projects'),
  },
  {
    id: 'session-filter',
    value: () => sessionFilter,
    active: () => sessionFilter !== FILTER_DEFAULTS.session,
    short: () => 'inactive',
    long: () => 'including inactive sessions',
  },
  {
    id: 'session-limit',
    value: () => sessionLimit,
    active: () => sessionLimit !== FILTER_DEFAULTS.limit,
    short: () => (sessionLimit === 'all' ? 'n=∞' : `n=${sessionLimit}`),
    long: () => (sessionLimit === 'all' ? 'no session limit' : `showing ${sessionLimit}`),
  },
];

// Keeps the header (summary + funnel tint) and the popover's selects in sync with state.
// Safe to call on every filter change — it only touches classes, values, and text.
function renderFilterState() {
  const short = [];
  const long = [];
  for (const f of FILTERS) {
    const active = f.active();
    if (active) {
      short.push(f.short());
      long.push(f.long());
    }
    const el = document.getElementById(f.id);
    if (!el) continue;
    const value = String(f.value());
    if (el.value !== value) el.value = value;
    el.classList.toggle('non-default', active);
  }

  const summary = document.getElementById('filter-summary');
  if (summary) {
    summary.textContent = short.join(' · ');
    summary.title = long.length ? `Active filters: ${long.join(', ')}` : '';
  }
  document.getElementById('filter-menu-btn')?.classList.toggle('has-filters', short.length > 0);
}

// biome-ignore lint/correctness/noUnusedVariables: used in HTML
function filterBySessions(value) {
  sessionFilter = value;
  if (value !== 'active') activityFilter.clear();
  renderFilterState();
  updateUrl();
  // Instant feedback from cached data, then refetch — the cached list was fetched
  // with the previous filter's server params (e.g. filter=active), so "All Sessions"
  // needs a server round-trip to actually include inactive sessions.
  renderSessions();
  renderActivityChip();
  fetchSessions(false);
}

// biome-ignore lint/correctness/noUnusedVariables: used in HTML
function changeSessionLimit(value) {
  sessionLimit = value;
  renderFilterState();
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
// Selecting text inside a dialog and releasing past its edge puts the mouseup on the
// backdrop, so the synthesized click targets the overlay and the `onclick="close…()"`
// on every .modal-overlay would dismiss it. Only a press that *started* on the
// backdrop counts as a dismissal.
let _overlayPressTarget = null;
document.addEventListener(
  'mousedown',
  (e) => {
    // Only an overlay is ever compared below, so don't hold a reference to any other node —
    // that would keep the last-pressed element (and a detached subtree, after a re-render)
    // alive until the next mousedown anywhere.
    _overlayPressTarget = e.target.classList?.contains('modal-overlay') ? e.target : null;
  },
  true,
);
document.addEventListener(
  'click',
  (e) => {
    if (!e.target.classList?.contains('modal-overlay')) return;
    if (_overlayPressTarget === e.target) return;
    e.stopPropagation();
  },
  true,
);

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

  const projectBtn = e.target.closest('.project-view-btn');
  if (projectBtn) {
    e.stopPropagation();
    const projectPath = projectBtn.dataset.projectPath;
    if (projectPath) fetchProjectView(projectPath);
    return;
  }

  if (e.target.closest('.pinned-ungroup-btn')) {
    e.stopPropagation();
    localStorage.setItem('groupPinnedSessions', 'false');
    renderSessions();
    return;
  }

  if (e.target.closest('.pinned-regroup-banner')) {
    localStorage.setItem('groupPinnedSessions', 'true');
    renderSessions();
    return;
  }

  const sgHeader = e.target.closest('.session-group-header');
  if (sgHeader) {
    if (e.target.closest('.sg-name-input')) return;
    e.stopPropagation();
    const groupId = sgHeader.dataset.groupId;
    const group = sgGroupById(groupId);
    if (!group) return;
    if (e.target.closest('.sg-rename')) {
      sgBeginRename(groupId);
      return;
    }
    if (e.target.closest('.sg-delete')) {
      if (confirm(`Delete group “${group.name}”? Its sessions and projects go back to Projects.`)) {
        sgDeleteGroup(groupId);
        renderSessions();
      }
      return;
    }
  }

  const header = e.target.closest(COLLAPSIBLE_HEADER_SELECTOR);
  if (header) {
    setGroupCollapsed(header, !collapsedProjectGroups.has(header.dataset.groupPath));
  }
});

// Used in HTML; also called by the hub project shim, so no biome suppression is needed.
function filterByProject(project) {
  filterProject = project || null;
  renderFilterState();
  updateUrl();
  fetchSessions(false);
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
  const prevRecent = recentProjects;
  recentProjects = new Set(
    projects.filter((p) => p.modifiedAt && new Date(p.modifiedAt).getTime() > cutoff).map((p) => p.path),
  );

  renderProjectDropdown(dropdown, projects);

  // recentProjects was empty before — sidebar rendered with __recent__ filter
  // dropping every session. Re-render now that we know which projects qualify.
  if (filterProject === '__recent__' && prevRecent.size === 0 && recentProjects.size > 0) {
    renderSessions();
  }
}

function renderProjectDropdown(dropdown, projects) {
  const recentSelected = filterProject === '__recent__' ? ' selected' : '';
  // A hub-pushed project with no session history isn't in /api/projects, so synthesize its
  // option here rather than in the hub shim — this also survives the SSE re-render below.
  const list =
    filterProject && filterProject !== '__recent__' && !projects.some((p) => p.path === filterProject)
      ? [...projects, { path: filterProject, modifiedAt: null }]
      : projects;
  dropdown.innerHTML =
    '<option value="">All Projects</option>' +
    `<option value="__recent__"${recentSelected}>Recent (24h)</option>` +
    list
      .map((p) => {
        const name = p.path.split(/[/\\]/).pop();
        const selected = p.path === filterProject ? ' selected' : '';
        return `<option value="${escapeHtml(p.path)}"${selected} title="${escapeHtml(p.path)}">${escapeHtml(name)}</option>`;
      })
      .join('');
  // The option list just changed under the select — re-assert tint and header summary.
  renderFilterState();
}

function updateThemeColor(isLight) {
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
    m.setAttribute('content', isLight ? '#e8e6e3' : '#101114');
  });
}

//#endregion

//#region THEME
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
  reinitMermaidTheme();
}

function syncHljsTheme() {
  const light = isLightTheme();
  const dark$ = document.getElementById('hljs-theme-dark');
  const light$ = document.getElementById('hljs-theme-light');
  if (dark$) dark$.disabled = light;
  if (light$) light$.disabled = !light;
}

function updateThemeIcon() {
  const light = isLightTheme();
  document.getElementById('theme-icon-dark').style.display = light ? 'none' : 'block';
  document.getElementById('theme-icon-light').style.display = light ? 'block' : 'none';
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
  buildThemeMenu();
  const colorTheme = localStorage.getItem('color-theme');
  if (colorTheme) document.body.dataset.colorTheme = colorTheme;
  syncColorThemeSelect(colorTheme || 'ember');
}

const COLOR_THEMES = [
  ['ember', 'Ember'],
  ['gruvbox', 'Gruvbox'],
  ['catppuccin', 'Catppuccin'],
  ['tokyo-night', 'Tokyo Night'],
  ['solarized', 'Solarized'],
  ['dracula', 'Dracula'],
  ['nord', 'Nord'],
  ['rose-pine', 'Rosé Pine'],
  ['everforest', 'Everforest'],
  ['kanagawa', 'Kanagawa'],
  ['one-dark', 'One Dark'],
  ['night-owl', 'Night Owl'],
  ['monokai', 'Monokai Pro'],
  ['github', 'GitHub'],
  ['ayu', 'Ayu'],
  ['vitesse', 'Vitesse'],
  ['synthwave', "Synthwave '84"],
];

function buildThemeMenu() {
  const menu = document.getElementById('themeMenu');
  menu.innerHTML = COLOR_THEMES.map(
    ([id, label]) =>
      `<button type="button" class="theme-menu-item theme-swatch-${id}" data-theme-id="${id}"
         onclick="event.stopPropagation(); setColorTheme('${id}'); toggleThemeMenu()">
         <span class="theme-swatch theme-swatch-${id}"><i class="sw-bg"></i><i class="sw-accent"></i><i class="sw-ink"></i></span>${label}
       </button>`,
  ).join('');
}

// biome-ignore lint/correctness/noUnusedVariables: used in HTML
function toggleThemeMenu(e) {
  e?.stopPropagation();
  const menu = document.getElementById('themeMenu');
  const open = menu.classList.toggle('open');
  if (open) {
    document.addEventListener('click', () => menu.classList.remove('open'), { once: true });
  }
}

function syncColorThemeSelect(id) {
  document.querySelectorAll('.theme-menu-item').forEach((el) => {
    el.classList.toggle('on', el.dataset.themeId === (id || 'ember'));
  });
}

// 'ember' (the :root default) has no override block — selecting it clears the attribute.
function setColorTheme(id) {
  if (!id || id === 'ember') {
    delete document.body.dataset.colorTheme;
    localStorage.removeItem('color-theme');
  } else {
    document.body.dataset.colorTheme = id;
    localStorage.setItem('color-theme', id);
  }
  syncColorThemeSelect(id);
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

// Shared drag-session lifecycle for every resize grip (sidebar, panels, modal):
// the `.dragging` class, text-selection suppression, and document-level
// listener add/remove live here once. Callers keep only their geometry.
// onStart may return false to veto the drag.
function _initDragResize(handle, { onStart, onMove, onEnd }) {
  let startX, startY;

  handle.addEventListener('mousedown', (e) => {
    if (onStart && onStart() === false) return;
    startX = e.clientX;
    startY = e.clientY;
    handle.classList.add('dragging');
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    e.preventDefault();
  });

  function move(e) {
    onMove(e.clientX - startX, e.clientY - startY);
  }

  function up() {
    handle.classList.remove('dragging');
    document.body.style.userSelect = '';
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    onEnd();
  }
}

function initSidebarResize() {
  const sidebar = document.querySelector('.sidebar');
  const handle = document.getElementById('sidebar-resize');
  let startWidth;

  _initDragResize(handle, {
    onStart() {
      if (sidebar.classList.contains('collapsed')) return false;
      startWidth = sidebar.offsetWidth;
      sidebar.classList.add('resizing');
    },
    onMove(dx) {
      const w = Math.min(600, Math.max(200, startWidth + dx));
      sidebar.style.setProperty('--sidebar-width', `${w}px`);
      sidebar.style.width = `${w}px`;
    },
    onEnd() {
      sidebar.classList.remove('resizing');
      localStorage.setItem('sidebar-width', sidebar.style.getPropertyValue('--sidebar-width'));
    },
  });
}

function initPanelResize(panelId, handleId, cssVar, storageKey) {
  const panel = document.getElementById(panelId);
  const handle = document.getElementById(handleId);
  let startWidth;

  _initDragResize(handle, {
    onStart() {
      startWidth = panel.offsetWidth;
      panel.classList.add('resizing');
    },
    onMove(dx) {
      const w = Math.max(200, startWidth - dx);
      panel.style.setProperty(cssVar, `${w}px`);
    },
    onEnd() {
      panel.classList.remove('resizing');
      localStorage.setItem(storageKey, panel.style.getPropertyValue(cssVar));
    },
  });
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

//#region SESSION_INFO
async function showSessionInfoModal(sessionId) {
  const session = sessions.find((s) => s.id === sessionId);
  if (!session) return;

  // Open modal immediately with session metadata (cwd / path / branch are
  // already in-memory). Plan / team / tasks are fetched in the background
  // and re-rendered when they arrive, so the modal doesn't block on network.
  _planSessionId = sessionId;
  const cachedTasks = currentSessionId === sessionId ? currentTasks : [];
  showInfoModal(session, null, cachedTasks, null, null);

  const rerender = (teamConfig, tasks, planContent, parentInfo) => {
    if (_planSessionId !== sessionId) return; // user opened a different modal
    const modal = document.getElementById('team-modal');
    if (!modal?.classList.contains('visible')) return; // user closed modal — don't reopen
    showInfoModal(session, teamConfig, tasks, planContent, parentInfo);
  };

  const teamPromise = session.isTeam
    ? fetch(`/api/teams/${session.teamName || sessionId}`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
    : Promise.resolve(null);

  const planPromise = fetch(`/api/sessions/${sessionId}/plan`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
    .then((data) => data?.content || null);

  const tasksPromise =
    cachedTasks.length > 0
      ? Promise.resolve(cachedTasks)
      : fetch(`/api/sessions/${sessionId}`)
          .then((r) => (r.ok ? r.json() : []))
          .catch(() => []);

  const parentPromise = fetch(`/api/sessions/${sessionId}/parent`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);

  const [teamConfig, planContent, tasks, parentInfo] = await Promise.all([
    teamPromise,
    planPromise,
    tasksPromise,
    parentPromise,
  ]);
  rerender(teamConfig, tasks, planContent, parentInfo);
}

let _infoModalSessionId = null;
let _pendingPlanContent = null;

function updateStickyBtnState() {
  const stickyBtn = document.getElementById('session-info-sticky-btn');
  if (!stickyBtn || !_infoModalSessionId) return;
  const isSticky = stickySessionIds.has(_infoModalSessionId);
  stickyBtn.style.display = '';
  stickyBtn.classList.toggle('active', isSticky);
  stickyBtn.title = isSticky ? 'Remove sticky pin' : 'Sticky pin — always show at top';
  const svg = stickyBtn.querySelector('svg');
  if (svg) svg.setAttribute('fill', isSticky ? 'currentColor' : 'none');
}

// Purely cosmetic: the tmp root is identical for every session and the encoded
// project segment is already shown in the Path row, so only the last two segments
// carry information. The full path stays in the tooltip and the copy button.
function abbreviateScratchpadDir(dir) {
  const sep = dir.includes('\\') ? '\\' : '/';
  return ['$tmp', '…', ...dir.split(/[/\\]/).slice(-2)].join(sep);
}

function showInfoModal(session, teamConfig, tasks, planContent, parentInfo) {
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
  // Each row: [label, value, { openPath?, abbrev? }] — `value` is authoritative
  // (tooltip + copy); `abbrev` only replaces the rendered text.
  const infoRows = [];
  infoRows.push(['Session', session.id, { openClaudeDir: true, openFile: session.jsonlPath }]);
  if (parentInfo?.parentSessionId) {
    infoRows.push([
      parentInfo.relation === 'compact' ? 'Continued from' : 'Forked from',
      parentInfo.parentSessionId,
      { openClaudeDir: true, openFile: parentInfo.parentJsonlPath, openSession: parentInfo.parentSessionId },
    ]);
  }
  if (session.slug && session.hasPlan) {
    infoRows.push(['Slug', session.slug, { openClaudeDir: true, openFile: session.planPath }]);
  }
  if (session.project) {
    const projectName = session.project.split(/[/\\]/).pop();
    infoRows.push(['Project', projectName, { openPath: session.projectDir }]);
    infoRows.push(['Path', session.project, { openPath: session.project }]);
    if (session.cwd) {
      infoRows.push(['CWD', session.cwd, { openPath: session.cwd }]);
    }
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
  if (session.scratchpadDir) {
    infoRows.push([
      'Scratchpad',
      session.scratchpadDir,
      { openPath: session.scratchpadDir, abbrev: abbreviateScratchpadDir(session.scratchpadDir) },
    ]);
  }
  if (session.sharedTaskList) {
    infoRows.push(['Shared Tasks', session.sharedTaskList]);
  }
  if (teamConfig?.configPath) {
    const configDir = teamConfig.configPath.replace(/[/\\][^/\\]+$/, '');
    infoRows.push(['Team Config', teamConfig.configPath, { openPath: configDir, openFile: teamConfig.configPath }]);
  }
  const clickableStyle =
    'font-family: var(--mono); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; color: var(--accent-text); text-decoration: underline; text-decoration-style: dotted; text-underline-offset: 3px;';
  const plainStyle =
    'font-family: var(--mono); font-size: 12px; color: var(--text-primary); user-select: all; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
  html += `<div class="team-modal-meta info-grid">`;
  infoRows.forEach(([label, value, opts]) => {
    html += `<span style="font-weight: 500; color: var(--text-secondary); font-size: 12px; white-space: nowrap;">${label}</span>`;
    if (opts?.openSession) {
      html += `<span onclick="openSessionFromInfo('${escAttrJs(opts.openSession)}')" style="${clickableStyle}" title="Open session in app">${escapeHtml(value)}</span>`;
    } else {
      html += `<span style="${plainStyle}" title="${escapeHtml(value)}">${escapeHtml(opts?.abbrev || value)}</span>`;
    }
    const copyBtn = `<button onclick="copyWithFeedback('${escAttrJs(value)}', this)" title="Copy">${ICON_COPY}</button>`;
    let openBtn = '';
    if (opts?.openClaudeDir || opts?.openPath) {
      const folder = opts.openClaudeDir ? '' : escapeHtml(opts.openPath);
      const file = opts.openFile ? escapeHtml(opts.openFile) : '';
      openBtn = `<button data-folder="${folder}" data-file="${file}" data-claude-dir="${opts.openClaudeDir ? '1' : ''}" onclick="openFolderInEditor(this.dataset.claudeDir ? undefined : this.dataset.folder, this.dataset.file || undefined)" title="Open in editor">${ICON_OPEN_EXTERNAL}</button>`;
    }
    html += `<span class="row-actions">${copyBtn}${openBtn}</span>`;
  });
  html += `</div>`;

  if (session.goal?.condition) {
    html += `<div class="info-goal-card">
          <div class="info-goal-head"><span class="info-goal-icon">◎</span>Goal</div>
          <div class="info-goal-text">${escapeHtml(session.goal.condition)}</div>
        </div>`;
  }

  if (session.contextStatus) {
    html += `<hr style="border: none; border-top: 1px solid var(--border); margin: 12px 0;">`;
    html += renderContextDetail(session.contextStatus);
  }

  if (planContent) {
    _pendingPlanContent = planContent;
    const titleMatch = planContent.match(/^#\s+(.+)$/m);
    const planTitle = titleMatch ? titleMatch[1].trim() : null;
    html += `<div data-plan-card="1" onclick="openPlanModal()" style="margin-bottom: 16px; padding: 10px 14px; background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 8px; cursor: pointer; display: flex; align-items: center; gap: 10px; transition: all 0.15s ease;" onmouseover="this.style.borderColor='var(--accent)';this.style.background='var(--bg-hover)'" onmouseout="this.style.borderColor='var(--border)';this.style.background='var(--bg-elevated)'">
          <span style="font-size: 14px;">📋</span>
          <div style="flex: 1; min-width: 0;">
            <div style="font-size: 11px; font-weight: 500; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px;">Plan</div>
            ${planTitle ? `<div style="font-size: 13px; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(planTitle)}</div>` : ''}
          </div>
          <svg viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="2" style="width: 16px; height: 16px; flex-shrink: 0;"><path d="M9 18l6-6-6-6"/></svg>
        </div>`;
  }

  html += renderLinkedDocsHtml(session.id);

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
      const mc = resolveNamedColor(member.color);
      const borderStyle = mc ? ` style="border-left:3px solid ${mc.color}"` : '';
      const nameStyle = mc ? ` style="color:${mc.color}"` : '';
      html += `
            <div class="team-member-card"${borderStyle}>
              <div class="member-name"${nameStyle}>${escapeHtml(member.name)}</div>
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
  // Bind to the section, not bodyEl: bodyEl outlives the modal, so listeners on it
  // would stack up once per open and fire the click handler N times.
  bindLinkedDocsHandlers(bodyEl.querySelector('.linked-docs-section'), session.id);
  const alreadyVisible = modal.classList.contains('visible');
  _infoModalSessionId = session.id;
  updateStickyBtnState();
  updateDismissBtnState();
  const costBtn = document.getElementById('session-info-cost-btn');
  if (costBtn) costBtn.style.display = window.__HUB__?.enabled || appConfig.costUrl ? '' : 'none';
  const mkBtn = document.getElementById('session-info-marketplace-btn');
  const memBtn = document.getElementById('session-info-memory-btn');
  const proj = session.project;
  if (mkBtn) mkBtn.style.display = proj && (window.__HUB__?.enabled || appConfig.marketplaceUrl) ? '' : 'none';
  if (memBtn) memBtn.style.display = proj && (window.__HUB__?.enabled || appConfig.memoryUrl) ? '' : 'none';
  modal.classList.add('visible');

  if (alreadyVisible) return; // re-render during deferred hydration — key handler already attached

  const keyHandler = (e) => {
    if (e.key === 'Escape') {
      // An inline editor inside the modal owns Escape first — it reverts itself.
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
      if (document.getElementById('plan-modal').classList.contains('visible')) return;
      if (document.getElementById('tool-stats-modal').classList.contains('visible')) return;
      e.preventDefault();
      closeTeamModal();
      document.removeEventListener('keydown', keyHandler);
    }
  };
  document.addEventListener('keydown', keyHandler);
}

function closeTeamModal() {
  document.getElementById('team-modal').classList.remove('visible');
  _planSessionId = null;
}

// biome-ignore lint/correctness/noUnusedVariables: used in HTML
function openSessionFromInfo(sessionId) {
  closeTeamModal();
  fetchTasks(sessionId);
}

// biome-ignore lint/correctness/noUnusedVariables: used in HTML
function toggleDismissSession(sessionId) {
  if (dismissedSessionIds.has(sessionId)) {
    dismissedSessionIds.delete(sessionId);
  } else {
    dismissedSessionIds.add(sessionId);
  }
  updateDismissBtnState();
  renderSessions();
  renderActivityChip();
}

function updateDismissBtnState() {
  const btn = document.getElementById('session-info-dismiss-btn');
  if (!btn || !_infoModalSessionId) return;
  const isDismissed = dismissedSessionIds.has(_infoModalSessionId);
  btn.textContent = isDismissed ? 'Restore' : 'Dismiss';
  btn.title = isDismissed ? 'Restore — show in active list again' : 'Dismiss — hide from active list';
}

let _planSessionId = null;

//#endregion

//#region SESSION_PICKER
// Snapshot of what the sidebar is showing, taken once per open: the picker only ever offers
// sessions already on screen, and the recency order cannot change while it is up.
let spSource = [];
let spRows = [];
let spIdx = 0;

function openSessionPicker() {
  const input = document.getElementById('session-picker-input');
  input.value = '';
  spSource = getFilteredSessions().sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt));
  document.getElementById('session-picker-modal').classList.add('visible');
  renderSessionPicker();
  input.focus();
}

function closeSessionPicker() {
  hideModalOverlay('session-picker-modal');
}

function spMatches(session, query) {
  return (
    fuzzyMatch(session.name, query) ||
    fuzzyMatch(session.id, query) ||
    fuzzyMatch(session.project, query) ||
    fuzzyMatch(session.gitBranch, query)
  );
}

// Spelled out rather than interpolated so the class never comes from a variable.
const SP_DOTS = {
  waiting: '<span class="activity-dot waiting"></span>',
  live: '<span class="activity-dot live"></span>',
  active: '<span class="activity-dot active"></span>',
  idle: '<span class="activity-dot"></span>',
};

function spDotHtml(session) {
  if (isWaitingSession(session)) return SP_DOTS.waiting;
  if (isSessionLive(session)) return SP_DOTS.live;
  return isActiveSession(session) ? SP_DOTS.active : SP_DOTS.idle;
}

function renderSessionPicker() {
  const list = document.getElementById('session-picker-list');
  const query = document.getElementById('session-picker-input').value.trim();
  spRows = spSource.filter((s) => spMatches(s, query));

  if (!spRows.length) {
    spIdx = -1;
    list.innerHTML = `<div class="sp-empty">${spSource.length ? 'No session matches' : 'No sessions in the current sidebar filter'}</div>`;
    return;
  }

  list.innerHTML = spRows
    .map((s, i) => {
      const project = s.project ? s.project.split(/[/\\]/).pop() : '';
      return `<button class="sp-row${s.id === currentSessionId ? ' current' : ''}" data-idx="${i}" title="${escapeHtml(s.id)}">
        ${spDotHtml(s)}
        <span class="sp-name">${escapeHtml(sessionDisplayName(s))}</span>
        <span class="sp-project">${escapeHtml(project)}</span>
        ${s.gitBranch ? `<span class="sp-branch">${escapeHtml(s.gitBranch)}</span>` : ''}
        <span class="sp-count">${s.completed}/${s.taskCount}</span>
        <span class="sp-time">${formatDate(s.modifiedAt)}</span>
      </button>`;
    })
    .join('');
  spSelect(0);
}

function spSelect(idx) {
  const list = document.getElementById('session-picker-list');
  list.children[spIdx]?.classList.remove('selected');
  spIdx = Math.min(Math.max(idx, 0), spRows.length - 1);
  const row = list.children[spIdx];
  row?.classList.add('selected');
  row?.scrollIntoView({ block: 'nearest' });
}

async function spOpen(idx) {
  const session = spRows[idx];
  if (!session) return;
  closeSessionPicker();
  await revealSession(session.id);
}

function initSessionPicker() {
  const input = document.getElementById('session-picker-input');
  input.addEventListener('input', renderSessionPicker);
  // Bound on the input: the global handler returns early on INPUT targets.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSessionPicker();
    else if (matchKey(e, 'ArrowDown') || (e.ctrlKey && e.key === 'n')) spSelect(spIdx + 1);
    else if (matchKey(e, 'ArrowUp') || (e.ctrlKey && e.key === 'p')) spSelect(spIdx - 1);
    else if (e.key === 'Enter') spOpen(spIdx);
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  document.getElementById('session-picker-list').addEventListener('click', (e) => {
    const row = e.target.closest('.sp-row');
    if (row) spOpen(Number(row.dataset.idx));
  });
}
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

// biome-ignore lint/correctness/noUnusedVariables: used in HTML
function showLoopModal(sessionId) {
  const body = document.getElementById('loop-modal-body');
  body.innerHTML = '<div style="padding:16px;color:var(--text-secondary);">Loading…</div>';
  document.getElementById('loop-modal').classList.add('visible');
  fetch(`/api/sessions/${sessionId}/loop`)
    .then((r) => (r.ok ? r.json() : { wakeups: [], crons: [] }))
    .catch(() => ({ wakeups: [], crons: [] }))
    .then((data) => {
      renderLoopModalBody(data);
    });
}

function fmtLoopDelay(s) {
  if (s == null) return '';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

function fmtLoopFireTime(timestamp, delaySeconds) {
  if (!timestamp || delaySeconds == null) return { abs: '', rel: '', status: '' };
  const fireMs = new Date(timestamp).getTime() + delaySeconds * 1000;
  const fireDate = new Date(fireMs);
  const diff = fireMs - Date.now();
  const abs = fireDate.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const absSec = Math.abs(Math.round(diff / 1000));
  const rel =
    absSec < 60 ? `${absSec}s` : absSec < 3600 ? `${Math.round(absSec / 60)}m` : `${(absSec / 3600).toFixed(1)}h`;
  if (diff > 0) return { abs, rel: `in ${rel}`, status: 'pending' };
  return { abs, rel: `${rel} ago`, status: 'fired' };
}

const LOOP_CLOCK_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
const LOOP_CRON_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v4l3 3"/><circle cx="12" cy="12" r="10"/></svg>';

function loopField(label, value, mono = false) {
  if (!value) return '';
  const inner = mono ? `<code>${escapeHtml(value)}</code>` : escapeHtml(value);
  return `<div class="loop-field"><div class="loop-field-label">${label}</div><div class="loop-field-val">${inner}</div></div>`;
}

function renderLoopRow(item, kind) {
  const when = item.timestamp ? formatDate(item.timestamp) : '';
  let headline = '';
  let footer = '';
  let fields = '';
  if (kind === 'wakeup') {
    const fire = fmtLoopFireTime(item.timestamp, item.delaySeconds);
    const delayLbl = item.delaySeconds != null ? `delay ${fmtLoopDelay(item.delaySeconds)}` : '';
    if (fire.abs) {
      headline = `<div class="loop-headline loop-fire-${fire.status}">${LOOP_CLOCK_SVG}<span class="loop-headline-rel">${fire.status === 'pending' ? 'Fires' : 'Fired'} ${escapeHtml(fire.rel)}</span><span class="loop-headline-abs">${escapeHtml(fire.abs)}</span></div>`;
    }
    fields = loopField('Reason', item.reason) + loopField('Prompt', item.prompt, true);
    footer = `<div class="loop-foot">scheduled ${escapeHtml(when)}${delayLbl ? ` · ${delayLbl}` : ''}</div>`;
  } else {
    if (item.cron) {
      headline = `<div class="loop-headline">${LOOP_CRON_SVG}<span class="loop-headline-rel"><code>${escapeHtml(item.cron)}</code></span></div>`;
    }
    fields = loopField('Description', item.description) + loopField('Prompt', item.prompt, true);
    footer = `<div class="loop-foot">created ${escapeHtml(when)}</div>`;
  }
  return `<div class="loop-row">${headline}${fields}${footer}</div>`;
}

function renderLoopModalBody(data) {
  const body = document.getElementById('loop-modal-body');
  const wakeups = data.wakeups || [];
  const crons = data.crons || [];
  if (!wakeups.length && !crons.length) {
    body.innerHTML =
      '<div style="padding:24px;text-align:center;color:var(--text-secondary);">No scheduled wakeups or cron jobs.</div>';
    return;
  }
  const section = (title, items, kind) =>
    items.length
      ? `<h4 class="loop-section-title">${title} <span class="loop-count">${items.length}</span></h4>${items.map((i) => renderLoopRow(i, kind)).join('')}`
      : '';
  body.innerHTML = section('Wakeups', wakeups, 'wakeup') + section('Cron jobs', crons, 'cron');
}

function renderGoalSubtitle(session) {
  const g = session.goal;
  if (!g?.condition) return '';
  const short = g.condition.length > 70 ? `${g.condition.slice(0, 70)}…` : g.condition;
  // Only active (unmet) goals reach here — a met goal auto-clears. Clicking
  // opens the info modal (full text); stopPropagation so it doesn't also
  // trigger the card's fetchTasks.
  return `<div class="session-goal" onclick="event.stopPropagation(); showSessionInfoModal('${escAttrJs(session.id)}')" title="${escapeHtml(g.condition)}"><span class="session-goal-icon">◎</span><span class="session-goal-text">${escapeHtml(short)}</span></div>`;
}

function renderLoopBadge(session) {
  const li = session.loopInfo;
  const total = (li?.wakeupCount || 0) + (li?.cronCount || 0);
  if (total === 0) return '';
  let tip = `${li.wakeupCount} wakeup${li.wakeupCount === 1 ? '' : 's'}, ${li.cronCount} cron${li.cronCount === 1 ? '' : 's'}`;
  if (li.latest?.timestamp && li.latest.delaySeconds != null) {
    const f = fmtLoopFireTime(li.latest.timestamp, li.latest.delaySeconds);
    if (f.abs) tip += ` — latest ${f.status === 'pending' ? 'fires' : 'fired'} ${f.rel} (${f.abs})`;
  }
  return `<span class="loop-badge" onclick="event.stopPropagation(); showLoopModal('${escAttrJs(session.id)}')" title="${escapeHtml(tip)}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></span>`;
}

function closeLoopModal() {
  document.getElementById('loop-modal').classList.remove('visible');
}

const WORKFLOW_GEAR_SVG =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';

// Standard "open in editor" glyph — matches the message-detail / plan modals.
const ICON_OPEN_EDITOR =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';

function renderWorkflowBadge(session) {
  if (!session.hasWorkflow) return '';
  const n = session.workflowCount || 0;
  const tip = `${n} workflow${n === 1 ? '' : 's'}`;
  return `<span class="workflow-badge" onclick="event.stopPropagation(); showWorkflowModal('${escAttrJs(session.id)}')" title="${escapeHtml(tip)}">${WORKFLOW_GEAR_SVG}</span>`;
}

let _workflowSessionId = null;
let _workflowHeaderId = null;
let _workflowList = [];

// biome-ignore lint/correctness/noUnusedVariables: used in HTML
function showWorkflowModal(sessionId) {
  _workflowSessionId = sessionId;
  setWorkflowHeader('Workflows', null);
  const body = document.getElementById('workflow-modal-body');
  body.innerHTML = '<div style="padding:16px;color:var(--text-secondary);">Loading…</div>';
  document.getElementById('workflow-modal').classList.add('visible');
  fetch(`/api/sessions/${sessionId}/workflows`)
    .then((r) => (r.ok ? r.json() : { workflows: [] }))
    .catch(() => ({ workflows: [] }))
    .then((data) => {
      _workflowList = data.workflows || [];
      if (!_workflowList.length) {
        setWorkflowHeader('Workflows', null);
        body.innerHTML =
          '<div style="padding:24px;text-align:center;color:var(--text-secondary);">No workflow scripts for this session.</div>';
      } else if (_workflowList.length === 1) {
        showWorkflowRun(_workflowList[0].id);
      } else {
        renderWorkflowPicker(_workflowList);
      }
    });
}

function setWorkflowHeader(name, wfId) {
  const titleText = document.getElementById('workflow-modal-title-text');
  const headerBtn = document.getElementById('workflow-modal-open-btn');
  _workflowHeaderId = wfId || null;
  if (titleText) {
    titleText.textContent = name;
    titleText.title = wfId ? name : '';
  }
  if (headerBtn) headerBtn.style.display = wfId ? '' : 'none';
}

// Multiple workflows: pick one to drill into (we show a single run at a time).
function renderWorkflowPicker(workflows) {
  setWorkflowHeader('Workflows', null);
  const body = document.getElementById('workflow-modal-body');
  body.innerHTML = workflows
    .map((w) => {
      const when = w.modifiedAt ? formatDate(w.modifiedAt) : '';
      return `<div class="workflow-row" onclick="showWorkflowRun('${escAttrJs(w.id)}')">
        <div class="workflow-row-head">
          <span class="workflow-row-name">${escapeHtml(w.name || w.id)}</span>
          <span class="workflow-row-id"><code>${escapeHtml(w.id)}</code></span>
          <button class="icon-btn workflow-open-icon" aria-label="Open in editor" title="Open in editor" onclick="event.stopPropagation(); openWorkflowInEditor('${escAttrJs(w.id)}')">${ICON_OPEN_EDITOR}</button>
        </div>
        ${w.description ? `<div class="workflow-row-desc">${escapeHtml(w.description)}</div>` : ''}
        ${when ? `<div class="workflow-row-meta">${escapeHtml(when)}</div>` : ''}
      </div>`;
    })
    .join('');
}

function showWorkflowRun(wfId) {
  const name = _workflowList.find((w) => w.id === wfId)?.name || wfId;
  setWorkflowHeader(name, wfId);
  const body = document.getElementById('workflow-modal-body');
  body.innerHTML = '<div style="padding:16px;color:var(--text-secondary);">Loading…</div>';
  fetch(`/api/sessions/${_workflowSessionId}/workflows/${encodeURIComponent(wfId)}/run`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
    .then((run) => {
      if (!run) {
        body.innerHTML = '<div style="padding:16px;color:var(--text-secondary);">Failed to load run state.</div>';
        return;
      }
      renderWorkflowRun(run);
    });
}

function fmtTokens(t) {
  return t >= 1000 ? `${(t / 1000).toFixed(1).replace(/\.0$/, '')}k` : `${t}`;
}

function shortModelName(model) {
  return model ? model.replace(/^claude-/, '').replace(/-\d{8}$/, '') : '';
}

function renderWorkflowRun(run) {
  const body = document.getElementById('workflow-modal-body');
  const allDone = run.startedCount > 0 && run.doneCount >= run.startedCount;
  const wall =
    run.startedAt && run.stoppedAt ? formatDuration(new Date(run.stoppedAt) - new Date(run.startedAt)) : null;

  const back =
    _workflowList.length > 1
      ? `<div class="wf-back" onclick="renderWorkflowPicker(_workflowList)">‹ All workflows</div>`
      : '';

  const stats = [`${run.doneCount}/${run.startedCount} agents`, wall ? escapeHtml(wall) : null]
    .filter(Boolean)
    .join(' · ');

  const desc = run.description ? `<div class="wf-run-desc">${escapeHtml(run.description)}</div>` : '';

  const phases = (run.phases || [])
    .map(
      (p) => `<div class="wf-phase">
        <span class="wf-phase-mark${allDone ? ' done' : ''}">${allDone ? '✓' : ''}</span>
        <span class="wf-phase-title">${escapeHtml(p.title)}</span>
        ${p.detail ? `<span class="wf-phase-detail">${escapeHtml(p.detail)}</span>` : ''}
      </div>`,
    )
    .join('');
  const phasesBlock = phases ? `<div class="wf-section-title">Phases</div><div class="wf-phases">${phases}</div>` : '';

  const agents = (run.agents || [])
    .map((a) => {
      const dur = a.durationMs != null ? formatDuration(a.durationMs) : '';
      const running = a.status !== 'done';
      return `<div class="wf-agent" onclick="showAgentModal('${escAttrJs(a.agentId)}')" title="${escapeHtml(a.agentId)}">
        <span class="wf-agent-type">${escapeHtml(a.type || 'agent')}</span>
        <span class="wf-agent-model">${escapeHtml(shortModelName(a.model))}</span>
        <span class="wf-agent-tok">${a.outputTokens ? `${fmtTokens(a.outputTokens)} tok` : ''}</span>
        <span class="wf-agent-dur">${escapeHtml(dur)}</span>
        <span class="wf-agent-status ${running ? 'running' : 'done'}">${running ? '●' : '✓'}</span>
      </div>`;
    })
    .join('');
  const agentsBlock = run.agents?.length
    ? `<div class="wf-section-title">Agents · ${run.agents.length}</div><div class="wf-agents">${agents}</div>`
    : '<div class="wf-section-title">Agents</div><div class="wf-empty">No agent runs recorded yet.</div>';

  body.innerHTML = `<div class="workflow-run">
    ${back}
    ${desc}
    <div class="wf-run-stats">${stats} · <code>${escapeHtml(run.id)}</code></div>
    ${phasesBlock}
    ${agentsBlock}
    <details class="wf-source">
      <summary>Source</summary>
      <div class="workflow-row-code"></div>
    </details>
  </div>`;

  const details = body.querySelector('.wf-source');
  details.addEventListener(
    'toggle',
    () => {
      if (details.open) loadWorkflowCode(run.id, details.querySelector('.workflow-row-code'));
    },
    { once: true },
  );
}

function loadWorkflowCode(wfId, codeEl) {
  if (!codeEl) return;
  codeEl.innerHTML = '<div style="padding:8px 0;color:var(--text-secondary);">Loading…</div>';
  fetch(`/api/sessions/${_workflowSessionId}/workflows/${encodeURIComponent(wfId)}`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
    .then((data) => {
      if (!data?.content) {
        codeEl.innerHTML = '<div style="padding:8px 0;color:var(--text-secondary);">Failed to load script.</div>';
        return;
      }
      let highlighted;
      if (typeof hljs !== 'undefined' && hljs.getLanguage('javascript')) {
        highlighted = hljs.highlight(data.content, { language: 'javascript' }).value;
      } else {
        highlighted = escapeHtml(data.content);
      }
      codeEl.innerHTML = `<pre><code class="hljs language-javascript">${highlighted}</code></pre>`;
    });
}

function openWorkflowInEditor(wfId) {
  postAndToast(`/api/sessions/${_workflowSessionId}/workflows/${encodeURIComponent(wfId)}/open`, {}, 'in editor');
}

// biome-ignore lint/correctness/noUnusedVariables: used in HTML
function openWorkflowHeaderScript() {
  if (_workflowHeaderId) openWorkflowInEditor(_workflowHeaderId);
}

function closeWorkflowModal() {
  document.getElementById('workflow-modal').classList.remove('visible');
  _workflowSessionId = null;
  _workflowList = [];
  setWorkflowHeader('Workflows', null);
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
  // A saved plan opened while its approval ask is still pending (sidebar
  // click, 'p') is the same review moment — offer Approve/Reject here too.
  document.getElementById('plan-approval-footer')?.remove();
  if (currentWaiting?.kind === 'plan' && isWaitingAnswerable() && _planSessionId === currentSessionId) {
    const controls = document.createElement('div');
    controls.id = 'plan-approval-footer';
    controls.innerHTML = planApprovalControlsHtml('plan-modal-reject-feedback');
    document.querySelector('#plan-modal .modal-footer').prepend(controls);
  }
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
  hideModalOverlay('plan-modal');
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

// biome-ignore lint/correctness/noUnusedVariables: used in HTML
function openCost(sessionId) {
  if (window.__HUB__?.enabled) {
    hubNavigate('cost', `?view=detail&session=${encodeURIComponent(sessionId)}`);
  } else if (appConfig.costUrl) {
    window.open(`${appConfig.costUrl}?view=detail&session=${encodeURIComponent(sessionId)}`, '_blank');
  }
}

function openMarketplace(projectPath) {
  const params = new URLSearchParams({ project: projectPath });
  if (window.__HUB__?.enabled) {
    hubNavigate('marketplace', `?${params}`);
  } else if (appConfig.marketplaceUrl) {
    const url = new URL(appConfig.marketplaceUrl);
    url.search = params.toString();
    window.open(url.toString(), '_blank');
  }
}

function openMemory(projectPath) {
  const params = new URLSearchParams({ project: projectPath });
  if (window.__HUB__?.enabled) {
    hubNavigate('memory', `?${params}`);
  } else if (appConfig.memoryUrl) {
    const url = new URL(appConfig.memoryUrl);
    url.search = params.toString();
    window.open(url.toString(), '_blank');
  }
}

function openForInfoModalProject(open) {
  const s = sessions.find((x) => x.id === _infoModalSessionId);
  if (s?.project) open(s.project);
}
// biome-ignore lint/correctness/noUnusedVariables: used in HTML
function openMarketplaceForInfoModal() {
  openForInfoModalProject(openMarketplace);
}
// biome-ignore lint/correctness/noUnusedVariables: used in HTML
function openMemoryForInfoModal() {
  openForInfoModalProject(openMemory);
}

//#endregion

//#region TOOL_STATS_MODAL
let _toolStatsSortCol = 'count';
let _toolStatsSortDir = 'desc';
let _toolStatsData = null;

// biome-ignore lint/correctness/noUnusedVariables: used in HTML
function showToolStatsModal(sessionId) {
  if (!sessionId) return;
  const body = document.getElementById('tool-stats-modal-body');
  body.innerHTML = '<div style="padding:16px;color:var(--text-secondary);">Loading…</div>';
  document.getElementById('tool-stats-modal').classList.add('visible');

  fetch(`/api/sessions/${sessionId}/tool-stats`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
    .then((data) => {
      if (!data) {
        body.innerHTML = '<div style="padding:16px;color:var(--text-secondary);">Failed to load tool statistics.</div>';
        return;
      }
      _toolStatsSortCol = 'count';
      _toolStatsSortDir = 'desc';
      _toolStatsData = data;
      body.innerHTML = renderToolStatsBody(data);
    });
}

function renderToolStatsBody(data) {
  const { totalCalls, uniqueTools, totalFailed, totalRejected, tools } = data;

  const summary = `
    <div class="tool-stats-summary">
      <div class="tool-stats-chip"><span class="tool-stats-chip-val">${totalCalls}</span><span class="tool-stats-chip-lbl">Total calls</span></div>
      <div class="tool-stats-chip"><span class="tool-stats-chip-val">${uniqueTools}</span><span class="tool-stats-chip-lbl">Unique tools</span></div>
      <div class="tool-stats-chip"><span class="tool-stats-chip-val${totalFailed > 0 ? ' failed' : ''}">${totalFailed}</span><span class="tool-stats-chip-lbl">Failed</span></div>
      <div class="tool-stats-chip"><span class="tool-stats-chip-val${totalRejected > 0 ? ' rejected' : ''}">${totalRejected}</span><span class="tool-stats-chip-lbl">Rejected</span></div>
    </div>`;

  if (!tools?.length) {
    return (
      summary +
      '<div style="padding:24px;text-align:center;color:var(--text-tertiary);">No tool calls recorded in this session.</div>'
    );
  }

  const sorted = [...tools].sort((a, b) => {
    if (_toolStatsSortCol === 'name')
      return _toolStatsSortDir === 'asc' ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name);
    return _toolStatsSortDir === 'asc'
      ? a[_toolStatsSortCol] - b[_toolStatsSortCol]
      : b[_toolStatsSortCol] - a[_toolStatsSortCol];
  });
  const arrow = (col) => (col === _toolStatsSortCol ? (_toolStatsSortDir === 'asc' ? ' ▲' : ' ▼') : '');

  const table = `<table class="tool-stats-table">
    <thead><tr>
      <th onclick="toolStatsSortBy('name')">Tool${arrow('name')}</th>
      <th onclick="toolStatsSortBy('count')">Calls${arrow('count')}</th>
      <th onclick="toolStatsSortBy('success')">✓ Success${arrow('success')}</th>
      <th onclick="toolStatsSortBy('failed')">✗ Failed${arrow('failed')}</th>
      <th onclick="toolStatsSortBy('rejected')">⊘ Rejected${arrow('rejected')}</th>
      <th onclick="toolStatsSortBy('impact')" title="Share of total tool output by character count">Impact${arrow('impact')}</th>
    </tr></thead>
    <tbody>${sorted
      .map(
        (t) => `<tr>
      <td class="tool-name">${escapeHtml(t.name)}</td>
      <td>${t.count}</td>
      <td>${t.success > 0 ? `<span class="badge-success">${t.success}</span>` : '—'}</td>
      <td>${t.failed > 0 ? `<span class="badge-failed">${t.failed}</span>` : '—'}</td>
      <td>${t.rejected > 0 ? `<span class="badge-rejected">${t.rejected}</span>` : '—'}</td>
      <td class="impact-cell">${
        t.impact != null
          ? `<div class="impact-cell-inner"><div class="impact-bar-wrap"><div class="impact-bar-fill" style="width:${t.impact}%"></div></div><span class="impact-pct">${t.impact < 1 ? '<1' : t.impact}%</span></div>`
          : '—'
      }</td>
    </tr>`,
      )
      .join('')}</tbody>
  </table>`;

  return summary + table;
}

// biome-ignore lint/correctness/noUnusedVariables: used in HTML
function toolStatsSortBy(col) {
  if (_toolStatsSortCol === col) {
    _toolStatsSortDir = _toolStatsSortDir === 'asc' ? 'desc' : 'asc';
  } else {
    _toolStatsSortCol = col;
    _toolStatsSortDir = col === 'name' ? 'asc' : 'desc';
  }
  if (!_toolStatsData) return;
  const body = document.getElementById('tool-stats-modal-body');
  body.innerHTML = renderToolStatsBody(_toolStatsData);
}

function closeToolStatsModal() {
  document.getElementById('tool-stats-modal').classList.remove('visible');
}
//#endregion

//#region OWNER_FILTER
function updateOwnerFilter() {
  const bar = document.getElementById('owner-filter-bar');
  const select = document.getElementById('owner-filter');

  const session = sessions.find((s) => s.id === currentSessionId);
  if (!session?.isTeam) {
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

//#region PWA
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js');
}

//#endregion

//#region INIT
loadTheme();
if (localStorage.getItem('sessions-filtersCollapsed') === 'true') {
  document.getElementById('sessions-filters').classList.add('collapsed');
  document.getElementById('sessions-chevron').classList.add('rotated');
}

document.addEventListener('DOMContentLoaded', () => {
  if (typeof marked !== 'undefined' && typeof hljs !== 'undefined') {
    const renderer = new marked.Renderer();
    renderer.code = ({ text, lang }) => {
      if (lang === 'mermaid') {
        return `<pre class="mermaid" data-original="${escapeHtml(text)}">${escapeHtml(text)}</pre>`;
      }
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

  if (typeof mermaid !== 'undefined') {
    mermaid.initialize({ startOnLoad: false, theme: getMermaidTheme() });
    let mermaidPending = false;
    const mo = new MutationObserver(() => {
      if (mermaidPending) return;
      mermaidPending = true;
      queueMicrotask(() => {
        mermaidPending = false;
        initMermaidBlocks();
      });
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }
});

loadSidebarState();
try {
  const cg = JSON.parse(localStorage.getItem('collapsedGroups') || '[]');
  // biome-ignore lint/suspicious/useIterableCallbackReturn: forEach side-effect
  cg.forEach((p) => collapsedProjectGroups.add(p));
} catch (_) {}
loadSessionGroups();
initSessionGroupsDnd();
initSessionPicker();
try {
  const af = JSON.parse(localStorage.getItem('activityFilter') || '[]');
  // biome-ignore lint/suspicious/useIterableCallbackReturn: forEach side-effect
  af.forEach((k) => activityFilter.add(k));
} catch (_) {}
initSidebarResize();
applyModalZoom();
loadModalFullscreen();
initModalResize();
loadPanelWidths();
initPanelResize('detail-panel', 'detail-panel-resize', '--detail-panel-width', 'detail-panel-width');
initPanelResize('message-panel', 'message-panel-resize', '--message-panel-width', 'message-panel-width');

const msgContentEl = document.getElementById('message-panel-content');
const jumpLatestBtn = document.createElement('button');
jumpLatestBtn.id = 'msg-jump-latest';
jumpLatestBtn.className = 'msg-jump-latest';
jumpLatestBtn.style.display = 'none';
jumpLatestBtn.textContent = '\u2193 Latest';
jumpLatestBtn.onclick = function () {
  msgContentEl.scrollTop = msgContentEl.scrollHeight;
  msgUserScrolledUp = false;
  this.style.display = 'none';
};
msgContentEl.parentElement.appendChild(jumpLatestBtn);

let msgScrollThrottled = false;
msgContentEl.addEventListener('scroll', () => {
  if (msgScrollThrottled) return;
  msgScrollThrottled = true;
  requestAnimationFrame(() => {
    msgScrollThrottled = false;
    const el = msgContentEl;
    if (el.scrollTop === 0 && msgHasMore && !msgLoadingMore) {
      loadOlderMessages();
    }
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    msgUserScrolledUp = !nearBottom;
    jumpLatestBtn.style.display = msgUserScrolledUp ? '' : 'none';
  });
});
// Load older messages on wheel-up when content doesn't overflow
msgContentEl.addEventListener('wheel', function (e) {
  if (e.deltaY < 0 && this.scrollTop === 0 && msgHasMore && !msgLoadingMore) {
    loadOlderMessages();
  }
});

const footerState = { version: null, limitsKey: null, timer: null };
function formatResetIn(epochSec) {
  if (!epochSec) return null;
  const ms = epochSec * 1000 - Date.now();
  if (ms <= 0) return 'now';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm ? `${h}h ${rm}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}
function makeLimitCell(label, bucket) {
  const pct = bucket?.used_percentage;
  const cell = document.createElement('span');
  cell.className = 'footer-limit-cell';
  const reset = formatResetIn(bucket?.resets_at);
  if (reset) cell.title = `${label}: resets in ${reset}`;
  cell.append(document.createTextNode(`${label} `));
  const strong = document.createElement('strong');
  strong.textContent = pct == null ? '-%' : `${Math.ceil(pct)}%`;
  cell.appendChild(strong);
  if (reset) {
    const r = document.createElement('span');
    r.className = 'footer-limit-reset';
    r.textContent = ` (${reset})`;
    cell.appendChild(r);
  }
  return cell;
}
function makeLimitSpan(rl) {
  const span = document.createElement('span');
  span.className = 'footer-limits';
  span.append(makeLimitCell('5h', rl?.five_hour), document.createTextNode(' · '), makeLimitCell('7d', rl?.seven_day));
  return span;
}
function renderSidebarFooter(rateLimits) {
  const el = document.getElementById('sidebar-footer');
  if (!el) return;
  const fh = rateLimits?.five_hour?.used_percentage ?? null;
  const sd = rateLimits?.seven_day?.used_percentage ?? null;
  const children = [];
  if (footerState.version) {
    const v = document.createElement('span');
    v.textContent = `v${footerState.version}`;
    children.push(v);
  }
  if (fh != null || sd != null) children.push(makeLimitSpan(rateLimits));
  el.replaceChildren(...children);
}
function refreshRateLimits() {
  if (footerState.timer) return;
  footerState.timer = setTimeout(() => {
    footerState.timer = null;
    fetch('/api/context-status')
      .then((r) => r.json())
      .then((all) => {
        let freshest = null;
        for (const e of Object.values(all || {})) {
          if (e?.rate_limits && (!freshest || (e._updatedAt || 0) > (freshest._updatedAt || 0))) freshest = e;
        }
        const rl = freshest?.rate_limits || null;
        const fh = rl?.five_hour?.used_percentage ?? null;
        const sd = rl?.seven_day?.used_percentage ?? null;
        const key = `${fh}|${sd}`;
        if (key === footerState.limitsKey) return;
        footerState.limitsKey = key;
        renderSidebarFooter(rl);
      })
      .catch(() => {});
  }, 1500);
}
fetch('/api/version')
  .then((r) => r.json())
  .then((d) => {
    footerState.version = d.version;
    renderSidebarFooter(null);
    refreshRateLimits();
  })
  .catch(() => {});

const urlState = getUrlState();
const lastView = loadLastView();
sessionFilter = urlState.filter || FILTER_DEFAULTS.session;
sessionLimit = urlState.limit || FILTER_DEFAULTS.limit;
// The URL wins; the persisted view only fills in when it carries a project key, so 'all' (null)
// restores as 'all' and pre-existing blobs without the key still default to '__recent__'.
filterProject = urlState.project || (lastView && 'project' in lastView ? lastView.project : FILTER_DEFAULTS.project);
ownerFilter = urlState.owner || '';
searchQuery = urlState.search || '';

renderFilterState();
pinnedSessionIds = loadPinnedSessions();
stickySessionIds = loadStickySessions();
setupEventSource();

if (urlState.search) {
  document.getElementById('search-input').value = urlState.search;
  document.getElementById('search-clear-btn').classList.add('visible');
}

Promise.all([
  fetch('/hub-config')
    .then((r) => r.json())
    .then((cfg) => {
      if (!cfg.enabled) return;
      window.__HUB__ = cfg;
    })
    .catch(() => {}),
  fetch('/api/config')
    .then((r) => r.json())
    .then((c) => {
      appConfig = c;
    })
    .catch(() => {}),
])
  .then(() => fetchSessions())
  .then(async () => {
    if (urlState.projectView) {
      try {
        await fetchProjectView(atob(urlState.projectView));
      } catch (_) {
        showAllTasks();
      }
    } else if (urlState.session) {
      await fetchTasks(urlState.session);
    } else if (urlState.view === 'all') {
      showAllTasks();
    } else {
      const last = loadLastView();
      if (last?.view === 'project' && last.projectPath && sessions.some((s) => s.project === last.projectPath)) {
        try {
          await fetchProjectView(last.projectPath);
        } catch (_) {
          showAllTasks();
        }
      } else if (last?.view === 'session' && last.session && sessions.some((s) => s.id === last.session)) {
        await fetchTasks(last.session);
      } else {
        showAllTasks();
      }
    }
    if (urlState.messages && currentSessionId) {
      toggleMessagePanel();
      // Re-render after panel layout settles so scroll dimensions are correct
      requestAnimationFrame(() => {
        if (currentMessages.length) renderMessages(currentMessages);
      });
    }
  });

window.addEventListener('popstate', () => {
  const s = getUrlState();
  sessionFilter = s.filter || FILTER_DEFAULTS.session;
  sessionLimit = s.limit || FILTER_DEFAULTS.limit;
  filterProject = s.project || FILTER_DEFAULTS.project;
  ownerFilter = s.owner || '';
  searchQuery = s.search || '';
  renderFilterState();
  // fetchSessions derives query params from the globals set above — refetch so
  // back/forward across a filter change doesn't render a stale server-filtered list.
  fetchSessions(false);
  if (s.projectView) {
    try {
      fetchProjectView(atob(s.projectView));
    } catch (_) {
      showAllTasks();
    }
  } else if (s.session) fetchTasks(s.session);
  else showAllTasks();
  if (s.messages !== messagePanelOpen) toggleMessagePanel();
});
//#endregion

// #region HUB_INTEGRATION
document.addEventListener('keydown', (e) => {
  if (!window.__HUB__?.enabled) return;
  const fwd = (key) => {
    e.preventDefault();
    hubPost({ type: 'hub:keydown', key, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey });
  };
  if (e.ctrlKey && e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    fwd(e.key);
  }
  // Own branch: the Alt+digit case below requires !ctrlKey. The hub owns the Ctrl+Alt+letter
  // keymap and ignores unbound letters.
  if (e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey && /^[a-z]$/i.test(e.key)) {
    fwd(e.key);
  }
  if (e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey && /^[1-9]$/.test(e.key)) {
    fwd(e.key);
  }
});

document.addEventListener('click', (e) => {
  if (!window.__HUB__?.enabled) return;
  const a = e.target.closest?.('a[href]');
  if (!a) return;
  const href = a.getAttribute('href');
  if (!href) return;
  let url;
  try {
    url = new URL(href, window.location.href);
  } catch (_) {
    return;
  }
  if (url.origin === window.location.origin) return;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  e.preventDefault();
  e.stopPropagation();
  hubPost({ type: 'hub:openExternal', url: url.href });
});

window.hubNavigate = function hubNavigate(app, url) {
  if (!window.__HUB__?.enabled) return;
  hubPost({ type: 'hub:navigate', app, url });
};

// Hoisted out of initHubTheme so initHubProject can share it.
const hubOrigin = () => (window.__HUB__?.url ? new URL(window.__HUB__.url).origin : null);

// Every send is addressed to the hub explicitly. With targetOrigin '*' any page that
// framed this app also received the forwarded keystrokes and navigation intents.
function hubPost(message) {
  const origin = hubOrigin();
  if (origin) window.parent?.postMessage(message, origin);
}

(function initHubTheme() {
  const getTheme = () => (document.body.classList.contains('light') ? 'light' : 'dark');
  const getColorTheme = () => document.body.dataset.colorTheme || 'ember';
  // lastTheme/lastColorTheme are updated synchronously when applying a hub
  // message, so the (async) observer sees no diff and doesn't echo it back.
  let lastTheme = getTheme();
  let lastColorTheme = getColorTheme();
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent || e.origin !== hubOrigin()) return;
    if (e.data?.type !== 'hub:theme') return;
    if (typeof e.data.colorTheme === 'string' && e.data.colorTheme !== getColorTheme()) {
      setColorTheme(e.data.colorTheme);
      lastColorTheme = getColorTheme();
    }
    if (getTheme() !== e.data.theme) {
      window.toggleTheme();
      lastTheme = getTheme();
    }
  });
  new MutationObserver(() => {
    const t = getTheme();
    const ct = getColorTheme();
    if (t === lastTheme && ct === lastColorTheme) return;
    lastTheme = t;
    lastColorTheme = ct;
    hubPost({ type: 'hub:theme', theme: t, colorTheme: ct });
  }).observe(document.body, {
    attributes: true,
    attributeFilter: ['class', 'data-color-theme'],
  });
})();

(function initHubProject() {
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent || e.origin !== hubOrigin()) return;
    if (e.data?.type !== 'hub:project') return;
    const dirPath = e.data.project;
    if (typeof dirPath !== 'string' || !dirPath || dirPath === filterProject) return;
    filterByProject(dirPath);
    updateProjectDropdown();
  });
})();
// #endregion HUB_INTEGRATION
