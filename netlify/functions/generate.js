const { getStore } = require('@netlify/blobs');

const BLOBS_CONFIG = {
  siteID: process.env.NETLIFY_SITE_ID,
  token: process.env.NETLIFY_BLOBS_TOKEN
};

const DAILY_CAP = parseInt(process.env.DAILY_CAP || '20', 10);
const DAILY_CAP_PER_IP = parseInt(process.env.DAILY_CAP_PER_IP || '6', 10);
const MODEL = 'claude-sonnet-4-6';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': 'https://cosmik-fieldnote.netlify.app',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function clientIp(event) {
  return (event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();
}

function scrubPII(text) {
  let out = text.replace(
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    () => '[email removed]'
  );

  out = out.replace(
    /(?<![A-Za-z0-9-])(\+?\d[\d\s()./-]{6,}\d)(?![A-Za-z0-9])/g,
    (match) => {
      const digits = match.replace(/\D/g, '');
      const seps = (match.match(/[/-]/g) || []).length;
      const looksLikeDate = digits.length === 8 && seps === 2;
      if (digits.length >= 8 && digits.length <= 15 && !looksLikeDate) {
        return '[phone removed]';
      }
      return match;
    }
  );

  return out;
}

// Netlify Blobs has no conditional/compare-and-swap write, so a true atomic
// increment isn't possible here. This narrows (does not eliminate) the race
// window between the check and the write.
async function checkAndBumpUsage(usageStore, key, cap) {
  const read = async () => {
    try {
      return parseInt((await usageStore.get(key)) || '0', 10);
    } catch (e) {
      return 0;
    }
  };

  if ((await read()) >= cap) return false;

  await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 120)));

  const count = await read();
  if (count >= cap) return false;

  await usageStore.set(key, String(count + 1));
  return true;
}

const SYSTEM_PROMPT = `You turn a messy spoken or typed field observation (classroom, site visit, inspection, or similar) into a clean structured report.
Respond ONLY with a JSON object, no markdown fences, no preamble, in exactly this shape:
{"summary": "<one or two sentence plain-language summary of what happened>", "highlights": ["<short positive observation>", ...], "flags": ["<short concern or issue that needs attention>", ...], "nextSteps": ["<short concrete action item>", ...]}
Keep every array item under 20 words. Use only what's actually in the note, never invent details. If a category genuinely has nothing to report, return an empty array for it rather than padding it.
Never use em-dashes. Use commas, full stops, or the word "to" for ranges instead.`;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  const note = (body.note || '').toString().trim();

  if (!note) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Write or speak an observation first.' }) };
  }
  if (note.length > 4000) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Keep the observation under 4000 characters.' }) };
  }

  try {
    const usageStore = getStore({ name: 'fieldnote-usage', ...BLOBS_CONFIG });
    const today = new Date().toISOString().slice(0, 10);
    const usageKey = `count-${today}`;
    const ipUsageKey = `count-${today}-ip-${clientIp(event)}`;

    const globalOk = await checkAndBumpUsage(usageStore, usageKey, DAILY_CAP);
    if (!globalOk) {
      return {
        statusCode: 429,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'Fieldnote has hit its free report limit for today. Check back tomorrow.' })
      };
    }
    const ipOk = await checkAndBumpUsage(usageStore, ipUsageKey, DAILY_CAP_PER_IP);
    if (!ipOk) {
      return {
        statusCode: 429,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "You've hit today's per-user report limit. Check back tomorrow." })
      };
    }

    const scrubbedNote = scrubPII(note);

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 800,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: scrubbedNote }]
      })
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      console.error('fieldnote upstream error:', resp.status, errText.slice(0, 500));
      return { statusCode: 502, headers: CORS_HEADERS, body: JSON.stringify({ error: 'The report generator is having trouble right now. Try again in a minute.' }) };
    }

    const data = await resp.json();
    const raw = (data.content || []).map((b) => b.text || '').join('').trim();

    let report;
    try {
      report = JSON.parse(raw);
    } catch (e) {
      return { statusCode: 502, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Could not parse the report. Try again.' }) };
    }

    const remaining = DAILY_CAP - parseInt((await usageStore.get(usageKey)) || '0', 10);

    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        summary: (report.summary || '').toString().slice(0, 300),
        highlights: Array.isArray(report.highlights) ? report.highlights.slice(0, 10) : [],
        flags: Array.isArray(report.flags) ? report.flags.slice(0, 10) : [],
        nextSteps: Array.isArray(report.nextSteps) ? report.nextSteps.slice(0, 10) : [],
        remainingToday: Math.max(0, remaining)
      })
    };
  } catch (err) {
    console.error('fieldnote generate error:', err);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Something went wrong generating that report. Try again in a minute.' }) };
  }
};
