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

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const isMember = await verifyMember(event.headers.authorization || event.headers.Authorization);
  if (!isMember) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Sign in required.' }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 501,
      body: JSON.stringify({ code: 'NOT_CONFIGURED', error: 'AI generator is not configured on this site yet.' })
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body.' }) };
  }

  const { topic, notes, topIdeas } = payload;
  if (!topic || !String(topic).trim()) {
    return { statusCode: 400, body: JSON.stringify({ error: 'A topic or passage is required.' }) };
  }

  const ideasLine = Array.isArray(topIdeas) && topIdeas.length
    ? `\n\nFor extra context, here are a few topics the group has recently suggested (use only if relevant, do not force it): ${topIdeas.join('; ')}`
    : '';
  const notesLine = notes && String(notes).trim() ? `\n\nAdditional focus requested by the group leader: ${notes}` : '';

  const systemPrompt = `You write small-group Bible study guides for a lay Christian discussion group. Respond ONLY with a single JSON object, no markdown fences, no preamble, matching exactly this shape:
{
  "title": string,
  "scriptureRef": string,
  "openingPrayer": string,
  "context": string (2-4 sentences of historical/theological background),
  "reflectionQuestions": string[] (3-5 personal reflection questions),
  "discussionQuestions": string[] (3-5 group discussion questions),
  "application": string (a short paragraph on living it out this week),
  "closingPrayer": string
}`;

  const userPrompt = `Create a study guide on: ${topic}${notesLine}${ideasLine}`;

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
        max_tokens: 1800,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('Anthropic API error:', errText);
      return { statusCode: 502, body: JSON.stringify({ error: 'The AI generator hit a snag. Try again in a moment.' }) };
    }

    const data = await res.json();
    const textBlock = (data.content || []).find(b => b.type === 'text');
    if (!textBlock) throw new Error('No text in response');

    const cleaned = textBlock.text.replace(/^```json\s*|\s*```$/g, '').trim();
    const guide = JSON.parse(cleaned);

    return { statusCode: 200, body: JSON.stringify(guide) };
  } catch (err) {
    console.error('generate-guide error:', err);
    return { statusCode: 502, body: JSON.stringify({ error: 'The AI generator hit a snag. Try again in a moment.' }) };
  }
};
