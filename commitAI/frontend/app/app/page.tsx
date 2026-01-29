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

type CalendarEvent = {
  step_title: string;
  event_id?: string | null;
  htmlLink?: string | null;
  start?: string;
  end?: string;
};

// type PlanStep = { title: string; minutes: number; details: string };

type DailyPlanItem = {
  item_id: string;
  title: string;
  minutes: number;
  details: string;
  goal_ids: string[];
  kind: string;
  window: string;
  occurrences?: number;
  min_gap_minutes?: number;
};

type ScheduledBlock = {
  item_id?: string | null;
  title: string;
  details: string;
  goal_ids: string[];
  kind: string;
  start: string;
  end: string;
};

// type AutopilotResult = {
//   agent_run_id: string;
//   opik_trace_id?: string;
//   state: string;
//   selected_agent: string;
//   summary: string;
//   steps: PlanStep[];
//   total_minutes: number;
//   calendar_events?: CalendarEvent[];
//   calendar_error?: string | null;
// };

type DailyAutopilotResult = {
  daily_run_id?: string;
  summary: string;
  items: DailyPlanItem[];
  schedule: ScheduledBlock[];
  calendar_events?: CalendarEvent[];
  calendar_error?: string | null;
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
  // local YYYY-MM-DD
  return new Date().toLocaleDateString("en-CA");
}


type CalendarStatus = {
  connected: boolean;
  calendar_id?: string | null;
  expires_at?: string | null;
};

