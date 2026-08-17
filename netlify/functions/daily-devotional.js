const SUPABASE_URL = 'https://tltewglxvxdymumuknpo.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_2dqRVNmrZQJR2T5kIe8xNw_c3sZdBuu';

async function getUser(token) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY }
  });
  if (!res.ok) return null;
  return res.json();
}

async function getCached(date, token) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/devotionals?devo_date=eq.${date}&select=*`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` }
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows && rows[0] ? rows[0] : null;
}

async function saveDevotional(row, token) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/devotionals`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    },
    body: JSON.stringify(row)
  });
  if (res.status === 409 || res.status === 201 || res.status === 200) {
    if (res.ok) {
      const rows = await res.json();
      return rows && rows[0] ? rows[0] : null;
    }
  }
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const authHeader = event.headers.authorization || event.headers.Authorization;
  const token = (authHeader || '').replace(/^Bearer\s+/i, '');
  const user = token ? await getUser(token) : null;
  if (!user) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Sign in required.' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body.' }) };
  }

  const date = payload.date; // 'YYYY-MM-DD'
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'A date (YYYY-MM-DD) is required.' }) };
  }

  const cached = await getCached(date, token);
  if (cached) {
    return { statusCode: 200, body: JSON.stringify(cached) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 501,
      body: JSON.stringify({ code: 'NOT_CONFIGURED', error: 'AI devotional generator is not configured on this site yet.' })
    };
  }

  const anchor = payload.anchorCitation ? `\n\nIf it fits naturally, you may draw on today's Gospel reading (${payload.anchorCitation}), but don't force a connection if it doesn't serve the devotional.` : '';

  const systemPrompt = `You write a short daily devotional for a men's Christian Bible study group. The tone is direct, honest, and encouraging — speaking to men about faith, integrity, discipline, brotherhood, fatherhood, work, and perseverance, without being preachy or clichéd. Respond ONLY with a single JSON object, no markdown fences, no preamble, matching exactly this shape:
{
  "title": string (short, punchy),
  "citation": string (one Bible reference this devotional centers on),
  "scriptureText": string (the actual verse text, public domain wording, 1-4 verses),
  "reflection": string (2-3 short paragraphs, direct and grounded, written to men),
  "challenge": string (one concrete, specific action to take today),
  "closingPrayer": string (short, a few sentences)
}`;

  const userPrompt = `Write today's devotional for ${date}.${anchor}`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1200,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('Anthropic API error:', errText);
      return { statusCode: 502, body: JSON.stringify({ error: 'The devotional generator hit a snag. Try again shortly.' }) };
    }

    const data = await res.json();
    const textBlock = (data.content || []).find(b => b.type === 'text');
    if (!textBlock) throw new Error('No text in response');
    const cleaned = textBlock.text.replace(/^```json\s*|\s*```$/g, '').trim();
    const gen = JSON.parse(cleaned);

    const row = {
      devo_date: date,
      title: gen.title,
      citation: gen.citation || '',
      scripture_text: gen.scriptureText || '',
      reflection: gen.reflection,
      challenge: gen.challenge,
      closing_prayer: gen.closingPrayer
    };

    const saved = await saveDevotional(row, token);
    if (saved) {
      return { statusCode: 200, body: JSON.stringify(saved) };
    }
    // Someone else generated it in the same instant — fetch the winning row.
    const raceWinner = await getCached(date, token);
    if (raceWinner) {
      return { statusCode: 200, body: JSON.stringify(raceWinner) };
    }
    return { statusCode: 200, body: JSON.stringify(row) };
  } catch (err) {
    console.error('daily-devotional error:', err);
    return { statusCode: 502, body: JSON.stringify({ error: 'The devotional generator hit a snag. Try again shortly.' }) };
  }
};
