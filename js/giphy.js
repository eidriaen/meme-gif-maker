// GIPHY search. Needs a (free) API key from https://developers.giphy.com/dashboard/

const API = 'https://api.giphy.com/v1';

export async function giphySearch({ key, query, kind = 'gifs', offset = 0, limit = 24, rating = 'r' }) {
  const q = query.trim();
  const endpoint = q ? 'search' : 'trending';
  const params = new URLSearchParams({ api_key: key, limit, offset, rating });
  if (q) params.set('q', q);
  const res = await fetch(`${API}/${kind}/${endpoint}?${params}`);
  if (res.status === 401 || res.status === 403) throw new Error('GIPHY rejected the API key. Check it in Settings.');
  if (res.status === 429) throw new Error('GIPHY rate limit hit. Wait a bit and try again.');
  if (!res.ok) throw new Error(`GIPHY error ${res.status}`);
  const json = await res.json();
  return {
    total: json.pagination?.total_count ?? 0,
    items: json.data.map((g) => ({
      id: g.id,
      title: g.title,
      thumb: g.images.fixed_width_downsampled?.webp || g.images.fixed_width?.webp || g.images.fixed_width?.url,
      thumbW: +g.images.fixed_width?.width || 200,
      thumbH: +g.images.fixed_width?.height || 200,
      gif: pickGif(g.images),
    })),
  };
}

// Full quality unless it is huge; the app downsizes on import anyway.
function pickGif(im) {
  const orig = im.original;
  if (orig?.url && +orig.size < 8_000_000) return orig.url;
  return im.downsized_large?.url || im.downsized_medium?.url || orig?.url;
}