function CalendarIntegration({ userId }: { userId: string }) {
  const [status, setStatus] = useState<CalendarStatus | null>(null);
  const [loading, setLoading] = useState(false);

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
    window.location.href = j.auth_url;
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
  const base = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:8000";

  const tzName = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);


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

  // plans
  const [dailyAutopilot, setDailyAutopilot] = useState<DailyAutopilotResult | null>(null);

  // running states
  const [runningAutopilot, setRunningAutopilot] = useState(false);
  const [committingCalendar, setCommittingCalendar] = useState(false);

  // feedback UX
  const [showPlanFeedback, setShowPlanFeedback] = useState(false);
  const [planFeedbackText, setPlanFeedbackText] = useState("");

  // checklist state (Daily Autopilot)
  const [checkedItemIds, setCheckedItemIds] = useState<Record<string, boolean>>({});

  // form fields for check-in
  const [energy, setEnergy] = useState(3);
  const [workload, setWorkload] = useState(3);
  const [blockers, setBlockers] = useState("");
  const [completed, setCompleted] = useState(false);

  // calendar commit setting (used AFTER preview)
  const [scheduleCalendar, setScheduleCalendar] = useState(false);
  const [startInMinutes, setStartInMinutes] = useState(5);

  const [msg, setMsg] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const selectedGoal = useMemo(() => goals[0] ?? null, [goals]);

  const [recentRuns, setRecentRuns] = useState<RunRow[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(false);

  // ✅ helper: map goal id -> title for nicer daily UI
  const goalTitleById = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of goals) m.set(g.id, g.title);
    return m;
  }, [goals]);

  // ✅ checklist helpers (localStorage)
  function checklistKeyForToday() {
    return `commitAI:daily_checklist:${todayISODate()}`;
  }

  function loadChecklistFromStorage(): Record<string, boolean> {
    try {
      const raw = localStorage.getItem(checklistKeyForToday());
      return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
    } catch {
      return {};
    }
  }

  function toggleItemChecked(itemId: string) {
    setCheckedItemIds((prev) => {
      const next = { ...prev, [itemId]: !prev[itemId] };
      try {
        localStorage.setItem(checklistKeyForToday(), JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  }

  // hydrate checklist whenever a new daily run is loaded
  useEffect(() => {
    if (!dailyAutopilot?.items?.length) return;
    setCheckedItemIds(loadChecklistFromStorage());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dailyAutopilot?.daily_run_id]);

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
      const res = await fetch(`${base}/api/runs/recent?user_id=${userId}&limit=10`, {
        cache: "no-store",
      });
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
      setEnergy(3);
      setWorkload(3);
      setBlockers("");
      setCompleted(false);
    }

    setLoadingCheckins(false);
  }

  useEffect(() => {
    if (userId) {
      loadGoals();
      loadRecentRuns();
    }
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
      user_id: userId,
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

    const { error } = await supabase.from("checkins").upsert(payload, {
      onConflict: "user_id,goal_id,checkin_date",
    });

    setSavingCheckin(false);

    if (error) {
      setMsg(error.message);
      return;
    }

    await loadCheckins(selectedGoal.id);
    setToast("✅ Check-in saved");
  }

  async function submitFeedback(params: { agent_run_id: string; opik_trace_id?: string; helpful: boolean; comment?: string | null }) {
    if (!userId) return;
    const res = await fetch(`${base}/api/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: userId,
        agent_run_id: params.agent_run_id,
        opik_trace_id: params.opik_trace_id ?? null,
        helpful: params.helpful,
        comment: params.comment ?? null,
      }),
    });
    if (!res.ok) throw new Error(await res.text());
    await loadRecentRuns();
  }

  async function runAutopilotAllGoals() {
    if (!userId) return;
  
    setRunningAutopilot(true);
    setMsg(null);
    setDailyAutopilot(null);
  
    try {
      const base = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:8000";
  
      const body = {
        user_id: userId,
        energy,
        workload,
        blockers: blockers.trim() ? blockers.trim() : null,
        schedule_calendar: scheduleCalendar,
        start_in_minutes: startInMinutes,
        goal_ids: goals.map((g) => g.id), // ensures all goals included
        tz_name: tzName,
      };
  
      const res = await fetch(`${base}/api/run_daily_autopilot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
  
      if (!res.ok) throw new Error(await res.text());
  
      const data = (await res.json()) as DailyAutopilotResult;
      setDailyAutopilot(data);
      setToast("✅ Autopilot plan created (all goals)");
      await loadRecentRuns();
    } catch (e: any) {
      setMsg(e?.message ?? String(e));
    } finally {
      setRunningAutopilot(false);
    }
  }
  

  // // ✅ Commit Autopilot plan to calendar AFTER user accepts it
  // async function commitAutopilotToCalendar() {
  //   if (!userId || !autopilot?.agent_run_id) return;

  //   setCommittingCalendar(true);
  //   setMsg(null);

  //   try {
  //     // Preferred: a dedicated endpoint that schedules an existing agent_run_id
  //     const res = await fetch(`${base}/api/calendar/commit_autopilot`, {
  //       method: "POST",
  //       headers: { "Content-Type": "application/json" },
  //       body: JSON.stringify({
  //         user_id: userId,
  //         agent_run_id: autopilot.agent_run_id,
  //         start_in_minutes: startInMinutes,
  //       }),
  //     });

  //     if (!res.ok) {
  //       // If you haven't added the commit endpoint yet, you’ll see an error here.
  //       throw new Error(await res.text());
  //     }

  //     const data = await res.json();
  //     setAutopilot((prev) =>
  //       prev
  //         ? {
  //             ...prev,
  //             calendar_events: data.calendar_events ?? prev.calendar_events ?? [],
  //             calendar_error: data.calendar_error ?? null,
  //           }
  //         : prev
  //     );

  //     setToast("✅ Added to Google Calendar");
  //   } catch (e: any) {
  //     setMsg(
  //       e?.message ??
  //         "Calendar commit failed. Ensure backend has POST /api/calendar/commit_autopilot."
  //     );
  //   } finally {
  //     setCommittingCalendar(false);
  //   }
  // }

  // ✅ Commit Daily schedule to calendar AFTER user accepts it
  async function commitDailyToCalendar() {
    if (!userId || !dailyAutopilot?.daily_run_id) return;
  
    setCommittingCalendar(true);
    setMsg(null);
  
    try {
      const res = await fetch(`${base}/api/daily/commit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: userId,
          daily_run_id: dailyAutopilot.daily_run_id,
          start_in_minutes: startInMinutes,
        }),
      });
  
      if (!res.ok) throw new Error(await res.text());
  
      const data = (await res.json()) as DailyAutopilotResult;
  
      // backend returns updated schedule + calendar_events
      setDailyAutopilot(data);
  
      setToast("✅ Daily schedule added to Google Calendar");
    } catch (e: any) {
      setMsg(e?.message ?? String(e));
    } finally {
      setCommittingCalendar(false);
    }
  }
  


  const dailyChecklistStats = useMemo(() => {
    const items = dailyAutopilot?.items ?? [];
    if (!items.length) return { done: 0, total: 0 };
    const done = items.reduce((acc, it) => acc + (checkedItemIds[it.item_id] ? 1 : 0), 0);
    return { done, total: items.length };
  }, [dailyAutopilot?.items, checkedItemIds]);

  return (
    <main className="p-8 max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">commitAI</h1>
          <p className="mt-1 text-sm text-gray-600">Signed in as {email ?? "…"}</p>
        </div>

        <button className="underline text-sm" onClick={signOut}>
          Sign out
        </button>
      </div>

      {msg && <p className="mt-4 text-sm text-red-700">{msg}</p>}

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

            <button className="border rounded px-3 py-2 text-sm" disabled={savingGoal} type="submit">
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
          <p className="mt-3 text-sm text-gray-600">No goals yet. Create your first goal above.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {goals.map((g) => (
              <li key={g.id} className="border rounded p-3">
                <div className="font-medium">{g.title}</div>
                <div className="text-sm text-gray-600">Cadence/day: {g.cadence_per_day}</div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-8 border rounded p-4">
        <h2 className="font-semibold">Today’s check-in</h2>

        {!selectedGoal ? (
          <p className="mt-2 text-sm text-gray-600">Create a goal first to start checking in.</p>
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
                <input type="checkbox" checked={completed} onChange={(e) => setCompleted(e.target.checked)} />
                Mark goal completed today
              </label>
            </div>

            {/* ✅ Calendar start offset (used when you click "Add to Calendar" AFTER preview) */}
            <label className="text-sm mt-3 block">
              Calendar start offset (minutes)
              <input
                className="mt-1 w-32 border rounded px-3 py-2"
                type="number"
                min={0}
                max={180}
                value={startInMinutes}
                onChange={(e) => setStartInMinutes(Number(e.target.value))}
              />
            </label>

            <div className="mt-4 flex gap-2 flex-wrap">
              <button className="border rounded px-3 py-2 text-sm" onClick={saveTodayCheckin} disabled={savingCheckin}>
                {savingCheckin ? "Saving…" : "Save today’s check-in"}
              </button>

              <button
                    className="mt-3 border rounded px-3 py-2 text-sm"
                    onClick={runAutopilotAllGoals}
                    disabled={runningAutopilot}
                  >
                    {runningAutopilot ? "Running Autopilot…" : "Run Autopilot (All Goals)"}
                  </button>

            </div>

            {/* ✅ Single-goal autopilot card: preview → accept → commit to calendar
            {autopilot && (
              <div className="mt-4 border rounded p-4">
                <div className="flex items-center justify-between">
                  <div className="font-semibold">Autopilot Plan (Preview)</div>
                  <div className="text-sm text-gray-600">{autopilot.total_minutes} min</div>
                </div>

                <p className="mt-1 text-sm text-gray-700">
                  <span className="font-medium">{autopilot.selected_agent}</span> · {autopilot.state}
                </p>

                <p className="mt-2 text-sm text-gray-600">{autopilot.summary}</p>

                <ol className="mt-3 space-y-2 list-decimal list-inside">
                  {autopilot.steps.map((s, idx) => (
                    <li key={idx} className="border rounded p-3">
                      <div className="font-medium">
                        {s.title} <span className="text-sm text-gray-600">({s.minutes}m)</span>
                      </div>
                      <div className="text-sm mt-1">{s.details}</div>
                    </li>
                  ))}
                </ol>

                <div className="mt-4 flex gap-2 flex-wrap">
                  <button
                    type="button"
                    className="border rounded px-3 py-2 text-sm"
                    disabled={committingCalendar}
                    onClick={commitAutopilotToCalendar}
                  >
                    {committingCalendar ? "Adding…" : "✅ Add this plan to Google Calendar"}
                  </button>

                  <button
                    type="button"
                    className="border rounded px-3 py-2 text-sm"
                    onClick={() => setShowPlanFeedback((v) => !v)}
                  >
                    {showPlanFeedback ? "Hide feedback" : "👎 I want changes"}
                  </button>

                  <button
                    type="button"
                    className="border rounded px-3 py-2 text-sm"
                    onClick={async () => {
                      try {
                        await submitFeedback({
                          agent_run_id: autopilot.agent_run_id,
                          opik_trace_id: autopilot.opik_trace_id,
                          helpful: true,
                          comment: null,
                        });
                        setToast("✅ Feedback saved (helpful)");
                      } catch (e: any) {
                        setMsg(e?.message ?? String(e));
                      }
                    }}
                  >
                    👍 Helpful
                  </button>
                </div>

                {showPlanFeedback && (
                  <div className="mt-3 space-y-2">
                    <textarea
                      className="w-full border rounded px-3 py-2 text-sm"
                      rows={3}
                      placeholder="What should change? e.g., ‘too long’, ‘include water reminders’, ‘make first step unblock me’, ‘move focus to afternoon’…"
                      value={planFeedbackText}
                      onChange={(e) => setPlanFeedbackText(e.target.value)}
                    />
                    <div className="flex gap-2 flex-wrap">
                      <button
                        type="button"
                        className="border rounded px-3 py-2 text-sm"
                        onClick={async () => {
                          try {
                            await submitFeedback({
                              agent_run_id: autopilot.agent_run_id,
                              opik_trace_id: autopilot.opik_trace_id,
                              helpful: false,
                              comment: planFeedbackText.trim() ? planFeedbackText.trim() : "Needs changes",
                            });
                            setToast("✅ Feedback saved (needs changes)");
                            setShowPlanFeedback(false);
                            setPlanFeedbackText("");
                            // ✅ re-run so “agents negotiate again”
                            await runAutopilotAllGoals();
                          } catch (e: any) {
                            setMsg(e?.message ?? String(e));
                          }
                        }}
                      >
                        Save feedback + regenerate plan
                      </button>
                      <button
                        type="button"
                        className="border rounded px-3 py-2 text-sm"
                        onClick={() => {
                          setShowPlanFeedback(false);
                          setPlanFeedbackText("");
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {autopilot.calendar_error && (
                  <p className="mt-3 text-sm text-red-600">Calendar error: {autopilot.calendar_error}</p>
                )}

                {(autopilot.calendar_events?.length ?? 0) > 0 && (
                  <div className="mt-3 text-sm">
                    <div className="font-medium">Calendar events created:</div>
                    <ul className="list-disc list-inside">
                      {autopilot.calendar_events!.map((e, i) => (
                        <li key={i}>
                          {e.step_title} —{" "}
                          {e.htmlLink ? (
                            <a className="underline" href={e.htmlLink} target="_blank" rel="noreferrer">
                              open
                            </a>
                          ) : (
                            e.event_id ?? "created"
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <p className="mt-3 text-xs text-gray-600">agent_run_id: {autopilot.agent_run_id}</p>
                {autopilot.opik_trace_id && (
                  <p className="mt-1 text-xs text-gray-600">opik_trace_id: {autopilot.opik_trace_id}</p>
                )}
              </div>
            )} */}

            {/* Daily autopilot card: checklist + schedule preview → accept → commit to calendar */}
            {dailyAutopilot && (
              <div className="mt-4 border rounded p-4">
                <div className="flex items-center justify-between">
                  <div className="font-semibold">Autopilot Plan (for all your current goals)</div>
                  <div className="text-sm text-gray-600">{dailyChecklistStats.done}/{dailyChecklistStats.total} done</div>
                </div>

                <p className="mt-2 text-sm text-gray-600">{dailyAutopilot.summary}</p>

                <div className="mt-3 flex gap-2 flex-wrap">
                  <button
                    type="button"
                    className="border rounded px-3 py-2 text-sm"
                    disabled={committingCalendar}
                    onClick={commitDailyToCalendar}
                  >
                    {committingCalendar ? "Adding…" : "✅ Add daily schedule to Google Calendar"}
                  </button>
                </div>

                {/* ✅ Checklist */}
                {(dailyAutopilot.items?.length ?? 0) > 0 && (
                  <>
                    <div className="mt-4 font-medium text-sm">Checklist for today</div>
                    <ul className="mt-2 space-y-2">
                      {dailyAutopilot.items.map((it) => {
                        const checked = !!checkedItemIds[it.item_id];
                        return (
                          <li key={it.item_id} className="border rounded p-3">
                            <label className="flex items-start gap-3 cursor-pointer">
                              <input
                                type="checkbox"
                                className="mt-1"
                                checked={checked}
                                onChange={() => toggleItemChecked(it.item_id)}
                              />
                              <div className="flex-1">
                                <div className={`font-medium ${checked ? "line-through text-gray-500" : ""}`}>
                                  {it.title}
                                  <span className="ml-2 text-xs text-gray-600">
                                    {it.window ? it.window : ""}
                                    {it.minutes ? ` · ${it.minutes}m` : ""}
                                  </span>
                                </div>

                                {(it.goal_ids?.length ?? 0) > 0 && (
                                  <div className="text-xs text-gray-600 mt-1">
                                    Goals: {it.goal_ids.map((gid) => goalTitleById.get(gid) ?? gid).join(", ")}
                                  </div>
                                )}

                                {it.details && <div className={`text-sm mt-1 ${checked ? "text-gray-500" : ""}`}>{it.details}</div>}

                                <div className="text-xs text-gray-500 mt-1">
                                  kind: {it.kind}
                                  {it.occurrences ? ` · occurrences: ${it.occurrences}` : ""}
                                  {it.min_gap_minutes ? ` · min gap: ${it.min_gap_minutes}m` : ""}
                                </div>
                              </div>
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}

                {/* ✅ Suggested schedule */}
                {(dailyAutopilot.schedule?.length ?? 0) > 0 && (
                  <>
                    <div className="mt-4 font-medium text-sm">Suggested schedule</div>
                    <ol className="mt-2 space-y-2">
                      {dailyAutopilot.schedule.map((b, i) => (
                        <li key={i} className="border rounded p-3">
                          <div className="font-medium">
                            {b.title}{" "}
                            <span className="text-xs text-gray-600">
                              (
                              {new Date(b.start).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} -{" "}
                              {new Date(b.end).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })})
                            </span>
                          </div>
                          <div className="text-sm mt-1">{b.details}</div>
                          <div className="text-xs text-gray-600 mt-1">
                            kind: {b.kind} · goals: {(b.goal_ids?.length ?? 0).toString()}
                          </div>
                        </li>
                      ))}
                    </ol>
                  </>
                )}

                {dailyAutopilot.calendar_error && (
                  <p className="mt-3 text-sm text-red-600">Calendar error: {dailyAutopilot.calendar_error}</p>
                )}

                {(dailyAutopilot.calendar_events?.length ?? 0) > 0 && (
                  <div className="mt-3 text-sm">
                    <div className="font-medium">Calendar events created:</div>
                    <ul className="list-disc list-inside">
                      {dailyAutopilot.calendar_events!.map((e, i) => (
                        <li key={i}>
                          {e.step_title} —{" "}
                          {e.htmlLink ? (
                            <a className="underline" href={e.htmlLink} target="_blank" rel="noreferrer">
                              open
                            </a>
                          ) : (
                            e.event_id ?? "created"
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

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
                        <div className="text-sm">{c.completed ? "✅ Completed" : "⬜ Not completed"}</div>
                      </div>
                      <div className="text-sm text-gray-600 mt-1">
                        Energy: {c.energy} · Workload: {c.workload}
                      </div>
                      {c.blockers && <div className="text-sm mt-1">Blockers: {c.blockers}</div>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </section>

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
                  <div className="font-medium">
                    {r.selected_agent} · {r.state}
                  </div>
                  <div className="text-xs text-gray-600">{new Date(r.created_at).toLocaleString()}</div>
                </div>

                <div className="text-sm text-gray-700 mt-1">{r.summary}</div>

                <div className="text-xs text-gray-600 mt-2 flex gap-3 flex-wrap">
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
