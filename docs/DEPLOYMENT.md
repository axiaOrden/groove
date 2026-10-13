# Deployment Guide

## Deployment model

Groove is currently a fully static Vite application. Production needs an HTTPS-capable static web server or static hosting provider, not a Node.js process, application backend, or database. Node.js is required only on the build machine.

Build from a clean, reviewed revision:

```bash
npm ci
npm test
npm run typecheck
npm run build
```

Upload the **contents** of `frontend/dist/` to the site's document root. The bundle contains `index.html` and fingerprinted assets, including the analysis worker. Preserve the generated paths and filenames.

Do not upload the source tree, `.git/`, `.freebuff/`, `node_modules/`, `test-assets/`, phase notes, development configuration, logs, environment files, coverage, imported user music, or local analysis/transcode output. None is needed at runtime.

An example release layout on a Linux VPS is:

```text
/var/www/groove/
|-- releases/
|   |-- 20261013-001/
|   |   |-- index.html
|   |   `-- assets/
|   `-- 20261013-002/
|       |-- index.html
|       `-- assets/
`-- current -> /var/www/groove/releases/20261013-002
```

Build elsewhere, copy a new immutable release directory, verify it, then atomically point `current` to it. The server should expose only `/var/www/groove/current`.

## Nginx example

Replace every value marked `CHANGE_ME` and confirm paths before enabling this configuration.

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name CHANGE_ME.example.com;

    location /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name CHANGE_ME.example.com;

    root /var/www/groove/current;
    index index.html;

    ssl_certificate     /etc/letsencrypt/live/CHANGE_ME.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/CHANGE_ME.example.com/privkey.pem;

    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;

    location /assets/ {
        try_files $uri =404;
        expires 1y;
        add_header Cache-Control "public, max-age=31536000, immutable";
    }

    location = /index.html {
        add_header Cache-Control "no-cache";
    }

    # Safe for current client-side routing and future history routes.
    location / {
        try_files $uri $uri/ /index.html;
        add_header Cache-Control "no-cache";
    }
}
```

The current app does not require a history route beyond `/`, but the fallback is appropriate for a Vite SPA and prevents deep-link 404s if client routes are added. Do not apply the fallback to `/assets/`; missing fingerprinted assets should fail rather than return HTML.

Obtain and renew a trusted certificate with the VPS's chosen ACME client (for example Certbot), following that tool's current operating-system instructions. Validate the Nginx configuration before reload and monitor certificate renewal. HTTPS protects the application bundle in transit and provides the secure context expected by modern browser features; `localhost` is the usual development exception.

## Browser and storage behavior

Target current evergreen Chromium, Firefox, and Safari releases with WebGL, ES2022 modules, Web Audio/OfflineAudioContext, Web Workers, Blob/File APIs, and IndexedDB enabled. Actual MP3 decoding, WebGL capacity, worker behavior, storage quota, touch latency, audio latency, and background-audio policies vary by browser and device. Test representative desktop, Android, and iOS devices before declaring support.

IndexedDB is stored on each visitor's device under the production origin. It does not create files or records on the VPS, and one user cannot see another user's songs. Changing the scheme, host, port, or domain creates a different storage origin; migrating domains does not migrate users' libraries. Users can lose local data through site-data clearing, private browsing, quota eviction, or browser/profile removal.

## Security and privacy

- Groove processes user-selected audio locally. The static server should not accept uploads; do not add upload handling to Nginx.
- File extensions and MIME labels are not proof of content. Maintain size/type validation and defensive decode error handling in the client.
- Imported audio may be copyrighted, sensitive, or malformed. Never log, collect, redistribute, or back it up without explicit user consent and a separate security/legal design.
- Keep source maps under review. Vite currently emits them; they aid debugging but expose readable source structure. Decide whether public production source maps are acceptable before launch rather than silently changing the current build.
- Use least-privilege filesystem ownership. The Nginx worker needs read access to the release, not write access.
- Serve no directory listing, secrets, repository metadata, or development artifacts.
- A Content Security Policy should be tested before launch. Do not paste a restrictive policy into production without confirming Three.js, workers, blob URLs, audio decoding, and WASM encoding still function.
- Update dependencies on a reviewed branch, rerun validation, and inspect the generated dependency audit separately from runtime server patching.

## Release, update, and rollback

1. Check out the intended commit or tag on a trusted build machine.
2. Run the clean install and validation commands above.
3. Create a new uniquely named release directory and copy only `frontend/dist/` contents into it.
4. Confirm ownership, permissions, file count, and that `index.html` references assets present in that same release.
5. Point the `current` symlink at the new release atomically.
6. Run `nginx -t`, reload Nginx, and perform desktop/mobile smoke checks: app load, demo playback, import, worker analysis, play, reload, and IndexedDB persistence.
7. Keep at least one previously verified release until the new release is established.

To roll back, atomically repoint `current` to the previous immutable release, test Nginx configuration, reload, and smoke-test again. Static rollback does not roll back or migrate a visitor's IndexedDB; any future storage-schema change must remain backward compatible or include an explicit client migration plan.
