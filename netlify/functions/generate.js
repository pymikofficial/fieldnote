const { getStore } = require('@netlify/blobs');

const BLOBS_CONFIG = {
  siteID: process.env.NETLIFY_SITE_ID,
  token: process.env.NETLIFY_BLOBS_TOKEN
};

const DAILY_CAP = parseInt(process.env.DAILY_CAP || '20', 10);
const MODEL = 'claude-sonnet-4-6';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

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
    const current = parseInt((await usageStore.get(usageKey)) || '0', 10);

    if (current >= DAILY_CAP) {
      return {
        statusCode: 429,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'Fieldnote has hit its free report limit for today. Check back tomorrow.' })
      };
    }

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
        messages: [{ role: 'user', content: note }]
      })
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      return { statusCode: 502, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Upstream error: ' + errText.slice(0, 200) }) };
    }

    const data = await resp.json();
    const raw = (data.content || []).map((b) => b.text || '').join('').trim();

    let report;
    try {
      report = JSON.parse(raw);
    } catch (e) {
      return { statusCode: 502, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Could not parse the report. Try again.' }) };
    }

    await usageStore.set(usageKey, String(current + 1));

    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        summary: (report.summary || '').toString().slice(0, 300),
        highlights: Array.isArray(report.highlights) ? report.highlights.slice(0, 10) : [],
        flags: Array.isArray(report.flags) ? report.flags.slice(0, 10) : [],
        nextSteps: Array.isArray(report.nextSteps) ? report.nextSteps.slice(0, 10) : [],
        remainingToday: Math.max(0, DAILY_CAP - (current + 1))
      })
    };
  } catch (err) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};
