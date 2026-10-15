/* Spaco Document Vault — front end. Plain JavaScript, no external dependencies.
   All user-supplied text is inserted with textContent (never innerHTML) to prevent XSS. */
(function () {
  'use strict';

  const $app = document.getElementById('app');
  const state = { user: null, school: "St. Paul's SHS & Minor Seminary", showDeleted: false };
  let uid = 0;

  /* ---------- tiny DOM helper ---------- */
  const PROPS = new Set(['value', 'checked', 'disabled', 'selected', 'hidden', 'multiple', 'required', 'readOnly', 'tabIndex']);
  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    let value;
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'value') value = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
      else if (PROPS.has(k)) e[k] = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
    append(e, kids);
    if (value !== undefined) e.value = value; // after options exist, for <select>
    return e;
  }
  function append(parent, kids) {
    for (const k of kids) {
      if (k === null || k === undefined || k === false) continue;
      if (Array.isArray(k)) append(parent, k);
      else parent.append(k instanceof Node ? k : document.createTextNode(String(k)));
    }
  }

  /* ---------- formatting ---------- */
  const fmtSize = b => b < 1024 ? b + ' B' : b < 1048576 ? Math.round(b / 1024) + ' KB' : (b / 1048576).toFixed(1) + ' MB';
  function parseDate(s) { return new Date(s.length <= 10 ? s + 'T00:00:00' : s.replace(' ', 'T') + 'Z'); }
  function fmtDate(s) {
    if (!s) return '—';
    const d = parseDate(s);
    return isNaN(d) ? s : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  function fmtDateTime(s) {
    if (!s) return 'Never';
    const d = parseDate(s);
    return isNaN(d) ? s : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many || one + 's');
  const ROLE_LABEL = { admin: 'Administrator', registrar: 'Registrar', viewer: 'Viewer (read-only)' };
  const STATUS_LABEL = { current: 'Current', alumni: 'Alumni', transferred: 'Transferred' };
  const canWrite = () => state.user && (state.user.role === 'admin' || state.user.role === 'registrar');
  const isAdmin = () => state.user && state.user.role === 'admin';

  /* ---------- API ---------- */
  async function api(method, url, body) {
    const opts = { method, headers: { 'X-Requested-With': 'spaco-vault' }, credentials: 'same-origin' };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    let r;
    try { r = await fetch(url, opts); } catch (e) { throw new Error('Cannot reach the server. Check the network connection and try again.'); }
    let data = null;
    try { data = await r.json(); } catch (e) { /* no body */ }
    if (!r.ok) {
      const err = new Error((data && data.error) || `Request failed (${r.status})`);
      err.status = r.status; err.code = data && data.code;
      handleAuthFailure(err);
      throw err;
    }
    return data;
  }
  function handleAuthFailure(err) {
    if (err.status === 401 && state.user) {
      state.user = null; toast('Your session has ended. Please sign in again.', true); render();
    } else if (err.code === 'MUST_CHANGE_PASSWORD' && state.user) {
      state.user.must_change_password = true; render();
    }
  }

  /* ---------- toast / modal ---------- */
  function toast(msg, isErr) {
    const t = h('div', { class: 'toast' + (isErr ? ' err' : ''), text: msg });
    document.getElementById('toasts').append(t);
    setTimeout(() => t.remove(), isErr ? 7000 : 3500);
  }

  function openModal(title, build, opts = {}) {
    const prev = document.activeElement;
    const overlay = h('div', { class: 'overlay' });
    const box = h('div', { class: 'modal' + (opts.wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
    const m = { el: box, close };
    function close() {
      overlay.remove(); document.removeEventListener('keydown', onKey);
      if (prev && prev.focus) prev.focus();
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onKey);
    box.append(h('h2', { text: title }), build(m));
    overlay.append(box); document.body.append(overlay);
    const first = box.querySelector('input:not([type=hidden]):not([type=file]),select,textarea');
    (first || box.querySelector('button')).focus();
    return m;
  }

  function formModal(title, body, submitLabel, onSubmit, opts = {}) {
    return openModal(title, m => {
      const err = h('div', { class: 'formerror', role: 'alert', hidden: true });
      const btn = h('button', { class: 'btn ' + (opts.danger ? 'danger' : 'primary'), type: 'submit', text: submitLabel });
      const form = h('form', { novalidate: true }, err, body,
        h('div', { class: 'buttons' }, h('button', { class: 'btn ghost', type: 'button', onclick: m.close, text: 'Cancel' }), btn));
      form.addEventListener('submit', async e => {
        e.preventDefault(); err.hidden = true; btn.disabled = true; btn.textContent = 'Please wait…';
        try { await onSubmit(m); }
        catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; btn.textContent = submitLabel; err.scrollIntoView({ block: 'nearest' }); }
      });
      return form;
    }, opts);
  }

  function confirmModal(title, message, label, onConfirm, danger = true) {
    return formModal(title, h('p', { text: message }), label, async m => { await onConfirm(); m.close(); }, { danger });
  }

  function field(label, input, hint) {
    const id = 'f' + (++uid); input.id = id;
    return h('div', { class: 'field' }, h('label', { for: id, text: label }), input, hint ? h('small', { text: hint }) : null);
  }
  const textInput = (value, props) => h('input', { type: 'text', value: value || '', autocomplete: 'off', ...props });
  const selectInput = (options, value) => h('select', { value }, options.map(([v, l]) => h('option', { value: v, text: l })));

  /* ---------- shell ---------- */
  function render() {
    document.getElementById('toasts').dataset.ready = '1';
    if (!state.user) return renderLogin();
    if (state.user.must_change_password) return renderForcedChange();
    renderShell(); route();
  }

  function brand() {
    return h('a', { class: 'brand', href: '#/' }, h('span', { class: 'seal', text: 'SP' }),
      h('span', {}, h('b', { text: 'Document Vault' }), h('small', { text: state.school })));
  }

  function renderShell() {
    const nav = h('nav', { class: 'nav', 'aria-label': 'Main' },
      h('a', { href: '#/', 'data-nav': '', text: 'Batches' }),
      isAdmin() ? h('a', { href: '#/users', 'data-nav': 'users', text: 'Users' }) : null,
      isAdmin() ? h('a', { href: '#/audit', 'data-nav': 'audit', text: 'Audit log' }) : null);
    const user = h('div', { class: 'usermenu' },
      h('div', { class: 'who' }, state.user.full_name, h('small', { text: ROLE_LABEL[state.user.role] })),
      h('button', { class: 'linkbtn', text: 'Change password', onclick: openChangePassword }),
      h('button', { class: 'linkbtn', text: 'Sign out', onclick: signOut }));
    $app.replaceChildren(
      h('header', { class: 'topbar' }, brand(), nav, buildSearch(), user),
      h('main', { class: 'container', id: 'view' }));
  }

  function updateNav(section) {
    document.querySelectorAll('.nav a').forEach(a => {
      if (a.dataset.nav === section || (a.dataset.nav === '' && ['', 'batch', 'class', 'student'].includes(section))) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
  }

  async function signOut() {
    try { await api('POST', '/api/auth/logout'); } catch (e) { /* ignore */ }
    state.user = null; location.hash = ''; render();
  }

  /* ---------- search ---------- */
  function buildSearch() {
    const input = h('input', { type: 'search', placeholder: 'Find a student by name or record ID…', 'aria-label': 'Find a student', autocomplete: 'off' });
    const results = h('div', { class: 'results', hidden: true });
    const wrap = h('div', { class: 'searchbox' }, input, results);
    let timer, seq = 0;
    const clear = () => { results.hidden = true; results.replaceChildren(); };
    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 2) return clear();
      timer = setTimeout(async () => {
        const my = ++seq;
        try {
          const { results: rows } = await api('GET', '/api/search?q=' + encodeURIComponent(q));
          if (my !== seq) return;
          results.replaceChildren(...(rows.length ? rows.map(r =>
            h('a', { href: '#/student/' + r.id, onclick: () => { input.value = ''; clear(); } },
              r.full_name, h('small', { text: `${r.record_id} · Batch ${r.batch_label} · ${r.class_name} · ${STATUS_LABEL[r.status]}` })))
            : [h('div', { class: 'none', text: 'No matching students.' })]));
          results.hidden = false;
        } catch (e) { /* api() already handled auth errors */ }
      }, 250);
    });
    input.addEventListener('keydown', e => { if (e.key === 'Escape') { input.value = ''; clear(); } });
    document.addEventListener('click', e => { if (!wrap.contains(e.target)) clear(); });
    return wrap;
  }

  /* ---------- login / password ---------- */
  function renderLogin() {
    document.title = 'Sign in — Document Vault';
    const err = h('div', { class: 'formerror', role: 'alert', hidden: true });
    const user = textInput('', { autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false' });
    const pass = h('input', { type: 'password', autocomplete: 'current-password' });
    const btn = h('button', { class: 'btn primary', type: 'submit', text: 'Sign in' });
    const form = h('form', { novalidate: true }, err, field('Username', user), field('Password', pass), btn);
    form.addEventListener('submit', async e => {
      e.preventDefault(); err.hidden = true; btn.disabled = true; btn.textContent = 'Signing in…';
      try {
        const res = await api('POST', '/api/auth/login', { username: user.value, password: pass.value });
        state.user = res.user; location.hash = ''; render();
      } catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; btn.textContent = 'Sign in'; pass.value = ''; pass.focus(); }
    });
    $app.replaceChildren(h('div', { class: 'loginpage' }, h('div', { class: 'logincard' },
      h('div', { class: 'seal', text: 'SP' }), h('h1', { text: 'Document Vault' }),
      h('p', { class: 'sub', text: state.school + ' — student records' }), form,
      h('p', { class: 'hint', text: 'Authorised staff only. All activity is recorded.' }))));
    user.focus();
  }

  function passwordFields() {
    return { cur: h('input', { type: 'password', autocomplete: 'current-password' }),
      next: h('input', { type: 'password', autocomplete: 'new-password' }),
      again: h('input', { type: 'password', autocomplete: 'new-password' }) };
  }
  async function submitPasswordChange(f) {
    if (f.next.value !== f.again.value) throw new Error('The new password and its confirmation do not match.');
    await api('POST', '/api/auth/password', { current: f.cur.value, next: f.next.value });
  }
  const PW_HINT = 'At least 8 characters, with letters and numbers.';

  function renderForcedChange() {
    document.title = 'Choose a new password — Document Vault';
    const f = passwordFields();
    const err = h('div', { class: 'formerror', role: 'alert', hidden: true });
    const btn = h('button', { class: 'btn primary', type: 'submit', text: 'Save new password' });
    const form = h('form', { novalidate: true }, err,
      field('Temporary password', f.cur), field('New password', f.next, PW_HINT), field('Confirm new password', f.again), btn);
    form.addEventListener('submit', async e => {
      e.preventDefault(); err.hidden = true; btn.disabled = true;
      try { await submitPasswordChange(f); state.user.must_change_password = false; toast('Password updated. Welcome!'); render(); }
      catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; }
    });
    $app.replaceChildren(h('div', { class: 'loginpage' }, h('div', { class: 'logincard' },
      h('div', { class: 'seal', text: 'SP' }), h('h1', { text: 'Choose a new password' }),
      h('p', { class: 'sub', text: `Hello ${state.user.full_name}. Replace the temporary password before continuing.` }), form,
      h('p', { class: 'hint' }, h('button', { class: 'linkbtn', style: 'color:var(--ink-2)', text: 'Sign out', onclick: signOut })))));
    f.cur.focus();
  }

  function openChangePassword() {
    const f = passwordFields();
    formModal('Change your password', h('div', {},
      field('Current password', f.cur), field('New password', f.next, PW_HINT), field('Confirm new password', f.again)),
      'Update password', async m => { await submitPasswordChange(f); m.close(); toast('Password updated.'); });
  }

  /* ---------- router ---------- */
  let navToken = 0;
  async function route() {
    const view = document.getElementById('view');
    if (!view || !state.user) return;
    const token = ++navToken;
    const parts = (location.hash.replace(/^#/, '') || '/').split('/').filter(Boolean);
    const id = parseInt(parts[1], 10);
    updateNav(parts[0] || '');
    try {
      let page;
      if (!parts.length) page = await pageHome();
      else if (parts[0] === 'batch' && id) page = await pageBatch(id);
      else if (parts[0] === 'class' && id) page = await pageClass(id);
      else if (parts[0] === 'student' && id) page = await pageStudent(id);
      else if (parts[0] === 'users' && isAdmin()) page = await pageUsers();
      else if (parts[0] === 'audit' && isAdmin()) page = await pageAudit();
      else page = h('div', { class: 'empty' }, h('b', { text: 'Page not found' }), h('a', { href: '#/', text: 'Back to all batches' }));
      if (token !== navToken) return;
      view.replaceChildren(page); window.scrollTo(0, 0);
      const t = view.querySelector('h1'); document.title = (t ? t.textContent + ' — ' : '') + 'Document Vault';
    } catch (e) {
      if (token !== navToken || e.status === 401 || e.code === 'MUST_CHANGE_PASSWORD') return;
      view.replaceChildren(h('div', { class: 'empty' }, h('b', { text: 'Could not load this page' }), e.message,
        h('p', {}, h('a', { href: '#/', text: 'Back to all batches' }))));
    }
  }
  window.addEventListener('hashchange', route);

  const crumbs = (...items) => h('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' },
    items.map((it, i) => [i ? h('span', { 'aria-hidden': 'true', text: '/' }) : null,
      it.href ? h('a', { href: it.href, text: it.text }) : h('span', { 'aria-current': 'page', text: it.text })]));

  /* =====================================================================
     PAGES
     ===================================================================== */

  /* ---------- home: all year batches ---------- */
  async function pageHome() {
    const [stats, { batches }] = await Promise.all([api('GET', '/api/stats'), api('GET', '/api/batches')]);
    const stat = (n, label) => h('div', { class: 'stat' }, h('b', { text: n }), h('span', { text: label }));
    const grid = batches.length
      ? h('div', { class: 'grid' }, batches.map(b => h('a', { class: 'folder', href: '#/batch/' + b.id },
          h('h3', { text: 'Batch ' + b.label }),
          h('p', { text: `${plural(b.class_count, 'class', 'classes')} · ${plural(b.student_count, 'student')}` }))))
      : h('div', { class: 'empty' }, h('b', { text: 'No year batches yet' }),
          canWrite() ? 'Start by creating your first batch, then add its classes and students.' : 'A registrar needs to create the first batch.');
    return h('div', {},
      h('div', { class: 'pagehead' }, h('div', {}, h('h1', { text: 'Student records' }),
        h('p', { text: 'Scanned documents, filed by year batch → class → student.' }))),
      h('div', { class: 'stats' }, stat(stats.students, 'Students on file'), stat(stats.current, 'Current students'),
        stat(stats.alumni, 'Alumni'), stat(stats.documents, 'Scanned documents'), stat(fmtSize(stats.bytes), 'Storage used')),
      h('div', { class: 'sectionhead' }, h('h2', { text: 'Year batches' }),
        canWrite() ? h('button', { class: 'btn primary', text: '+ New batch', onclick: newBatchModal }) : null),
      grid);
  }

  function newBatchModal() {
    const label = textInput('', { placeholder: 'e.g. 2023', inputmode: 'numeric' });
    formModal('New year batch', field('Batch year', label,
      'A year such as 2023, or a range such as 2020-2023. Use the same rule for every batch (for example, the year the students completed SHS).'),
      'Create batch', async m => {
        const r = await api('POST', '/api/batches', { label: label.value });
        m.close(); toast('Batch created.'); location.hash = '#/batch/' + r.id;
      });
  }

  /* ---------- batch: its classes ---------- */
  async function pageBatch(id) {
    const { batch, classes } = await api('GET', '/api/batches/' + id);
    const grid = classes.length
      ? h('div', { class: 'grid' }, classes.map(c => h('a', { class: 'folder', href: '#/class/' + c.id },
          h('h3', { text: c.name }),
          h('p', { text: `${plural(c.student_count, 'student')} · ${plural(c.document_count, 'document')}` }))))
      : h('div', { class: 'empty' }, h('b', { text: 'No classes in this batch yet' }),
          canWrite() ? 'Add a class such as "Science A" or "General Arts B", then file students into it.' : '');
    return h('div', {}, crumbs({ href: '#/', text: 'All batches' }, { text: 'Batch ' + batch.label }),
      h('div', { class: 'pagehead' }, h('div', {}, h('h1', { text: 'Batch ' + batch.label }),
        h('p', { text: plural(classes.length, 'class', 'classes') })),
        canWrite() ? h('div', { class: 'actions' },
          classes.length === 0 ? h('button', { class: 'btn danger', text: 'Remove batch', onclick: () =>
            confirmModal('Remove batch ' + batch.label + '?', 'This empty batch will be removed.', 'Remove batch', async () => {
              await api('DELETE', '/api/batches/' + batch.id); toast('Batch removed.'); location.hash = '#/'; }) }) : null,
          h('button', { class: 'btn primary', text: '+ New class', onclick: () => newClassModal(batch) })) : null),
      grid);
  }

  function newClassModal(batch) {
    const name = textInput('', { placeholder: 'e.g. Science A' });
    formModal('New class in Batch ' + batch.label, field('Class name', name), 'Create class', async m => {
      const r = await api('POST', `/api/batches/${batch.id}/classes`, { name: name.value });
      m.close(); toast('Class created.'); location.hash = '#/class/' + r.id;
    });
  }

  /* ---------- class: its students ---------- */
  async function pageClass(id) {
    const { class: cls, students } = await api('GET', '/api/classes/' + id);
    const filter = h('input', { type: 'search', placeholder: 'Filter this class…', 'aria-label': 'Filter students' });
    const status = selectInput([['', 'All statuses'], ['current', 'Current'], ['alumni', 'Alumni'], ['transferred', 'Transferred']], '');
    status.setAttribute('aria-label', 'Filter by status');
    const tbody = h('tbody');
    const count = h('p', { class: 'mono' });
    function draw() {
      const q = filter.value.trim().toLowerCase();
      const rows = students.filter(s => (!status.value || s.status === status.value) &&
        (!q || s.full_name.toLowerCase().includes(q) || s.record_id.toLowerCase().includes(q)));
      tbody.replaceChildren(...rows.map(s => h('tr', {},
        h('td', { class: 'mono', text: s.record_id }),
        h('td', {}, h('a', { class: 'name', href: '#/student/' + s.id, text: s.full_name })),
        h('td', {}, h('span', { class: 'badge ' + s.status, text: STATUS_LABEL[s.status] })),
        h('td', { text: [s.guardian_name, s.guardian_phone].filter(Boolean).join(' · ') || '—' }),
        h('td', { class: 'right' }, s.document_count ? String(s.document_count) : h('span', { class: 'badge warn', text: 'none' })))));
      count.textContent = `Showing ${rows.length} of ${students.length}`;
    }
    filter.addEventListener('input', draw); status.addEventListener('change', draw); draw();
    const table = students.length
      ? h('div', {}, h('div', { class: 'toolbar' }, filter, status, count),
          h('div', { class: 'tablewrap' }, h('table', {},
            h('thead', {}, h('tr', {}, ['Record ID', 'Student', 'Status', 'Guardian', 'Documents'].map((t, i) => h('th', { class: i === 4 ? 'right' : '', text: t })))), tbody)))
      : h('div', { class: 'empty' }, h('b', { text: 'No students in this class yet' }),
          canWrite() ? 'Add students one by one, or paste a whole class list at once.' : '');
    return h('div', {},
      crumbs({ href: '#/', text: 'All batches' }, { href: '#/batch/' + cls.batch_id, text: 'Batch ' + cls.batch_label }, { text: cls.name }),
      h('div', { class: 'pagehead' }, h('div', {}, h('h1', { text: cls.name }),
        h('p', { text: `Batch ${cls.batch_label} · ${plural(students.length, 'student')}` })),
        canWrite() ? h('div', { class: 'actions' },
          students.length === 0 ? h('button', { class: 'btn danger', text: 'Remove class', onclick: () =>
            confirmModal('Remove ' + cls.name + '?', 'This empty class will be removed.', 'Remove class', async () => {
              await api('DELETE', '/api/classes/' + cls.id); toast('Class removed.'); location.hash = '#/batch/' + cls.batch_id; }) }) : null,
          h('button', { class: 'btn ghost', text: 'Add several students', onclick: () => bulkModal(cls) }),
          h('button', { class: 'btn primary', text: '+ Add student', onclick: () => studentModal(cls) })) : null),
      table);
  }

  function studentFields(s = {}) {
    const f = {
      name: textInput(s.full_name, { placeholder: 'Full name as on the admission record' }),
      gender: selectInput([['', '— not recorded —'], ['Male', 'Male'], ['Female', 'Female']], s.gender || ''),
      dob: h('input', { type: 'date', value: s.date_of_birth || '' }),
      status: selectInput([['current', 'Current student'], ['alumni', 'Alumni (completed)'], ['transferred', 'Transferred out']], s.status || 'current'),
      gname: textInput(s.guardian_name), gphone: textInput(s.guardian_phone, { inputmode: 'tel' })
    };
    const node = h('div', {}, field('Full name', f.name),
      h('div', { class: 'row2' }, field('Gender', f.gender), field('Date of birth', f.dob)),
      field('Status', f.status),
      h('div', { class: 'row2' }, field('Guardian name', f.gname), field('Guardian phone', f.gphone)));
    const read = () => ({ full_name: f.name.value, gender: f.gender.value, date_of_birth: f.dob.value,
      status: f.status.value, guardian_name: f.gname.value, guardian_phone: f.gphone.value });
    return { node, read };
  }

  function studentModal(cls) {
    const f = studentFields();
    formModal('Add student to ' + cls.name, f.node, 'Add student', async m => {
      const r = await api('POST', `/api/classes/${cls.id}/students`, f.read());
      m.close(); toast(`Added. Record ID ${r.record_id}`); location.hash = '#/student/' + r.id;
    });
  }

  function bulkModal(cls) {
    const names = h('textarea', { rows: 10, placeholder: 'Kwame Owusu Boateng\nAbena Serwaa Mensah\nFrancis Kojo Antwi' });
    const status = selectInput([['current', 'Current students'], ['alumni', 'Alumni (completed)'], ['transferred', 'Transferred out']], 'current');
    formModal('Add several students to ' + cls.name, h('div', {},
      field('Names — one per line', names, 'Paste a class list from a spreadsheet or document. Details can be added to each student later.'),
      field('All of these students are', status)), 'Add students', async m => {
        const list = names.value.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
        const r = await api('POST', `/api/classes/${cls.id}/students/bulk`, { names: list, status: status.value });
        m.close(); toast(plural(r.created, 'student') + ' added.'); route();
      });
  }

  /* ---------- student: folder with documents ---------- */
  async function pageStudent(id) {
    const delQ = isAdmin() && state.showDeleted ? '?deleted=1' : '';
    const [{ student: s }, docData] = await Promise.all([api('GET', '/api/students/' + id), api('GET', `/api/students/${id}/documents${delQ}`)]);
    const fact = (k, v) => [h('dt', { text: k }), h('dd', { text: v || '—' })];
    const head = h('div', { class: 'panel' }, h('div', { class: 'studenthead' },
      h('div', {}, h('h1', { text: s.full_name }),
        h('p', { class: 'mono' }, s.record_id + '  ', h('span', { class: 'badge ' + s.status, text: STATUS_LABEL[s.status] }))),
      canWrite() ? h('button', { class: 'btn ghost', text: 'Edit details', onclick: () => editStudentModal(s) }) : null),
      h('dl', { class: 'facts' }, fact('Class', `Batch ${s.batch_label} · ${s.class_name}`), fact('Gender', s.gender),
        fact('Date of birth', s.date_of_birth ? fmtDate(s.date_of_birth) : ''), fact('Guardian', s.guardian_name), fact('Guardian phone', s.guardian_phone)));
    return h('div', {},
      crumbs({ href: '#/', text: 'All batches' }, { href: '#/batch/' + s.batch_id, text: 'Batch ' + s.batch_label },
        { href: '#/class/' + s.class_id, text: s.class_name }, { text: s.full_name }),
      head, documentsSection(s, docData));
  }

  function documentsSection(s, d) {
    const sec = h('div', {}, h('div', { class: 'sectionhead' }, h('h2', { text: 'Scanned documents' }),
      isAdmin() ? h('label', { class: 'mono' }, h('input', { type: 'checkbox', checked: state.showDeleted,
        onchange: e => { state.showDeleted = e.target.checked; route(); } }), ' Show deleted') : null));
    if (canWrite() && !state.showDeleted) sec.append(uploadPanel(s, d));
    if (!d.documents.length) {
      sec.append(h('div', { class: 'empty' }, h('b', { text: state.showDeleted ? 'No deleted documents' : 'No documents on file yet' }),
        canWrite() && !state.showDeleted ? 'Scan the paper originals and upload them above.' : ''));
      return sec;
    }
    sec.append(h('div', { class: 'tablewrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Type', 'File', 'Size', 'Uploaded', ''].map(t => h('th', { text: t })))),
      h('tbody', {}, d.documents.map(doc => h('tr', {},
        h('td', { text: doc.category }),
        h('td', {}, doc.previewable && !doc.deleted_at
          ? h('a', { class: 'name', href: '#', text: doc.original_name, onclick: e => { e.preventDefault(); previewModal(doc); } })
          : doc.original_name),
        h('td', { class: 'mono', text: fmtSize(doc.size_bytes) }),
        h('td', { text: `${fmtDate(doc.uploaded_at)}${doc.uploaded_by_name ? ' · ' + doc.uploaded_by_name : ''}` }),
        h('td', {}, h('div', { class: 'rowactions' },
          doc.deleted_at
            ? h('button', { class: 'btn small', text: 'Restore', onclick: async () => { await api('POST', `/api/documents/${doc.id}/restore`); toast('Document restored.'); route(); } })
            : [doc.previewable ? h('button', { class: 'btn small ghost', text: 'View', onclick: () => previewModal(doc) }) : null,
               h('a', { class: 'btn small ghost', href: `/api/documents/${doc.id}/file?download=1`, text: 'Download' }),
               canWrite() ? h('button', { class: 'btn small danger', text: 'Delete', onclick: () => confirmModal('Delete this document?',
                 `"${doc.original_name}" will be hidden from the student's folder. An administrator can restore it later.`, 'Delete', async () => {
                   await api('DELETE', '/api/documents/' + doc.id); toast('Document deleted.'); route(); }) }) : null]))))))));
    return sec;
  }

  function previewModal(doc) {
    const url = `/api/documents/${doc.id}/file`;
    const content = doc.mime_type === 'application/pdf' ? h('iframe', { src: url, title: doc.original_name })
      : h('img', { class: 'preview', src: url, alt: doc.original_name });
    openModal(doc.original_name, m => h('div', {}, content, h('div', { class: 'buttons' },
      h('a', { class: 'btn ghost', href: url + '?download=1', text: 'Download' }),
      h('button', { class: 'btn', text: 'Close', onclick: m.close }))), { wide: true });
  }

  function uploadPanel(s, d) {
    let files = [];
    const cat = selectInput(d.categories.map(c => [c, c]), 'Other');
    const picker = h('input', { type: 'file', multiple: true, accept: '.pdf,.jpg,.jpeg,.png,.webp,.tif,.tiff,application/pdf,image/*' });
    const list = h('ul', { class: 'queued' });
    const bar = h('i'); const progress = h('div', { class: 'progress', hidden: true }, bar);
    const go = h('button', { class: 'btn primary', text: 'Upload', disabled: true });
    const zone = h('div', { class: 'dropzone' }, h('p', {}, 'Drag scanned pages here, or ',
      h('button', { class: 'btn small ghost', type: 'button', text: 'choose files', onclick: () => picker.click() })),
      h('p', { class: 'mono', text: `PDF, JPEG, PNG, WebP or TIFF · up to ${d.max_upload_mb} MB each` }), picker, list, progress);

    function setFiles(incoming) {
      const tooBig = [], ok = [];
      for (const f of incoming) (f.size > d.max_upload_mb * 1048576 ? tooBig : ok).push(f);
      if (tooBig.length) toast(`Too large (limit ${d.max_upload_mb} MB): ${tooBig.map(f => f.name).join(', ')}`, true);
      files = ok.slice(0, 20);
      list.replaceChildren(...files.map(f => h('li', { text: `${f.name} — ${fmtSize(f.size)}` })));
      go.disabled = !files.length; go.textContent = files.length ? `Upload ${plural(files.length, 'file')}` : 'Upload';
    }
    picker.addEventListener('change', () => setFiles([...picker.files]));
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('over'); setFiles([...e.dataTransfer.files]); });

    go.addEventListener('click', async () => {
      go.disabled = true; progress.hidden = false; bar.style.width = '0%';
      try {
        const r = await uploadFiles(s.id, cat.value, files, p => { bar.style.width = Math.round(p * 100) + '%'; });
        reportUpload(r); route();
      } catch (e) {
        if (e.data && e.data.rejected && e.data.rejected.length) reportUpload(e.data); else toast(e.message, true);
        go.disabled = false; progress.hidden = true;
      }
    });
    return h('div', { class: 'panel', style: 'margin-bottom:14px' },
      h('div', { class: 'uploadrow' }, field('Document type', cat), h('div', { class: 'field' }, h('label', { class: 'sr-only', text: 'Upload' }), go)), zone);
  }

  function reportUpload(r) {
    if (r.uploaded) toast(plural(r.uploaded, 'document') + ' uploaded.');
    if (r.rejected && r.rejected.length) toast('Not uploaded — ' + r.rejected.map(x => `${x.name}: ${x.reason}`).join(' | '), true);
  }

  function uploadFiles(studentId, category, files, onProgress) {
    return new Promise((resolve, reject) => {
      const fd = new FormData();
      fd.append('category', category);
      files.forEach(f => fd.append('files', f));
      const x = new XMLHttpRequest();
      x.open('POST', `/api/students/${studentId}/documents`);
      x.setRequestHeader('X-Requested-With', 'spaco-vault');
      x.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      x.onerror = () => reject(new Error('The upload did not finish — check the network connection and try again.'));
      x.onload = () => {
        let data = {}; try { data = JSON.parse(x.responseText); } catch (e) { /* ignore */ }
        if (x.status >= 200 && x.status < 300) return resolve(data);
        const err = new Error(data.error || `Upload failed (${x.status})`); err.status = x.status; err.code = data.code; err.data = data;
        handleAuthFailure(err); reject(err);
      };
      x.send(fd);
    });
  }

  async function editStudentModal(s) {
    const f = studentFields(s);
    let newClassId = null;
    const batchSel = h('select', {}, h('option', { value: '', text: '— keep in current class —' }));
    const classSel = h('select', { disabled: true }, h('option', { value: '', text: 'Choose a batch first' }));
    api('GET', '/api/batches').then(({ batches }) => batches.forEach(b => batchSel.append(h('option', { value: b.id, text: 'Batch ' + b.label }))));
    batchSel.addEventListener('change', async () => {
      newClassId = null; classSel.replaceChildren(h('option', { value: '', text: '— choose class —' }));
      if (!batchSel.value) { classSel.disabled = true; return; }
      const { classes } = await api('GET', '/api/batches/' + batchSel.value);
      classes.forEach(c => classSel.append(h('option', { value: c.id, text: c.name })));
      classSel.disabled = false;
    });
    classSel.addEventListener('change', () => { newClassId = classSel.value ? parseInt(classSel.value, 10) : null; });
    const move = h('details', {}, h('summary', { text: 'Move to a different class' }),
      h('p', { class: 'mono', text: 'The scanned documents move to the new class folder automatically.' }),
      field('Batch', batchSel), field('Class', classSel));
    formModal('Edit ' + s.full_name, h('div', {}, f.node, move), 'Save changes', async m => {
      const body = f.read(); if (newClassId && newClassId !== s.class_id) body.class_id = newClassId;
      await api('PATCH', '/api/students/' + s.id, body);
      m.close(); toast('Student updated.'); route();
    });
  }

  /* ---------- users (admin) ---------- */
  async function pageUsers() {
    const { users } = await api('GET', '/api/users');
    const rows = users.map(u => h('tr', {},
      h('td', { class: 'mono', text: u.username }), h('td', { text: u.full_name }),
      h('td', {}, h('span', { class: 'badge ' + u.role, text: ROLE_LABEL[u.role] })),
      h('td', {}, u.is_active ? h('span', { class: 'badge current', text: 'Active' }) : h('span', { class: 'badge off', text: 'Deactivated' }),
        u.must_change_password ? [' ', h('span', { class: 'badge warn', text: 'Temp password' })] : null),
      h('td', { text: fmtDateTime(u.last_login_at) }),
      h('td', {}, h('div', { class: 'rowactions' },
        h('button', { class: 'btn small ghost', text: 'Edit', onclick: () => editUserModal(u) }),
        h('button', { class: 'btn small ghost', text: 'Reset password', onclick: () => resetPasswordModal(u) })))));
    return h('div', {},
      h('div', { class: 'pagehead' }, h('div', {}, h('h1', { text: 'Staff accounts' }),
        h('p', { text: 'Everyone signs in with their own account, so the audit log shows who did what.' })),
        h('button', { class: 'btn primary', text: '+ Add staff member', onclick: addUserModal })),
      h('div', { class: 'note', text: 'Roles — Administrator: everything, including accounts and the audit log. Registrar: add and edit records and documents. Viewer: read and download only.' }),
      h('div', { class: 'tablewrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Username', 'Name', 'Role', 'Status', 'Last sign-in', ''].map(t => h('th', { text: t })))), h('tbody', {}, rows))));
  }

  function roleSelect(value) { return selectInput(Object.entries(ROLE_LABEL), value); }

  function addUserModal() {
    const un = textInput('', { autocapitalize: 'none', spellcheck: 'false' }), fn = textInput(''), role = roleSelect('registrar');
    const pw = textInput('', { autocomplete: 'off' });
    formModal('Add staff member', h('div', {}, field('Username', un, 'Letters, numbers, dot, dash or underscore.'), field('Full name', fn),
      field('Role', role), field('Temporary password', pw, 'They must replace it at first sign-in. ' + PW_HINT)), 'Create account', async m => {
        await api('POST', '/api/users', { username: un.value, full_name: fn.value, role: role.value, password: pw.value });
        m.close(); toast('Account created. Share the temporary password with them privately.'); route();
      });
  }

  function editUserModal(u) {
    const self = u.id === state.user.id;
    const fn = textInput(u.full_name), role = roleSelect(u.role);
    const active = h('input', { type: 'checkbox', checked: !!u.is_active });
    if (self) { role.disabled = true; active.disabled = true; }
    formModal('Edit ' + u.username, h('div', {}, field('Full name', fn), field('Role', role),
      h('div', { class: 'field' }, h('label', {}, active, ' Account is active (can sign in)')),
      self ? h('p', { class: 'mono', text: 'You cannot change your own role or deactivate yourself.' }) : null), 'Save changes', async m => {
        await api('PATCH', '/api/users/' + u.id, self ? { full_name: fn.value } : { full_name: fn.value, role: role.value, is_active: active.checked });
        m.close(); toast('Account updated.'); route();
      });
  }

  function resetPasswordModal(u) {
    const pw = textInput('', { autocomplete: 'off' });
    formModal('Reset password for ' + u.username, field('New temporary password', pw,
      'They will be signed out and must choose their own password next time. ' + PW_HINT), 'Reset password', async m => {
        await api('POST', `/api/users/${u.id}/reset-password`, { password: pw.value });
        m.close(); toast('Password reset. Share it with them privately.');
      });
  }

  /* ---------- audit log (admin) ---------- */
  const audit = { q: '', offset: 0, limit: 50 };
  async function pageAudit() {
    const { total, rows } = await api('GET', `/api/audit?limit=${audit.limit}&offset=${audit.offset}&q=${encodeURIComponent(audit.q)}`);
    const q = h('input', { type: 'search', value: audit.q, placeholder: 'Search by user, action or detail…', 'aria-label': 'Search the audit log' });
    const form = h('form', { class: 'toolbar', onsubmit: e => { e.preventDefault(); audit.q = q.value.trim(); audit.offset = 0; route(); } },
      q, h('button', { class: 'btn', type: 'submit', text: 'Search' }));
    const from = total ? audit.offset + 1 : 0, to = Math.min(audit.offset + audit.limit, total);
    return h('div', {},
      h('div', { class: 'pagehead' }, h('div', {}, h('h1', { text: 'Audit log' }),
        h('p', { text: 'Every sign-in, view, upload, change and deletion is recorded here and cannot be edited.' }))),
      form,
      rows.length ? h('div', { class: 'tablewrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['When', 'User', 'Action', 'Details', 'From'].map(t => h('th', { text: t })))),
        h('tbody', {}, rows.map(r => h('tr', {}, h('td', { text: fmtDateTime(r.created_at) }), h('td', { text: r.username || '—' }),
          h('td', { class: 'mono', text: r.action }), h('td', { text: r.detail || '' }), h('td', { class: 'mono', text: r.ip || '' }))))))
        : h('div', { class: 'empty' }, h('b', { text: 'Nothing matches' })),
      h('div', { class: 'toolbar', style: 'margin-top:12px' },
        h('button', { class: 'btn ghost small', text: '← Newer', disabled: audit.offset === 0, onclick: () => { audit.offset = Math.max(0, audit.offset - audit.limit); route(); } }),
        h('span', { class: 'mono', text: `${from}–${to} of ${total}` }),
        h('button', { class: 'btn ghost small', text: 'Older →', disabled: to >= total, onclick: () => { audit.offset += audit.limit; route(); } })));
  }

  /* ---------- start ---------- */
  (async function boot() {
    try { const c = await (await fetch('/api-config.json')).json(); if (c.school) state.school = c.school; } catch (e) { /* default */ }
    try { state.user = (await api('GET', '/api/auth/me')).user; } catch (e) { state.user = null; }
    render();
  })();
})();
