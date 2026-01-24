"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useRouter } from "next/navigation";

type Goal = {
  id: string;
  title: string;
  cadence_per_day: number;
  created_at: string;
};

type Checkin = {
  id: string;
  goal_id: string;
  checkin_date: string;
  energy: number;
  workload: number;
  blockers: string | null;
  completed: boolean;
  created_at: string;
};

type AutopilotResult = {
    agent_run_id: string;
    opik_trace_id?: string;   // add
    state: string;
    selected_agent: string;
    summary: string;
    steps: { title: string; minutes: number; details: string }[];
    total_minutes: number;


    calendar_events?: CalendarEvent[];
    calendar_error?: string | null;
  };

  type CalendarEvent = {
    step_title: string;
    event_id?: string | null;
    htmlLink?: string | null;
    start?: string;
    end?: string;
  };  

  type RunRow = {
    id: string;
    created_at: string;
    state: string;
    selected_agent: string;
    summary: string;
    opik_trace_id?: string;
    feedback?: { helpful: boolean; comment?: string | null; created_at: string } | null;
  };
  
  
  

function todayISODate() {
  // Supabase `date` column expects YYYY-MM-DD
  return new Date().toISOString().slice(0, 10);
}


type CalendarStatus = {
  connected: boolean;
  calendar_id?: string | null;
  expires_at?: string | null;
};

