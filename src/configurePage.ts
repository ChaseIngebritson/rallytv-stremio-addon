import type { Manifest, ManifestConfig } from 'stremio-addon-sdk';

/**
 * Configure UI that emits a configured HTTPS manifest URL
 * (…/{encodeURIComponent(JSON.stringify(config))}/manifest.json)
 * which Stremio installs; handlers then receive config.authToken.
 */
export function configurePage(manifest: Manifest): string {
  const logo = manifest.logo || 'https://dl.strem.io/addon-logo.png';
  const fields = (manifest.config || [])
    .map((elem: ManifestConfig) => {
      const required = elem.required ? ' required' : '';
      const value =
        elem.default != null ? ` value="${String(elem.default).replace(/"/g, '&quot;')}"` : '';
      const type = elem.type === 'password' ? 'password' : 'text';
      return `
        <label class="field">
          <span>${elem.title}${elem.required ? ' *' : ''}</span>
          <input type="${type}" name="${elem.key}" id="${elem.key}"${value}${required} autocomplete="off" spellcheck="false" />
        </label>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${manifest.name} — Configure</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; background: #0f1115; color: #f2f4f8; }
    .wrap { max-width: 40rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
    .logo { width: 4.5rem; height: 4.5rem; object-fit: contain; display: block; margin-bottom: 1rem; }
    h1 { font-size: 1.6rem; margin: 0 0 .35rem; }
    .sub { opacity: .75; margin: 0 0 1.5rem; line-height: 1.45; }
    form { display: grid; gap: 1rem; margin-bottom: 1.25rem; }
    .field { display: grid; gap: .4rem; font-size: .9rem; }
    input { width: 100%; box-sizing: border-box; border: 1px solid #2a3140; background: #171b24; color: inherit; border-radius: .5rem; padding: .75rem .85rem; font-size: .95rem; }
    input:focus { outline: 2px solid #7c5cff; border-color: transparent; }
    .actions { display: flex; flex-wrap: wrap; gap: .75rem; margin-bottom: 1.25rem; }
    button, .btn { appearance: none; border: 0; border-radius: .5rem; padding: .8rem 1.1rem; font-weight: 600; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; }
    .primary { background: #8A5AAB; color: white; }
    .secondary { background: #232836; color: white; }
    .box { background: #171b24; border: 1px solid #2a3140; border-radius: .75rem; padding: 1rem; margin-bottom: 1rem; }
    .box h2 { font-size: .85rem; text-transform: uppercase; letter-spacing: .04em; opacity: .7; margin: 0 0 .6rem; }
    code, textarea { display: block; width: 100%; box-sizing: border-box; word-break: break-all; white-space: pre-wrap; background: #0f1115; border: 1px solid #2a3140; border-radius: .5rem; padding: .75rem; color: #c8d0e0; font-size: .78rem; line-height: 1.4; }
    textarea { min-height: 5.5rem; resize: vertical; }
    .hint { font-size: .85rem; opacity: .7; margin-top: .75rem; }
    .ok { color: #7dffa3; font-size: .85rem; min-height: 1.2em; }
  </style>
</head>
<body>
  <div class="wrap">
    <img class="logo" src="${logo}" alt="" />
    <h1>${manifest.name}</h1>
    <p class="sub">Paste your Rally.tv Auth0 access token, then install the <strong>configured</strong> manifest URL below (not the bare /manifest.json).</p>

    <form id="cfg" novalidate>
      ${fields}
    </form>

    <div class="actions">
      <a class="btn primary" id="install" href="#">Install in Stremio</a>
      <button type="button" class="secondary" id="copyHttps">Copy HTTPS manifest</button>
      <button type="button" class="secondary" id="openHttps">Open HTTPS manifest</button>
    </div>
    <div class="ok" id="status"></div>

    <div class="box">
      <h2>Configured HTTPS manifest (use this)</h2>
      <textarea id="httpsUrl" readonly></textarea>
      <p class="hint">Stremio embeds your token in this URL path. Reinstall whenever you refresh the token.</p>
    </div>
    <div class="box">
      <h2>stremio:// install link</h2>
      <code id="stremioUrl"></code>
    </div>
  </div>
  <script>
    const form = document.getElementById('cfg');
    const httpsUrlEl = document.getElementById('httpsUrl');
    const stremioUrlEl = document.getElementById('stremioUrl');
    const install = document.getElementById('install');
    const status = document.getElementById('status');
    const proto = location.protocol === 'https:' ? 'https' : 'http';

    function buildUrls() {
      const data = Object.fromEntries(new FormData(form).entries());
      // Drop empty optional fields so the path stays smaller
      Object.keys(data).forEach((k) => { if (data[k] === '') delete data[k]; });
      const encoded = encodeURIComponent(JSON.stringify(data));
      const httpsManifest = proto + '://' + location.host + '/' + encoded + '/manifest.json';
      const stremioManifest = 'stremio://' + location.host + '/' + encoded + '/manifest.json';
      httpsUrlEl.value = httpsManifest;
      stremioUrlEl.textContent = stremioManifest;
      install.href = stremioManifest;
      return { httpsManifest, stremioManifest, data };
    }

    form.addEventListener('input', buildUrls);
    form.addEventListener('change', buildUrls);
    buildUrls();

    document.getElementById('copyHttps').onclick = async () => {
      const { httpsManifest, data } = buildUrls();
      if (!data.authToken) {
        status.textContent = 'Paste an Auth0 access token first.';
        return;
      }
      try {
        await navigator.clipboard.writeText(httpsManifest);
        status.textContent = 'Copied configured HTTPS manifest URL.';
      } catch {
        httpsUrlEl.select();
        status.textContent = 'Select and copy the URL manually.';
      }
    };

    document.getElementById('openHttps').onclick = () => {
      const { httpsManifest, data } = buildUrls();
      if (!data.authToken) {
        status.textContent = 'Paste an Auth0 access token first.';
        return;
      }
      window.open(httpsManifest, '_blank');
    };

    install.onclick = (e) => {
      const { data } = buildUrls();
      if (!form.reportValidity() || !data.authToken) {
        e.preventDefault();
        status.textContent = 'Paste an Auth0 access token first.';
      }
    };
  </script>
</body>
</html>`;
}
