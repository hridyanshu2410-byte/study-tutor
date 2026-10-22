import { notFound } from "next/navigation";
import { loadStudy, requireAdmin } from "@/lib/research";
import { researchMode } from "@/lib/supabase/env";

export const dynamic = "force-dynamic";
export const metadata = { title: "Study · Tutor" };

export default async function AdminPage() {
  if (!researchMode) notFound();
  const db = await requireAdmin();
  if (!db) notFound();
  const { participants, events, feedback } = await loadStudy(db);

  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  const active = participants.filter((p) => p.last_active && new Date(p.last_active).getTime() > weekAgo).length;
  const turns = participants.reduce((n, p) => n + p.tutor_turns, 0);
  const reviews = participants.reduce((n, p) => n + p.reviews, 0);
  const stats = [
    ["Testers", participants.length],
    ["Consented", participants.filter((p) => p.consented).length],
    ["Active this week", active],
    ["Tutor turns", turns],
    ["Reviews", reviews],
    ["Feedback", feedback.length],
  ] as const;

  return (
    <main className="admin">
      <header className="admin-head">
        <h1 className="brand">Study</h1>
        <nav>
          <a href="/api/admin/export?table=participants">Download participants CSV</a>
          <a href="/api/admin/export?table=events">Download events CSV ({events.length})</a>
          <a href="/">Back to the tutor</a>
        </nav>
      </header>

      <section className="admin-stats">
        {stats.map(([label, value]) => (
          <div key={label} className="stat">
            <span className="stat-value">{value}</span>
            <span className="stat-label">{label}</span>
          </div>
        ))}
      </section>

      <section>
        <h2>Participants</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Participant</th>
                <th>Level</th>
                <th>Course</th>
                <th>Sessions</th>
                <th>Tutor turns</th>
                <th>Cards</th>
                <th>Reviews</th>
                <th>Last active</th>
              </tr>
            </thead>
            <tbody>
              {participants.map((p) => (
                <tr key={p.participant}>
                  <td>{p.participant}</td>
                  <td>{String(p.level)}</td>
                  <td>{String(p.course)}</td>
                  <td className="num">{p.sessions}</td>
                  <td className="num">{p.tutor_turns}</td>
                  <td className="num">{p.cards_created}</td>
                  <td className="num">{p.reviews}</td>
                  <td>{p.last_active ? new Date(p.last_active).toLocaleString() : "never"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2>Latest feedback</h2>
        {feedback.length ? (
          <ul className="feedback-list">
            {feedback.slice(0, 50).map((f) => (
              <li key={f.id}>
                <span className="detail">
                  {f.participant} · {new Date(f.at).toLocaleString()}
                  {f.data.rating ? ` · ${f.data.rating}/5` : ""}
                </span>
                <p>{String(f.data.note ?? "")}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="detail">No feedback yet.</p>
        )}
      </section>
    </main>
  );
}