function CalendarIntegration({ userId }: { userId: string }) {
  const [status, setStatus] = useState<CalendarStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [scheduleCalendar, setScheduleCalendar] = useState(false);
  const [startInMinutes, setStartInMinutes] = useState(5);


  const base = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:8000";

  async function refreshStatus() {
    setLoading(true);
    try {
      const r = await fetch(
        `${base}/api/integrations/google/status?user_id=${encodeURIComponent(userId)}`,
        { cache: "no-store" }
      );
      const j = await r.json();
      setStatus(j);
    } finally {
      setLoading(false);
    }
  }

  async function connectGoogle() {
    const r = await fetch(
      `${base}/api/integrations/google/start?user_id=${encodeURIComponent(userId)}`,
      { cache: "no-store" }
    );
    const j = await r.json();
    window.location.href = j.auth_url; // sends user to Google consent screen
  }

  useEffect(() => {
    if (userId) refreshStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  return (
    <div className="space-y-2">
      <div className="text-sm">
        Google Calendar:{" "}
        {status?.connected ? "✅ Connected" : status ? "❌ Not connected" : "…"}
      </div>

      {status?.connected && (
        <div className="text-xs text-gray-600">
          calendar_id: {status.calendar_id ?? "primary"} · expires_at:{" "}
          {status.expires_at ?? "—"}
        </div>
      )}

      <div className="flex gap-2">
        {!status?.connected && (
          <button className="border rounded px-3 py-2 text-sm" onClick={connectGoogle}>
            {loading ? "Opening…" : "Connect Google Calendar"}
          </button>
        )}

        <button className="border rounded px-3 py-2 text-sm" onClick={refreshStatus}>
          {loading ? "Refreshing…" : "Refresh status"}
        </button>
      </div>
    </div>
  );
}


export default function AppHome() {
  const router = useRouter();

  const [email, setEmail] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);

  const [goals, setGoals] = useState<Goal[]>([]);
  const [loadingGoals, setLoadingGoals] = useState(true);

  // create goal form
  const [title, setTitle] = useState("");
  const [cadence, setCadence] = useState<number>(1);
  const [savingGoal, setSavingGoal] = useState(false);

  // check-in state
  const [todayCheckin, setTodayCheckin] = useState<Checkin | null>(null);
  const [recentCheckins, setRecentCheckins] = useState<Checkin[]>([]);
  const [loadingCheckins, setLoadingCheckins] = useState(false);
  const [savingCheckin, setSavingCheckin] = useState(false);

  const [autopilot, setAutopilot] = useState<AutopilotResult | null>(null);
  const [runningAutopilot, setRunningAutopilot] = useState(false);


  // form fields for check-in
  const [energy, setEnergy] = useState(3);
  const [workload, setWorkload] = useState(3);
  const [blockers, setBlockers] = useState("");
  const [completed, setCompleted] = useState(false);

  // calendar scheduling toggles
  const [scheduleCalendar, setScheduleCalendar] = useState(false);
  const [startInMinutes, setStartInMinutes] = useState(5);

  const [msg, setMsg] = useState<string | null>(null);

  const selectedGoal = useMemo(() => goals[0] ?? null, [goals]);

  const [toast, setToast] = useState<string | null>(null);

  const [recentRuns, setRecentRuns] = useState<RunRow[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(false);


useEffect(() => {
  if (!toast) return;
  const t = setTimeout(() => setToast(null), 2500);
  return () => clearTimeout(t);
}, [toast]);


  useEffect(() => {
    // session gate
    supabase.auth.getSession().then(({ data }) => {
      const session = data.session;
      if (!session) router.replace("/auth");
      else {
        setEmail(session.user.email ?? null);
        setUserId(session.user.id);
      }
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) router.replace("/auth");
      else {
        setEmail(session.user.email ?? null);
        setUserId(session.user.id);
      }
    });

    return () => sub.subscription.unsubscribe();
  }, [router]);

  async function signOut() {
    await supabase.auth.signOut();
  }

  async function loadGoals() {
    setLoadingGoals(true);
    const { data, error } = await supabase
      .from("goals")
      .select("id,title,cadence_per_day,created_at")
      .order("created_at", { ascending: false });

    if (error) {
      setMsg(error.message);
      setGoals([]);
    } else {
      setGoals((data ?? []) as Goal[]);
    }
    setLoadingGoals(false);
  }

  async function loadRecentRuns() {
    if (!userId) return;
    setLoadingRuns(true);
    try {
      const base = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:8000";
      const res = await fetch(`${base}/api/runs/recent?user_id=${userId}&limit=10`, { cache: "no-store" });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setRecentRuns(data.runs ?? []);
    } catch (e: any) {
      setMsg(e?.message ?? String(e));
    } finally {
      setLoadingRuns(false);
    }
  }
  

  async function loadCheckins(goalId: string) {
    setLoadingCheckins(true);
    setMsg(null);

    const today = todayISODate();

    const { data, error } = await supabase
      .from("checkins")
      .select("id,goal_id,checkin_date,energy,workload,blockers,completed,created_at")
      .eq("goal_id", goalId)
      .order("checkin_date", { ascending: false })
      .limit(7);

    if (error) {
      setMsg(error.message);
      setTodayCheckin(null);
      setRecentCheckins([]);
      setLoadingCheckins(false);
      return;
    }

    const rows = (data ?? []) as Checkin[];
    setRecentCheckins(rows);

    const t = rows.find((r) => r.checkin_date === today) ?? null;
    setTodayCheckin(t);

    // hydrate form from today's check-in if it exists
    if (t) {
      setEnergy(t.energy);
      setWorkload(t.workload);
      setBlockers(t.blockers ?? "");
      setCompleted(t.completed);
    } else {
      // defaults if no check-in yet
      setEnergy(3);
      setWorkload(3);
      setBlockers("");
      setCompleted(false);
    }

    setLoadingCheckins(false);
  }

  useEffect(() => {
    if (userId) loadGoals();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  useEffect(() => {
    if (selectedGoal?.id) loadCheckins(selectedGoal.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedGoal?.id]);

  async function createGoal(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);

    const cleanTitle = title.trim();
    if (!cleanTitle) {
      setMsg("Goal title is required.");
      return;
    }

    setSavingGoal(true);
    const { error } = await supabase.from("goals").insert({
      title: cleanTitle,
      cadence_per_day: cadence,
      user_id: userId, // explicit, works with your RLS
    });

    setSavingGoal(false);

    if (error) {
      setMsg(error.message);
      return;
    }

    setTitle("");
    setCadence(1);
    await loadGoals();
  }

  async function saveTodayCheckin() {
    if (!selectedGoal?.id || !userId) return;

    setSavingCheckin(true);
    setMsg(null);

    const payload = {
      user_id: userId,
      goal_id: selectedGoal.id,
      checkin_date: todayISODate(),
      energy,
      workload,
      blockers: blockers.trim() ? blockers.trim() : null,
      completed,
    };

    // upsert using the unique constraint (user_id, goal_id, checkin_date)
    const { error } = await supabase
      .from("checkins")
      .upsert(payload, {
        onConflict: "user_id,goal_id,checkin_date",
      });

    setSavingCheckin(false);

    if (error) {
      setMsg(error.message);
      return;
    }

    await loadCheckins(selectedGoal.id);
  }

  async function runAutopilot() {
    if (!selectedGoal?.id || !userId) return;
  
    setRunningAutopilot(true);
    setMsg(null);
    setAutopilot(null);
  
    try {
      const base =
        process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:8000";
  
      const body = {
        user_id: userId,
        goal_id: selectedGoal.id,
        checkin_id: todayCheckin?.id ?? null,
        energy,
        workload,
        blockers: blockers.trim() ? blockers.trim() : null,
        completed,
        schedule_calendar: scheduleCalendar,
        start_in_minutes: startInMinutes,      
      };
  
      const res = await fetch(`${base}/api/run_autopilot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
  
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`Backend error (${res.status}): ${t}`);
      }
  
      const data = (await res.json()) as AutopilotResult;
      setAutopilot(data);
      await loadRecentRuns();
      setToast("✅ Feedback saved ...");

  
      // Optional: refresh checkins list (not required, but keeps state fresh)
      await loadCheckins(selectedGoal.id);
    } catch (e: any) {
      setMsg(e?.message ?? String(e));
    } finally {
      setRunningAutopilot(false);
    }
  }
  

  return (
    <main className="p-8 max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">commitAI</h1>
          <p className="mt-1 text-sm text-gray-600">
            Signed in as {email ?? "…"}
          </p>
        </div>

        <button className="underline text-sm" onClick={signOut}>
          Sign out
        </button>
      </div>

      {msg && <p className="mt-4 text-sm">{msg}</p>}

      <section className="mt-8 border rounded p-4">
        <h2 className="font-semibold">Create a goal</h2>
        <form onSubmit={createGoal} className="mt-3 space-y-3">
          <input
            className="w-full border rounded px-3 py-2"
            placeholder='e.g., "2 deep work sprints daily"'
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <div className="flex items-center gap-3">
            <label className="text-sm text-gray-700">
              Cadence / day:
              <input
                className="ml-2 w-20 border rounded px-2 py-1"
                type="number"
                min={1}
                max={10}
                value={cadence}
                onChange={(e) => setCadence(Number(e.target.value))}
              />
            </label>

            <button
              className="border rounded px-3 py-2 text-sm"
              disabled={savingGoal}
              type="submit"
            >
              {savingGoal ? "Creating..." : "Create goal"}
            </button>
          </div>
        </form>
      </section>

      <section className="mt-8 border rounded p-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Your goals</h2>
          <button className="underline text-sm" onClick={loadGoals}>
            Refresh
          </button>
        </div>

        {loadingGoals ? (
          <p className="mt-3 text-sm text-gray-600">Loading...</p>
        ) : goals.length === 0 ? (
          <p className="mt-3 text-sm text-gray-600">
            No goals yet. Create your first goal above.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {goals.map((g) => (
              <li key={g.id} className="border rounded p-3">
                <div className="font-medium">{g.title}</div>
                <div className="text-sm text-gray-600">
                  Cadence/day: {g.cadence_per_day}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-8 border rounded p-4">
        <h2 className="font-semibold">Today’s check-in</h2>

        {!selectedGoal ? (
          <p className="mt-2 text-sm text-gray-600">
            Create a goal first to start checking in.
          </p>
        ) : loadingCheckins ? (
          <p className="mt-2 text-sm text-gray-600">Loading check-ins…</p>
        ) : (
          <>
            <p className="mt-2 text-sm text-gray-600">
              Goal: <span className="font-medium">{selectedGoal.title}</span>
            </p>

            <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
              <label className="text-sm">
                Energy (1–5)
                <input
                  className="mt-1 w-full border rounded px-3 py-2"
                  type="number"
                  min={1}
                  max={5}
                  value={energy}
                  onChange={(e) => setEnergy(Number(e.target.value))}
                />
              </label>

              <label className="text-sm">
                Workload (1–5)
                <input
                  className="mt-1 w-full border rounded px-3 py-2"
                  type="number"
                  min={1}
                  max={5}
                  value={workload}
                  onChange={(e) => setWorkload(Number(e.target.value))}
                />
              </label>

              <label className="text-sm md:col-span-2">
                Blockers (optional)
                <textarea
                  className="mt-1 w-full border rounded px-3 py-2"
                  rows={3}
                  value={blockers}
                  onChange={(e) => setBlockers(e.target.value)}
                />
              </label>

              <label className="text-sm flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={completed}
                  onChange={(e) => setCompleted(e.target.checked)}
                />
                Mark goal completed today
              </label>
            </div>

            <label className="text-sm flex items-center gap-2 md:col-span-2">
              <input
                type="checkbox"
                checked={scheduleCalendar}
                onChange={(e) => setScheduleCalendar(e.target.checked)}
              />
              Schedule these steps on my Google Calendar
            </label>

            <label className="text-sm md:col-span-2">
              Start in (minutes)
              <input
                className="mt-1 w-full border rounded px-3 py-2"
                type="number"
                min={0}
                max={180}
                value={startInMinutes}
                onChange={(e) => setStartInMinutes(Number(e.target.value))}
                disabled={!scheduleCalendar}
              />
            </label>

            <label className="text-sm flex items-center gap-2 mt-3">
  <input
    type="checkbox"
    checked={scheduleCalendar}
    onChange={(e) => setScheduleCalendar(e.target.checked)}
  />
  Add plan to Google Calendar
</label>

{scheduleCalendar && (
  <label className="text-sm mt-2 block">
    Start in (minutes)
    <input
      className="mt-1 w-32 border rounded px-3 py-2"
      type="number"
      min={0}
      max={180}
      value={startInMinutes}
      onChange={(e) => setStartInMinutes(Number(e.target.value))}
    />
  </label>
)}

            <button
              className="mt-4 border rounded px-3 py-2 text-sm"
              onClick={saveTodayCheckin}
              disabled={savingCheckin}
            >
              {savingCheckin ? "Saving…" : "Save today’s check-in"}
            </button>

            <button
  className="mt-3 border rounded px-3 py-2 text-sm"
  onClick={runAutopilot}
  disabled={runningAutopilot}
>
  {runningAutopilot ? "Running Autopilot…" : "Run Autopilot"}
</button>

{autopilot && (
  <div className="mt-4 border rounded p-4">
    <div className="flex items-center justify-between">
      <div className="font-semibold">Autopilot Plan</div>
      <div className="text-sm text-gray-600">{autopilot.total_minutes} min</div>
    </div>

    <p className="mt-1 text-sm text-gray-700">
      <span className="font-medium">{autopilot.selected_agent}</span> ·{" "}
      {autopilot.state}
    </p>

    <p className="mt-2 text-sm text-gray-600">{autopilot.summary}</p>

    <ol className="mt-3 space-y-2 list-decimal list-inside">
      {autopilot.steps.map((s, idx) => (
        <li key={idx} className="border rounded p-3">
          <div className="font-medium">
            {s.title}{" "}
            <span className="text-sm text-gray-600">({s.minutes}m)</span>
          </div>
          <div className="text-sm mt-1">{s.details}</div>
        </li>
      ))}
    </ol>

    {/* ✅ ADD THIS RIGHT HERE */}
    {(autopilot as any)?.calendar_error && (
      <p className="mt-3 text-sm text-red-600">
        Calendar error: {(autopilot as any).calendar_error}
      </p>
    )}

    {(autopilot as any)?.calendar_events?.length > 0 && (
      <div className="mt-3 text-sm">
        <div className="font-medium">Calendar events created:</div>
        <ul className="list-disc list-inside">
          {(autopilot as any).calendar_events.map((e: any, i: number) => (
            <li key={i}>
              {e.step_title} —{" "}
              {e.htmlLink ? (
                <a className="underline" href={e.htmlLink} target="_blank" rel="noreferrer">
                  open
                </a>
              ) : (
                e.event_id
              )}
            </li>
          ))}
        </ul>
      </div>
    )}
    {/* ✅ END ADD */}


{autopilot.calendar_error && (
  <div className="mt-3 text-sm text-red-600">
    Calendar error: {autopilot.calendar_error}
  </div>
)}


    <p className="mt-3 text-xs text-gray-600">
      agent_run_id: {autopilot.agent_run_id}
    </p>

    {autopilot.opik_trace_id && (
      <p className="mt-1 text-xs text-gray-600">
        opik_trace_id: {autopilot.opik_trace_id}
      </p>
    )}

    {/* ✅ Add feedback buttons here */}
    <div className="mt-3 flex gap-2 relative z-10">
  <button
    type="button"
    className="border rounded px-3 py-2 text-sm cursor-pointer pointer-events-auto"
    onClick={async () => {
      setMsg("clicked 👍");
      try {
        const base =
          process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:8000";
        const res = await fetch(`${base}/api/feedback`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            user_id: userId!,
            agent_run_id: autopilot.agent_run_id,
            opik_trace_id: autopilot.opik_trace_id ?? null,
            helpful: true,
            comment: null,
          }),
        });
    
        if (!res.ok) {
          const t = await res.text();
          throw new Error(`Feedback failed (${res.status}): ${t}`);
        }
    
        setToast("✅ Feedback saved (helpful).");
      } catch (e: any) {
        setMsg(e?.message ?? String(e));
      }
    }}
    
  >
    👍 Helpful
  </button>

  <button
    type="button"
    className="border rounded px-3 py-2 text-sm cursor-pointer pointer-events-auto"
    onClick={async () => {
      const base =
        process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:8000";
      await fetch(`${base}/api/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: userId!,
          agent_run_id: autopilot.agent_run_id,
          opik_trace_id: autopilot.opik_trace_id ?? null,
          helpful: false,
          comment: null,
        }),
      });
      setMsg("✅ Feedback saved (not helpful).");
    }}
  >
    👎 Not helpful
  </button>
</div>

  </div>
)}

