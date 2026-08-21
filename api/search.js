/**
 * Vercel serverless function: proxies YouTube search so the API key
 * never reaches the browser.
 *
 * Set YOUTUBE_API_KEY as an environment variable in the Vercel project
 * settings (Settings → Environment Variables). It is only read here,
 * server-side, and is never sent to the client.
 *
 * GET /api/search?q=<query>
 * -> { results: [{ videoId, title, channelTitle, thumbnailUrl }] }
 */
module.exports = async function handler(req, res) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  const query = (req.query.q || '').toString().trim();

  // Vercel populates this from the request's geo-IP for every request that
  // hits a serverless function — no extra lookup needed.
  const viewerCountry = (req.headers['x-vercel-ip-country'] || '').toString().toUpperCase();

  if (!apiKey) {
    res.status(500).json({
      error: "Search isn't configured yet: set YOUTUBE_API_KEY in the Vercel project's environment variables.",
    });
    return;
  }

  if (!query) {
    res.status(400).json({ error: 'Missing search query.' });
    return;
  }

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
    const detailsParams = new URLSearchParams({
      part: 'contentDetails,status,statistics',
      id: videoIds,
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
        const item = entry.item;
        const details = entry.details;
        const snippet = item.snippet || {};
        const thumbnails = snippet.thumbnails || {};
        const thumb = thumbnails.medium || thumbnails.default || {};
        const stats = details && details.statistics;

        return {
          videoId: item.id.videoId,
          title: snippet.title || '',
          channelTitle: snippet.channelTitle || '',
          thumbnailUrl: thumb.url || '',
          publishedAt: snippet.publishedAt || null,
          viewCount: stats && stats.viewCount != null ? Number(stats.viewCount) : null,
          duration: (details && details.contentDetails && details.contentDetails.duration) || null,
        };
      });

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.status(200).json({ results: results });
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach YouTube.' });
  }
};
