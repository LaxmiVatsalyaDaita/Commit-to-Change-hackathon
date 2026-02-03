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

type CalendarEvent = {
  step_title: string;
  event_id?: string | null;
  htmlLink?: string | null;
  start?: string;
  end?: string;
};

type DailyPlanItem = {
  item_id: string;
  title: string;
  minutes: number;
  details: string;
  goal_ids: string[];
  kind: string; // "focus" | "habit"
  window: string; // "morning" | ...
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
  event_id?: string | null;
  htmlLink?: string | null;
};

type DailyAutopilotResult = {
  found?: boolean;
  daily_run_id?: string;
  summary: string;
  items: DailyPlanItem[];
  schedule: ScheduledBlock[];
  status?: "DRAFT" | "COMMITTED" | string;
  version?: number;
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

type CalendarStatus = {
  connected: boolean;
  calendar_id?: string | null;
  expires_at?: string | null;
};

function Pill({
  active,
  children,
  onClick,
}: {
  active?: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "px-3 py-1.5 rounded-full text-sm border",
        active ? "bg-black text-white border-black" : "bg-white text-gray-700 hover:bg-gray-50",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function SectionCard({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="mt-6 border rounded-xl p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-semibold">{title}</h2>
          {subtitle && <p className="mt-1 text-sm text-gray-600">{subtitle}</p>}
        </div>
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function CalendarIntegration({ userId }: { userId: string }) {
  const [status, setStatus] = useState<CalendarStatus | null>(null);
  const [loading, setLoading] = useState(false);

  const base = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:8000";

  async function refreshStatus() {
    setLoading(true);
    try {
      const r = await fetch(`${base}/api/integrations/google/status?user_id=${encodeURIComponent(userId)}`, {
        cache: "no-store",
      });
      const j = await r.json();
      setStatus(j);
    } finally {
      setLoading(false);
    }
  }

  async function connectGoogle() {
    const r = await fetch(`${base}/api/integrations/google/start?user_id=${encodeURIComponent(userId)}`, {
      cache: "no-store",
    });
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
        {status?.connected ? (
          <span className="text-green-700 font-medium">Connected</span>
        ) : status ? (
          <span className="text-red-700 font-medium">Not connected</span>
        ) : (
          "…"
        )}
      </div>

      {status?.connected && (
        <div className="text-xs text-gray-600">
          calendar_id: {status.calendar_id ?? "primary"} · expires_at: {status.expires_at ?? "—"}
        </div>
      )}

      <div className="flex gap-2 flex-wrap">
        {!status?.connected && (
          <button className="border rounded px-3 py-2 text-sm" onClick={connectGoogle} disabled={loading}>
            {loading ? "Opening…" : "Connect Google Calendar"}
          </button>
        )}
        <button className="border rounded px-3 py-2 text-sm" onClick={refreshStatus} disabled={loading}>
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

  const [tab, setTab] = useState<"today" | "goals" | "calendar" | "activity">("today");

  // Goals
  const [goals, setGoals] = useState<Goal[]>([]);
  const [loadingGoals, setLoadingGoals] = useState(true);
  const [title, setTitle] = useState("");
  const [cadence, setCadence] = useState<number>(1);
  const [savingGoal, setSavingGoal] = useState(false);

  // Daily check-in inputs (applies to ALL goals)
  const [energy, setEnergy] = useState(3);
  const [workload, setWorkload] = useState(3);
  const [blockers, setBlockers] = useState("");

  // Planning state
  const [dailyAutopilot, setDailyAutopilot] = useState<DailyAutopilotResult | null>(null);
  const [runningAutopilot, setRunningAutopilot] = useState(false);
  const [committingCalendar, setCommittingCalendar] = useState(false);

  // Checklist state (DB-backed)
  const [checkedItemIds, setCheckedItemIds] = useState<Record<string, boolean>>({});

  // Calendar start offset
  const [startInMinutes, setStartInMinutes] = useState(5);

  // Activity
  const [recentRuns, setRecentRuns] = useState<RunRow[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(false);

  // Messaging
  const [msg, setMsg] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const goalTitleById = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of goals) m.set(g.id, g.title);
    return m;
  }, [goals]);

  const dailyChecklistStats = useMemo(() => {
    const items = dailyAutopilot?.items ?? [];
    if (!items.length) return { done: 0, total: 0 };
    const done = items.reduce((acc, it) => acc + (checkedItemIds[it.item_id] ? 1 : 0), 0);
    return { done, total: items.length };
  }, [dailyAutopilot?.items, checkedItemIds]);

  // session gate
  useEffect(() => {
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

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(t);
  }, [toast]);

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
    setToast("✅ Goal created");
  }

  async function loadRecentRuns() {
    if (!userId) return;
    setLoadingRuns(true);
    try {
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

  async function loadTodayDailyRun() {
    if (!userId) return;
    try {
      const res = await fetch(
        `${base}/api/daily/today?user_id=${encodeURIComponent(userId)}&tz_name=${encodeURIComponent(tzName)}`,
        { cache: "no-store" }
      );
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      if (data?.found) {
        setDailyAutopilot(data);
        setToast("✅ Loaded today’s plan");
      }
    } catch {
      // silent: no plan yet is normal
    }
  }

  async function loadDailyTaskStatuses(dailyRunId: string) {
    if (!userId) return;

    const res = await fetch(
      `${base}/api/daily/tasks?user_id=${encodeURIComponent(userId)}&daily_run_id=${encodeURIComponent(dailyRunId)}`,
      { cache: "no-store" }
    );
    if (!res.ok) throw new Error(await res.text());

    const data = await res.json();
    const map: Record<string, boolean> = {};
    for (const t of data.tasks ?? []) {
      map[t.item_id] = !!t.completed;
    }
    setCheckedItemIds(map);
  }

  useEffect(() => {
    if (userId) {
      loadGoals();
      loadRecentRuns();
      loadTodayDailyRun();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  useEffect(() => {
    if (dailyAutopilot?.daily_run_id) {
      loadDailyTaskStatuses(dailyAutopilot.daily_run_id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dailyAutopilot?.daily_run_id]);

  async function toggleItemChecked(itemId: string) {
    if (!dailyAutopilot?.daily_run_id || !userId) return;

    const nextCompleted = !checkedItemIds[itemId];
    setCheckedItemIds((prev) => ({ ...prev, [itemId]: nextCompleted }));

    try {
      const res = await fetch(`${base}/api/daily/task/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: userId,
          daily_run_id: dailyAutopilot.daily_run_id,
          item_id: itemId,
          completed: nextCompleted,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
    } catch (e: any) {
      setCheckedItemIds((prev) => ({ ...prev, [itemId]: !nextCompleted }));
      setMsg(e?.message ?? String(e));
    }
  }

  async function runAutopilotAllGoals() {
    if (!userId) return;
    if (!goals.length) {
      setMsg("Create at least 1 goal first.");
      return;
    }

    setRunningAutopilot(true);
    setMsg(null);

    try {
      const body = {
        user_id: userId,
        energy,
        workload,
        blockers: blockers.trim() ? blockers.trim() : null,
        start_in_minutes: startInMinutes,
        goal_ids: goals.map((g) => g.id),
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
      setToast("✅ Draft plan created");
      await loadRecentRuns();
      setTab("today");
    } catch (e: any) {
      setMsg(e?.message ?? String(e));
    } finally {
      setRunningAutopilot(false);
    }
  }

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
          tz_name: tzName,
        }),
      });

      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as DailyAutopilotResult;

      setDailyAutopilot(data);
      setToast("✅ Added to Google Calendar");
    } catch (e: any) {
      setMsg(e?.message ?? String(e));
    } finally {
      setCommittingCalendar(false);
    }
  }

  async function checkinAndReschedule() {
    if (!userId || !dailyAutopilot?.daily_run_id) return;

    setRunningAutopilot(true);
    setMsg(null);

    try {
      const completed_item_ids = Object.keys(checkedItemIds).filter((k) => checkedItemIds[k]);

      const res = await fetch(`${base}/api/daily/checkin_reschedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: userId,
          daily_run_id: dailyAutopilot.daily_run_id,
          energy,
          workload,
          blockers: blockers.trim() ? blockers.trim() : null,
          completed_item_ids,
          tz_name: tzName,
          start_in_minutes: 0,
        }),
      });

      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as DailyAutopilotResult;

      setDailyAutopilot(data);
      setToast("✅ Plan updated for the rest of today");
    } catch (e: any) {
      setMsg(e?.message ?? String(e));
    } finally {
      setRunningAutopilot(false);
    }
  }

  const planStatusLabel = useMemo(() => {
    const s = dailyAutopilot?.status ?? (dailyAutopilot?.found ? "DRAFT" : "");
    if (!s) return "";
    const v = dailyAutopilot?.version ? ` · v${dailyAutopilot.version}` : "";
    return `${s}${v}`;
  }, [dailyAutopilot?.status, dailyAutopilot?.version, dailyAutopilot?.found]);

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

      <div className="mt-6 flex gap-2 flex-wrap">
        <Pill active={tab === "today"} onClick={() => setTab("today")}>
          Today
        </Pill>
        <Pill active={tab === "goals"} onClick={() => setTab("goals")}>
          Goals
        </Pill>
        <Pill active={tab === "calendar"} onClick={() => setTab("calendar")}>
          Calendar
        </Pill>
        <Pill active={tab === "activity"} onClick={() => setTab("activity")}>
          Activity
        </Pill>
      </div>

      {msg && <p className="mt-4 text-sm text-red-700">{msg}</p>}

      {/* TODAY TAB */}
      {tab === "today" && (
        <>
          <SectionCard
            title="Daily check-in"
            subtitle="These inputs affect planning for ALL your goals. You can update them anytime and reschedule."
          >
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <label className="text-sm">
                Energy
                <select
                  className="mt-1 w-full border rounded px-3 py-2"
                  value={energy}
                  onChange={(e) => setEnergy(Number(e.target.value))}
                >
                  <option value={1}>1 — exhausted</option>
                  <option value={2}>2 — low</option>
                  <option value={3}>3 — okay</option>
                  <option value={4}>4 — good</option>
                  <option value={5}>5 — high</option>
                </select>
              </label>

              <label className="text-sm">
                Workload
                <select
                  className="mt-1 w-full border rounded px-3 py-2"
                  value={workload}
                  onChange={(e) => setWorkload(Number(e.target.value))}
                >
                  <option value={1}>1 — light</option>
                  <option value={2}>2 — manageable</option>
                  <option value={3}>3 — normal</option>
                  <option value={4}>4 — heavy</option>
                  <option value={5}>5 — overloaded</option>
                </select>
              </label>

              <label className="text-sm md:col-span-2">
                Blockers (optional)
                <textarea
                  className="mt-1 w-full border rounded px-3 py-2"
                  rows={3}
                  placeholder="What might stop you today? e.g., meeting overload, unclear next step, low focus…"
                  value={blockers}
                  onChange={(e) => setBlockers(e.target.value)}
                />
              </label>
            </div>

            <div className="mt-4 flex gap-2 flex-wrap">
              <button
                className="border rounded px-3 py-2 text-sm"
                onClick={runAutopilotAllGoals}
                disabled={runningAutopilot}
              >
                {runningAutopilot ? "Creating plan…" : "✨ Create today’s plan"}
              </button>

              <button
                className="border rounded px-3 py-2 text-sm"
                onClick={checkinAndReschedule}
                disabled={runningAutopilot || !dailyAutopilot?.daily_run_id}
                title={!dailyAutopilot?.daily_run_id ? "Create a plan first" : ""}
              >
                {runningAutopilot ? "Updating…" : "🔁 Update plan for the rest of today"}
              </button>

              <button
                className="border rounded px-3 py-2 text-sm"
                onClick={loadTodayDailyRun}
                disabled={!userId}
              >
                Load today’s saved plan
              </button>
            </div>

            <p className="mt-3 text-xs text-gray-600">
              Creating a plan is a <span className="font-medium">preview</span>. Calendar changes only happen when you
              click <span className="font-medium">Add to Google Calendar</span>.
            </p>
          </SectionCard>

          {dailyAutopilot && (
            <SectionCard
              title={`Today’s plan ${planStatusLabel ? `· ${planStatusLabel}` : ""}`}
              subtitle={dailyAutopilot.summary || "—"}
            >
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="text-sm text-gray-600">
                  Checklist:{" "}
                  <span className="font-medium">
                    {dailyChecklistStats.done}/{dailyChecklistStats.total}
                  </span>{" "}
                  done
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                  <label className="text-sm flex items-center gap-2">
                    Start after
                    <select
                      className="border rounded px-2 py-1 text-sm"
                      value={startInMinutes}
                      onChange={(e) => setStartInMinutes(Number(e.target.value))}
                    >
                      <option value={0}>0m</option>
                      <option value={5}>5m</option>
                      <option value={10}>10m</option>
                      <option value={15}>15m</option>
                      <option value={30}>30m</option>
                      <option value={60}>60m</option>
                    </select>
                  </label>

                  <button
                    type="button"
                    className="border rounded px-3 py-2 text-sm"
                    disabled={committingCalendar || !dailyAutopilot?.daily_run_id}
                    onClick={commitDailyToCalendar}
                  >
                    {committingCalendar ? "Adding…" : "✅ Add to Google Calendar"}
                  </button>
                </div>
              </div>

              {/* Checklist */}
              {(dailyAutopilot.items?.length ?? 0) > 0 && (
                <>
                  <div className="mt-4 font-medium text-sm">Checklist</div>
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
                                  {it.window ? it.window : ""} {it.minutes ? `· ${it.minutes}m` : ""}
                                </span>
                              </div>

                              {(it.goal_ids?.length ?? 0) > 0 && (
                                <div className="text-xs text-gray-600 mt-1">
                                  Goals: {it.goal_ids.map((gid) => goalTitleById.get(gid) ?? gid).join(", ")}
                                </div>
                              )}

                              {it.details && (
                                <div className={`text-sm mt-1 ${checked ? "text-gray-500" : ""}`}>{it.details}</div>
                              )}
                            </div>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}

              {/* Schedule preview */}
              {(dailyAutopilot.schedule?.length ?? 0) > 0 && (
                <>
                  <div className="mt-5 font-medium text-sm">Suggested timeline (preview)</div>
                  <ol className="mt-2 space-y-2">
                    {dailyAutopilot.schedule.map((b, i) => (
                      <li key={i} className="border rounded p-3">
                        <div className="font-medium">
                          {b.title}{" "}
                          <span className="text-xs text-gray-600">
                            (
                            {new Date(b.start).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} –{" "}
                            {new Date(b.end).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })})
                          </span>
                        </div>
                        <div className="text-sm mt-1">{b.details}</div>
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
            </SectionCard>
          )}
        </>
      )}

      {/* GOALS TAB */}
      {tab === "goals" && (
        <>
          <SectionCard title="Create a goal" subtitle="Keep goals short and clear. Cadence is how many times/day.">
            <form onSubmit={createGoal} className="space-y-3">
              <input
                className="w-full border rounded px-3 py-2"
                placeholder='e.g., "Study LLM theory" or "Drink 2L water"'
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />

              <div className="flex items-center gap-3 flex-wrap">
                <label className="text-sm text-gray-700 flex items-center gap-2">
                  Cadence/day
                  <input
                    className="w-20 border rounded px-2 py-1"
                    type="number"
                    min={1}
                    max={10}
                    value={cadence}
                    onChange={(e) => setCadence(Number(e.target.value))}
                  />
                </label>

                <button className="border rounded px-3 py-2 text-sm" disabled={savingGoal} type="submit">
                  {savingGoal ? "Creating…" : "Create goal"}
                </button>

                <button type="button" className="underline text-sm" onClick={loadGoals}>
                  Refresh
                </button>
              </div>
            </form>
          </SectionCard>

          <SectionCard title="Your goals" subtitle="These are the goals that will be included in today’s plan.">
            {loadingGoals ? (
              <p className="text-sm text-gray-600">Loading…</p>
            ) : goals.length === 0 ? (
              <p className="text-sm text-gray-600">No goals yet. Create one above.</p>
            ) : (
              <ul className="space-y-2">
                {goals.map((g) => (
                  <li key={g.id} className="border rounded p-3">
                    <div className="font-medium">{g.title}</div>
                    <div className="text-sm text-gray-600">Cadence/day: {g.cadence_per_day}</div>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </>
      )}

      {/* CALENDAR TAB */}
      {tab === "calendar" && (
        <SectionCard title="Calendar integration" subtitle="CommitAI only creates events when you commit a plan.">
          {!userId ? <p className="text-sm text-gray-600">Loading user…</p> : <CalendarIntegration userId={userId} />}
        </SectionCard>
      )}

      {/* ACTIVITY TAB */}
      {tab === "activity" && (
        <SectionCard title="Recent agent runs" subtitle="Debug feed. Safe to ignore for normal usage.">
          <div className="flex items-center justify-between mb-3">
            <button className="underline text-sm" onClick={loadRecentRuns}>
              Refresh
            </button>
          </div>

          {loadingRuns ? (
            <p className="text-sm text-gray-600">Loading…</p>
          ) : recentRuns.length === 0 ? (
            <p className="text-sm text-gray-600">No runs yet.</p>
          ) : (
            <ul className="space-y-2">
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
        </SectionCard>
      )}

      {toast && (
        <div className="fixed bottom-4 right-4 z-50 border rounded px-4 py-2 text-sm bg-white shadow">
          {toast}
        </div>
      )}
    </main>
  );
}