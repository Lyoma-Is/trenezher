// Тренажёр аттестации учителей


const STORAGE_KEY = 'teacher-trainer-custom-v3';

// —— Безопасность ——
function isSafeHttpUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const u = url.trim();
  try {
    const parsed = new URL(u, window.location.href);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

function sanitizeUrl(url) {
  if (!url) return '';
  const u = String(url).trim();
  if (isSafeHttpUrl(u)) return u;
  return '';
}

function isSafeDataImageUrl(url) {
  if (!url || typeof url !== 'string') return false;
  // только изображения data:image/...;base64,
  return /^data:image\/(png|jpeg|jpg|gif|webp|bmp);base64,/i.test(url.trim());
}

function sanitizeImageSrc(src) {
  if (!src) return '';
  const s = String(src).trim();
  if (isSafeDataImageUrl(s)) return s;
  if (isSafeHttpUrl(s)) return s;
  return '';
}

function sanitizeText(s, maxLen) {
  let t = String(s == null ? '' : s);
  if (maxLen && t.length > maxLen) t = t.slice(0, maxLen);
  return t;
}



let currentQuiz = {
  questions: [],
  index: 0,
  score: 0,
  type: null,
  level: null, // 'first' | 'highest'
  answered: false,
  selected: [],
  // per-question state: { answered, selected, wasCorrect, order }
  // order = permutation of option indices for display
  states: []
};

let quizTimerInterval = null;
let quizTimerSeconds = 0;

let manageMode = 'general'; // 'general' | 'informatics'
let manageLevel = 'first'; // 'first' | 'highest'
let activeSectorId = null;
let editingId = null; // { key, index } или null
let optionFieldCount = 0;

// —— Нормализация вопроса (поддержка старого формата correct: number) ——
function normalizeQuestion(q) {
  if (q && q.kind === 'task') return q;
  let correct = q.correct;
  if (!Array.isArray(correct)) {
    correct = typeof correct === 'number' ? [correct] : [];
  }
  return { ...q, correct };
}

function isMulti(q) {
  return Array.isArray(q.correct) && q.correct.length > 1;
}

// —— localStorage ——
function emptyStore() {
  return {
    siteTitle: 'Тренажёр для подготовки к аттестации учителей',
    extraBlocks: [],
    first: { general: [], sectors: [] },
    highest: { general: [], sectors: [] }
  };
}

function newSectorId() {
  return 's_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

function levelKey() {
  return manageLevel === 'highest' ? 'highest' : 'first';
}

let cloudCache = null;
let cloudLoading = false;
let cloudSaveTimer = null;
const RTDB_PATH = 'content/main';

function toArray(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val.filter(function(x) { return x != null; });
  if (typeof val === 'object') {
    return Object.keys(val)
      .filter(function(k) { return k !== 'length' && val[k] != null; })
      .sort(function(a, b) {
        const na = parseInt(a, 10);
        const nb = parseInt(b, 10);
        if (!isNaN(na) && !isNaN(nb)) return na - nb;
        return String(a).localeCompare(String(b));
      })
      .map(function(k) { return val[k]; });
  }
  return [];
}

function normalizeTaskItem(t) {
  if (!t || typeof t !== 'object') return t;
  const task = Object.assign({}, t);
  if (task.content) task.content = toArray(task.content);
  if (task.files) task.files = toArray(task.files);
  if (task.explanationBlocks) task.explanationBlocks = toArray(task.explanationBlocks);
  if (task.answerTable) {
    task.answerTable = toArray(task.answerTable).map(function(row) {
      return toArray(row);
    });
  }
  if (task.options) task.options = toArray(task.options);
  if (task.correct != null && !Array.isArray(task.correct)) {
    if (typeof task.correct === 'object') task.correct = toArray(task.correct);
  }
  return task;
}

function normalizeStore(data) {
  const store = emptyStore();
  if (!data || typeof data !== 'object') return store;
  function fixSide(side) {
    side = side || {};
    let sectors = toArray(side.sectors);
    const legacyTasks = toArray(side.tasks);
    if (!sectors.length && legacyTasks.length) {
      sectors = [{
        id: newSectorId(),
        name: 'Основной сектор',
        count: Math.min(30, legacyTasks.length),
        tasks: legacyTasks.filter(function(t) { return t && t.kind === 'task'; })
      }];
    }
    return {
      general: toArray(side.general).map(normalizeQuestion),
      sectors: sectors.map(function(s) {
        s = s || {};
        return {
          id: s.id || newSectorId(),
          name: s.name || 'Сектор',
          count: Math.max(0, parseInt(s.count, 10) || 0),
          tasks: toArray(s.tasks).map(normalizeTaskItem)
        };
      })
    };
  }
  store.first = fixSide(data.first);
  store.highest = fixSide(data.highest);
  if (data.siteTitle) store.siteTitle = sanitizeText(data.siteTitle, 200);
  store.extraBlocks = toArray(data.extraBlocks).map(function(b) {
    if (!b || typeof b !== 'object') return null;
    if (b.type === 'link') {
      return {
        type: 'link',
        text: sanitizeText(b.text, 500),
        url: sanitizeUrl(b.url)
      };
    }
    return { type: 'text', value: sanitizeText(b.value, 5000) };
  }).filter(Boolean);
  return store;
}

let cloudSynced = false;

function readLocalStore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return normalizeStore(JSON.parse(raw));
  } catch (e) {}
  return emptyStore();
}

function countContent(data) {
  data = data || emptyStore();
  function sideCount(side) {
    side = side || {};
    const g = (side.general || []).length;
    const t = (side.sectors || []).reduce(function(s, sec) {
      return s + ((sec.tasks || []).length);
    }, 0);
    return g + t;
  }
  return sideCount(data.first) + sideCount(data.highest);
}

function loadCustom() {
  if (cloudCache) return JSON.parse(JSON.stringify(cloudCache));
  // Пока ждём Firebase — показываем локальный кэш (на телефонах иначе пусто)
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = normalizeStore(JSON.parse(raw));
      // не помечаем cloudSynced — Firebase потом перезапишет
      return JSON.parse(JSON.stringify(data));
    }
  } catch (e) {
    console.error(e);
  }
  return emptyStore();
}

function saveCustom(data) {
  const normalized = normalizeStore(data);
  cloudCache = normalized;
  cloudSynced = true;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  } catch (e) {
    console.warn('localStorage full or blocked', e);
  }
  updateCustomCounts();
  // сразу в Firebase (один профиль данных для всех браузеров)
  scheduleCloudSave(normalized);
}

function scheduleCloudSave(data) {
  if (!firebaseReady || !window.firebase || !firebase.database) return;
  const user = firebase.auth().currentUser;
  if (!user || user.uid !== ADMIN_UID) return;
  if (cloudSaveTimer) clearTimeout(cloudSaveTimer);
  cloudSaveTimer = setTimeout(function() {
    pushToRealtime(data);
  }, 300);
}

function pushToRealtime(data) {
  return new Promise(function(resolve, reject) {
    try {
      if (!firebaseReady || !window.firebase || !firebase.database) {
        resolve(false);
        return;
      }
      const user = firebase.auth().currentUser;
      if (!user || user.uid !== ADMIN_UID) {
        console.warn('Отмена записи: нет прав Firebase Auth');
        resolve(false);
        return;
      }
      const payload = JSON.parse(JSON.stringify(data || cloudCache || emptyStore()));
      payload.updatedAt = new Date().toISOString();
      payload.updatedBy = user.uid;
      firebase.database().ref('content/main').set(payload)
        .then(function() {
          console.log('Realtime DB: сохранено, элементов:', countContent(payload));
          cloudCache = normalizeStore(payload);
          cloudSynced = true;
          try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(cloudCache));
          } catch (e) {}
          resolve(true);
        })
        .catch(function(e) {
          console.error('Realtime DB save error', e);
          appAlert('Не удалось сохранить в Firebase. Проверьте Rules и сеть.\n' + (e.message || e));
          reject(e);
        });
    } catch (e) {
      console.error(e);
      reject(e);
    }
  });
}

/** После входа админа: если локально данных больше, чем в облаке — залить в Firebase */
function syncLocalToCloudIfNeeded() {
  if (!isAdmin()) return Promise.resolve();
  const local = readLocalStore();
  const cloud = cloudCache || emptyStore();
  const localN = countContent(local);
  const cloudN = countContent(cloud);
  console.log('Синхронизация: локально', localN, 'в облаке', cloudN);
  if (localN > cloudN) {
    cloudCache = local;
    cloudSynced = true;
    return pushToRealtime(local).then(function() {
      updateCustomCounts();
      applyHomeSettings();
      return true;
    });
  }
  return Promise.resolve(false);
}

function applyCloudData(val, fromListen) {
  // не сбрасывать форму редактирования живым listener'ом
  const form = document.getElementById('question-form');
  if (fromListen && form && !form.classList.contains('hidden') && isAdmin()) {
    cloudCache = normalizeStore(val || emptyStore());
    cloudSynced = true;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cloudCache));
    } catch (e) {}
    return;
  }
  const data = normalizeStore(val || emptyStore());
  cloudCache = data;
  cloudSynced = true;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {}
  updateCustomCounts();
  applyHomeSettings();
  const manage = document.getElementById('manage-page');
  if (manage && manage.classList.contains('active')) {
    renderQuestionsList();
  }
}

function pullFromRealtime() {
  if (!firebaseReady || !window.firebase || !firebase.database) {
    // offline / no firebase — fallback to local once
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        cloudCache = normalizeStore(JSON.parse(raw));
        cloudSynced = true;
        updateCustomCounts();
        applyHomeSettings();
      } else {
        cloudSynced = true;
        cloudCache = emptyStore();
      }
    } catch (e) {
      cloudSynced = true;
      cloudCache = emptyStore();
    }
    return Promise.resolve(false);
  }
  cloudLoading = true;
  return firebase.database().ref('content/main').once('value')
    .then(function(snap) {
      cloudLoading = false;
      const val = snap.val();
      // Firebase — источник правды. Пустой узел = пустые данные, не заливаем localStorage.
      applyCloudData(val);
      return !!val;
    })
    .catch(function(e) {
      cloudLoading = false;
      console.error('Realtime DB load error', e);
      // при ошибке сети — локальный кэш
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
          cloudCache = normalizeStore(JSON.parse(raw));
          cloudSynced = true;
          updateCustomCounts();
          applyHomeSettings();
        } else {
          cloudSynced = true;
          cloudCache = emptyStore();
        }
      } catch (e2) {
        cloudSynced = true;
        cloudCache = emptyStore();
      }
      return false;
    });
}

