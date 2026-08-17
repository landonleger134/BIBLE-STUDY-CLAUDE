const SUPABASE_URL = 'https://tltewglxvxdymumuknpo.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_2dqRVNmrZQJR2T5kIe8xNw_c3sZdBuu';

async function verifyMember(authHeader) {
  const token = (authHeader || '').replace(/^Bearer\s+/i, '');
  if (!token) return false;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY }
  });
  return res.ok;
}

function mmddyyToIso(mmddyy) {
  const mm = mmddyy.slice(0, 2), dd = mmddyy.slice(2, 4), yy = mmddyy.slice(4, 6);
  return `20${yy}-${mm}-${dd}`;
}

async function getCached(isoDate) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/readings_cache?reading_date=eq.${isoDate}&select=*`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows && rows[0] ? rows[0] : null;
}

async function saveCache(isoDate, title, pageUrl, sections) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/readings_cache`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates'
      },
      body: JSON.stringify({ reading_date: isoDate, title, page_url: pageUrl, sections })
    });
  } catch {
    // Non-fatal — worst case we just re-scrape next time.
  }
}

async function fetchPublicDomainText(citation) {
  if (!citation) return null;
  try {
    const cleaned = citation.replace(/\s+and\s+/gi, ', ');
    const res = await fetch(`https://bible-api.com/${encodeURIComponent(cleaned)}?translation=web`);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.text) return null;
    return data.text.replace(/\s+/g, ' ').trim();
  } catch {
    return null;
  }
}

const SECTION_LABELS = ['Reading 1', 'Reading 2', 'Responsorial Psalm', 'Alleluia', 'Gospel'];

// --- Direct HTML fetch/parse (works when USCCB isn't blocking the request) ---
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

function extractSectionHtml(html, label) {
  const headRe = new RegExp(`<h[23][^>]*>\\s*${label}\\s*<\\/h[23]>`, 'i');
  const headMatch = headRe.exec(html);
  if (!headMatch) return null;
  const rest = html.slice(headMatch.index + headMatch[0].length, headMatch.index + headMatch[0].length + 2000);
  const linkMatch = /<a[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/i.exec(rest);
  if (!linkMatch) return null;
  return { citation: linkMatch[2].trim().replace(/\s+/g, ' '), usccbUrl: linkMatch[1] };
}

async function tryDirect(pageUrl) {
  const res = await fetch(pageUrl, { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`Direct fetch failed: ${res.status}`);
  const html = await res.text();
  const titleMatch = /<title>([^<|]+)/i.exec(html);
  const title = titleMatch ? titleMatch[1].trim() : 'Today\'s Readings';
  const sections = [];
  for (const label of SECTION_LABELS) {
    const found = extractSectionHtml(html, label);
    if (found) sections.push({ label, ...found });
  }
  if (!sections.length) throw new Error('No sections found in direct HTML.');
  return { title, sections };
}

// --- Proxy reader fetch/parse (bypasses IP-based blocking on USCCB's end) ---
function extractSectionMarkdown(text, label) {
  const headRe = new RegExp(`#{2,3}\\s*${label}\\s*\\n`, 'i');
  const headMatch = headRe.exec(text);
  if (!headMatch) return null;
  const rest = text.slice(headMatch.index + headMatch[0].length, headMatch.index + headMatch[0].length + 1000);
  const linkMatch = /\[([^\]]+)\]\(([^)]+)\)/.exec(rest);
  if (!linkMatch) return null;
  return { citation: linkMatch[1].trim().replace(/\s+/g, ' '), usccbUrl: linkMatch[2] };
}

async function tryViaReaderProxy(pageUrl) {
  const res = await fetch(`https://r.jina.ai/${pageUrl}`, { headers: { Accept: 'text/plain' } });
  if (!res.ok) throw new Error(`Reader proxy fetch failed: ${res.status}`);
  const text = await res.text();
  const titleMatch = /^title:\s*(.+)$/mi.exec(text);
  const title = titleMatch ? titleMatch[1].replace(/\s*\|\s*USCCB.*$/i, '').trim() : 'Today\'s Readings';
  const sections = [];
  for (const label of SECTION_LABELS) {
    const found = extractSectionMarkdown(text, label);
    if (found) sections.push({ label, ...found });
  }
  if (!sections.length) throw new Error('No sections found via reader proxy.');
  return { title, sections };
}

async function withRetry(fn, attempts = 2) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 500));
    }
  }
  throw lastErr;
}

exports.handler = async (event) => {
  const isMember = await verifyMember(event.headers.authorization || event.headers.Authorization);
  if (!isMember) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Sign in required.' }) };
  }

  const mmddyy = (event.queryStringParameters || {}).date;
  if (!mmddyy || !/^\d{6}$/.test(mmddyy)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'A date in mmddyy format is required.' }) };
  }

  const isoDate = mmddyyToIso(mmddyy);
  const pageUrl = `https://bible.usccb.org/bible/readings/${mmddyy}.cfm`;

  const cached = await getCached(isoDate);
  if (cached && Array.isArray(cached.sections) && cached.sections.length) {
    return { statusCode: 200, body: JSON.stringify({ title: cached.title, pageUrl: cached.page_url, sections: cached.sections }) };
  }

  let result;
  let lastError;
  try {
    result = await withRetry(() => tryDirect(pageUrl), 1);
  } catch (err) {
    lastError = err;
    try {
      result = await withRetry(() => tryViaReaderProxy(pageUrl), 2);
    } catch (err2) {
      lastError = err2;
    }
  }

  if (!result) {
    console.error('daily-readings error:', lastError);
    return { statusCode: 502, body: JSON.stringify({ error: (lastError && lastError.message) || 'Could not load readings right now.', pageUrl }) };
  }

  try {
    await Promise.all(result.sections.map(async (s) => {
      s.text = await fetchPublicDomainText(s.citation);
    }));
    await saveCache(isoDate, result.title, pageUrl, result.sections);
    return { statusCode: 200, body: JSON.stringify({ title: result.title, pageUrl, sections: result.sections }) };
  } catch (err) {
    console.error('daily-readings post-processing error:', err);
    return { statusCode: 502, body: JSON.stringify({ error: err.message || 'Could not load readings right now.', pageUrl }) };
  }
};
