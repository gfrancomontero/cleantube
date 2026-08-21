/**
 * Vercel serverless function: proxies YouTube Data API calls so the API
 * key never reaches the browser.
 *
 * Set YOUTUBE_API_KEY as an environment variable in the Vercel project
 * settings (Settings → Environment Variables). It is only read here,
 * server-side, and is never sent to the client.
 *
 * Three modes, one endpoint:
 *   GET /api/search?q=<query>     -> search
 *   GET /api/search?trending=1    -> "trending now" fallback for the
 *                                     suggested-videos grid when a visitor
 *                                     has no watch history yet
 *   GET /api/search?id=<videoId>  -> single-video lookup (used to backfill
 *                                     title/channel/thumbnail for videos
 *                                     opened by pasted link, so they can be
 *                                     recorded into watch history)
 *
 * All three return the same shape:
 *   { results: [{ videoId, title, channelTitle, thumbnailUrl, publishedAt,
 *                  viewCount, duration }] }
 * except the single-video lookup, which returns { result: {...} }.
 */
module.exports = async function handler(req, res) {
  const apiKey = process.env.YOUTUBE_API_KEY;

  if (!apiKey) {
    res.status(500).json({
      error: "Search isn't configured yet: set YOUTUBE_API_KEY in the Vercel project's environment variables.",
    });
    return;
  }

  // Vercel populates this from the request's geo-IP for every request that
  // hits a serverless function — no extra lookup needed.
  const viewerCountry = (req.headers['x-vercel-ip-country'] || '').toString().toUpperCase();

  if (req.query.trending === '1') {
    await handleTrending(res, apiKey, viewerCountry || 'US');
    return;
  }

  if (req.query.id) {
    await handleSingleVideo(res, apiKey, (req.query.id || '').toString().trim());
    return;
  }

  const query = (req.query.q || '').toString().trim();

  if (!query) {
    res.status(400).json({ error: 'Missing search query.' });
    return;
  }

  await handleSearch(res, apiKey, viewerCountry, query);
};

/**
 * Shape a raw YouTube API video resource into our common result format.
 * `snippet` and `details` may come from different API calls (search.list
 * vs videos.list) so they're passed in separately.
 */
function toResult(videoId, snippet, details) {
  snippet = snippet || {};
  const thumbnails = snippet.thumbnails || {};
  const thumb = thumbnails.medium || thumbnails.default || {};
  const stats = details && details.statistics;

  return {
    videoId: videoId,
    title: snippet.title || '',
    channelTitle: snippet.channelTitle || '',
    thumbnailUrl: thumb.url || '',
    publishedAt: snippet.publishedAt || null,
    viewCount: stats && stats.viewCount != null ? Number(stats.viewCount) : null,
    duration: (details && details.contentDetails && details.contentDetails.duration) || null,
  };
}