function ensureDataLoaded() {
  // всегда быстро отдаём данные — кнопки не должны «зависать»
  function fromLocal() {
    const local = cloudCache || readLocalStore();
    if (!cloudCache) cloudCache = local;
    return local;
  }
  if (cloudSynced && cloudCache) {
    return Promise.resolve(JSON.parse(JSON.stringify(cloudCache)));
  }
  if (firebaseReady && window.firebase && firebase.database) {
    try { firebase.database().goOnline(); } catch (e) {}
    const timeout = new Promise(function(resolve) {
      setTimeout(function() {
        resolve(fromLocal());
      }, 2500);
    });
    const pull = pullFromRealtime().then(function() {
      return cloudCache || fromLocal();
    }).catch(function() {
      return fromLocal();
    });
    return Promise.race([pull, timeout]).then(function(data) {
      cloudSynced = true;
      if (data && !cloudCache) cloudCache = normalizeStore(data);
      return cloudCache || fromLocal();
    });
  }
  cloudSynced = true;
  return Promise.resolve(fromLocal());
}

function listenRealtime() {
  if (!firebaseReady || !window.firebase || !firebase.database) return;
  firebase.database().ref('content/main').on('value', function(snap) {
    applyCloudData(snap.val(), true);
  });
}

function autoResizeTitle(el) {
  if (!el) el = document.getElementById('site-title');
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.max(el.scrollHeight, 40) + 'px';
}

function applyHomeSettings() {
  const data = loadCustom();
  const titleEl = document.getElementById('site-title');
  if (titleEl) {
    titleEl.value = data.siteTitle || 'Тренажёр для подготовки к аттестации учителей';
    document.title = titleEl.value;
    autoResizeTitle(titleEl);
  }
  renderExtraBlocks();
}

function saveSiteTitle(value) {
  if (!isAdmin()) return;
  const data = loadCustom();
  data.siteTitle = (value || '').trim() || 'Тренажёр для подготовки к аттестации учителей';
  saveCustom(data);
  document.title = data.siteTitle;
  const titleEl = document.getElementById('site-title');
  if (titleEl) {
    if (titleEl.value !== data.siteTitle) titleEl.value = data.siteTitle;
    autoResizeTitle(titleEl);
  }
}

function addExtraBlock(type) {
  if (!requireAdmin()) return;
  const data = loadCustom();
  if (!Array.isArray(data.extraBlocks)) data.extraBlocks = [];
  if (type === 'link') {
    data.extraBlocks.push({ type: 'link', text: 'Текст ссылки', url: 'https://' });
  } else {
    data.extraBlocks.push({ type: 'text', value: '' });
  }
  saveCustom(data);
  renderExtraBlocks();
}

function updateExtraBlock(index, field, value) {
  if (!isAdmin()) return;
  const data = loadCustom();
  if (!data.extraBlocks || !data.extraBlocks[index]) return;
  if (field === 'url') {
    value = sanitizeUrl(value);
    if (!value && String(arguments[2] || '').trim()) {
      appAlert('Разрешены только ссылки http:// и https://');
    }
  } else {
    value = sanitizeText(value, 5000);
  }
  data.extraBlocks[index][field] = value;
  saveCustom(data);
  if (field === 'url') renderExtraBlocks();
}

function removeExtraBlock(index) {
  if (!requireAdmin()) return;
  const data = loadCustom();
  if (!data.extraBlocks) return;
  data.extraBlocks.splice(index, 1);
  saveCustom(data);
  renderExtraBlocks();
}

function moveExtraBlock(index, dir) {
  if (!isAdmin()) return;
  const data = loadCustom();
  const blocks = data.extraBlocks || [];
  const j = index + dir;
  if (j < 0 || j >= blocks.length) return;
  const tmp = blocks[index];
  blocks[index] = blocks[j];
  blocks[j] = tmp;
  saveCustom(data);
  renderExtraBlocks();
}

function extraMoveBtns(i, total) {
  return '<div class="extra-move">' +
    '<button type="button" class="btn-sm" onclick="moveExtraBlock(' + i + ', -1)" title="Выше" ' + (i === 0 ? 'disabled' : '') + '>↑</button>' +
    '<button type="button" class="btn-sm" onclick="moveExtraBlock(' + i + ', 1)" title="Ниже" ' + (i >= total - 1 ? 'disabled' : '') + '>↓</button>' +
    '</div>';
}

function renderExtraBlocks() {
  const box = document.getElementById('extra-blocks');
  if (!box) return;
  const data = loadCustom();
  const blocks = data.extraBlocks || [];
  if (!blocks.length) {
    box.innerHTML = '<p class="form-hint" style="margin:0">Можно добавить текст или ссылку под карточками категорий.</p>';
    return;
  }
  const n = blocks.length;
  const admin = isAdmin();
  if (!admin) {
    box.innerHTML = blocks.map(function(b) {
      if (b.type === 'link') {
        const href = sanitizeUrl(b.url);
        const label = b.text || b.url || 'Ссылка';
        if (!href) {
          return '<div class="extra-item" style="border:none;box-shadow:none;background:transparent;padding:4px 0">' +
            '<span>' + escapeHtml(label) + '</span></div>';
        }
        return '<div class="extra-item" style="border:none;box-shadow:none;background:transparent;padding:4px 0">' +
          '<a class="extra-link-preview" href="' + escapeAttr(href) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(label) + '</a></div>';
      }
      return '<div class="extra-item" style="border:none;box-shadow:none;background:transparent;padding:4px 0"><div class="content-text">' +
        escapeHtml(b.value || '') + '</div></div>';
    }).join('');
    return;
  }
  box.innerHTML = blocks.map(function(b, i) {
    const moves = extraMoveBtns(i, n);
    if (b.type === 'link') {
      return '<div class="extra-item">' + moves +
        '<div class="link-fields">' +
        '<input type="text" value="' + escapeAttr(b.text || '') + '" placeholder="Текст ссылки" onchange="updateExtraBlock(' + i + ', \'text\', this.value)">' +
        '<input type="url" value="' + escapeAttr(b.url || '') + '" placeholder="https://..." onchange="updateExtraBlock(' + i + ', \'url\', this.value)">' +
        (sanitizeUrl(b.url) ? '<a class="extra-link-preview" href="' + escapeAttr(sanitizeUrl(b.url)) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(b.text || b.url) + '</a>' : '') +
        '</div>' +
        '<button type="button" class="btn-remove" onclick="removeExtraBlock(' + i + ')" title="Удалить">×</button>' +
        '</div>';
    }
    return '<div class="extra-item">' + moves +
      '<textarea rows="2" placeholder="Текст..." onchange="updateExtraBlock(' + i + ', \'value\', this.value)">' + escapeHtml(b.value || '') + '</textarea>' +
      '<button type="button" class="btn-remove" onclick="removeExtraBlock(' + i + ')" title="Удалить">×</button>' +
      '</div>';
  }).join('');
}

function updateCustomCounts() {
  const data = loadCustom();
  const set = (id, n, label) => {
    const el = document.getElementById(id);
    if (el) el.textContent = n > 0 ? `${label}: ${n}` : '';
  };
  function taskCount(side) {
    return (side.sectors || []).reduce(function(s, sec) { return s + (sec.tasks || []).length; }, 0);
  }
  set('count-general-first', data.first.general.length, 'Ваших');
  set('count-tasks-first', taskCount(data.first), 'Ваших');
  set('count-general-highest', data.highest.general.length, 'Ваших');
  set('count-tasks-highest', taskCount(data.highest), 'Ваших');
}

// —— Навигация ——
function showPage(pageId) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(pageId).classList.add('active');
  const profile = document.getElementById('profile-btn');
  if (profile) {
    profile.classList.toggle('hidden', pageId !== 'home-page');
  }
  if (pageId !== 'home-page') closeAuthPanel();
}

function goHome() {
  stopQuizTimer();
  showPage('home-page');
  currentQuiz = { questions: [], index: 0, score: 0, type: null, level: null, answered: false, selected: [], states: [] };
  editingId = null;
  updateCustomCounts();
}

function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  const sa = [...a].sort((x, y) => x - y);
  const sb = [...b].sort((x, y) => x - y);
  return sa.every((v, i) => v === sb[i]);
}

// —— Квизы ——

function stopQuizTimer() {
  if (quizTimerInterval) {
    clearInterval(quizTimerInterval);
    quizTimerInterval = null;
  }
}

function startQuizTimer() {
  stopQuizTimer();
  quizTimerSeconds = 0;
  const el = document.getElementById('question-timer');
  if (el) el.textContent = '00:00';
  quizTimerInterval = setInterval(() => {
    quizTimerSeconds++;
    const m = Math.floor(quizTimerSeconds / 60);
    const s = quizTimerSeconds % 60;
    const el = document.getElementById('question-timer');
    if (el) el.textContent = String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }, 1000);
}

function categoryTitle(level) {
  if (level === 'highest') {
    return 'Тренажёр для подготовки к аттестации учителей ЧР на высшую квалификационную категорию';
  }
  return 'Тренажёр для подготовки к аттестации учителей ЧР на первую квалификационную категорию';
}


function initQuizStates(questions) {
  return questions.map(q => {
    if (q.kind === 'task') {
      return {
        answered: false,
        selected: [],
        wasCorrect: false,
        order: [],
        userText: '',
        userTable: null
      };
    }
    const n = (q.options || []).length;
    const order = shuffle([...Array(n).keys()]);
    return {
      answered: false,
      selected: [],
      wasCorrect: false,
      order
    };
  });
}

function normalizeStr(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function tablesEqual(a, b) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!a[i] || !b[i] || a[i].length !== b[i].length) return false;
    for (let j = 0; j < a[i].length; j++) {
      if (normalizeStr(a[i][j]) !== normalizeStr(b[i][j])) return false;
    }
  }
  return true;
}