<section className="mt-8 border rounded p-4">
  <h2 className="font-semibold">Calendar integration</h2>

  {!userId ? (
    <p className="mt-2 text-sm text-gray-600">Loading user…</p>
  ) : (
    <div className="mt-3">
      <CalendarIntegration userId={userId} />
    </div>
  )}
</section>


            <p className="mt-2 text-xs text-gray-600">
              Status:{" "}
              {todayCheckin
                ? "You already have a check-in for today (updates will overwrite it)."
                : "No check-in saved for today yet."}
            </p>

            <div className="mt-6">
              <h3 className="font-semibold">Recent check-ins (last 7)</h3>
              {recentCheckins.length === 0 ? (
                <p className="mt-2 text-sm text-gray-600">None yet.</p>
              ) : (
                <ul className="mt-2 space-y-2">
                  {recentCheckins.map((c) => (
                    <li key={c.id} className="border rounded p-3">
                      <div className="flex items-center justify-between">
                        <div className="font-medium">{c.checkin_date}</div>
                        <div className="text-sm">
                          {c.completed ? "✅ Completed" : "⬜ Not completed"}
                        </div>
                      </div>
                      <div className="text-sm text-gray-600 mt-1">
                        Energy: {c.energy} · Workload: {c.workload}
                      </div>
                      {c.blockers && (
                        <div className="text-sm mt-1">Blockers: {c.blockers}</div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </section>

      <section className="mt-8 border rounded p-4">
  <div className="flex items-center justify-between">
    <h2 className="font-semibold">Recent agent runs</h2>
    <button className="underline text-sm" onClick={loadRecentRuns}>
      Refresh
    </button>
  </div>

  {loadingRuns ? (
    <p className="mt-2 text-sm text-gray-600">Loading…</p>
  ) : recentRuns.length === 0 ? (
    <p className="mt-2 text-sm text-gray-600">No runs yet. Click “Run Autopilot”.</p>
  ) : (
    <ul className="mt-3 space-y-2">
      {recentRuns.map((r) => (
        <li key={r.id} className="border rounded p-3">
          <div className="flex items-center justify-between">
            <div className="font-medium">{r.selected_agent} · {r.state}</div>
            <div className="text-xs text-gray-600">
              {new Date(r.created_at).toLocaleString()}
            </div>
          </div>

          <div className="text-sm text-gray-700 mt-1">{r.summary}</div>

          <div className="text-xs text-gray-600 mt-2 flex gap-3">
            <span>run_id: {r.id}</span>
            {r.opik_trace_id && <span>opik: {r.opik_trace_id}</span>}
            {r.feedback && <span>feedback: {r.feedback.helpful ? "👍" : "👎"}</span>}
          </div>
        </li>
      ))}
    </ul>
  )}
</section>


      {toast && (
  <div className="fixed bottom-4 right-4 z-50 border rounded px-4 py-2 text-sm bg-white shadow">
    {toast}
  </div>
)}

    </main>
  );
}


