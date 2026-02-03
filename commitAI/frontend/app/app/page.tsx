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

type Confetti = {
  id: number;
  x: number;
  y: number;
  rotation: number;
  color: string;
  size: number;
  velocityX: number;
  velocityY: number;
};

function ConfettiExplosion({ onComplete }: { onComplete: () => void }) {
  const [confetti, setConfetti] = useState<Confetti[]>([]);

  useEffect(() => {
    const colors = ["#8b5cf6", "#6366f1", "#ec4899", "#f59e0b", "#10b981", "#3b82f6"];
    const pieces: Confetti[] = [];
    
    for (let i = 0; i < 50; i++) {
      pieces.push({
        id: i,
        x: 50,
        y: 50,
        rotation: Math.random() * 360,
        color: colors[Math.floor(Math.random() * colors.length)],
        size: Math.random() * 8 + 4,
        velocityX: (Math.random() - 0.5) * 15,
        velocityY: (Math.random() - 0.5) * 15 - 5,
      });
    }
    setConfetti(pieces);

    const interval = setInterval(() => {
      setConfetti((prev) =>
        prev.map((p) => ({
          ...p,
          x: p.x + p.velocityX,
          y: p.y + p.velocityY,
          velocityY: p.velocityY + 0.5,
          rotation: p.rotation + 10,
        }))
      );
    }, 50);

    const timeout = setTimeout(() => {
      clearInterval(interval);
      onComplete();
    }, 3000);

    return () => {
      clearInterval(interval);
      clearTimeout(timeout);
    };
  }, [onComplete]);

  return (
    <div className="fixed inset-0 pointer-events-none z-[100]">
      {confetti.map((c) => (
        <div
          key={c.id}
          className="absolute"
          style={{
            left: `${c.x}%`,
            top: `${c.y}%`,
            width: `${c.size}px`,
            height: `${c.size}px`,
            backgroundColor: c.color,
            transform: `rotate(${c.rotation}deg)`,
            transition: "all 0.05s linear",
          }}
        />
      ))}
    </div>
  );
}

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
        "px-6 py-3 rounded-2xl text-sm font-bold transition-all duration-300 relative overflow-hidden group",
        active
          ? "bg-gradient-to-r from-violet-600 via-purple-600 to-indigo-600 text-white shadow-2xl shadow-violet-500/50 scale-105"
          : "bg-white text-gray-700 hover:bg-gradient-to-r hover:from-violet-50 hover:to-indigo-50 border-2 border-gray-200 hover:border-violet-300 shadow-lg hover:shadow-xl hover:scale-105",
      ].join(" ")}
    >
      {active && (
        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent animate-shimmer"></div>
      )}
      <span className="relative z-10">{children}</span>
    </button>
  );
}