function startGeneralQuiz(level) {
  ensureDataLoaded().then(function() {
    const inputId = level === 'first' ? 'count-first' : 'count-highest';
    const maxAllowed = level === 'first' ? 300 : 600;
    let count = parseInt(document.getElementById(inputId).value, 10);
    if (isNaN(count) || count < 1) count = 1;
    if (count > maxAllowed) count = maxAllowed;
    document.getElementById(inputId).value = count;

    let custom = loadCustom();
    let levelKey = level === 'highest' ? 'highest' : 'first';
    let pool = (GENERAL_QUESTIONS || []).map(normalizeQuestion).concat(custom[levelKey].general || []);
    // запасной вариант — локальный кэш (если облако ещё пустое)
    if (!pool.length) {
      const local = readLocalStore();
      if (countContent(local) > countContent(custom)) {
        custom = local;
        cloudCache = local;
        pool = (GENERAL_QUESTIONS || []).map(normalizeQuestion).concat(custom[levelKey].general || []);
      }
    }
    if (!pool.length) {
      appAlert('Вопросы не добавлены');
      return;
    }
    let selected = [];
    if (count <= pool.length) {
      selected = shuffle(pool).slice(0, count);
    } else {
      while (selected.length < count) selected = selected.concat(shuffle(pool));
      selected = selected.slice(0, count);
    }

    const questions = selected.map(q => ({ ...q, qType: 'general' }));
    currentQuiz = {
      questions,
      index: 0, score: 0, type: `general-${level}`, level: level,
      answered: false, selected: [], states: initQuizStates(questions)
    };
    showPage('quiz-page');
    startQuizTimer();
    renderQuestion();
  }).catch(function(e) {
    console.error(e);
    appAlert('Не удалось загрузить вопросы. Проверьте интернет и обновите страницу.');
  });
}

function startInformaticsQuiz(level) {
  ensureDataLoaded().then(function() {
    _startInformaticsQuizBody(level);
  }).catch(function(e) {
    console.error(e);
    appAlert('Не удалось загрузить задания. Проверьте интернет и обновите страницу.');
  });
}

function _startInformaticsQuizBody(level) {
  let custom = loadCustom();
  const levelKey = level === 'highest' ? 'highest' : 'first';
  let generalPool = (GENERAL_QUESTIONS || []).map(normalizeQuestion).concat(custom[levelKey].general || []);
  let sectors = sortSectors(custom[levelKey].sectors || []);
  let allTasks = sectors.reduce(function(acc, s) { return acc.concat(s.tasks || []); }, []);
  if (!generalPool.length || !allTasks.length) {
    const local = readLocalStore();
    if (countContent(local) > countContent(custom)) {
      custom = local;
      cloudCache = local;
      generalPool = (GENERAL_QUESTIONS || []).map(normalizeQuestion).concat(custom[levelKey].general || []);
      sectors = sortSectors(custom[levelKey].sectors || []);
      allTasks = sectors.reduce(function(acc, s) { return acc.concat(s.tasks || []); }, []);
    }
  }
  if (!generalPool.length) {
    appAlert('Вопросы не добавлены');
    return;
  }
  if (!allTasks.length) {
    appAlert('Задания не добавлены');
    return;
  }

  let g = shuffle(generalPool).slice(0, Math.min(10, generalPool.length));
  while (g.length < 10 && generalPool.length) {
    g = g.concat(shuffle(generalPool));
  }
  g = g.slice(0, 10);

  let t = [];

  // «Задание N» с подряд идущими номерами (19,20,21) — чередование с одним индексом.
  // Остальные секторы (и одиночные «Задание N») — как раньше, независимо.
  function parseZadanieNum(name) {
    const m = String(name || '').trim().match(/^Задание\s*(\d+)$/i);
    return m ? parseInt(m[1], 10) : null;
  }

  function pickPlain(sec) {
    const pool = sec.tasks || [];
    if (!pool.length) return;
    let need = Math.max(0, parseInt(sec.count, 10) || 0);
    if (!need) return;
    let picked = shuffle(pool).slice(0, Math.min(need, pool.length));
    while (picked.length < need && pool.length) {
      picked = picked.concat(shuffle(pool));
    }
    t = t.concat(picked.slice(0, need));
  }

  function pickLinkedGroup(group) {
    const minLen = Math.min.apply(null, group.map(function(s) { return (s.tasks || []).length; }));
    if (minLen <= 0) return;
    let rounds = 0;
    group.forEach(function(s) {
      const c = Math.max(0, parseInt(s.count, 10) || 0);
      if (c > rounds) rounds = c;
    });
    if (!rounds) return;
    const base = [];
    for (let i = 0; i < minLen; i++) base.push(i);
    let indices = [];
    while (indices.length < rounds) {
      indices = indices.concat(shuffle(base.slice()));
    }
    indices = indices.slice(0, rounds);
    // Задание19[i], Задание20[i], Задание21[i], затем следующий i
    indices.forEach(function(taskIdx) {
      group.forEach(function(sec) {
        const task = (sec.tasks || [])[taskIdx];
        if (task) t.push(task);
      });
    });
  }

  const numbered = [];
  const plain = [];
  sectors.forEach(function(sec) {
    const num = parseZadanieNum(sec.name);
    if (num != null) numbered.push({ sec: sec, num: num });
    else plain.push(sec);
  });
  numbered.sort(function(a, b) { return a.num - b.num; });

  // группы подряд идущих номеров: (19,20,21), отдельно (25), отдельно (1,2)…
  // Связанные группы (19–20–21) идут В КОНЦЕ списка, остальные секторы — раньше.
  let run = [];
  const linkedGroups = [];
  function flushRun() {
    if (run.length >= 2) {
      linkedGroups.push(run.map(function(x) { return x.sec; }));
    } else if (run.length === 1) {
      plain.push(run[0].sec);
    }
    run = [];
  }
  for (let i = 0; i < numbered.length; i++) {
    if (!run.length || numbered[i].num === run[run.length - 1].num + 1) {
      run.push(numbered[i]);
    } else {
      flushRun();
      run.push(numbered[i]);
    }
  }
  flushRun();

  // сначала обычные секторы
  plain.forEach(pickPlain);
  // затем связанные «Задание 19, 20, 21» — в конце
  linkedGroups.forEach(pickLinkedGroup);

  if (!t.length) {
    appAlert('Задания не добавлены');
    return;
  }

  const questions = [
    ...g.map(q => ({ ...q, qType: 'general' })),
    ...t.map(q => ({ ...q, qType: 'practice' }))
  ];
  currentQuiz = {
    questions,
    index: 0, score: 0, type: `informatics-${level}`, level: level,
    answered: false, selected: [], states: initQuizStates(questions)
  };
  showPage('quiz-page');
  startQuizTimer();
  renderQuestion();
}

function updateQuestionSelect() {
  const sel = document.getElementById('question-select');
  if (!sel) return;
  const total = currentQuiz.questions.length;
  let html = '';
  for (let i = 0; i < total; i++) {
    const st = currentQuiz.states[i];
    const mark = st && st.answered ? ' ✓' : '';
    const q = currentQuiz.questions[i];
    const short = q.title || q.text || ('Вопрос ' + (i + 1));
    const label = short.length > 50 ? short.slice(0, 50) + '…' : short;
    html += `<option value="${i}">${i + 1}. ${escapeHtml(label)}${mark}</option>`;
  }
  sel.innerHTML = html;
  sel.value = String(currentQuiz.index);
}

function jumpToQuestion(value) {
  const idx = parseInt(value, 10);
  if (isNaN(idx) || idx < 0 || idx >= currentQuiz.questions.length) return;
  if (idx === currentQuiz.index) return;
  const st = currentQuiz.states[currentQuiz.index];
  const q = currentQuiz.questions[currentQuiz.index];
  if (st && !st.answered) {
    if (q.kind === 'task') {
      if (q.answerType === 'table') {
        try { st.userTable = readEditTable('user-answer-table'); } catch (e) {}
      } else {
        const el = document.getElementById('user-answer-text');
        if (el) st.userText = el.value;
      }
    } else {
      st.selected = [...currentQuiz.selected];
    }
  }
  currentQuiz.index = idx;
  renderQuestion();
}

