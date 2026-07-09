import { env } from '../config/env.js';

/**
 * Creates a video room for a telemedicine session. Uses the same provider
 * (Daily.co) your offline HMS already integrates, so there's one video vendor
 * across the whole platform, not two.
 *
 * With no DAILY_API_KEY configured (local dev), returns a clearly-labeled
 * mock URL instead of failing, so the rest of the flow is testable without
 * a Daily.co account.
 */
export async function createRoom(sessionRef: string): Promise<string> {
  if (!env.dailyApiKey) {
    return `https://mock.daily.co/${sessionRef}`;
  }

  const res = await fetch('https://api.daily.co/v1/rooms', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.dailyApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name: sessionRef,
      properties: {
        exp: Math.floor(Date.now() / 1000) + 60 * 60 * 2, // room expires 2h after creation
        enable_chat: true,
        enable_screenshare: true
      }
    })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`daily_room_create_failed: ${res.status} ${text}`);
  }

  const data = (await res.json()) as { url: string };
  return data.url;
}
