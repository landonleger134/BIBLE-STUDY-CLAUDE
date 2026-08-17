// Scheduled function: runs daily, and if there's a group meeting today,
// emails a reminder to the configured recipient list.
//
// Requires these Netlify environment variables to be set (Site settings > Environment variables):
//   RESEND_API_KEY          - API key from https://resend.com
//   REMINDER_TO_EMAILS      - comma-separated list of recipient emails
//   SUPABASE_SERVICE_ROLE_KEY - from Supabase project settings > API (needed to read
//                                calendar_events without a logged-in user session)
//
// Until all three are set, this function no-ops safely (same pattern as the other
// AI-powered functions in this app).

const SUPABASE_URL = 'https://tltewglxvxdymumuknpo.supabase.co';

function formatTime(t) {
  const [h, m] = t.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

async function handler() {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const REMINDER_TO_EMAILS = process.env.REMINDER_TO_EMAILS;
  const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!RESEND_API_KEY || !REMINDER_TO_EMAILS || !SERVICE_ROLE_KEY) {
    return { statusCode: 200, body: 'NOT_CONFIGURED' };
  }

  const today = new Date().toISOString().slice(0, 10);
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/calendar_events?event_date=eq.${today}&is_meeting=eq.true&select=*`,
    { headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` } }
  );
  if (!res.ok) return { statusCode: 500, body: 'Failed to check calendar' };
  const events = await res.json();
  if (!events || !events.length) return { statusCode: 200, body: 'No meeting today' };

  const meeting = events[0];
  const recipients = REMINDER_TO_EMAILS.split(',').map(s => s.trim()).filter(Boolean);
  if (!recipients.length) return { statusCode: 200, body: 'No recipients configured' };

  const whenParts = [
    meeting.event_time ? formatTime(meeting.event_time) : null,
    meeting.location || null,
  ].filter(Boolean);

  const html = `
    <div style="font-family: Georgia, serif; max-width: 480px; margin: 0 auto; color: #1a1a1a;">
      <h2 style="margin-bottom: 4px;">${meeting.title}</h2>
      <p style="color: #666; font-size: 14px;">Today${whenParts.length ? ' · ' + whenParts.join(' · ') : ''}</p>
      ${meeting.note ? `<p style="font-size: 14px;">${meeting.note}</p>` : ''}
    </div>
  `;

  const sendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'The Upper Room <onboarding@resend.dev>',
      to: recipients,
      subject: `Reminder: ${meeting.title} today`,
      html,
    }),
  });

  if (!sendRes.ok) {
    const errText = await sendRes.text();
    return { statusCode: 500, body: `Failed to send: ${errText}` };
  }

  return { statusCode: 200, body: 'Sent' };
}

// Runs daily at 10:00 UTC (~5am Central Daylight Time), about an hour before a 6:15am meeting.
// Note: this is a fixed UTC time, so the local-time offset will shift by an hour when
// daylight saving time changes.
module.exports.handler = handler;
module.exports.config = { schedule: '0 10 * * *' };