function renderQuestion() {
  const idx = currentQuiz.index;
  let q = currentQuiz.questions[idx];
  if (q.kind !== 'task') {
    q = normalizeQuestion(q);
    currentQuiz.questions[idx] = q;
  }
  let st = currentQuiz.states[idx];
  if (!st) {
    st = initQuizStates([q])[0];
    currentQuiz.states[idx] = st;
  }

  const total = currentQuiz.questions.length;
  const num = idx + 1;

  document.getElementById('progress-text').textContent = `Вопрос ${num} из ${total}`;
  document.getElementById('progress-fill').style.width = `${(num / total) * 100}%`;
  document.getElementById('score-display').textContent = currentQuiz.score;

  document.getElementById('question-type').textContent = categoryTitle(currentQuiz.level);

  const isTask = q.kind === 'task';
  updateQuestionSelect();

  const container = document.getElementById('options-container');
  const taskArea = document.getElementById('task-answer-area');
  const hint = document.getElementById('multi-hint');
  const contentView = document.getElementById('task-content-view');
  container.innerHTML = '';

  document.getElementById('feedback').className = 'feedback hidden';
  document.getElementById('answer-details').className = 'answer-details hidden';
  document.getElementById('answer-details').innerHTML = '';
  const divider = document.getElementById('result-divider');
  if (divider) divider.classList.add('hidden');

  currentQuiz.answered = st.answered;

  if (isTask) {
    document.getElementById('question-text').textContent = '';
    document.getElementById('question-text').style.display = 'none';
    // content blocks
    let content = q.content;
    if (!content || !content.length) {
      content = [];
      if (q.taskImage) content.push({ type: 'image', value: q.taskImage });
      if (q.text) content.push({ type: 'text', value: q.text });
    }
    contentView.innerHTML = content.map(b => {
      if (b.type === 'image') {
        const src = sanitizeImageSrc(b.value);
        return src ? `<img src="${src}" alt="Задание">` : '';
      }
      return `<div class="content-text">${escapeHtml(b.value)}</div>`;
    }).join('');
    contentView.classList.remove('hidden');

    const filesView = document.getElementById('task-files-view');
    if (filesView) {
      if (q.files && q.files.length) {
        filesView.innerHTML = '<div class="form-hint" style="margin-bottom:4px">Файлы к заданию:</div>' + formatFilesView(q.files);
        filesView.classList.remove('hidden');
      } else {
        filesView.innerHTML = '';
        filesView.classList.add('hidden');
      }
    }

    hint.textContent = q.answerType === 'table' ? 'Заполните таблицу' : 'Введите текстовый ответ';
    hint.classList.remove('hidden');
    taskArea.classList.remove('hidden');
    const textArea = document.getElementById('user-answer-text');
    const tableWrap = document.getElementById('user-answer-table-wrap');
    if (q.answerType === 'table') {
      textArea.classList.add('hidden');
      textArea.style.display = 'none';
      tableWrap.classList.remove('hidden');
      tableWrap.style.display = '';
      const rows = (q.answerTable && q.answerTable.length) || 2;
      const cols = (q.answerTable && q.answerTable[0] && q.answerTable[0].length) || 2;
      const data = st.userTable || Array.from({ length: rows }, () => Array(cols).fill(''));
      buildEditTable('user-answer-table', rows, cols, data);
    } else {
      textArea.classList.remove('hidden');
      textArea.style.display = '';
      tableWrap.classList.add('hidden');
      tableWrap.style.display = 'none';
      textArea.value = st.userText || '';
      textArea.disabled = !!st.answered;
    }
    if (st.answered) {
      if (q.answerType === 'table') {
        document.querySelectorAll('#user-answer-table input').forEach(i => i.disabled = true);
      }
      showTaskAnswerState(q, st);
      document.querySelector('.quiz-actions').classList.add('hidden');
      document.getElementById('btn-next').classList.remove('hidden');
    } else {
      document.getElementById('btn-next').classList.add('hidden');
      document.querySelector('.quiz-actions').classList.remove('hidden');
      document.getElementById('btn-check').classList.remove('hidden');
      document.getElementById('btn-finish').classList.remove('hidden');
    }
    return;
  }

  document.getElementById('question-text').style.display = '';
  contentView.innerHTML = '';
  contentView.classList.add('hidden');
  const filesViewHide = document.getElementById('task-files-view');
  if (filesViewHide) {
    filesViewHide.innerHTML = '';
    filesViewHide.classList.add('hidden');
  }
  document.getElementById('question-text').textContent = q.text;


  // choice question
  taskArea.classList.add('hidden');
  const multi = isMulti(q);
  hint.textContent = multi ? 'Выберите все правильные ответы' : 'Выберите правильный ответ';
  hint.classList.remove('hidden');

  currentQuiz.selected = st.answered ? [...st.selected] : [...(st.selected || [])];
  const order = st.order && st.order.length ? st.order : shuffle([...(q.options || []).keys()]);
  st.order = order;
  order.forEach((origIdx) => {
    const btn = document.createElement('button');
    btn.className = 'option checkbox-option';
    btn.type = 'button';
    btn.dataset.orig = String(origIdx);
    btn.innerHTML = `<span class="option-check">✓</span><span>${escapeHtml(q.options[origIdx])}</span>`;
    if (currentQuiz.selected.includes(origIdx)) btn.classList.add('checked');
    btn.onclick = () => toggleOption(origIdx, btn);
    container.appendChild(btn);
  });

  if (st.answered) {
    showAnswerState(q, st.selected, st.wasCorrect);
    document.querySelector('.quiz-actions').classList.add('hidden');
    document.getElementById('btn-next').classList.remove('hidden');
  } else {
    document.getElementById('btn-next').classList.add('hidden');
    document.querySelector('.quiz-actions').classList.remove('hidden');
    document.getElementById('btn-check').classList.remove('hidden');
    document.getElementById('btn-finish').classList.remove('hidden');
  }
}

function toggleOption(origIdx, btn) {
  if (currentQuiz.answered) return;
  const q = currentQuiz.questions[currentQuiz.index];
  if (q.kind === 'task') return;
  const multi = isMulti(q);
  if (multi) {
    const pos = currentQuiz.selected.indexOf(origIdx);
    if (pos >= 0) {
      currentQuiz.selected.splice(pos, 1);
      btn.classList.remove('checked');
    } else {
      currentQuiz.selected.push(origIdx);
      btn.classList.add('checked');
    }
  } else {
    currentQuiz.selected = [origIdx];
    document.querySelectorAll('.option').forEach(o => o.classList.remove('checked'));
    btn.classList.add('checked');
  }
  currentQuiz.states[currentQuiz.index].selected = [...currentQuiz.selected];
}

function checkAnswer() {
  if (currentQuiz.answered) return;
  const q = currentQuiz.questions[currentQuiz.index];
  if (q.kind === 'task') {
    checkTaskAnswer();
    return;
  }
  if (currentQuiz.selected.length === 0) {
    appAlert('Выберите хотя бы один вариант');
    return;
  }
  finishAnswer();
}

function checkTaskAnswer() {
  const idx = currentQuiz.index;
  const q = currentQuiz.questions[idx];
  const st = currentQuiz.states[idx];
  let isRight = false;
  let userText = '';
  let userTable = null;

  if (q.answerType === 'table') {
    userTable = readEditTable('user-answer-table');
    const hasAny = userTable.some(r => r.some(c => c !== ''));
    if (!hasAny) { appAlert('Заполните таблицу'); return; }
    isRight = tablesEqual(userTable, q.answerTable);
    st.userTable = userTable;
  } else {
    userText = document.getElementById('user-answer-text').value;
    if (!userText.trim()) { appAlert('Введите ответ'); return; }
    isRight = normalizeStr(userText) === normalizeStr(q.answerText);
    st.userText = userText;
  }

  const already = st.answered;
  st.answered = true;
  st.wasCorrect = isRight;
  currentQuiz.answered = true;
  if (isRight && !already) {
    currentQuiz.score++;
    document.getElementById('score-display').textContent = currentQuiz.score;
  }

  if (q.answerType === 'table') {
    document.querySelectorAll('#user-answer-table input').forEach(i => i.disabled = true);
  } else {
    document.getElementById('user-answer-text').disabled = true;
  }

  showTaskAnswerState(q, st);
  document.querySelector('.quiz-actions').classList.add('hidden');
  document.getElementById('btn-next').classList.remove('hidden');
  updateQuestionSelect();
}

function showTaskAnswerState(q, st) {
  const divider = document.getElementById('result-divider');
  if (divider) divider.classList.remove('hidden');
  const feedback = document.getElementById('feedback');
  const details = document.getElementById('answer-details');

  let explBlocks = q.explanationBlocks;
  if (!explBlocks || !explBlocks.length) {
    explBlocks = [];
    if (q.explanationType === 'image' && q.explanationImage) explBlocks.push({ type: 'image', value: q.explanationImage });
    else if (q.explanation) explBlocks.push({ type: 'text', value: q.explanation });
  }

  let explHtml = '';
  if (explBlocks.length) {
    explHtml = explBlocks.map(b => {
      if (b.type === 'image') return `<div class="image-preview"><img src="${b.value}" alt="Пояснение"></div>`;
      return `<div>${escapeHtml(b.value)}</div>`;
    }).join('');
  } else {
    explHtml = '<em>Пояснение не добавлено</em>';
  }

  if (st.wasCorrect) {
    feedback.className = 'feedback correct';
    feedback.innerHTML = `<strong>Верно!</strong>`;
  } else {
    feedback.className = 'feedback incorrect';
    feedback.innerHTML = `<strong>Неверно.</strong>`;
  }

  let html = '';
  if (!st.wasCorrect) {
    if (q.answerType === 'table') {
      html += `<div class="detail-block detail-missed"><div class="detail-title">Правильная таблица:</div>`;
      html += '<div class="table-scroll"><table class="edit-table"><tbody>';
      (q.answerTable || []).forEach(row => {
        html += '<tr>' + row.map(c => `<td><input disabled value="${escapeAttr(c)}"></td>`).join('') + '</tr>';
      });
      html += '</tbody></table></div></div>';
    } else {
      html += `<div class="detail-block detail-missed"><div class="detail-title">Правильный ответ:</div><ul><li>${escapeHtml(q.answerText)}</li></ul></div>`;
    }
  }
  html += `<div class="detail-block detail-ok"><div class="detail-title">Пояснение:</div>${explHtml}</div>`;
  details.innerHTML = html;
  details.className = 'answer-details';
}

function showAnswerState(q, selected, isRight) {
  if (q.kind === 'task') return;
  const correctSet = q.correct;
  const options = document.querySelectorAll('.option');
  options.forEach((opt) => {
    const origIdx = parseInt(opt.dataset.orig, 10);
    opt.classList.add('disabled');
    const shouldBeCorrect = correctSet.includes(origIdx);
    const wasSelected = selected.includes(origIdx);
    if (shouldBeCorrect && wasSelected) opt.classList.add('correct');
    else if (wasSelected && !shouldBeCorrect) opt.classList.add('incorrect');
    else if (shouldBeCorrect && !wasSelected) {
      opt.classList.add('missed');
      opt.classList.add('correct');
    }
  });

  const divider = document.getElementById('result-divider');
  if (divider) divider.classList.remove('hidden');

  const feedback = document.getElementById('feedback');
  const details = document.getElementById('answer-details');

  if (isRight) {
    feedback.className = 'feedback correct';
    feedback.innerHTML = `<strong>Верно!</strong> ${q.explanation || ''}`;
    details.className = 'answer-details hidden';
    details.innerHTML = '';
  } else {
    feedback.className = 'feedback incorrect';
    feedback.innerHTML = `<strong>Неверно.</strong> ${q.explanation || ''}`;

    const extra = selected.filter(i => !correctSet.includes(i));
    const missed = correctSet.filter(i => !selected.includes(i));
    const chosenOk = selected.filter(i => correctSet.includes(i));

    let html = '';
    if (extra.length) {
      html += `<div class="detail-block detail-extra"><div class="detail-title">Выбрано лишнее:</div><ul>`;
      extra.forEach(i => { html += `<li>${escapeHtml(q.options[i])}</li>`; });
      html += `</ul></div>`;
    }
    if (chosenOk.length) {
      html += `<div class="detail-block detail-ok"><div class="detail-title">Выбрано верно:</div><ul>`;
      chosenOk.forEach(i => { html += `<li>${escapeHtml(q.options[i])}</li>`; });
      html += `</ul></div>`;
    }
    if (missed.length) {
      html += `<div class="detail-block detail-missed"><div class="detail-title">Не выбрано (нужно было выбрать):</div><ul>`;
      missed.forEach(i => { html += `<li>${escapeHtml(q.options[i])}</li>`; });
      html += `</ul></div>`;
    }
    details.innerHTML = html;
    details.className = 'answer-details';
  }
}

function finishAnswer() {
  const idx = currentQuiz.index;
  const q = currentQuiz.questions[idx];
  if (q.kind === 'task') { checkTaskAnswer(); return; }
  const correctSet = q.correct;
  const selected = currentQuiz.selected;
  const isRight = arraysEqual(selected, correctSet);

  const st = currentQuiz.states[idx];
  const already = st.answered;
  st.answered = true;
  st.selected = [...selected];
  st.wasCorrect = isRight;
  currentQuiz.answered = true;

  if (isRight && !already) {
    currentQuiz.score++;
    document.getElementById('score-display').textContent = currentQuiz.score;
  }

  showAnswerState(q, selected, isRight);
  document.querySelector('.quiz-actions').classList.add('hidden');
  document.getElementById('btn-next').classList.remove('hidden');
  updateQuestionSelect();
}