async function handleSearch(res, apiKey, viewerCountry, query) {
  // Over-fetch a bit since some candidates get filtered out below
  // (geo-restricted or not embeddable), then trim back down to 12.
  const searchParams = new URLSearchParams({
    part: 'snippet',
    type: 'video',
    maxResults: '16',
    q: query,
    key: apiKey,
  });

  try {
    const searchResponse = await fetch('https://www.googleapis.com/youtube/v3/search?' + searchParams.toString());
    const searchData = await searchResponse.json().catch(function () { return null; });

    if (!searchResponse.ok) {
      const reason = searchData && searchData.error && searchData.error.message ? searchData.error.message : searchResponse.statusText;
      res.status(searchResponse.status).json({ error: reason || 'YouTube search failed.' });
      return;
    }

    const candidates = (Array.isArray(searchData.items) ? searchData.items : [])
      .filter(function (item) { return item.id && item.id.videoId; });

    if (!candidates.length) {
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
      res.status(200).json({ results: [] });
      return;
    }

    // search.list doesn't report embeddability, region restrictions, or view
    // counts, so fetch those separately (cheap: videos.list is 1 quota unit
    // no matter how many IDs or parts are batched in).
    const videoIds = candidates.map(function (item) { return item.id.videoId; }).join(',');
    const detailsById = await fetchVideosDetails(apiKey, videoIds);

    const results = candidates
      .map(function (item) { return { item: item, details: detailsById[item.id.videoId] }; })
      .filter(function (entry) {
        const details = entry.details;

        // Couldn't fetch details for this one — don't block it on that alone.
        if (!details) return true;

        if (details.status && details.status.embeddable === false) return false;

        const restriction = details.contentDetails && details.contentDetails.regionRestriction;
        if (restriction && viewerCountry) {
          if (Array.isArray(restriction.blocked) && restriction.blocked.indexOf(viewerCountry) !== -1) return false;
          if (Array.isArray(restriction.allowed) && restriction.allowed.indexOf(viewerCountry) === -1) return false;
        }

        return true;
      })
      .slice(0, 12)
      .map(function (entry) {
        return toResult(entry.item.id.videoId, entry.item.snippet, entry.details);
      });

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.status(200).json({ results: results });
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach YouTube.' });
  }
}

async function fetchVideosDetails(apiKey, idsCsv) {
  const detailsParams = new URLSearchParams({
    part: 'contentDetails,status,statistics',
    id: idsCsv,
    key: apiKey,
  });

  const detailsResponse = await fetch('https://www.googleapis.com/youtube/v3/videos?' + detailsParams.toString());
  const detailsData = await detailsResponse.json().catch(function () { return null; });

  const detailsById = {};
  if (detailsResponse.ok && detailsData && Array.isArray(detailsData.items)) {
    detailsData.items.forEach(function (video) {
      detailsById[video.id] = video;
    });
  }

  return detailsById;
}

/**
 * "Trending now" — the suggested-videos fallback for visitors with no
 * watch history yet. YouTube's own most-popular chart, region-scoped.
 */
async function handleTrending(res, apiKey, regionCode) {
  const params = new URLSearchParams({
    part: 'snippet,contentDetails,statistics',
    chart: 'mostPopular',
    maxResults: '12',
    regionCode: regionCode,
    key: apiKey,
  });

  try {
    const response = await fetch('https://www.googleapis.com/youtube/v3/videos?' + params.toString());
    const data = await response.json().catch(function () { return null; });

    if (!response.ok) {
      const reason = data && data.error && data.error.message ? data.error.message : response.statusText;
      res.status(response.status).json({ error: reason || 'Failed to load trending videos.' });
      return;
    }

    const items = Array.isArray(data.items) ? data.items : [];
    const results = items.map(function (item) {
      return toResult(item.id, item.snippet, item);
    });

    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
    res.status(200).json({ results: results });
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach YouTube.' });
  }
}

/**
 * Single-video lookup — used to backfill title/channel/thumbnail for a
 * video opened via pasted link (search results already carry that data),
 * so it can be recorded into watch history with a proper title, not just
 * an ID.
 */
async function handleSingleVideo(res, apiKey, videoId) {
  if (!videoId) {
    res.status(400).json({ error: 'Missing video id.' });
    return;
  }

  const params = new URLSearchParams({
    part: 'snippet,contentDetails,statistics',
    id: videoId,
    key: apiKey,
  });

  try {
    const response = await fetch('https://www.googleapis.com/youtube/v3/videos?' + params.toString());
    const data = await response.json().catch(function () { return null; });

    if (!response.ok) {
      const reason = data && data.error && data.error.message ? data.error.message : response.statusText;
      res.status(response.status).json({ error: reason || 'Failed to look up video.' });
      return;
    }

    const item = Array.isArray(data.items) ? data.items[0] : null;

    if (!item) {
      res.status(404).json({ error: 'Video not found.' });
      return;
    }

    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    res.status(200).json({ result: toResult(item.id, item.snippet, item) });
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach YouTube.' });
  }
}
