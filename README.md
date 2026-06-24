# apimanga

API proxy-cache ringan untuk manga app di Azure VPS kecil.

## Endpoint

- `GET /health`
- `GET /cache/stats`
- `GET /comic/latest`
- `GET /comic/popular`
- `GET /comic/top`
- `GET /comic/recommended`
- `GET /comic/search?q=keyword`
- `GET /comic/genres`
- `GET /comic/genre/:slug`
- `GET /comic/detail/:slug`
- `GET /comic/chapter/:slug`
- `GET /comic/only/:type`

## Local

Install dependency, copy `.env.example` ke `.env`, lalu jalankan `npm run dev`.

## Azure

Gunakan Node.js 20, PM2, dan Nginx. Jalankan app dengan command:

```bash
pm2 start src/server.js --name apimanga --max-memory-restart 500M
pm2 save
```

Nginx reverse proxy diarahkan ke `http://127.0.0.1:4000`.

Untuk VPS 2GB, gunakan satu proses saja dan set `SANKA_MAX_REQUESTS_PER_MINUTE` di 20-30.
