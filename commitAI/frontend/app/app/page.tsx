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
        "px-5 py-2.5 rounded-full text-sm font-medium transition-all duration-200",
        "hover:scale-105 active:scale-95",
        active
          ? "bg-gradient-to-r from-violet-600 to-indigo-600 text-white shadow-lg shadow-violet-500/30"
          : "bg-white/80 backdrop-blur-sm text-gray-700 hover:bg-white border border-gray-200 hover:border-gray-300 shadow-sm",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function SectionCard({ title, subtitle, children, icon }: { title: string; subtitle?: string; children: React.ReactNode; icon?: string }) {
  return (
    <section className="mt-8 bg-white/80 backdrop-blur-sm border border-gray-200 rounded-2xl p-6 shadow-xl shadow-gray-200/50 hover:shadow-2xl hover:shadow-gray-300/50 transition-all duration-300">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          {icon && <span className="text-3xl">{icon}</span>}
          <div>
            <h2 className="text-xl font-bold bg-gradient-to-r from-gray-800 to-gray-600 bg-clip-text text-transparent">{title}</h2>
            {subtitle && <p className="mt-1.5 text-sm text-gray-600 leading-relaxed">{subtitle}</p>}
          </div>
        </div>
      </div>
      <div className="mt-6">{children}</div>
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
    <div className="space-y-4">
      <div className="flex items-center gap-3 p-4 bg-gradient-to-r from-gray-50 to-gray-100 rounded-xl border border-gray-200">
        <div className="text-2xl">📅</div>
        <div className="flex-1">
          <div className="font-medium text-gray-900">Google Calendar</div>
          <div className="text-sm mt-0.5">
            {status?.connected ? (
              <span className="inline-flex items-center gap-1.5 text-emerald-700 font-medium">
                <span className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></span>
                Connected
              </span>
            ) : status ? (
              <span className="text-amber-700 font-medium">Not connected</span>
            ) : (
              <span className="text-gray-500">Loading…</span>
            )}
          </div>
        </div>
      </div>

      {status?.connected && (
        <div className="text-xs text-gray-600 bg-gray-50 p-3 rounded-lg border border-gray-200">
          <div className="font-mono">calendar_id: {status.calendar_id ?? "primary"}</div>
          <div className="font-mono mt-1">expires_at: {status.expires_at ?? "—"}</div>
        </div>
      )}

      <div className="flex gap-3 flex-wrap">
        {!status?.connected && (
          <button
            className="flex-1 min-w-[200px] bg-gradient-to-r from-blue-600 to-indigo-600 text-white rounded-xl px-4 py-3 text-sm font-medium hover:from-blue-700 hover:to-indigo-700 transition-all duration-200 shadow-lg shadow-blue-500/30 hover:shadow-xl hover:shadow-blue-500/40 disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={connectGoogle}
            disabled={loading}
          >
            {loading ? "Opening…" : "🔗 Connect Google Calendar"}
          </button>
        )}
        <button
          className="border-2 border-gray-300 rounded-xl px-4 py-3 text-sm font-medium hover:bg-gray-50 transition-all duration-200 disabled:opacity-50"
          onClick={refreshStatus}
          disabled={loading}
        >
          {loading ? "Refreshing…" : "🔄 Refresh"}
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

  const [goals, setGoals] = useState<Goal[]>([]);
  const [loadingGoals, setLoadingGoals] = useState(true);
  const [title, setTitle] = useState("");
  const [cadence, setCadence] = useState<number>(1);
  const [savingGoal, setSavingGoal] = useState(false);

  const [energy, setEnergy] = useState(3);
  const [workload, setWorkload] = useState(3);
  const [blockers, setBlockers] = useState("");

  const [dailyAutopilot, setDailyAutopilot] = useState<DailyAutopilotResult | null>(null);
  const [runningAutopilot, setRunningAutopilot] = useState(false);
  const [committingCalendar, setCommittingCalendar] = useState(false);

  const [checkedItemIds, setCheckedItemIds] = useState<Record<string, boolean>>({});

  const [startInMinutes, setStartInMinutes] = useState(5);

  const [recentRuns, setRecentRuns] = useState<RunRow[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(false);

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
    const t = setTimeout(() => setToast(null), 3000);
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
    setToast("✅ Goal created successfully");
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
        setToast("✅ Loaded today's plan");
      }
    } catch {
      // silent
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

  const progressPercentage = dailyChecklistStats.total > 0 
    ? Math.round((dailyChecklistStats.done / dailyChecklistStats.total) * 100) 
    : 0;

  return (
    <main className="min-h-screen bg-gradient-to-br from-violet-50 via-purple-50 to-indigo-100 relative overflow-hidden">
      {/* Animated background elements */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-20 -left-20 w-96 h-96 bg-violet-300/20 rounded-full blur-3xl animate-pulse"></div>
        <div className="absolute bottom-20 -right-20 w-96 h-96 bg-indigo-300/20 rounded-full blur-3xl animate-pulse" style={{ animationDelay: '1s' }}></div>
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 h-96 bg-purple-300/20 rounded-full blur-3xl animate-pulse" style={{ animationDelay: '2s' }}></div>
      </div>

      <div className="relative z-10 p-6 md:p-8 max-w-5xl mx-auto">
        {/* Header */}
        <div className="bg-white/80 backdrop-blur-md border border-gray-200 rounded-2xl p-6 shadow-xl shadow-gray-200/50 mb-8">
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div className="flex items-center gap-4">
              <div className="w-14 h-14 bg-gradient-to-br from-violet-600 to-indigo-600 rounded-2xl flex items-center justify-center text-3xl shadow-lg shadow-violet-500/30">
                🎯
              </div>
              <div>
                <h1 className="text-3xl font-bold bg-gradient-to-r from-violet-600 to-indigo-600 bg-clip-text text-transparent">
                  commitAI
                </h1>
                <p className="mt-1 text-sm text-gray-600 flex items-center gap-2">
                  <span className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></span>
                  {email ?? "Loading…"}
                </p>
              </div>
            </div>

            <button
              className="px-4 py-2 text-sm font-medium text-gray-700 hover:text-gray-900 hover:bg-gray-100 rounded-xl transition-all duration-200 border border-gray-200"
              onClick={signOut}
            >
              Sign out →
            </button>
          </div>
        </div>

        {/* Navigation */}
        <div className="flex gap-3 flex-wrap mb-8">
          <Pill active={tab === "today"} onClick={() => setTab("today")}>
            🌅 Today
          </Pill>
          <Pill active={tab === "goals"} onClick={() => setTab("goals")}>
            🎯 Goals
          </Pill>
          <Pill active={tab === "calendar"} onClick={() => setTab("calendar")}>
            📅 Calendar
          </Pill>
          <Pill active={tab === "activity"} onClick={() => setTab("activity")}>
            📊 Activity
          </Pill>
        </div>

        {/* Error messages */}
        {msg && (
          <div className="mb-6 p-4 bg-red-50 border-2 border-red-200 rounded-xl text-red-800 text-sm font-medium flex items-start gap-3 animate-in slide-in-from-top-2">
            <span className="text-xl">⚠️</span>
            <span className="flex-1">{msg}</span>
            <button onClick={() => setMsg(null)} className="text-red-600 hover:text-red-800">✕</button>
          </div>
        )}

        {/* TODAY TAB */}
        {tab === "today" && (
          <>
            <SectionCard
              title="Daily Check-in"
              subtitle="How are you feeling today? This helps AI create a realistic plan for you."
              icon="💭"
            >
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <label className="block">
                  <div className="text-sm font-medium text-gray-700 mb-2 flex items-center gap-2">
                    <span>⚡</span> Energy Level
                  </div>
                  <select
                    className="w-full border-2 border-gray-200 rounded-xl px-4 py-3 bg-white focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20 transition-all duration-200 outline-none"
                    value={energy}
                    onChange={(e) => setEnergy(Number(e.target.value))}
                  >
                    <option value={1}>1 — 😴 Exhausted</option>
                    <option value={2}>2 — 😔 Low</option>
                    <option value={3}>3 — 😐 Okay</option>
                    <option value={4}>4 — 😊 Good</option>
                    <option value={5}>5 — 🚀 High</option>
                  </select>
                </label>

                <label className="block">
                  <div className="text-sm font-medium text-gray-700 mb-2 flex items-center gap-2">
                    <span>📋</span> Workload
                  </div>
                  <select
                    className="w-full border-2 border-gray-200 rounded-xl px-4 py-3 bg-white focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20 transition-all duration-200 outline-none"
                    value={workload}
                    onChange={(e) => setWorkload(Number(e.target.value))}
                  >
                    <option value={1}>1 — 🌱 Light</option>
                    <option value={2}>2 — ✅ Manageable</option>
                    <option value={3}>3 — ⚖️ Normal</option>
                    <option value={4}>4 — 📚 Heavy</option>
                    <option value={5}>5 — 🔥 Overloaded</option>
                  </select>
                </label>

                <label className="block md:col-span-2">
                  <div className="text-sm font-medium text-gray-700 mb-2 flex items-center gap-2">
                    <span>🚧</span> Blockers (optional)
                  </div>
                  <textarea
                    className="w-full border-2 border-gray-200 rounded-xl px-4 py-3 bg-white focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20 transition-all duration-200 outline-none resize-none"
                    rows={3}
                    placeholder="What might stop you today? e.g., meeting overload, unclear next step, low focus…"
                    value={blockers}
                    onChange={(e) => setBlockers(e.target.value)}
                  />
                </label>
              </div>

              <div className="mt-6 flex gap-3 flex-wrap">
                <button
                  className="flex-1 min-w-[200px] bg-gradient-to-r from-violet-600 to-indigo-600 text-white rounded-xl px-6 py-3.5 font-medium hover:from-violet-700 hover:to-indigo-700 transition-all duration-200 shadow-lg shadow-violet-500/30 hover:shadow-xl hover:shadow-violet-500/40 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  onClick={runAutopilotAllGoals}
                  disabled={runningAutopilot}
                >
                  {runningAutopilot ? (
                    <>
                      <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                      Creating plan…
                    </>
                  ) : (
                    <>✨ Create today's plan</>
                  )}
                </button>

                <button
                  className="px-6 py-3.5 border-2 border-violet-300 text-violet-700 rounded-xl font-medium hover:bg-violet-50 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                  onClick={checkinAndReschedule}
                  disabled={runningAutopilot || !dailyAutopilot?.daily_run_id}
                  title={!dailyAutopilot?.daily_run_id ? "Create a plan first" : ""}
                >
                  {runningAutopilot ? "Updating…" : "🔁 Update plan"}
                </button>

                <button
                  className="px-6 py-3.5 border-2 border-gray-300 text-gray-700 rounded-xl font-medium hover:bg-gray-50 transition-all duration-200"
                  onClick={loadTodayDailyRun}
                  disabled={!userId}
                >
                  📂 Load saved plan
                </button>
              </div>

              <div className="mt-4 p-3 bg-blue-50 border border-blue-200 rounded-xl text-xs text-blue-800 flex items-start gap-2">
                <span>💡</span>
                <span>Creating a plan is a <strong>preview</strong>. Calendar changes only happen when you click <strong>Add to Google Calendar</strong>.</span>
              </div>
            </SectionCard>

            {dailyAutopilot && (
              <SectionCard
                title={`Today's Plan ${planStatusLabel ? `· ${planStatusLabel}` : ""}`}
                subtitle={dailyAutopilot.summary || "Your personalized daily schedule"}
                icon="📝"
              >
                {/* Progress bar */}
                <div className="mb-6 p-5 bg-gradient-to-r from-violet-50 to-indigo-50 rounded-xl border-2 border-violet-200">
                  <div className="flex items-center justify-between mb-3">
                    <div className="text-sm font-medium text-gray-700">Progress Today</div>
                    <div className="text-2xl font-bold bg-gradient-to-r from-violet-600 to-indigo-600 bg-clip-text text-transparent">
                      {dailyChecklistStats.done}/{dailyChecklistStats.total}
                    </div>
                  </div>
                  <div className="w-full bg-white rounded-full h-3 overflow-hidden shadow-inner">
                    <div
                      className="h-full bg-gradient-to-r from-violet-600 to-indigo-600 transition-all duration-500 ease-out rounded-full"
                      style={{ width: `${progressPercentage}%` }}
                    ></div>
                  </div>
                  <div className="mt-2 text-xs text-gray-600 text-center">{progressPercentage}% Complete</div>
                </div>

                <div className="flex items-center justify-between gap-3 flex-wrap mb-6">
                  <label className="flex items-center gap-3 bg-white border-2 border-gray-200 rounded-xl px-4 py-2.5">
                    <span className="text-sm font-medium text-gray-700">⏰ Start after</span>
                    <select
                      className="border-2 border-gray-200 rounded-lg px-3 py-1.5 text-sm font-medium bg-white focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20 outline-none"
                      value={startInMinutes}
                      onChange={(e) => setStartInMinutes(Number(e.target.value))}
                    >
                      <option value={0}>Now</option>
                      <option value={5}>5 min</option>
                      <option value={10}>10 min</option>
                      <option value={15}>15 min</option>
                      <option value={30}>30 min</option>
                      <option value={60}>1 hour</option>
                    </select>
                  </label>

                  <button
                    type="button"
                    className="bg-gradient-to-r from-emerald-600 to-green-600 text-white rounded-xl px-6 py-2.5 font-medium hover:from-emerald-700 hover:to-green-700 transition-all duration-200 shadow-lg shadow-emerald-500/30 hover:shadow-xl hover:shadow-emerald-500/40 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                    disabled={committingCalendar || !dailyAutopilot?.daily_run_id}
                    onClick={commitDailyToCalendar}
                  >
                    {committingCalendar ? (
                      <>
                        <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                        Adding…
                      </>
                    ) : (
                      <>✅ Add to Google Calendar</>
                    )}
                  </button>
                </div>

                {/* Checklist */}
                {(dailyAutopilot.items?.length ?? 0) > 0 && (
                  <>
                    <div className="mb-3 font-bold text-lg flex items-center gap-2">
                      <span>📋</span> Task Checklist
                    </div>
                    <ul className="space-y-3">
                      {dailyAutopilot.items.map((it) => {
                        const checked = !!checkedItemIds[it.item_id];
                        return (
                          <li
                            key={it.item_id}
                            className={[
                              "border-2 rounded-xl p-4 transition-all duration-300 hover:shadow-md",
                              checked
                                ? "bg-emerald-50 border-emerald-200"
                                : "bg-white border-gray-200 hover:border-violet-300",
                            ].join(" ")}
                          >
                            <label className="flex items-start gap-4 cursor-pointer">
                              <input
                                type="checkbox"
                                className="mt-1.5 w-5 h-5 rounded-md border-2 border-gray-300 text-violet-600 focus:ring-2 focus:ring-violet-500/20 transition-all duration-200 cursor-pointer"
                                checked={checked}
                                onChange={() => toggleItemChecked(it.item_id)}
                              />
                              <div className="flex-1">
                                <div className={`font-semibold text-gray-900 ${checked ? "line-through text-gray-500" : ""}`}>
                                  {it.title}
                                  <span className="ml-3 text-xs font-normal text-gray-500 bg-gray-100 px-2 py-1 rounded-full">
                                    {it.window ? `🕐 ${it.window}` : ""} {it.minutes ? `· ⏱️ ${it.minutes}m` : ""}
                                  </span>
                                </div>

                                {(it.goal_ids?.length ?? 0) > 0 && (
                                  <div className="flex flex-wrap gap-1.5 mt-2">
                                    {it.goal_ids.map((gid) => (
                                      <span
                                        key={gid}
                                        className="inline-flex items-center gap-1 text-xs bg-violet-100 text-violet-700 px-2.5 py-1 rounded-full font-medium"
                                      >
                                        🎯 {goalTitleById.get(gid) ?? gid}
                                      </span>
                                    ))}
                                  </div>
                                )}

                                {it.details && (
                                  <div className={`text-sm mt-2 leading-relaxed ${checked ? "text-gray-500" : "text-gray-700"}`}>
                                    {it.details}
                                  </div>
                                )}
                              </div>
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}

                {/* Schedule timeline */}
                {(dailyAutopilot.schedule?.length ?? 0) > 0 && (
                  <>
                    <div className="mt-8 mb-3 font-bold text-lg flex items-center gap-2">
                      <span>⏰</span> Timeline Preview
                    </div>
                    <ol className="space-y-3 relative pl-6 border-l-4 border-violet-200">
                      {dailyAutopilot.schedule.map((b, i) => (
                        <li key={i} className="relative">
                          <div className="absolute -left-[30px] top-3 w-5 h-5 bg-gradient-to-br from-violet-600 to-indigo-600 rounded-full border-4 border-violet-50 shadow-lg"></div>
                          <div className="bg-white border-2 border-gray-200 rounded-xl p-4 hover:border-violet-300 hover:shadow-md transition-all duration-200">
                            <div className="font-semibold text-gray-900 flex items-center gap-2 flex-wrap">
                              <span>{b.title}</span>
                              <span className="text-xs font-normal bg-gradient-to-r from-violet-100 to-indigo-100 text-violet-700 px-3 py-1 rounded-full">
                                {new Date(b.start).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} –{" "}
                                {new Date(b.end).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                              </span>
                            </div>
                            <div className="text-sm text-gray-600 mt-2 leading-relaxed">{b.details}</div>
                          </div>
                        </li>
                      ))}
                    </ol>
                  </>
                )}

                {dailyAutopilot.calendar_error && (
                  <div className="mt-6 p-4 bg-red-50 border-2 border-red-200 rounded-xl text-red-800 text-sm flex items-start gap-3">
                    <span className="text-xl">⚠️</span>
                    <div>
                      <div className="font-medium">Calendar Error</div>
                      <div className="mt-1">{dailyAutopilot.calendar_error}</div>
                    </div>
                  </div>
                )}

                {(dailyAutopilot.calendar_events?.length ?? 0) > 0 && (
                  <div className="mt-6 p-4 bg-emerald-50 border-2 border-emerald-200 rounded-xl">
                    <div className="font-medium text-emerald-900 mb-2 flex items-center gap-2">
                      <span>✅</span> Calendar Events Created
                    </div>
                    <ul className="space-y-1.5">
                      {dailyAutopilot.calendar_events!.map((e, i) => (
                        <li key={i} className="text-sm text-emerald-800 flex items-center gap-2">
                          <span>📅</span>
                          <span>{e.step_title}</span>
                          {e.htmlLink && (
                            <a
                              className="text-emerald-600 hover:text-emerald-800 underline font-medium"
                              href={e.htmlLink}
                              target="_blank"
                              rel="noreferrer"
                            >
                              open →
                            </a>
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
            <SectionCard
              title="Create a Goal"
              subtitle="Set clear, actionable goals with a daily cadence to stay on track"
              icon="🎯"
            >
              <form onSubmit={createGoal} className="space-y-4">
                <input
                  className="w-full border-2 border-gray-200 rounded-xl px-4 py-3.5 bg-white focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20 transition-all duration-200 outline-none text-gray-900 placeholder-gray-400"
                  placeholder='e.g., "Study LLM theory" or "Drink 2L water"'
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />

                <div className="flex items-center gap-3 flex-wrap">
                  <label className="flex items-center gap-3 bg-white border-2 border-gray-200 rounded-xl px-4 py-2.5">
                    <span className="text-sm font-medium text-gray-700">🔄 Cadence per day</span>
                    <input
                      className="w-20 border-2 border-gray-200 rounded-lg px-3 py-1.5 text-center font-medium bg-white focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20 outline-none"
                      type="number"
                      min={1}
                      max={10}
                      value={cadence}
                      onChange={(e) => setCadence(Number(e.target.value))}
                    />
                  </label>

                  <button
                    className="bg-gradient-to-r from-violet-600 to-indigo-600 text-white rounded-xl px-6 py-2.5 font-medium hover:from-violet-700 hover:to-indigo-700 transition-all duration-200 shadow-lg shadow-violet-500/30 hover:shadow-xl hover:shadow-violet-500/40 disabled:opacity-50 flex items-center gap-2"
                    disabled={savingGoal}
                    type="submit"
                  >
                    {savingGoal ? (
                      <>
                        <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                        Creating…
                      </>
                    ) : (
                      <>✨ Create Goal</>
                    )}
                  </button>

                  <button
                    type="button"
                    className="px-4 py-2.5 border-2 border-gray-300 text-gray-700 rounded-xl font-medium hover:bg-gray-50 transition-all duration-200"
                    onClick={loadGoals}
                  >
                    🔄 Refresh
                  </button>
                </div>
              </form>
            </SectionCard>

            <SectionCard
              title="Your Goals"
              subtitle="Active goals that shape your daily planning"
              icon="📌"
            >
              {loadingGoals ? (
                <div className="flex items-center justify-center py-12">
                  <div className="w-8 h-8 border-4 border-violet-200 border-t-violet-600 rounded-full animate-spin"></div>
                </div>
              ) : goals.length === 0 ? (
                <div className="text-center py-12">
                  <div className="text-5xl mb-3">🎯</div>
                  <p className="text-gray-600">No goals yet. Create one above to get started!</p>
                </div>
              ) : (
                <ul className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {goals.map((g) => (
                    <li
                      key={g.id}
                      className="border-2 border-gray-200 rounded-xl p-4 hover:border-violet-300 hover:shadow-md transition-all duration-200 bg-white"
                    >
                      <div className="font-semibold text-gray-900 flex items-start gap-2">
                        <span className="text-xl">🎯</span>
                        <span className="flex-1">{g.title}</span>
                      </div>
                      <div className="mt-2 text-sm text-gray-600 flex items-center gap-2">
                        <span className="bg-violet-100 text-violet-700 px-2.5 py-1 rounded-full font-medium">
                          🔄 {g.cadence_per_day}x per day
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>
          </>
        )}

        {/* CALENDAR TAB */}
        {tab === "calendar" && (
          <SectionCard
            title="Calendar Integration"
            subtitle="Connect your Google Calendar to automatically schedule your daily plans"
            icon="📅"
          >
            {!userId ? (
              <div className="flex items-center justify-center py-12">
                <div className="w-8 h-8 border-4 border-violet-200 border-t-violet-600 rounded-full animate-spin"></div>
              </div>
            ) : (
              <CalendarIntegration userId={userId} />
            )}
          </SectionCard>
        )}

        {/* ACTIVITY TAB */}
        {tab === "activity" && (
          <SectionCard
            title="Recent Activity"
            subtitle="Track your AI agent runs and planning history"
            icon="📊"
          >
            <div className="flex items-center justify-between mb-4">
              <button
                className="px-4 py-2 border-2 border-gray-300 text-gray-700 rounded-xl font-medium hover:bg-gray-50 transition-all duration-200 flex items-center gap-2"
                onClick={loadRecentRuns}
              >
                🔄 Refresh
              </button>
            </div>

            {loadingRuns ? (
              <div className="flex items-center justify-center py-12">
                <div className="w-8 h-8 border-4 border-violet-200 border-t-violet-600 rounded-full animate-spin"></div>
              </div>
            ) : recentRuns.length === 0 ? (
              <div className="text-center py-12">
                <div className="text-5xl mb-3">📊</div>
                <p className="text-gray-600">No activity yet. Create your first plan to get started!</p>
              </div>
            ) : (
              <ul className="space-y-3">
                {recentRuns.map((r) => (
                  <li key={r.id} className="border-2 border-gray-200 rounded-xl p-4 hover:border-violet-300 hover:shadow-md transition-all duration-200 bg-white">
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <div className="flex items-center gap-2">
                        <span className="text-lg">🤖</span>
                        <span className="font-semibold text-gray-900">{r.selected_agent}</span>
                        <span className="text-xs bg-gray-100 text-gray-700 px-2.5 py-1 rounded-full font-medium">
                          {r.state}
                        </span>
                      </div>
                      <div className="text-xs text-gray-500">
                        {new Date(r.created_at).toLocaleString()}
                      </div>
                    </div>
                    <div className="text-sm text-gray-700 mt-2 leading-relaxed">{r.summary}</div>
                    <div className="mt-3 flex gap-3 flex-wrap text-xs font-mono text-gray-500">
                      <span className="bg-gray-50 px-2 py-1 rounded">run_id: {r.id.substring(0, 8)}…</span>
                      {r.opik_trace_id && (
                        <span className="bg-gray-50 px-2 py-1 rounded">opik: {r.opik_trace_id.substring(0, 8)}…</span>
                      )}
                      {r.feedback && (
                        <span className="bg-gray-50 px-2 py-1 rounded">
                          feedback: {r.feedback.helpful ? "👍" : "👎"}
                        </span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        )}
      </div>

      {/* Toast notification */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 bg-white border-2 border-emerald-200 rounded-xl px-5 py-3.5 shadow-2xl shadow-emerald-500/20 flex items-center gap-3 animate-in slide-in-from-bottom-4">
          <span className="text-xl">✅</span>
          <span className="font-medium text-gray-900">{toast}</span>
        </div>
      )}
    </main>
  );
}