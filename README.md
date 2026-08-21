# CleanTube

Watch YouTube videos with no ads and no comments. Search or paste a link — just focus.

## Deploying on Vercel (recommended)

This project is set up for zero-config Vercel deployment:
- `index.html` is served as a static page.
- `api/search.js` is a Vercel serverless function that proxies YouTube search, so the API key never reaches the browser.

To enable search, set an environment variable in the Vercel project:

1. Get a YouTube Data API v3 key from the [Google Cloud Console](https://console.cloud.google.com/apis/credentials) (enable "YouTube Data API v3" for the project first).
2. In the Vercel dashboard, go to the project's **Settings → Environment Variables**.
3. Add `YOUTUBE_API_KEY` with that key as the value, for the Production (and Preview, if you want) environment.
4. Redeploy. The key stays server-side — it's read only inside `api/search.js` and is never shipped to the browser.

Free tier is 10,000 quota units/day; each search costs 100 units, so roughly 100 searches/day before results pause until the next day's reset.

## Run with docker (static file only, no search):

```
docker run -d -p 8080:80 ghcr.io/purify-video/app
```

[http://localhost:8080/](http://localhost:8080/)

Note: the Docker image just serves the static `index.html` via nginx — it has no Node runtime, so `/api/search` won't work there. Search only works when deployed on a platform that runs the `api/` serverless function (like Vercel). Pasting a link directly still works fine either way.