function appConfirm(message, options) {
  options = options || {};
  const alertOnly = !!options.alertOnly;
  return new Promise(function(resolve) {
    const modal = document.getElementById('app-confirm-modal');
    const msg = document.getElementById('app-confirm-message');
    const ok = document.getElementById('app-confirm-ok');
    const cancel = document.getElementById('app-confirm-cancel');
    if (!modal || !msg || !ok || !cancel) {
      if (alertOnly) {
        window.alert(message);
        resolve(true);
      } else {
        resolve(window.confirm(message));
      }
      return;
    }
    msg.textContent = message;
    ok.textContent = options.okText || (alertOnly ? 'ОК' : 'Да');
    if (alertOnly) {
      cancel.classList.add('hidden');
      cancel.style.display = 'none';
    } else {
      cancel.classList.remove('hidden');
      cancel.style.display = '';
      cancel.textContent = options.cancelText || 'Отмена';
    }
    modal.classList.remove('hidden');
    function cleanup(result) {
      modal.classList.add('hidden');
      ok.onclick = null;
      cancel.onclick = null;
      modal.onclick = null;
      resolve(result);
    }
    ok.onclick = function() { cleanup(true); };
    cancel.onclick = function() { cleanup(false); };
    modal.onclick = function(e) {
      if (e.target === modal) cleanup(alertOnly ? true : false);
    };
  });
}

function appAlert(message) {
  return appConfirm(message, { alertOnly: true });
}

function confirmGoBack() {
  appConfirm('Вы уверены, что хотите вернуться назад? Прогресс текущей тренировки будет потерян.').then(function(ok) {
    if (ok) goHome();
  });
}

function confirmFinish() {
  appConfirm('Вы действительно хотите завершить тренировку?').then(function(ok) {
    if (ok) showResults();
  });
}

function nextQuestion() {
  const total = currentQuiz.questions.length;
  const states = currentQuiz.states || [];
  // следующий неотвеченный после текущего; с конца — к началу
  let next = -1;
  for (let step = 1; step <= total; step++) {
    const i = (currentQuiz.index + step) % total;
    if (!states[i] || !states[i].answered) {
      next = i;
      break;
    }
  }
  if (next === -1) {
    showResults();
    return;
  }
  currentQuiz.index = next;
  renderQuestion();
}

function showResults() {
  stopQuizTimer();
  const total = currentQuiz.questions.length;
  const correct = currentQuiz.score;
  const percent = total ? Math.round((correct / total) * 100) : 0;

  document.getElementById('stat-correct').textContent = correct;
  document.getElementById('stat-total').textContent = total;
  document.getElementById('stat-percent').textContent = percent + '%';

  let icon = '🎉', title = 'Тренировка завершена!', message = '';
  if (percent >= 90) {
    icon = '🏆'; title = 'Отличный результат!';
    message = 'Вы отлично подготовились. Продолжайте в том же духе!';
  } else if (percent >= 70) {
    icon = '👍'; title = 'Хороший результат!';
    message = 'Есть уверенные знания. Имеет смысл повторить сложные темы.';
  } else if (percent >= 50) {
    icon = '📚'; title = 'Есть над чем поработать';
    message = 'Рекомендуем ещё раз пройти тренажёр и обратить внимание на объяснения.';
  } else {
    icon = '💪'; title = 'Начните подготовку активнее';
    message = 'Не расстраивайтесь — регулярная практика даст результат. Попробуйте ещё раз!';
  }
  document.getElementById('results-icon').textContent = icon;
  document.getElementById('results-title').textContent = title;
  document.getElementById('results-message').textContent = message;
  showPage('results-page');
}

function retryQuiz() {
  if (!currentQuiz.type) { goHome(); return; }
  if (currentQuiz.type.startsWith('general-')) {
    startGeneralQuiz(currentQuiz.type.split('-')[1]);
  } else if (currentQuiz.type.startsWith('informatics-')) {
    startInformaticsQuiz(currentQuiz.type.split('-')[1]);
  }
}

// —— Страница управления ——
let tableRows = 2;
let tableCols = 2;
let taskBlockId = 0;
let explBlockId = 0;
let taskFiles = []; // { name, type, size, dataUrl }

