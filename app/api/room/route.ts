// The tutor pen relay for running without Supabase: the student's device and
// the tutor's device each hold an event stream open here, and each posts its
// messages, which go to the other side. It keeps everything in this server's
// memory, so it works for `npm run dev` or `npm start` on one machine (a
// laptop and a tablet on the same network), not across serverless instances.
// With Supabase configured the app uses Realtime instead and this is off.

import { researchMode } from "@/lib/supabase/env";
import { validRoomCode } from "@/lib/room-clock";

export const dynamic = "force-dynamic";

type Sub = { role: "host" | "guest"; push: (data: string) => void };
type Rooms = Map<string, Set<Sub>>;
const g = globalThis as unknown as { __coinkRooms?: Rooms };
const rooms: Rooms = (g.__coinkRooms ??= new Map());

const roleOf = (v: unknown) => (v === "host" || v === "guest" ? v : null);

export async function GET(req: Request) {
  if (researchMode) return new Response("Not found", { status: 404 });
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const role = roleOf(url.searchParams.get("role"));
  if (!validRoomCode(code) || !role) return new Response("Bad room", { status: 400 });
  const enc = new TextEncoder();
  let sub: Sub | null = null;
  let beat: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      sub = {
        role,
        push: (data) => {
          try {
            c.enqueue(enc.encode(`data: ${data}\n\n`));
          } catch {
            // closed
          }
        },
      };
      const set = rooms.get(code) ?? new Set<Sub>();
      set.add(sub);
      rooms.set(code, set);
      c.enqueue(enc.encode(": open\n\n"));
      beat = setInterval(() => {
        try {
          c.enqueue(enc.encode(": .\n\n"));
        } catch {
          // closed
        }
      }, 15000);
    },
    cancel() {
      if (beat) clearInterval(beat);
      const set = rooms.get(code);
      if (set && sub) {
        set.delete(sub);
        if (!set.size) rooms.delete(code);
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" } });
}

export async function POST(req: Request) {
  if (researchMode) return new Response("Not found", { status: 404 });
  const body = (await req.json().catch(() => null)) as { code?: unknown; role?: unknown; messages?: unknown } | null;
  const role = roleOf(body?.role);
  if (!body || !validRoomCode(body.code) || !role || !Array.isArray(body.messages)) return Response.json({ error: "bad message" }, { status: 400 });
  const data = JSON.stringify(body.messages.slice(0, 500));
  if (data.length > 2_000_000) return Response.json({ error: "too large" }, { status: 413 });
  for (const s of rooms.get(body.code) ?? []) if (s.role !== role) s.push(data);
  return Response.json({ ok: true });
}
