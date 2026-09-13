import { getSettings, keys } from "./config";

const BASE = "https://api.gmi-serving.com/v1";

/** Chat completion that must return a JSON object. */
export async function chatJSON<T>(system: string, user: string): Promise<T> {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${keys.gmi}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: getSettings().llmModel,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
      temperature: 0.8,
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`GMI ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  const text: string = body.choices?.[0]?.message?.content ?? "";
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(json) as T;
}