function scrollToForm() {
  const form = document.getElementById('question-form');
  if (form) {
    setTimeout(function() {
      form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
  }
}

function scrollToElement(el) {
  if (!el) return;
  setTimeout(function() {
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, 50);
}

function openManagePage(mode, level) {
  if (!requireAdmin()) return;
  manageMode = mode;
  manageLevel = level === 'highest' ? 'highest' : 'first';
  editingId = null;
  activeSectorId = null;
  pullFromRealtime().then(function() {
    renderQuestionsList();
  });
  const cat = manageLevel === 'highest' ? 'высшую категорию' : 'первую категорию';
  document.getElementById('manage-title').textContent =
    mode === 'general'
      ? 'Общие вопросы (на ' + cat + ')'
      : 'Задания по информатике (на ' + cat + ')';
  document.getElementById('question-form').classList.add('hidden');
  const tg = document.getElementById('toolbar-general');
  const tt = document.getElementById('toolbar-tasks');
  const sectorsList = document.getElementById('sectors-list');
  const qList = document.getElementById('questions-list');
  if (mode === 'general') {
    if (tg) tg.classList.remove('hidden');
    if (tt) tt.classList.add('hidden');
    if (sectorsList) sectorsList.classList.add('hidden');
    if (qList) qList.classList.remove('hidden');
  } else {
    if (tg) tg.classList.add('hidden');
    if (tt) tt.classList.remove('hidden');
    if (sectorsList) sectorsList.classList.remove('hidden');
    if (qList) qList.classList.add('hidden');
  }
  renderQuestionsList();
  showPage('manage-page');
}

function startNewQuestion() {
  editingId = null;
  const form = document.getElementById('question-form');
  const formGeneral = document.getElementById('form-general');
  const formTask = document.getElementById('form-task');

  if (manageMode === 'general') {
    document.getElementById('form-heading').textContent = 'Новый вопрос';
    formGeneral.classList.remove('hidden');
    formTask.classList.add('hidden');
    document.getElementById('q-text').value = '';
    document.getElementById('q-explanation').value = '';
    try {
      resetOptionFields();
    } catch (e) {
      console.error('resetOptionFields', e);
      appAlert('Ошибка формы вопроса: ' + e.message);
    }
  } else {
    if (!activeSectorId) {
      appAlert('Сначала добавьте сектор, затем нажмите «+ Новое задание» в секторе.');
      return;
    }
    document.getElementById('form-heading').textContent = 'Новое задание';
    formGeneral.classList.add('hidden');
    formTask.classList.remove('hidden');
    try {
      resetTaskForm();
    } catch (e) {
      console.error('resetTaskForm error', e);
      appAlert('Ошибка формы задания: ' + e.message);
    }
  }
  form.classList.remove('hidden');
  scrollToForm();
}

function resetTaskForm() {
  document.querySelector('input[name="answer-type"][value="text"]').checked = true;
  const titleEl = document.getElementById('task-title');
  if (titleEl) titleEl.value = '';
  document.getElementById('answer-text').value = '';
  document.getElementById('task-blocks').innerHTML = '';
  document.getElementById('expl-blocks').innerHTML = '';
  taskBlockId = 0;
  explBlockId = 0;
  taskFiles = [];
  renderTaskFilesList();
  tableRows = 2;
  tableCols = 2;
  buildEditTable('answer-table', tableRows, tableCols, null);
  onAnswerTypeChange();
  addTaskBlock('text');
}

function addTaskBlock(type, value) {
  const list = document.getElementById('task-blocks');
  const id = taskBlockId++;
  const div = document.createElement('div');
  div.className = 'block-item';
  div.dataset.id = id;
  div.dataset.type = type;
  if (type === 'text') {
    div.innerHTML = `
      <div class="block-item-header"><span>Текст</span>
        <button type="button" class="btn-remove" onclick="this.closest('.block-item').remove()" title="Удалить">×</button>
      </div>
      <textarea class="form-textarea block-text" rows="3" placeholder="Текст задания...">${value ? escapeHtml(value) : ''}</textarea>`;
  } else {
    const src = value || '';
    div.innerHTML = `
      <div class="block-item-header"><span>Картинка</span>
        <button type="button" class="btn-remove" onclick="this.closest('.block-item').remove()" title="Удалить">×</button>
      </div>
      <input type="file" accept="image/*" class="form-file" onchange="onBlockImage(this)">
      <div class="image-preview">${src ? `<img src="${src}" alt="">` : ''}</div>`;
    if (src) div.dataset.src = src;
  }
  list.appendChild(div);
}

function addExplBlock(type, value) {
  const list = document.getElementById('expl-blocks');
  const id = explBlockId++;
  const div = document.createElement('div');
  div.className = 'block-item';
  div.dataset.id = id;
  div.dataset.type = type;
  if (type === 'text') {
    div.innerHTML = `
      <div class="block-item-header"><span>Текст</span>
        <button type="button" class="btn-remove" onclick="this.closest('.block-item').remove()" title="Удалить">×</button>
      </div>
      <textarea class="form-textarea block-text" rows="2" placeholder="Пояснение...">${value ? escapeHtml(value) : ''}</textarea>`;
  } else {
    const src = value || '';
    div.innerHTML = `
      <div class="block-item-header"><span>Картинка</span>
        <button type="button" class="btn-remove" onclick="this.closest('.block-item').remove()" title="Удалить">×</button>
      </div>
      <input type="file" accept="image/*" class="form-file" onchange="onBlockImage(this)">
      <div class="image-preview">${src ? `<img src="${src}" alt="">` : ''}</div>`;
    if (src) div.dataset.src = src;
  }
  list.appendChild(div);
}

function onBlockImage(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  if (!file.type || file.type.indexOf('image/') !== 0) {
    appAlert('Можно загружать только изображения');
    input.value = '';
    return;
  }
  if (file.size > 2 * 1024 * 1024) {
    appAlert('Картинка слишком большая (макс. 2 МБ)');
    input.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const src = sanitizeImageSrc(reader.result);
    if (!src) {
      appAlert('Некорректный файл изображения');
      return;
    }
    const item = input.closest('.block-item');
    item.dataset.src = src;
    item.querySelector('.image-preview').innerHTML = `<img src="${src}" alt="">`;
  };
  reader.readAsDataURL(file);
}

function setBlockImageFromDataUrl(item, dataUrl) {
  if (!item) return;
  const src = sanitizeImageSrc(dataUrl);
  if (!src) {
    appAlert('Можно вставлять только изображения (png, jpg, gif, webp)');
    return;
  }
  item.dataset.src = src;
  const prev = item.querySelector('.image-preview');
  if (prev) prev.innerHTML = '<img src="' + src + '" alt="">';
}

function readClipboardImage(clipboardData) {
  if (!clipboardData) return null;
  const items = clipboardData.items || [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.type && it.type.indexOf('image') === 0) {
      return it.getAsFile();
    }
  }
  const files = clipboardData.files || [];
  for (let i = 0; i < files.length; i++) {
    if (files[i].type && files[i].type.indexOf('image') === 0) {
      return files[i];
    }
  }
  return null;
}

function fileToDataUrl(file) {
  return new Promise(function(resolve, reject) {
    if (file.size > 2 * 1024 * 1024) {
      reject(new Error('Картинка слишком большая (макс. 2 МБ)'));
      return;
    }
    const reader = new FileReader();
    reader.onload = function() { resolve(reader.result); };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function handleClipboardPaste(e) {
  const form = document.getElementById('question-form');
  if (!form || form.classList.contains('hidden')) return;
  const formTask = document.getElementById('form-task');
  if (!formTask || formTask.classList.contains('hidden')) return;

  const file = readClipboardImage(e.clipboardData);
  if (!file) return;

  e.preventDefault();
  try {
    const dataUrl = await fileToDataUrl(file);
    const active = document.activeElement;
    const inExpl = active && active.closest && active.closest('#expl-blocks');
    const inTask = active && active.closest && active.closest('#task-blocks');
    const targetList = inExpl ? 'expl' : 'task';

    // если фокус на существующем image-блоке — заменить картинку
    const blockItem = active && active.closest && active.closest('.block-item');
    if (blockItem && blockItem.dataset.type === 'image') {
      setBlockImageFromDataUrl(blockItem, dataUrl);
      return;
    }

    if (targetList === 'expl') {
      addExplBlock('image', dataUrl);
    } else {
      addTaskBlock('image', dataUrl);
    }
  } catch (err) {
    appAlert(err.message || 'Не удалось вставить картинку');
  }
}

function readBlocks(containerId) {
  const items = [...document.querySelectorAll(`#${containerId} .block-item`)];
  const blocks = [];
  for (const item of items) {
    const type = item.dataset.type;
    if (type === 'text') {
      const t = item.querySelector('.block-text').value.trim();
      if (t) blocks.push({ type: 'text', value: t });
    } else {
      const src = item.dataset.src || '';
      if (src) blocks.push({ type: 'image', value: src });
    }
  }
  return blocks;
}

function onAnswerTypeChange() {
  const radio = document.querySelector('input[name="answer-type"]:checked');
  if (!radio) return;
  const v = radio.value;
  const textEl = document.getElementById('answer-text');
  const tableWrap = document.getElementById('answer-table-wrap');
  if (!textEl || !tableWrap) return;
  if (v === 'table') {
    textEl.classList.add('hidden');
    textEl.style.display = 'none';
    tableWrap.classList.remove('hidden');
    tableWrap.style.display = '';
  } else {
    textEl.classList.remove('hidden');
    textEl.style.display = '';
    tableWrap.classList.add('hidden');
    tableWrap.style.display = 'none';
  }
}

function buildEditTable(tableId, rows, cols, data) {
  const table = document.querySelector('#' + tableId);
  if (!table) return;
  let tbody = table.querySelector('tbody');
  if (!tbody) {
    tbody = document.createElement('tbody');
    table.appendChild(tbody);
  }
  tbody.innerHTML = '';
  for (let r = 0; r < rows; r++) {
    const tr = document.createElement('tr');
    for (let c = 0; c < cols; c++) {
      const td = document.createElement('td');
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.value = (data && data[r] && data[r][c] != null) ? data[r][c] : '';
      td.appendChild(inp);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
}

function readEditTable(tableId) {
  const rows = [...document.querySelectorAll('#' + tableId + ' tbody tr')];
  return rows.map(tr => [...tr.querySelectorAll('input')].map(i => i.value.trim()));
}

function addTableRow() {
  const data = readEditTable('answer-table');
  tableCols = data[0] ? data[0].length : (tableCols || 2);
  tableRows = data.length + 1;
  data.push(Array(tableCols).fill(''));
  buildEditTable('answer-table', tableRows, tableCols, data);
}

function addTableCol() {
  const data = readEditTable('answer-table');
  if (!data.length) {
    tableRows = 1;
    tableCols = (tableCols || 1) + 1;
    data.push(Array(tableCols).fill(''));
  } else {
    tableCols = data[0].length + 1;
    tableRows = data.length;
    data.forEach(row => row.push(''));
  }
  buildEditTable('answer-table', tableRows, tableCols, data);
}

function removeTableRow() {
  const data = readEditTable('answer-table');
  if (data.length <= 1) { appAlert('Нужна хотя бы 1 строка'); return; }
  data.pop();
  tableRows = data.length;
  tableCols = data[0].length;
  buildEditTable('answer-table', tableRows, tableCols, data);
}

function removeTableCol() {
  const data = readEditTable('answer-table');
  if (!data[0] || data[0].length <= 1) { appAlert('Нужен хотя бы 1 столбец'); return; }
  data.forEach(row => row.pop());
  tableRows = data.length;
  tableCols = data[0].length;
  buildEditTable('answer-table', tableRows, tableCols, data);
}


function cancelForm() {
  document.getElementById('question-form').classList.add('hidden');
  editingId = null;
}

function resetOptionFields(options, correct) {
  optionFieldCount = 0;
  const container = document.getElementById('options-fields');
  if (!container) return;
  container.innerHTML = '';
  if (options && options.length) {
    options.forEach((text, i) => {
      addOptionField(text, correct && correct.includes(i));
    });
  } else {
    addOptionField();
    addOptionField();
  }
}

function addOptionField(text, checked) {
  const container = document.getElementById('options-fields');
  if (!container) return;
  const id = optionFieldCount++;
  const row = document.createElement('div');
  row.className = 'option-field';
  row.dataset.id = String(id);
  const safe = text ? String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;') : '';
  row.innerHTML =
    '<input type="checkbox" class="opt-correct" ' + (checked ? 'checked' : '') + ' title="Правильный ответ">' +
    '<input type="text" class="form-input option-text" placeholder="Вариант ответа" value="' + safe + '">' +
    '<button type="button" class="btn-remove" onclick="removeOptionField(this)" title="Удалить">×</button>';
  container.appendChild(row);
}

function removeOptionField(btn) {
  const container = document.getElementById('options-fields');
  if (!container) return;
  if (container.children.length <= 2) {
    appAlert('Нужно минимум 2 варианта ответа');
    return;
  }
  const row = btn.closest('.option-field');
  if (row) row.remove();
}

function saveQuestion() {
  if (manageMode === 'informatics') {
    saveTask();
    return;
  }
  const text = document.getElementById('q-text').value.trim();
  if (!text) { appAlert('Введите текст вопроса'); return; }

  const fields = [...document.querySelectorAll('#options-fields .option-field')];
  const options = [];
  const correct = [];
  fields.forEach(row => {
    const val = row.querySelector('.option-text').value.trim();
    if (!val) return;
    if (row.querySelector('.opt-correct').checked) correct.push(options.length);
    options.push(val);
  });
  if (options.length < 2) { appAlert('Добавьте минимум 2 варианта ответа'); return; }
  if (correct.length === 0) { appAlert('Отметьте хотя бы один правильный ответ'); return; }

  const explanation = document.getElementById('q-explanation').value.trim();
  const question = { kind: 'choice', text, options, correct, explanation };
  const data = loadCustom();
  const lk = levelKey();
  if (editingId && editingId.index != null) {
    data[lk].general[editingId.index] = question;
  } else {
    data[lk].general.unshift(question);
  }
  saveCustom(data);
  document.getElementById('question-form').classList.add('hidden');
  editingId = null;
  renderQuestionsList();
  const qList = document.getElementById('questions-list');
  if (qList) qList.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function onTaskFilesSelected(input) {
  const files = input.files ? [...input.files] : [];
  input.value = '';
  files.forEach(file => {
    if (file.size > 5 * 1024 * 1024) {
      appAlert('Файл «' + file.name + '» больше 5 МБ');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      taskFiles.push({
        name: file.name,
        type: file.type || 'application/octet-stream',
        size: file.size,
        dataUrl: reader.result
      });
      renderTaskFilesList();
    };
    reader.readAsDataURL(file);
  });
}

function renderTaskFilesList() {
  const list = document.getElementById('task-files-list');
  if (!list) return;
  if (!taskFiles.length) {
    list.innerHTML = '<li class="empty" style="border:none;background:transparent;color:var(--text-muted)">Файлы не добавлены</li>';
    return;
  }
  list.innerHTML = taskFiles.map((f, i) => {
    const kb = (f.size / 1024).toFixed(1);
    return `<li>
      <span title="${escapeAttr(f.name)}">📎 ${escapeHtml(f.name)} <small>(${kb} КБ)</small></span>
      <button type="button" class="btn-remove" onclick="removeTaskFile(${i})" title="Удалить">×</button>
    </li>`;
  }).join('');
}

function removeTaskFile(index) {
  taskFiles.splice(index, 1);
  renderTaskFilesList();
}

function formatFilesView(files) {
  if (!files || !files.length) return '';
  return files.map(f => {
    const name = escapeHtml(f.name || 'файл');
    const href = sanitizeImageSrc(f.dataUrl) || (isSafeDataImageUrl(f.dataUrl) ? f.dataUrl : '');
    // файлы как data:application/... — разрешаем data: с ограничением
    let safe = '';
    if (f.dataUrl && /^data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,/i.test(String(f.dataUrl).slice(0, 80))) {
      safe = f.dataUrl;
    } else {
      safe = sanitizeUrl(f.dataUrl);
    }
    if (!safe) return `<span>📎 ${name}</span>`;
    return `<a href="${safe}" download="${escapeAttr(f.name || 'file')}" target="_blank" rel="noopener noreferrer">📎 ${name}</a>`;
  }).join('');
}

function sectorSortKey(sec) {
  const m = String(sec.name || '').trim().match(/(\d+)/);
  if (m) return { hasNum: 1, num: parseInt(m[1], 10), name: sec.name || '' };
  return { hasNum: 0, num: 0, name: sec.name || '' };
}

function sortSectors(sectors) {
  return (sectors || []).slice().sort(function(a, b) {
    const ka = sectorSortKey(a);
    const kb = sectorSortKey(b);
    // с номером — по возрастанию (2, 4, 14, 16, 19…); без номера — внизу
    if (ka.hasNum !== kb.hasNum) return kb.hasNum - ka.hasNum;
    if (ka.hasNum && kb.hasNum && ka.num !== kb.num) return ka.num - kb.num;
    return ka.name.localeCompare(kb.name, 'ru');
  });
}

function addSector() {
  const data = loadCustom();
  const lk = levelKey();
  const n = (data[lk].sectors || []).length + 1;
  const id = newSectorId();
  data[lk].sectors.push({
    id: id,
    name: 'Сектор ' + n,
    count: 5,
    tasks: []
  });
  // хранить отсортированно по номеру в названии
  data[lk].sectors = sortSectors(data[lk].sectors);
  saveCustom(data);
  renderQuestionsList();
  const el = document.querySelector('.sector-card[data-id="' + id + '"]');
  scrollToElement(el);
}

function updateSectorName(sectorId, name) {
  const data = loadCustom();
  const sec = (data[levelKey()].sectors || []).find(function(s) { return s.id === sectorId; });
  if (!sec) return;
  sec.name = (name || '').trim() || 'Сектор';
  data[levelKey()].sectors = sortSectors(data[levelKey()].sectors);
  saveCustom(data);
  renderQuestionsList();
}

function updateSectorCount(sectorId, value) {
  const data = loadCustom();
  const sec = (data[levelKey()].sectors || []).find(function(s) { return s.id === sectorId; });
  if (!sec) return;
  var n = parseInt(value, 10);
  if (isNaN(n) || n < 0) n = 0;
  sec.count = n;
  saveCustom(data);
}

function deleteSector(sectorId) {
  appConfirm('Удалить сектор и все задания в нём?').then(function(ok) {
    if (!ok) return;
    const data = loadCustom();
    data[levelKey()].sectors = (data[levelKey()].sectors || []).filter(function(s) { return s.id !== sectorId; });
    saveCustom(data);
    if (activeSectorId === sectorId) {
      activeSectorId = null;
      cancelForm();
    }
    renderQuestionsList();
  });
}

function startNewTaskInSector(sectorId) {
  activeSectorId = sectorId;
  startNewQuestion();
}

function saveTask() {
  const answerType = document.querySelector('input[name="answer-type"]:checked').value;
  const content = readBlocks('task-blocks');
  if (!content.length) {
    appAlert('Добавьте хотя бы один текст или картинку в задание');
    return;
  }

  let answerText = '';
  let answerTable = null;
  if (answerType === 'text') {
    answerText = document.getElementById('answer-text').value.trim();
    if (!answerText) { appAlert('Введите правильный текстовый ответ'); return; }
  } else {
    answerTable = readEditTable('answer-table');
    const hasAny = answerTable.some(r => r.some(c => c !== ''));
    if (!hasAny) { appAlert('Заполните хотя бы одну ячейку таблицы'); return; }
  }

  const explanationBlocks = readBlocks('expl-blocks');
  const titleEl = document.getElementById('task-title');
  const title = (titleEl && titleEl.value.trim()) || '';
  if (!title) {
    appAlert('Введите название задания');
    return;
  }
  const task = {
    kind: 'task',
    title,
    content,
    text: title,
    files: taskFiles.slice(),
    answerType,
    answerText,
    answerTable,
    explanationBlocks
  };

  const data = loadCustom();
  const lk = levelKey();
  if (editingId && editingId.sectorId != null && editingId.index != null) {
    const sec = (data[lk].sectors || []).find(function(s) { return s.id === editingId.sectorId; });
    if (sec) sec.tasks[editingId.index] = task;
  } else {
    const sec = (data[lk].sectors || []).find(function(s) { return s.id === activeSectorId; });
    if (!sec) {
      appAlert('Сектор не найден');
      return;
    }
    sec.tasks.push(task);
  }
  saveCustom(data);
  document.getElementById('question-form').classList.add('hidden');
  editingId = null;
  renderQuestionsList();
}

function renderQuestionsList() {
  const data = loadCustom();
  const lk = levelKey();
  const list = document.getElementById('questions-list');
  const sectorsList = document.getElementById('sectors-list');

  if (manageMode === 'general') {
    if (sectorsList) sectorsList.classList.add('hidden');
    if (list) list.classList.remove('hidden');
    const items = data[lk].general || [];
    if (!items.length) {
      list.innerHTML = '<div class="list-empty">Пока нет вопросов. Нажмите «+ Новый вопрос».</div>';
      return;
    }
    list.innerHTML = items.map(function(q, index) {
      const nq = normalizeQuestion(q);
      const opts = (nq.options || []).map(function(o, i) {
        const ok = nq.correct.includes(i);
        return '<li class="' + (ok ? 'correct-opt' : '') + '"><span class="check-icon">' + (ok ? '✓' : '') + '</span><span>' + escapeHtml(o) + '</span></li>';
      }).join('');
      return '<div class="q-card"><div class="q-card-header"><div class="q-card-text">' + escapeHtml(nq.text) +
        '</div><div class="q-card-actions"><button class="btn-edit" onclick="editQuestion(' + index +
        ')">Изменить</button><button class="btn-del" onclick="deleteQuestion(' + index +
        ')">Удалить</button></div></div><span class="q-card-meta">' +
        (nq.correct.length > 1 ? 'Несколько ответов' : 'Один ответ') +
        '</span><ul class="q-card-options">' + opts + '</ul></div>';
    }).join('');
    return;
  }

  if (list) list.classList.add('hidden');
  if (sectorsList) sectorsList.classList.remove('hidden');
  const sectors = sortSectors(data[lk].sectors || []);
  if (!sectors.length) {
    sectorsList.innerHTML = '<div class="list-empty">Пока нет секторов. Нажмите «+ Добавить сектор».</div>';
    return;
  }

  sectorsList.innerHTML = sectors.map(function(sec) {
    var tasksHtml;
    if (!(sec.tasks && sec.tasks.length)) {
      tasksHtml = '<div class="sector-empty">В секторе пока нет заданий</div>';
    } else {
      tasksHtml = sec.tasks.map(function(q, index) {
        var ans = q.answerType === 'table' ? 'таблица' : 'текст';
        var nFiles = (q.files && q.files.length) || 0;
        var title = q.title || q.text || 'Задание';
        return '<div class="q-card"><div class="q-card-header"><div class="q-card-text">' + escapeHtml(title) +
          '</div><div class="q-card-actions"><button class="btn-edit" onclick="editTaskInSector(\'' + sec.id +
          '\', ' + index + ')">Изменить</button><button class="btn-del" onclick="deleteTaskInSector(\'' + sec.id +
          '\', ' + index + ')">Удалить</button></div></div><span class="q-card-meta">Ответ: ' + ans +
          (nFiles ? ' · файлов: ' + nFiles : '') + '</span></div>';
      }).join('');
    }
    return '<div class="sector-card" data-id="' + sec.id + '"><div class="sector-header">' +
      '<input class="sector-name-input" value="' + escapeAttr(sec.name) + '" onchange="updateSectorName(\'' + sec.id +
      '\', this.value)" placeholder="Название сектора">' +
      '<div class="sector-count-wrap"><span>В тренажёр:</span>' +
      '<input type="number" min="0" value="' + sec.count + '" onchange="updateSectorCount(\'' + sec.id +
      '\', this.value)" title="Сколько заданий из сектора в тренажёре"></div>' +
      '<button class="btn btn-primary" onclick="startNewTaskInSector(\'' + sec.id +
      '\')">+ Новое задание</button>' +
      '<button class="btn btn-outline btn-danger-outline" onclick="deleteSector(\'' + sec.id +
      '\')">Удалить сектор</button></div><div class="sector-tasks">' + tasksHtml + '</div></div>';
  }).join('');
}

function editTaskInSector(sectorId, index) {
  activeSectorId = sectorId;
  editQuestion(index, sectorId);
}

function deleteTaskInSector(sectorId, index) {
  appConfirm('Удалить задание?').then(function(ok) {
    if (!ok) return;
    const data = loadCustom();
    const sec = (data[levelKey()].sectors || []).find(function(s) { return s.id === sectorId; });
    if (!sec) return;
    sec.tasks.splice(index, 1);
    saveCustom(data);
    cancelForm();
    renderQuestionsList();
  });
}

function editQuestion(index, sectorId) {
  const data = loadCustom();
  const lk = levelKey();
  var q;
  if (manageMode === 'general') {
    q = data[lk].general[index];
    editingId = { index: index };
  } else {
    var sid = sectorId || activeSectorId;
    var sec = (data[lk].sectors || []).find(function(s) { return s.id === sid; });
    q = sec && sec.tasks[index];
    activeSectorId = sid;
    editingId = { index: index, sectorId: sid };
  }
  if (!q) return;

  if (q.kind === 'task' || manageMode === 'informatics') {
    document.getElementById('form-heading').textContent = 'Редактирование задания';
    document.getElementById('form-general').classList.add('hidden');
    document.getElementById('form-task').classList.remove('hidden');

    const titleEl = document.getElementById('task-title');
    if (titleEl) titleEl.value = q.title || q.text || '';
    document.querySelector(`input[name="answer-type"][value="${q.answerType || 'text'}"]`).checked = true;
    document.getElementById('answer-text').value = q.answerText || '';
    document.getElementById('task-blocks').innerHTML = '';
    document.getElementById('expl-blocks').innerHTML = '';
    taskBlockId = 0;
    explBlockId = 0;
    taskFiles = Array.isArray(q.files) ? q.files.map(f => ({ ...f })) : [];
    renderTaskFilesList();

    // migrate old format
    let content = q.content;
    if (!content || !content.length) {
      content = [];
      if (q.taskContentType === 'image' && q.taskImage) content.push({ type: 'image', value: q.taskImage });
      if (q.text) content.push({ type: 'text', value: q.text });
      if (!content.length && q.text) content.push({ type: 'text', value: q.text });
    }
    content.forEach(b => addTaskBlock(b.type, b.value));
    if (!content.length) addTaskBlock('text');

    let expl = q.explanationBlocks;
    if (!expl || !expl.length) {
      expl = [];
      if (q.explanationType === 'image' && q.explanationImage) expl.push({ type: 'image', value: q.explanationImage });
      else if (q.explanation) expl.push({ type: 'text', value: q.explanation });
    }
    expl.forEach(b => addExplBlock(b.type, b.value));

    if (q.answerTable && q.answerTable.length) {
      tableRows = q.answerTable.length;
      tableCols = q.answerTable[0].length;
      buildEditTable('answer-table', tableRows, tableCols, q.answerTable);
    } else {
      tableRows = 2; tableCols = 2;
      buildEditTable('answer-table', 2, 2, null);
    }
    onAnswerTypeChange();
  } else {
    document.getElementById('form-heading').textContent = 'Редактирование вопроса';
    document.getElementById('form-general').classList.remove('hidden');
    document.getElementById('form-task').classList.add('hidden');
    document.getElementById('q-text').value = q.text;
    document.getElementById('q-explanation').value = q.explanation || '';
    const nq = normalizeQuestion(q);
    resetOptionFields(nq.options, nq.correct);
  }
  document.getElementById('question-form').classList.remove('hidden');
  scrollToForm();
}

function deleteQuestion(index) {
  appConfirm('Удалить?').then(function(ok) {
    if (!ok) return;
    const data = loadCustom();
    const lk = levelKey();
    if (manageMode !== 'general') return;
    data[lk].general.splice(index, 1);
    saveCustom(data);
    if (editingId && editingId.index === index) cancelForm();
    renderQuestionsList();
  });
}

function clearAllInSection() {
  appConfirm('Удалить все в этом разделе?').then(function(ok) {
    if (!ok) return;
    const data = loadCustom();
    const lk = levelKey();
    if (manageMode === 'general') data[lk].general = [];
    else data[lk].sectors = [];
    saveCustom(data);
    activeSectorId = null;
    cancelForm();
    renderQuestionsList();
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/`/g, '&#96;');
}

// —— init ——

// —— Админ (Firebase Auth) ——
const ADMIN_UID = (typeof window !== 'undefined' && window.ADMIN_UID) || 'tJqSbhZjNzL5Bm0vi7Umy8Kn3Vc2';
let firebaseReady = false;
let adminUser = null;

function initFirebase() {
  try {
    const cfg = window.FIREBASE_CONFIG || {};
    if (!cfg.apiKey || !cfg.authDomain || !cfg.projectId) {
      console.warn('Firebase: заполните FIREBASE_CONFIG');
      firebaseReady = false;
      return false;
    }
    if (!window.firebase) {
      console.warn('Firebase SDK не загружен');
      firebaseReady = false;
      return false;
    }
    if (!firebase.apps.length) {
      firebase.initializeApp(cfg);
    }
    firebaseReady = true;
    try { firebase.database().goOnline(); } catch (e) {}

    const auth = firebase.auth();
    auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL)
      .catch(function() {
        return auth.setPersistence(firebase.auth.Auth.Persistence.SESSION);
      })
      .finally(function() {
        auth.onAuthStateChanged(function(user) {
          if (user && user.uid === ADMIN_UID) {
            adminUser = user;
            applyAdminUI();
            ensureDataLoaded().then(function() {
              return syncLocalToCloudIfNeeded();
            }).then(function() {
              updateCustomCounts();
              applyHomeSettings();
              const manage = document.getElementById('manage-page');
              if (manage && manage.classList.contains('active')) renderQuestionsList();
            });
          } else if (user && user.uid !== ADMIN_UID) {
            adminUser = null;
            auth.signOut();
            applyAdminUI();
          } else {
            adminUser = null;
            applyAdminUI();
          }
        });
      });

    ensureDataLoaded().then(function() {
      listenRealtime();
      updateCustomCounts();
      applyHomeSettings();
    });
    setTimeout(function() {
      ensureDataLoaded().then(function() { updateCustomCounts(); applyHomeSettings(); });
    }, 2000);
    setTimeout(function() {
      ensureDataLoaded().then(function() { updateCustomCounts(); applyHomeSettings(); });
    }, 5000);
    return true;
  } catch (e) {
    console.error('Firebase init error', e);
    firebaseReady = false;
    return false;
  }
}

function isAdmin() {
  return !!(adminUser && adminUser.uid === ADMIN_UID);
}

function applyAdminUI() {
  const on = isAdmin();
  document.body.classList.toggle('is-admin', on);
  const btn = document.getElementById('profile-btn');
  if (btn) btn.classList.toggle('is-admin', on);
  const loginView = document.getElementById('auth-login-view');
  const adminView = document.getElementById('auth-admin-view');
  if (loginView && adminView) {
    if (on) {
      loginView.classList.add('hidden');
      loginView.style.display = 'none';
      adminView.classList.remove('hidden');
      adminView.style.display = '';
    } else {
      loginView.classList.remove('hidden');
      loginView.style.display = '';
      adminView.classList.add('hidden');
      adminView.style.display = 'none';
    }
  }
  renderExtraBlocks();
}

function openAuthPanel() {
  const modal = document.getElementById('auth-modal');
  if (!modal) return;
  applyAdminUI();
  modal.classList.remove('hidden');
  if (!isAdmin()) {
    const login = document.getElementById('auth-login');
    const pass = document.getElementById('auth-password');
    const err = document.getElementById('auth-error');
    if (login) login.value = '';
    if (pass) pass.value = '';
    if (err) { err.textContent = ''; err.classList.add('hidden'); }
    // гость: только форма входа, кнопка «Выйти» скрыта
    const adminView = document.getElementById('auth-admin-view');
    if (adminView) {
      adminView.classList.add('hidden');
      adminView.style.display = 'none';
    }
    setTimeout(function() { if (login) login.focus(); }, 50);
  }
}

function closeAuthPanel() {
  const modal = document.getElementById('auth-modal');
  if (modal) modal.classList.add('hidden');
}

function setAuthError(msg) {
  const err = document.getElementById('auth-error');
  if (!err) return;
  if (!msg) {
    err.textContent = '';
    err.classList.add('hidden');
  } else {
    err.textContent = msg;
    err.classList.remove('hidden');
  }
}

function tryAdminLogin() {
  const email = (document.getElementById('auth-login').value || '').trim();
  const password = document.getElementById('auth-password').value || '';
  const btn = document.querySelector('#auth-login-view .btn-primary');
  if (!email || !password) {
    setAuthError('Введите логин и пароль');
    return;
  }
  if (!window.firebase || !firebase.auth) {
    setAuthError('Firebase не загружен. Обновите страницу.');
    return;
  }
  if (!firebaseReady) {
    try { initFirebase(); } catch (e) {}
  }
  if (!firebaseReady) {
    setAuthError('Нет связи с Firebase. Проверьте интернет.');
    return;
  }
  setAuthError('');
  if (btn) { btn.disabled = true; btn.textContent = 'Вход…'; }
  try { firebase.database().goOnline(); } catch (e) {}

  firebase.auth().setPersistence(firebase.auth.Auth.Persistence.LOCAL)
    .catch(function() { return null; })
    .then(function() {
      return firebase.auth().signInWithEmailAndPassword(email, password);
    })
    .then(function(cred) {
      if (!cred.user || cred.user.uid !== ADMIN_UID) {
        return firebase.auth().signOut().then(function() {
          setAuthError('Нет прав администратора');
        });
      }
      adminUser = cred.user;
      applyAdminUI();
      return ensureDataLoaded().then(function() {
        return syncLocalToCloudIfNeeded();
      }).then(function() {
        updateCustomCounts();
        applyHomeSettings();
        closeAuthPanel();
      });
    })
    .catch(function(e) {
      var msg = 'Ошибка входа';
      if (e && e.code === 'auth/invalid-credential') msg = 'Неверный логин или пароль';
      else if (e && e.code === 'auth/user-not-found') msg = 'Пользователь не найден';
      else if (e && e.code === 'auth/wrong-password') msg = 'Неверный пароль';
      else if (e && e.code === 'auth/invalid-email') msg = 'Нужен email аккаунта Firebase';
      else if (e && e.code === 'auth/too-many-requests') msg = 'Слишком много попыток. Позже.';
      else if (e && e.code === 'auth/network-request-failed') msg = 'Нет сети. Проверьте интернет.';
      else if (e && e.message) msg = e.message;
      setAuthError(msg);
    })
    .finally(function() {
      if (btn) { btn.disabled = false; btn.textContent = 'Войти'; }
    });
}

function adminLogout() {
  if (firebaseReady && firebase.auth) {
    firebase.auth().signOut().finally(function() {
      adminUser = null;
      applyAdminUI();
      closeAuthPanel();
      const manage = document.getElementById('manage-page');
      if (manage && manage.classList.contains('active')) goHome();
    });
  } else {
    adminUser = null;
    applyAdminUI();
    closeAuthPanel();
  }
}

function requireAdmin() {
  if (isAdmin()) return true;
  appAlert('Редактирование доступно только администратору. Войдите через иконку профиля.');
  openAuthPanel();
  return false;
}


document.addEventListener('DOMContentLoaded', () => {
  initFirebase();
  updateCustomCounts();
  applyHomeSettings();
  applyAdminUI();
  document.addEventListener('paste', handleClipboardPaste);
  function authEnter(e) {
    if (e.key === 'Enter') { e.preventDefault(); tryAdminLogin(); }
  }
  const _ap = document.getElementById('auth-password');
  const _al = document.getElementById('auth-login');
  if (_ap) _ap.addEventListener('keydown', authEnter);
  if (_al) _al.addEventListener('keydown', authEnter);
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') closeAuthPanel();
  });
  const authModal = document.getElementById('auth-modal');
  if (authModal) authModal.addEventListener('click', function(e) {
    if (e.target === authModal) closeAuthPanel();
  });

  const firstInput = document.getElementById('count-first');
  const highestInput = document.getElementById('count-highest');
  if (firstInput) {
    firstInput.addEventListener('change', () => {
      let v = parseInt(firstInput.value, 10);
      if (isNaN(v) || v < 1) v = 1;
      if (v > 300) v = 300;
      firstInput.value = v;
    });
  }
  if (highestInput) {
    highestInput.addEventListener('change', () => {
      let v = parseInt(highestInput.value, 10);
      if (isNaN(v) || v < 1) v = 1;
      if (v > 600) v = 600;
      highestInput.value = v;
    });
  }
});
