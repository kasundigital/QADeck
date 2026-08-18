(() => {
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));

  function fieldTitle(control) {
    return control.label || control.placeholder || control.name || control.id || control.text || control.selector || 'Unnamed field';
  }

  function roleLabel(role) {
    return ({ username: 'Username', password: 'Password', submit: 'Login button', extra: 'Extra field', manual: 'Manual', ignore: 'Ignore' })[role] || role;
  }

  function roleClass(role) {
    return ['username', 'password', 'submit'].includes(role) ? 'good' : role === 'extra' ? 'extra' : role === 'manual' ? 'manual' : 'muted';
  }

  function addExtraField(root, control, value = '') {
    const list = document.getElementById(root.dataset.fieldList);
    const template = document.getElementById(root.dataset.fieldTemplate);
    if (!list || !template) return false;

    const selectorInputs = [...list.querySelectorAll('input[name$="field_selector"]')];
    if (selectorInputs.some((input) => input.value === control.selector)) return false;

    const fragment = template.content.cloneNode(true);
    const row = fragment.querySelector('.extra-field-row');
    if (!row) return false;

    const name = row.querySelector('input[name$="field_name"]');
    const fieldValue = row.querySelector('input[name$="field_value"]');
    const type = row.querySelector('select[name$="field_type"]');
    const selector = row.querySelector('input[name$="field_selector"]');

    if (name) name.value = fieldTitle(control).replace(/\s+/g, ' ').trim().slice(0, 100);
    if (fieldValue) fieldValue.value = value;
    if (type) type.value = control.tag === 'select' ? 'select' : control.type === 'password' ? 'password' : 'text';
    if (selector) selector.value = control.selector || '';

    list.appendChild(fragment);
    return true;
  }

  function render(root, data) {
    const results = root.querySelector('[data-inspector-results]');
    const summary = root.querySelector('[data-inspector-summary]');
    const list = root.querySelector('[data-inspector-controls]');
    if (!results || !summary || !list) return;

    const controls = Array.isArray(data.controls) ? data.controls : [];
    const needed = controls.filter((control) => ['username', 'password', 'extra', 'manual'].includes(control.role));
    const extras = controls.filter((control) => control.role === 'extra');

    summary.innerHTML = `
      <strong>${esc(data.title || 'Login page')}</strong>
      <span>${esc(data.final_url || data.requested_url || '')}</span>
      <small>HTTP ${esc(data.status ?? '—')} · ${needed.length} relevant field${needed.length === 1 ? '' : 's'} found</small>
    `;

    list.innerHTML = controls.map((control, index) => {
      const options = control.options?.length ? `<small class="inspect-options">Options: ${esc(control.options.map((option) => option.label).join(', '))}</small>` : '';
      const required = control.required ? '<span class="inspect-required">Required</span>' : '';
      const addButton = control.role === 'extra' ? `<button type="button" class="btn secondary small-btn" data-add-inspected="${index}">Add field</button>` : '';
      const guidance = control.role === 'username' ? 'Fill the normal Username / email box above.' : control.role === 'password' ? 'Fill the normal Password box above.' : control.role === 'submit' ? 'QADeck detected this as the login/continue button.' : control.note || '';
      return `
        <div class="inspect-control">
          <div class="inspect-control-main">
            <div class="inspect-control-title"><strong>${esc(fieldTitle(control))}</strong>${required}<span class="inspect-role ${roleClass(control.role)}">${esc(roleLabel(control.role))}</span></div>
            <span>${esc(control.tag)} · ${esc(control.type)}${control.name ? ` · name=${esc(control.name)}` : ''}</span>
            <code>${esc(control.selector)}</code>
            ${options}
            <small>${esc(guidance)}</small>
          </div>
          ${addButton}
        </div>
      `;
    }).join('') || '<div class="inspect-empty">No visible form fields were detected on this page.</div>';

    results.hidden = false;
    root._qadeckInspectedControls = controls;

    const addAll = root.querySelector('[data-add-all-inspected]');
    if (addAll) {
      addAll.hidden = extras.length === 0;
      addAll.textContent = `＋ Add ${extras.length} detected extra field${extras.length === 1 ? '' : 's'}`;
    }
  }

  async function inspect(root) {
    const form = root.closest('form');
    const urlInput = form?.querySelector('input[name="login_url"]');
    const button = root.querySelector('[data-inspect-login]');
    const status = root.querySelector('[data-inspector-status]');
    const results = root.querySelector('[data-inspector-results]');
    const url = urlInput?.value.trim();

    if (!url) {
      if (status) status.textContent = 'Enter the Login URL first.';
      urlInput?.focus();
      return;
    }

    if (button) button.disabled = true;
    if (results) results.hidden = true;
    if (status) status.innerHTML = '<span class="spinner tiny"></span> Opening page and detecting login fields…';

    try {
      const response = await fetch('/api/inspect-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `Inspection failed (HTTP ${response.status})`);
      render(root, data);
      if (status) status.textContent = 'Inspection complete. Review the detected fields below.';
    } catch (error) {
      if (status) status.textContent = error.message || String(error);
    } finally {
      if (button) button.disabled = false;
    }
  }

  function wire(root) {
    const inspectButton = root.querySelector('[data-inspect-login]');
    inspectButton?.addEventListener('click', () => inspect(root));

    root.addEventListener('click', (event) => {
      const addOne = event.target.closest('[data-add-inspected]');
      if (addOne) {
        const index = Number(addOne.dataset.addInspected);
        const control = root._qadeckInspectedControls?.[index];
        if (control && addExtraField(root, control)) {
          addOne.textContent = 'Added ✓';
          addOne.disabled = true;
        }
      }

      const addAll = event.target.closest('[data-add-all-inspected]');
      if (addAll) {
        let added = 0;
        for (const control of root._qadeckInspectedControls || []) {
          if (control.role === 'extra' && addExtraField(root, control)) added += 1;
        }
        addAll.textContent = added ? `Added ${added} field${added === 1 ? '' : 's'} ✓` : 'Fields already added';
        addAll.disabled = true;
      }
    });
  }

  document.querySelectorAll('[data-login-inspector]').forEach(wire);
})();
