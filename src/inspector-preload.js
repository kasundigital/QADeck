const { chromium } = require('playwright');
const express = require('express');

const originalListen = express.application.listen;
const inspectTimeout = Math.max(5000, Number(process.env.PAGE_INSPECT_TIMEOUT_MS || 20000));
let activeInspections = 0;
const maxConcurrent = 2;

function validTarget(raw) {
  try {
    const url = new URL(String(raw || '').trim());
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function classifyControl(control) {
  const haystack = [
    control.label,
    control.name,
    control.id,
    control.placeholder,
    control.autocomplete,
    control.type,
    control.text
  ].filter(Boolean).join(' ').toLowerCase();

  if (/captcha|recaptcha|turnstile|hcaptcha/.test(haystack)) return { role: 'manual', confidence: 'high', note: 'CAPTCHA requires manual handling.' };
  if (/\botp\b|one.?time|verification|verify code|2fa|mfa|totp|security code/.test(haystack)) return { role: 'manual', confidence: 'high', note: 'OTP/MFA usually requires manual or dedicated test handling.' };
  if (control.type === 'password' || /current-password|password|passwd/.test(haystack)) return { role: 'password', confidence: 'high', note: 'Looks like the account password field.' };
  if (control.tag === 'button' || control.type === 'submit') {
    if (/login|log in|sign in|signin|submit|continue/.test(haystack)) return { role: 'submit', confidence: 'high', note: 'Looks like the login/continue button.' };
    return { role: 'ignore', confidence: 'medium', note: 'Button detected.' };
  }
  if (control.type === 'email' || control.autocomplete === 'username' || /email|e-mail|username|user name|login id|user id/.test(haystack)) {
    return { role: 'username', confidence: control.type === 'email' ? 'high' : 'medium', note: 'Looks like the username/email field.' };
  }
  if (control.type === 'checkbox' || control.type === 'radio') return { role: 'ignore', confidence: 'medium', note: 'Optional checkbox/radio control.' };
  if (control.tag === 'select' || ['text', 'number', 'tel', 'password'].includes(control.type) || control.tag === 'textarea') {
    return { role: 'extra', confidence: 'medium', note: 'Additional value may be required before login.' };
  }
  return { role: 'ignore', confidence: 'low', note: 'Control does not normally need QADeck login data.' };
}

async function inspectLoginPage(targetUrl) {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1366, height: 900 },
      ignoreHTTPSErrors: true,
      userAgent: 'QADeck Login Inspector/1.0'
    });
    const page = await context.newPage();
    page.setDefaultTimeout(inspectTimeout);

    const response = await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: inspectTimeout });
    await page.waitForTimeout(700);

    const inspected = await page.evaluate(() => {
      const visible = (el) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };

      const selectorFor = (el) => {
        if (el.id) return `#${CSS.escape(el.id)}`;
        const tag = el.tagName.toLowerCase();
        if (el.getAttribute('name')) {
          const name = el.getAttribute('name').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          return `${tag}[name="${name}"]`;
        }
        const type = el.getAttribute('type');
        if (type && ['input', 'button'].includes(tag)) {
          const same = [...document.querySelectorAll(`${tag}[type="${type}"]`)].filter(visible);
          const index = same.indexOf(el);
          if (same.length === 1) return `${tag}[type="${type}"]`;
          if (index >= 0) return `${tag}[type="${type}"]:nth-of-type(${index + 1})`;
        }
        const parent = el.parentElement;
        if (parent) {
          const siblings = [...parent.children].filter((node) => node.tagName === el.tagName);
          const index = siblings.indexOf(el);
          if (index >= 0) return `${tag}:nth-of-type(${index + 1})`;
        }
        return tag;
      };

      const labelFor = (el) => {
        const aria = el.getAttribute('aria-label');
        if (aria) return aria.trim();
        if (el.id) {
          const explicit = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          if (explicit?.innerText) return explicit.innerText.trim();
        }
        const wrapped = el.closest('label');
        if (wrapped?.innerText) return wrapped.innerText.trim();
        const parentText = el.parentElement?.querySelector('label')?.innerText;
        return parentText ? parentText.trim() : '';
      };

      const controls = [...document.querySelectorAll('input, select, textarea, button')]
        .filter((el) => visible(el) && String(el.getAttribute('type') || '').toLowerCase() !== 'hidden')
        .slice(0, 40)
        .map((el, index) => {
          const tag = el.tagName.toLowerCase();
          const type = tag === 'select' ? 'select' : tag === 'textarea' ? 'text' : String(el.getAttribute('type') || (tag === 'button' ? 'button' : 'text')).toLowerCase();
          return {
            index,
            tag,
            type,
            label: labelFor(el).slice(0, 160),
            name: String(el.getAttribute('name') || '').slice(0, 120),
            id: String(el.id || '').slice(0, 120),
            placeholder: String(el.getAttribute('placeholder') || '').slice(0, 160),
            autocomplete: String(el.getAttribute('autocomplete') || '').toLowerCase().slice(0, 80),
            required: Boolean(el.required),
            disabled: Boolean(el.disabled),
            text: String(el.innerText || el.value || '').trim().slice(0, 120),
            selector: selectorFor(el),
            options: tag === 'select' ? [...el.options].slice(0, 25).map((option) => ({ value: option.value, label: option.text })) : []
          };
        });

      const forms = [...document.querySelectorAll('form')].filter(visible).slice(0, 10).map((form) => ({
        action: form.action || '',
        method: String(form.method || 'get').toUpperCase(),
        id: form.id || '',
        name: form.getAttribute('name') || ''
      }));

      return { title: document.title, url: location.href, controls, forms };
    });

    const controls = inspected.controls.map((control) => ({ ...control, ...classifyControl(control) }));

    // Keep only the strongest automatic username/password/submit suggestions.
    for (const role of ['username', 'password', 'submit']) {
      let found = false;
      for (const control of controls) {
        if (control.role !== role) continue;
        if (!found) found = true;
        else if (role === 'username') control.role = 'extra';
        else control.role = 'ignore';
      }
    }

    const recommended = {
      username: controls.find((control) => control.role === 'username')?.selector || null,
      password: controls.find((control) => control.role === 'password')?.selector || null,
      submit: controls.find((control) => control.role === 'submit')?.selector || null
    };

    await context.close();
    return {
      requested_url: targetUrl,
      final_url: inspected.url,
      title: inspected.title,
      status: response ? response.status() : null,
      forms: inspected.forms,
      controls,
      recommended
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

express.application.listen = function patchedListen(...args) {
  if (!this.__qadeckLoginInspectorInstalled) {
    this.__qadeckLoginInspectorInstalled = true;

    this.post('/api/inspect-login', async (req, res) => {
      const targetUrl = validTarget(req.body?.url);
      if (!targetUrl) return res.status(400).json({ error: 'Enter a valid http:// or https:// login URL.' });
      if (activeInspections >= maxConcurrent) return res.status(429).json({ error: 'Another login-page inspection is already running. Try again shortly.' });

      activeInspections += 1;
      try {
        const result = await inspectLoginPage(targetUrl);
        return res.json(result);
      } catch (error) {
        console.error('[QADeck inspector] Login page inspection failed:', error);
        return res.status(502).json({ error: `Could not inspect that page: ${error.message}` });
      } finally {
        activeInspections -= 1;
      }
    });
  }

  return originalListen.apply(this, args);
};