function SectionCard({
  title,
  subtitle,
  children,
  icon,
  gradient,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  icon?: string;
  gradient?: string;
}) {
  const gradientClass = gradient || "from-violet-500 to-indigo-500";
  
  return (
    <section className="mt-8 bg-white border-2 border-gray-200 rounded-3xl p-8 shadow-2xl shadow-gray-300/30 hover:shadow-3xl hover:shadow-gray-400/40 transition-all duration-500 hover:-translate-y-1 relative overflow-hidden group">
      <div className={`absolute top-0 left-0 w-full h-1 bg-gradient-to-r ${gradientClass}`}></div>
      
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          {icon && (
            <div className={`text-5xl p-4 bg-gradient-to-br ${gradientClass} rounded-2xl shadow-lg animate-bounce-slow`}>
              {icon}
            </div>
          )}
          <div>
            <h2 className={`text-2xl font-black bg-gradient-to-r ${gradientClass} bg-clip-text text-transparent`}>
              {title}
            </h2>
            {subtitle && <p className="mt-2 text-sm text-gray-600 leading-relaxed max-w-2xl">{subtitle}</p>}
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
    <div className="space-y-5">
      <div className="relative overflow-hidden group">
        <div className="absolute inset-0 bg-gradient-to-r from-blue-500/10 via-purple-500/10 to-pink-500/10 animate-gradient-x"></div>
        <div className="relative flex items-center gap-4 p-6 bg-white/80 backdrop-blur-sm rounded-2xl border-2 border-gray-200 shadow-xl">
          <div className="text-4xl animate-pulse">📅</div>
          <div className="flex-1">
            <div className="font-bold text-gray-900 text-lg">Google Calendar</div>
            <div className="text-sm mt-1">
              {status?.connected ? (
                <span className="inline-flex items-center gap-2 text-emerald-700 font-bold">
                  <span className="relative flex h-3 w-3">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
                  </span>
                  Connected & Synced
                </span>
              ) : status ? (
                <span className="text-amber-700 font-bold">⚠️ Not connected</span>
              ) : (
                <span className="text-gray-500">Loading…</span>
              )}
            </div>
          </div>
        </div>
      </div>

      {status?.connected && (
        <div className="text-xs text-gray-600 bg-gradient-to-r from-gray-50 to-gray-100 p-4 rounded-xl border-2 border-gray-200 font-mono">
          <div className="flex items-center gap-2">
            <span className="text-base">🔑</span>
            <span>calendar_id: {status.calendar_id ?? "primary"}</span>
          </div>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-base">⏰</span>
            <span>expires_at: {status.expires_at ?? "—"}</span>
          </div>
        </div>
      )}

      <div className="flex gap-3 flex-wrap">
        {!status?.connected && (
          <button
            className="flex-1 min-w-[200px] bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 text-white rounded-2xl px-6 py-4 text-sm font-black hover:from-blue-700 hover:via-indigo-700 hover:to-purple-700 transition-all duration-300 shadow-2xl shadow-blue-500/50 hover:shadow-3xl hover:shadow-blue-500/60 disabled:opacity-50 disabled:cursor-not-allowed hover:scale-105 active:scale-95 relative overflow-hidden group"
            onClick={connectGoogle}
            disabled={loading}
          >
            <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent animate-shimmer"></div>
            <span className="relative z-10">{loading ? "🔄 Opening…" : "🚀 Connect Google Calendar"}</span>
          </button>
        )}
        <button
          className="border-2 border-violet-300 bg-white rounded-2xl px-6 py-4 text-sm font-bold hover:bg-violet-50 hover:border-violet-400 transition-all duration-300 shadow-lg hover:shadow-xl disabled:opacity-50 hover:scale-105 active:scale-95"
          onClick={refreshStatus}
          disabled={loading}
        >
          {loading ? "🔄 Refreshing…" : "🔄 Refresh Status"}
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
  const [showConfetti, setShowConfetti] = useState(false);
  const [streak, setStreak] = useState(0);

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
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    const completed = dailyChecklistStats.done;
    const total = dailyChecklistStats.total;
    
    if (total > 0) {
      const newStreak = Math.floor((completed / total) * 10);
      if (newStreak > streak) {
        setStreak(newStreak);
        if (newStreak >= 5 && completed > 0) {
          // Show celebration for milestones
          setShowConfetti(true);
        }
      }
    }
  }, [dailyChecklistStats]);

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
    setToast("🎉 Goal created successfully!");
    setShowConfetti(true);
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

    if (nextCompleted) {
      setShowConfetti(true);
      setToast("🎉 Task completed! You're on fire!");
    }

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
      setToast("🚀 Your perfect day is ready!");
      setShowConfetti(true);
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
      setToast("🎊 Your calendar is now supercharged!");
      setShowConfetti(true);
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
      setToast("✨ Plan optimized for maximum impact!");
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

  const getMotivationalMessage = () => {
    if (progressPercentage === 0) return "Let's crush this day! 💪";
    if (progressPercentage < 25) return "Great start! Keep it up! 🌟";
    if (progressPercentage < 50) return "You're on fire! 🔥";
    if (progressPercentage < 75) return "Unstoppable! 🚀";
    if (progressPercentage < 100) return "Almost there, champion! 👑";
    return "LEGENDARY! You did it! 🏆";
  };

  return (
    <main className="min-h-screen bg-gradient-to-br from-violet-50 via-purple-50 to-indigo-100 relative overflow-hidden">
      {/* Animated background */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-20 -left-20 w-96 h-96 bg-gradient-to-br from-violet-400/30 to-purple-400/30 rounded-full blur-3xl animate-blob"></div>
        <div className="absolute top-40 -right-20 w-96 h-96 bg-gradient-to-br from-indigo-400/30 to-blue-400/30 rounded-full blur-3xl animate-blob animation-delay-2000"></div>
        <div className="absolute -bottom-20 left-1/2 w-96 h-96 bg-gradient-to-br from-purple-400/30 to-pink-400/30 rounded-full blur-3xl animate-blob animation-delay-4000"></div>
      </div>

      {showConfetti && <ConfettiExplosion onComplete={() => setShowConfetti(false)} />}

      <div className="relative z-10 p-6 md:p-8 max-w-6xl mx-auto">
        {/* Header */}
        <div className="bg-gradient-to-r from-violet-600 via-purple-600 to-indigo-600 rounded-3xl p-8 shadow-2xl shadow-violet-500/50 mb-8 relative overflow-hidden group">
          <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent animate-shimmer"></div>
          
          <div className="relative z-10 flex items-center justify-between flex-wrap gap-4">
            <div className="flex items-center gap-5">
              <div className="w-20 h-20 bg-white rounded-3xl flex items-center justify-center text-5xl shadow-2xl shadow-black/20 animate-bounce-slow transform hover:rotate-12 transition-transform duration-300">
                🎯
              </div>
              <div>
                <h1 className="text-5xl font-black text-white drop-shadow-lg">
                  commitAI
                </h1>
                <p className="mt-2 text-violet-100 flex items-center gap-2 font-semibold">
                  <span className="relative flex h-3 w-3">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-300"></span>
                  </span>
                  {email ?? "Loading…"}
                </p>
              </div>
            </div>

            <button
              className="px-6 py-3 text-sm font-bold text-white bg-white/20 backdrop-blur-sm hover:bg-white/30 rounded-2xl transition-all duration-300 border-2 border-white/30 hover:scale-105 active:scale-95"
              onClick={signOut}
            >
              Sign out →
            </button>
          </div>
        </div>

        {/* Streak & Stats Bar */}
        {dailyAutopilot && (
          <div className="mb-6 grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-gradient-to-br from-yellow-400 to-orange-500 rounded-2xl p-5 text-white shadow-xl hover:scale-105 transition-transform duration-300">
              <div className="text-3xl font-black">🔥 {streak}</div>
              <div className="text-sm font-semibold mt-1 opacity-90">Productivity Streak</div>
            </div>
            <div className="bg-gradient-to-br from-emerald-400 to-green-500 rounded-2xl p-5 text-white shadow-xl hover:scale-105 transition-transform duration-300">
              <div className="text-3xl font-black">✅ {dailyChecklistStats.done}</div>
              <div className="text-sm font-semibold mt-1 opacity-90">Tasks Completed</div>
            </div>
            <div className="bg-gradient-to-br from-blue-400 to-indigo-500 rounded-2xl p-5 text-white shadow-xl hover:scale-105 transition-transform duration-300">
              <div className="text-3xl font-black">🎯 {goals.length}</div>
              <div className="text-sm font-semibold mt-1 opacity-90">Active Goals</div>
            </div>
          </div>
        )}

        {/* Navigation */}
        <div className="flex gap-4 flex-wrap mb-8">
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
          <div className="mb-6 p-5 bg-gradient-to-r from-red-500 to-pink-500 text-white border-2 border-red-300 rounded-2xl font-semibold flex items-start gap-3 shadow-2xl animate-shake">
            <span className="text-2xl">⚠️</span>
            <span className="flex-1">{msg}</span>
            <button onClick={() => setMsg(null)} className="text-white hover:text-red-200 text-xl font-bold">✕</button>
          </div>
        )}

        {/* TODAY TAB */}
        {tab === "today" && (
          <>
            <SectionCard
              title="Daily Check-in"
              subtitle="Tell us how you're feeling and we'll craft the perfect day for you! ✨"
              icon="💭"
              gradient="from-violet-500 to-purple-500"
            >
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                <label className="block group">
                  <div className="text-sm font-bold text-gray-700 mb-3 flex items-center gap-2 group-hover:text-violet-600 transition-colors">
                    <span className="text-2xl">⚡</span> Energy Level
                  </div>
                  <select
                    className="w-full border-3 border-gray-300 rounded-2xl px-5 py-4 bg-white hover:border-violet-400 focus:border-violet-500 focus:ring-4 focus:ring-violet-500/20 transition-all duration-200 outline-none font-semibold text-gray-800 shadow-lg cursor-pointer"
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

                <label className="block group">
                  <div className="text-sm font-bold text-gray-700 mb-3 flex items-center gap-2 group-hover:text-violet-600 transition-colors">
                    <span className="text-2xl">📋</span> Workload
                  </div>
                  <select
                    className="w-full border-3 border-gray-300 rounded-2xl px-5 py-4 bg-white hover:border-violet-400 focus:border-violet-500 focus:ring-4 focus:ring-violet-500/20 transition-all duration-200 outline-none font-semibold text-gray-800 shadow-lg cursor-pointer"
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

                <label className="block md:col-span-2 group">
                  <div className="text-sm font-bold text-gray-700 mb-3 flex items-center gap-2 group-hover:text-violet-600 transition-colors">
                    <span className="text-2xl">🚧</span> Blockers (optional)
                  </div>
                  <textarea
                    className="w-full border-3 border-gray-300 rounded-2xl px-5 py-4 bg-white hover:border-violet-400 focus:border-violet-500 focus:ring-4 focus:ring-violet-500/20 transition-all duration-200 outline-none resize-none font-medium text-gray-800 shadow-lg"
                    rows={3}
                    placeholder="What might stop you today? We'll plan around it! 💪"
                    value={blockers}
                    onChange={(e) => setBlockers(e.target.value)}
                  />
                </label>
              </div>

              <div className="mt-8 flex gap-4 flex-wrap">
                <button
                  className="flex-1 min-w-[200px] bg-gradient-to-r from-violet-600 via-purple-600 to-indigo-600 text-white rounded-2xl px-8 py-5 text-lg font-black hover:from-violet-700 hover:via-purple-700 hover:to-indigo-700 transition-all duration-300 shadow-2xl shadow-violet-500/50 hover:shadow-3xl hover:shadow-violet-500/60 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-3 hover:scale-105 active:scale-95 relative overflow-hidden group"
                  onClick={runAutopilotAllGoals}
                  disabled={runningAutopilot}
                >
                  <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent animate-shimmer"></div>
                  {runningAutopilot ? (
                    <>
                      <div className="w-6 h-6 border-3 border-white/30 border-t-white rounded-full animate-spin"></div>
                      <span className="relative z-10">Crafting your perfect day…</span>
                    </>
                  ) : (
                    <span className="relative z-10">✨ Create Today's Plan</span>
                  )}
                </button>

                <button
                  className="px-8 py-5 border-3 border-violet-400 bg-white text-violet-700 rounded-2xl text-lg font-black hover:bg-violet-50 hover:border-violet-500 transition-all duration-300 shadow-xl hover:shadow-2xl disabled:opacity-50 disabled:cursor-not-allowed hover:scale-105 active:scale-95"
                  onClick={checkinAndReschedule}
                  disabled={runningAutopilot || !dailyAutopilot?.daily_run_id}
                  title={!dailyAutopilot?.daily_run_id ? "Create a plan first" : ""}
                >
                  {runningAutopilot ? "Updating…" : "🔁 Update Plan"}
                </button>

                <button
                  className="px-8 py-5 border-3 border-gray-400 bg-white text-gray-700 rounded-2xl text-lg font-black hover:bg-gray-50 hover:border-gray-500 transition-all duration-300 shadow-xl hover:shadow-2xl hover:scale-105 active:scale-95"
                  onClick={loadTodayDailyRun}
                  disabled={!userId}
                >
                  📂 Load Saved
                </button>
              </div>

              <div className="mt-5 p-4 bg-gradient-to-r from-blue-50 to-indigo-50 border-2 border-blue-300 rounded-2xl text-sm text-blue-900 flex items-start gap-3 font-semibold">
                <span className="text-xl">💡</span>
                <span>Planning is a <strong>preview</strong>. Changes go live when you click <strong>"Add to Google Calendar"</strong>.</span>
              </div>
            </SectionCard>

            {dailyAutopilot && (
              <SectionCard
                title={`Today's Master Plan ${planStatusLabel ? `· ${planStatusLabel}` : ""}`}
                subtitle={dailyAutopilot.summary || "Your AI-optimized schedule is ready! 🚀"}
                icon="📝"
                gradient="from-emerald-500 to-teal-500"
              >
                {/* Epic Progress Section */}
                <div className="mb-8 p-8 bg-gradient-to-br from-violet-600 via-purple-600 to-indigo-600 rounded-3xl border-3 border-violet-400 shadow-2xl relative overflow-hidden">
                  <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent animate-shimmer"></div>
                  
                  <div className="relative z-10">
                    <div className="flex items-center justify-between mb-4">
                      <div className="text-white">
                        <div className="text-sm font-bold opacity-90">Today's Progress</div>
                        <div className="text-4xl font-black mt-1">{getMotivationalMessage()}</div>
                      </div>
                      <div className="text-6xl font-black text-white drop-shadow-lg">
                        {dailyChecklistStats.done}/{dailyChecklistStats.total}
                      </div>
                    </div>
                    
                    <div className="w-full bg-white/20 backdrop-blur-sm rounded-full h-6 overflow-hidden shadow-inner border-2 border-white/30">
                      <div
                        className="h-full bg-gradient-to-r from-yellow-300 via-orange-300 to-pink-300 transition-all duration-700 ease-out rounded-full shadow-lg relative overflow-hidden"
                        style={{ width: `${progressPercentage}%` }}
                      >
                        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/40 to-transparent animate-shimmer"></div>
                      </div>
                    </div>
                    
                    <div className="mt-3 text-center text-2xl font-black text-white drop-shadow-lg">
                      {progressPercentage}% Complete
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-between gap-4 flex-wrap mb-8">
                  <label className="flex items-center gap-4 bg-white border-3 border-gray-300 rounded-2xl px-6 py-4 shadow-xl hover:shadow-2xl transition-all duration-300 hover:scale-105">
                    <span className="text-sm font-bold text-gray-700 flex items-center gap-2">
                      <span className="text-2xl">⏰</span> Start after
                    </span>
                    <select
                      className="border-2 border-gray-300 rounded-xl px-4 py-2 text-sm font-bold bg-white focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20 outline-none cursor-pointer"
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
                    className="bg-gradient-to-r from-emerald-600 via-green-600 to-teal-600 text-white rounded-2xl px-8 py-4 text-lg font-black hover:from-emerald-700 hover:via-green-700 hover:to-teal-700 transition-all duration-300 shadow-2xl shadow-emerald-500/50 hover:shadow-3xl hover:shadow-emerald-500/60 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-3 hover:scale-105 active:scale-95 relative overflow-hidden group"
                    disabled={committingCalendar || !dailyAutopilot?.daily_run_id}
                    onClick={commitDailyToCalendar}
                  >
                    <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent animate-shimmer"></div>
                    {committingCalendar ? (
                      <>
                        <div className="w-6 h-6 border-3 border-white/30 border-t-white rounded-full animate-spin"></div>
                        <span className="relative z-10">Adding to calendar…</span>
                      </>
                    ) : (
                      <span className="relative z-10">✅ Add to Google Calendar</span>
                    )}
                  </button>
                </div>

                {/* Checklist */}
                {(dailyAutopilot.items?.length ?? 0) > 0 && (
                  <>
                    <div className="mb-5 font-black text-2xl flex items-center gap-3 bg-gradient-to-r from-violet-600 to-purple-600 bg-clip-text text-transparent">
                      <span className="text-4xl">📋</span> Task Checklist
                    </div>
                    <ul className="space-y-4">
                      {dailyAutopilot.items.map((it) => {
                        const checked = !!checkedItemIds[it.item_id];
                        return (
                          <li
                            key={it.item_id}
                            className={[
                              "border-3 rounded-2xl p-6 transition-all duration-500 hover:shadow-2xl transform hover:-translate-y-1",
                              checked
                                ? "bg-gradient-to-br from-emerald-50 to-green-50 border-emerald-400 scale-98 opacity-75"
                                : "bg-white border-gray-300 hover:border-violet-400 shadow-lg",
                            ].join(" ")}
                          >
                            <label className="flex items-start gap-5 cursor-pointer group">
                              <input
                                type="checkbox"
                                className="mt-2 w-7 h-7 rounded-xl border-3 border-gray-400 text-violet-600 focus:ring-4 focus:ring-violet-500/30 transition-all duration-200 cursor-pointer hover:scale-110"
                                checked={checked}
                                onChange={() => toggleItemChecked(it.item_id)}
                              />
                              <div className="flex-1">
                                <div className={`font-black text-xl text-gray-900 ${checked ? "line-through text-gray-500" : "group-hover:text-violet-600"} transition-colors`}>
                                  {it.title}
                                  <div className="inline-flex gap-2 ml-3 mt-2">
                                    {it.window && (
                                      <span className="text-xs font-bold bg-gradient-to-r from-violet-100 to-purple-100 text-violet-700 px-3 py-1.5 rounded-full border-2 border-violet-200">
                                        🕐 {it.window}
                                      </span>
                                    )}
                                    {it.minutes && (
                                      <span className="text-xs font-bold bg-gradient-to-r from-blue-100 to-indigo-100 text-blue-700 px-3 py-1.5 rounded-full border-2 border-blue-200">
                                        ⏱️ {it.minutes}m
                                      </span>
                                    )}
                                  </div>
                                </div>

                                {(it.goal_ids?.length ?? 0) > 0 && (
                                  <div className="flex flex-wrap gap-2 mt-3">
                                    {it.goal_ids.map((gid) => (
                                      <span
                                        key={gid}
                                        className="inline-flex items-center gap-2 text-sm bg-gradient-to-r from-violet-500 to-purple-500 text-white px-4 py-2 rounded-full font-bold shadow-lg hover:scale-105 transition-transform"
                                      >
                                        🎯 {goalTitleById.get(gid) ?? gid}
                                      </span>
                                    ))}
                                  </div>
                                )}

                                {it.details && (
                                  <div className={`text-base mt-3 leading-relaxed font-medium ${checked ? "text-gray-500" : "text-gray-700"}`}>
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

                {/* Timeline */}
                {(dailyAutopilot.schedule?.length ?? 0) > 0 && (
                  <>
                    <div className="mt-10 mb-5 font-black text-2xl flex items-center gap-3 bg-gradient-to-r from-indigo-600 to-blue-600 bg-clip-text text-transparent">
                      <span className="text-4xl">⏰</span> Your Perfect Timeline
                    </div>
                    <ol className="space-y-4 relative pl-8 border-l-4 border-violet-300">
                      {dailyAutopilot.schedule.map((b, i) => (
                        <li key={i} className="relative group">
                          <div className="absolute -left-[42px] top-4 w-8 h-8 bg-gradient-to-br from-violet-600 to-indigo-600 rounded-full border-4 border-white shadow-xl group-hover:scale-125 transition-transform duration-300 flex items-center justify-center text-white font-black text-sm">
                            {i + 1}
                          </div>
                          <div className="bg-white border-3 border-gray-300 rounded-2xl p-6 hover:border-violet-400 hover:shadow-2xl transition-all duration-300 transform hover:-translate-y-1">
                            <div className="font-black text-lg text-gray-900 flex items-center gap-3 flex-wrap group-hover:text-violet-600 transition-colors">
                              <span>{b.title}</span>
                              <span className="text-sm font-bold bg-gradient-to-r from-violet-500 to-indigo-500 text-white px-4 py-2 rounded-full shadow-lg">
                                {new Date(b.start).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} –{" "}
                                {new Date(b.end).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                              </span>
                            </div>
                            <div className="text-base text-gray-700 mt-3 leading-relaxed font-medium">{b.details}</div>
                          </div>
                        </li>
                      ))}
                    </ol>
                  </>
                )}

                {dailyAutopilot.calendar_error && (
                  <div className="mt-8 p-6 bg-gradient-to-r from-red-500 to-pink-500 text-white border-3 border-red-400 rounded-2xl font-semibold flex items-start gap-4 shadow-2xl">
                    <span className="text-3xl">⚠️</span>
                    <div>
                      <div className="font-black text-lg">Calendar Error</div>
                      <div className="mt-2 opacity-90">{dailyAutopilot.calendar_error}</div>
                    </div>
                  </div>
                )}

                {(dailyAutopilot.calendar_events?.length ?? 0) > 0 && (
                  <div className="mt-8 p-6 bg-gradient-to-br from-emerald-500 to-green-500 text-white border-3 border-emerald-400 rounded-2xl shadow-2xl">
                    <div className="font-black text-xl mb-4 flex items-center gap-3">
                      <span className="text-3xl">🎉</span> Calendar Events Created!
                    </div>
                    <ul className="space-y-3">
                      {dailyAutopilot.calendar_events!.map((e, i) => (
                        <li key={i} className="flex items-center gap-3 bg-white/20 backdrop-blur-sm rounded-xl p-4 font-bold border-2 border-white/30">
                          <span className="text-2xl">📅</span>
                          <span className="flex-1">{e.step_title}</span>
                          {e.htmlLink && (
                            <a
                              className="text-white hover:text-yellow-300 underline font-black bg-white/20 px-4 py-2 rounded-xl hover:bg-white/30 transition-all"
                              href={e.htmlLink}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Open →
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
              subtitle="Dream big! Set goals that excite you and we'll make them happen! 🌟"
              icon="🎯"
              gradient="from-yellow-500 to-orange-500"
            >
              <form onSubmit={createGoal} className="space-y-5">
                <input
                  className="w-full border-3 border-gray-300 rounded-2xl px-6 py-5 bg-white hover:border-violet-400 focus:border-violet-500 focus:ring-4 focus:ring-violet-500/20 transition-all duration-200 outline-none text-xl font-bold text-gray-900 placeholder-gray-400 shadow-xl"
                  placeholder='e.g., "Master Machine Learning" or "Run 5K daily" 🚀'
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />

                <div className="flex items-center gap-4 flex-wrap">
                  <label className="flex items-center gap-4 bg-white border-3 border-gray-300 rounded-2xl px-6 py-4 shadow-xl hover:shadow-2xl transition-all duration-300 hover:scale-105">
                    <span className="text-base font-bold text-gray-700 flex items-center gap-2">
                      <span className="text-2xl">🔄</span> Daily Cadence
                    </span>
                    <input
                      className="w-24 border-3 border-gray-300 rounded-xl px-4 py-3 text-center text-xl font-black bg-white hover:border-violet-400 focus:border-violet-500 focus:ring-4 focus:ring-violet-500/20 outline-none shadow-lg"
                      type="number"
                      min={1}
                      max={10}
                      value={cadence}
                      onChange={(e) => setCadence(Number(e.target.value))}
                    />
                  </label>

                  <button
                    className="bg-gradient-to-r from-violet-600 via-purple-600 to-indigo-600 text-white rounded-2xl px-8 py-4 text-lg font-black hover:from-violet-700 hover:via-purple-700 hover:to-indigo-700 transition-all duration-300 shadow-2xl shadow-violet-500/50 hover:shadow-3xl hover:shadow-violet-500/60 disabled:opacity-50 flex items-center gap-3 hover:scale-105 active:scale-95 relative overflow-hidden group"
                    disabled={savingGoal}
                    type="submit"
                  >
                    <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent animate-shimmer"></div>
                    {savingGoal ? (
                      <>
                        <div className="w-6 h-6 border-3 border-white/30 border-t-white rounded-full animate-spin"></div>
                        <span className="relative z-10">Creating…</span>
                      </>
                    ) : (
                      <span className="relative z-10">✨ Create Goal</span>
                    )}
                  </button>

                  <button
                    type="button"
                    className="px-6 py-4 border-3 border-gray-400 bg-white text-gray-700 rounded-2xl text-lg font-black hover:bg-gray-50 hover:border-gray-500 transition-all duration-300 shadow-xl hover:shadow-2xl hover:scale-105 active:scale-95"
                    onClick={loadGoals}
                  >
                    🔄 Refresh
                  </button>
                </div>
              </form>
            </SectionCard>

            <SectionCard
              title="Your Goals"
              subtitle="These are the dreams you're crushing! Keep going! 💪"
              icon="📌"
              gradient="from-pink-500 to-rose-500"
            >
              {loadingGoals ? (
                <div className="flex items-center justify-center py-16">
                  <div className="w-16 h-16 border-6 border-violet-200 border-t-violet-600 rounded-full animate-spin"></div>
                </div>
              ) : goals.length === 0 ? (
                <div className="text-center py-16">
                  <div className="text-8xl mb-6 animate-bounce">🎯</div>
                  <p className="text-xl text-gray-600 font-bold">No goals yet. Create your first one above and start your journey!</p>
                </div>
              ) : (
                <ul className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {goals.map((g, idx) => (
                    <li
                      key={g.id}
                      className="border-3 border-gray-300 rounded-2xl p-6 hover:border-violet-400 hover:shadow-2xl transition-all duration-300 bg-white transform hover:-translate-y-2 hover:scale-105 relative overflow-hidden group"
                      style={{ animationDelay: `${idx * 100}ms` }}
                    >
                      <div className="absolute top-0 right-0 w-24 h-24 bg-gradient-to-br from-violet-500/10 to-purple-500/10 rounded-full blur-2xl group-hover:scale-150 transition-transform duration-500"></div>
                      
                      <div className="relative z-10">
                        <div className="font-black text-xl text-gray-900 flex items-start gap-3 group-hover:text-violet-600 transition-colors">
                          <span className="text-3xl">🎯</span>
                          <span className="flex-1">{g.title}</span>
                        </div>
                        <div className="mt-4 flex items-center gap-2">
                          <span className="bg-gradient-to-r from-violet-500 to-purple-500 text-white px-4 py-2 rounded-full font-black text-sm shadow-lg">
                            🔄 {g.cadence_per_day}x per day
                          </span>
                        </div>
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
            subtitle="Connect and automate your success! 🚀"
            icon="📅"
            gradient="from-blue-500 to-cyan-500"
          >
            {!userId ? (
              <div className="flex items-center justify-center py-16">
                <div className="w-16 h-16 border-6 border-violet-200 border-t-violet-600 rounded-full animate-spin"></div>
              </div>
            ) : (
              <CalendarIntegration userId={userId} />
            )}
          </SectionCard>
        )}

        {/* ACTIVITY TAB */}
        {tab === "activity" && (
          <SectionCard
            title="Activity Feed"
            subtitle="Track your AI-powered productivity journey! 📈"
            icon="📊"
            gradient="from-green-500 to-emerald-500"
          >
            <div className="flex items-center justify-between mb-6">
              <button
                className="px-6 py-3 border-3 border-gray-400 bg-white text-gray-700 rounded-2xl text-lg font-black hover:bg-gray-50 hover:border-gray-500 transition-all duration-300 shadow-xl hover:shadow-2xl flex items-center gap-3 hover:scale-105 active:scale-95"
                onClick={loadRecentRuns}
              >
                🔄 Refresh Activity
              </button>
            </div>

            {loadingRuns ? (
              <div className="flex items-center justify-center py-16">
                <div className="w-16 h-16 border-6 border-violet-200 border-t-violet-600 rounded-full animate-spin"></div>
              </div>
            ) : recentRuns.length === 0 ? (
              <div className="text-center py-16">
                <div className="text-8xl mb-6 animate-bounce">📊</div>
                <p className="text-xl text-gray-600 font-bold">No activity yet. Create your first plan to see magic happen!</p>
              </div>
            ) : (
              <ul className="space-y-4">
                {recentRuns.map((r, idx) => (
                  <li
                    key={r.id}
                    className="border-3 border-gray-300 rounded-2xl p-6 hover:border-violet-400 hover:shadow-2xl transition-all duration-300 bg-white transform hover:-translate-y-1"
                    style={{ animationDelay: `${idx * 50}ms` }}
                  >
                    <div className="flex items-center justify-between gap-4 flex-wrap">
                      <div className="flex items-center gap-3">
                        <span className="text-3xl">🤖</span>
                        <span className="font-black text-lg text-gray-900">{r.selected_agent}</span>
                        <span className="text-xs font-bold bg-gradient-to-r from-gray-100 to-gray-200 text-gray-700 px-3 py-1.5 rounded-full border-2 border-gray-300">
                          {r.state}
                        </span>
                      </div>
                      <div className="text-sm text-gray-500 font-semibold">
                        {new Date(r.created_at).toLocaleString()}
                      </div>
                    </div>
                    <div className="text-base text-gray-700 mt-3 leading-relaxed font-medium">{r.summary}</div>
                    <div className="mt-4 flex gap-3 flex-wrap text-xs font-mono text-gray-600">
                      <span className="bg-gray-100 px-3 py-1.5 rounded-lg border-2 border-gray-200 font-bold">
                        ID: {r.id.substring(0, 8)}…
                      </span>
                      {r.opik_trace_id && (
                        <span className="bg-gray-100 px-3 py-1.5 rounded-lg border-2 border-gray-200 font-bold">
                          Trace: {r.opik_trace_id.substring(0, 8)}…
                        </span>
                      )}
                      {r.feedback && (
                        <span className="bg-gradient-to-r from-emerald-100 to-green-100 px-3 py-1.5 rounded-lg border-2 border-emerald-300 font-bold">
                          {r.feedback.helpful ? "👍 Helpful" : "👎 Not Helpful"}
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
        <div className="fixed bottom-8 right-8 z-50 bg-gradient-to-r from-violet-600 via-purple-600 to-indigo-600 text-white border-3 border-violet-400 rounded-2xl px-8 py-5 shadow-2xl shadow-violet-500/50 flex items-center gap-4 animate-bounce-in">
          <span className="text-3xl">{toast.includes("🎉") || toast.includes("🎊") ? "🎉" : "✅"}</span>
          <span className="font-black text-lg">{toast}</span>
        </div>
      )}

      <style jsx global>{`
        @keyframes shimmer {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
        @keyframes blob {
          0%, 100% { transform: translate(0, 0) scale(1); }
          25% { transform: translate(20px, -50px) scale(1.1); }
          50% { transform: translate(-20px, 20px) scale(0.9); }
          75% { transform: translate(50px, 50px) scale(1.05); }
        }
        @keyframes bounce-slow {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-10px); }
        }
        @keyframes bounce-in {
          0% { transform: translateY(100px); opacity: 0; }
          100% { transform: translateY(0); opacity: 1; }
        }
        @keyframes shake {
          0%, 100% { transform: translateX(0); }
          25% { transform: translateX(-10px); }
          75% { transform: translateX(10px); }
        }
        @keyframes gradient-x {
          0%, 100% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
        }
        .animate-shimmer {
          animation: shimmer 3s infinite;
        }
        .animate-blob {
          animation: blob 7s infinite;
        }
        .animation-delay-2000 {
          animation-delay: 2s;
        }
        .animation-delay-4000 {
          animation-delay: 4s;
        }
        .animate-bounce-slow {
          animation: bounce-slow 3s ease-in-out infinite;
        }
        .animate-bounce-in {
          animation: bounce-in 0.5s ease-out;
        }
        .animate-shake {
          animation: shake 0.5s ease-in-out;
        }
        .animate-gradient-x {
          background-size: 200% 200%;
          animation: gradient-x 3s ease infinite;
        }
        .border-3 {
          border-width: 3px;
        }
        .border-6 {
          border-width: 6px;
        }
      `}</style>
    </main>
  );
}