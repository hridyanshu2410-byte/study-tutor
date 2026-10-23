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
    ["Pre quizzes", participants.filter((p) => p.pre_score !== "").length],
    ["Post quizzes", participants.filter((p) => p.post_score !== "").length],
  ] as const;
  // Mean quiz scores per study arm, for a first look; the CSVs have the rest.
  const arms = [...new Set(participants.map((p) => p.condition || "none"))].map((arm) => {
    const mine = participants.filter((p) => (p.condition || "none") === arm);
    const avg = (xs: unknown[]) => {
      const ns = xs.filter((x) => x !== "").map(Number);
      return ns.length ? (ns.reduce((a, b) => a + b, 0) / ns.length).toFixed(1) : "–";
    };
    return { arm, n: mine.length, pre: avg(mine.map((p) => p.pre_score)), post: avg(mine.map((p) => p.post_score)), helpful: avg(mine.map((p) => p.helpful_mean)) };
  });

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
        <h2>Study arms</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Arm</th>
                <th>Testers</th>
                <th>Mean pre quiz</th>
                <th>Mean post quiz</th>
                <th>Mean &ldquo;helped&rdquo; (1-5)</th>
              </tr>
            </thead>
            <tbody>
              {arms.map((a) => (
                <tr key={a.arm}>
                  <td>{a.arm}</td>
                  <td className="num">{a.n}</td>
                  <td className="num">{a.pre}</td>
                  <td className="num">{a.post}</td>
                  <td className="num">{a.helpful}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2>Participants</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Participant</th>
                <th>Arm</th>
                <th>Level</th>
                <th>Course</th>
                <th>Sessions</th>
                <th>Tutor turns</th>
                <th>Cards</th>
                <th>Reviews</th>
                <th>Pre</th>
                <th>Post</th>
                <th>Last active</th>
              </tr>
            </thead>
            <tbody>
              {participants.map((p) => (
                <tr key={p.participant}>
                  <td>{p.participant}</td>
                  <td>{p.condition || "–"}</td>
                  <td>{String(p.level)}</td>
                  <td>{String(p.course)}</td>
                  <td className="num">{p.sessions}</td>
                  <td className="num">{p.tutor_turns}</td>
                  <td className="num">{p.cards_created}</td>
                  <td className="num">{p.reviews}</td>
                  <td className="num">{String(p.pre_score)}</td>
                  <td className="num">{String(p.post_score)}</td>
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
