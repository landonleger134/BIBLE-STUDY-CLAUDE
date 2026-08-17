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

function extractSection(html, label) {
  // Looks for a heading containing the label, followed by the first link (citation) after it.
  const headRe = new RegExp(`<h[23][^>]*>\\s*${label}\\s*<\\/h[23]>`, 'i');
  const headMatch = headRe.exec(html);
  if (!headMatch) return null;
  const rest = html.slice(headMatch.index + headMatch[0].length, headMatch.index + headMatch[0].length + 2000);
  const linkMatch = /<a[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/i.exec(rest);
  if (!linkMatch) return null;
  return {
    citation: linkMatch[2].trim().replace(/\s+/g, ' '),
    usccbUrl: linkMatch[1].startsWith('http') ? linkMatch[1] : `https://bible.usccb.org${linkMatch[1]}`
  };
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

exports.handler = async (event) => {
  const isMember = await verifyMember(event.headers.authorization || event.headers.Authorization);
  if (!isMember) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Sign in required.' }) };
  }

  const mmddyy = (event.queryStringParameters || {}).date;
  if (!mmddyy || !/^\d{6}$/.test(mmddyy)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'A date in mmddyy format is required.' }) };
  }

  const pageUrl = `https://bible.usccb.org/bible/readings/${mmddyy}.cfm`;

  try {
    const res = await fetch(pageUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; UpperRoomBibleStudy/1.0)' } });
    if (!res.ok) throw new Error(`USCCB fetch failed: ${res.status}`);
    const html = await res.text();

    const titleMatch = /<title>([^<|]+)/i.exec(html);
    const title = titleMatch ? titleMatch[1].trim() : 'Today\'s Readings';

    const sectionLabels = ['Reading 1', 'Reading 2', 'Responsorial Psalm', 'Alleluia', 'Gospel'];
    const sections = [];
    for (const label of sectionLabels) {
      const found = extractSection(html, label);
      if (found) sections.push({ label, ...found });
    }

    // Fetch public-domain text for each section in parallel
    await Promise.all(sections.map(async (s) => {
      s.text = await fetchPublicDomainText(s.citation);
    }));

    return {
      statusCode: 200,
      body: JSON.stringify({ title, pageUrl, sections })
    };
  } catch (err) {
    console.error('daily-readings error:', err);
    return { statusCode: 502, body: JSON.stringify({ error: 'Could not load readings right now.', pageUrl }) };
  }
};
