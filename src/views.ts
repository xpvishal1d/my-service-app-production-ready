function escapeHtml(input: string) {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function page(title: string, body: string) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: system-ui, sans-serif; max-width: 920px; margin: 40px auto; padding: 0 16px; line-height: 1.55; }
    a, button { display: inline-block; padding: 10px 14px; border-radius: 10px; text-decoration: none; border: 1px solid #888; background: transparent; color: inherit; cursor: pointer; }
    .grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
    .card { border: 1px solid #444; padding: 20px; border-radius: 16px; }
    .muted { opacity: .75; font-size: 14px; }
    code, pre { background: rgba(127,127,127,.12); border-radius: 8px; }
    pre { padding: 14px; overflow: auto; }
    .row { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
  </style>
</head>
<body>${body}</body>
</html>`;
}

export function errorPage(title: string, message: string) {
  return page(
    title,
    `<div class="card">
      <h1>${escapeHtml(title)}</h1>
      <pre>${escapeHtml(message)}</pre>
      <p><a href="/">Go home</a></p>
    </div>`
  );
}
