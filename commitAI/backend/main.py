# backend/main.py

import os
import json
import time
import uuid
from typing import Optional, List, Dict, Any, Union

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, ValidationError
from supabase import create_client, Client
from openai import OpenAI
from opik import track, opik_context
from datetime import datetime, timezone, timedelta
from zoneinfo import ZoneInfo
from fastapi import Query


try:
    from zoneinfo import ZoneInfo  # py3.9+
except Exception:
    ZoneInfo = None

from integrations.calendar_google import (
    register_google_calendar_routes,
    google_create_event,
    google_delete_event,
    google_delete_commitai_events_in_range,
    google_list_events_in_range,
)

# -------------------------
# Env + Clients
# -------------------------
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), ".env"), override=True)

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
OPIK_PROJECT = os.getenv("OPIK_PROJECT_NAME", "commitAI")

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")

# ✅ robust model fallback (fixes: "you must provide a model parameter")
OPENAI_MODEL = (
    os.getenv("LLM_MODEL")
    or os.getenv("OPENAI_MODEL")
    or "gpt-4o-mini"
)

if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
    raise RuntimeError("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in backend/.env")
if not OPENAI_API_KEY:
    raise RuntimeError("Missing OPENAI_API_KEY in backend/.env")

sb: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
client = OpenAI(api_key=OPENAI_API_KEY)

# -------------------------
# FastAPI
# -------------------------
app = FastAPI(title="commitAI API")

origins = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "https://committochange.vercel.app",  # ✅ no trailing slash
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register Google integration routes (sets internal _SB in calendar_google.py)
register_google_calendar_routes(app, sb)

@app.get("/health")
def health():
    return {"status": "ok", "model": OPENAI_MODEL}


# -------------------------
# Models
# -------------------------
class RunAutopilotRequest(BaseModel):
    user_id: str
    goal_id: str
    checkin_id: Optional[str] = None
    energy: int = Field(ge=1, le=5)
    workload: int = Field(ge=1, le=5)
    blockers: Optional[str] = None
    completed: bool = False
    schedule_calendar: bool = False
    start_in_minutes: int = Field(default=5, ge=0, le=180)
    tz_name: Optional[str] = None


class FeedbackRequest(BaseModel):
    user_id: str
    agent_run_id: str
    opik_trace_id: Optional[str] = None
    helpful: bool
    comment: Optional[str] = None


class PlanStep(BaseModel):
    title: str
    minutes: int = Field(ge=1, le=90)
    details: str


class PlanOutput(BaseModel):
    steps: List[PlanStep] = Field(min_length=2, max_length=6)
    total_minutes: int
    summary: str


class CriticReview(BaseModel):
    ok: bool
    issues: List[str] = []
    suggested_edits: List[str] = []
    
from typing import Literal

class DailyAutopilotRequest(BaseModel):
    user_id: str
    energy: int = Field(ge=1, le=5)
    workload: int = Field(ge=1, le=5)
    blockers: Optional[str] = None
    schedule_calendar: bool = False
    start_in_minutes: int = Field(default=5, ge=0, le=180)
    goal_ids: Optional[List[str]] = None
    tz_name: Optional[str] = None
    

class DailyPlanItem(BaseModel):
    item_id: Optional[str] = None  # ✅ for checklist + event mapping
    title: str
    minutes: int = Field(ge=1, le=180)
    details: str
    goal_ids: List[str] = Field(min_length=1)

    kind: Literal["focus", "habit"] = "focus"
    window: Literal["morning", "midday", "afternoon", "evening", "any"] = "any"

    # only relevant for habits
    occurrences: int = Field(default=1, ge=1, le=12)
    min_gap_minutes: int = Field(default=60, ge=0, le=600)

class ScheduledBlock(BaseModel):
    item_id: Optional[str] = None  # ✅ carries through to calendar
    title: str
    details: str
    goal_ids: List[str]
    start: str
    end: str
    kind: str


class DailyPlanOutput(BaseModel):
    summary: str
    items: List[DailyPlanItem] = Field(min_length=2, max_length=20)

# -------------------------
# Models (Daily Autopilot)
# -------------------------
class RunDailyAutopilotRequest(BaseModel):
    user_id: str
    energy: int = Field(ge=1, le=5)
    workload: int = Field(ge=1, le=5)
    blockers: Optional[str] = None
    schedule_calendar: bool = False
    start_in_minutes: int = Field(default=5, ge=0, le=180)

class DailyPlanStep(BaseModel):
    goal_id: str
    goal_title: str
    title: str
    minutes: int = Field(ge=1, le=90)
    details: str

class DailyAutopilotResult(BaseModel):
    date: str  # YYYY-MM-DD
    summary: str
    total_minutes: int
    steps: List[DailyPlanStep]
    per_goal: List[dict] = []  # traceability for judges (state/agent per goal)
    calendar_events: List[dict] = []
    calendar_error: Optional[str] = None
    
class DailyRescheduleRequest(BaseModel):
    user_id: str
    daily_run_id: str
    energy: int = Field(ge=1, le=5)
    workload: int = Field(ge=1, le=5)
    blockers: Optional[str] = None
    completed_item_ids: List[str] = []
    tz_name: Optional[str] = None


# -------------------------
# Helpers
# -------------------------
def _dump_model(m: BaseModel) -> dict:
    return m.model_dump() if hasattr(m, "model_dump") else m.dict()

def _safe_tz(tz_name: Optional[str]) -> str:
    # fall back to Detroit if invalid
    if not tz_name:
        return "America/Detroit"
    try:
        ZoneInfo(tz_name)
        return tz_name
    except Exception:
        return "America/Detroit"
    
def _ensure_tz_aware(dt: datetime, tz_name: str) -> datetime:
    tz = ZoneInfo(tz_name)
    if dt.tzinfo is None:
        return dt.replace(tzinfo=tz)
    return dt.astimezone(tz)


def _to_local_naive(dt: datetime, tz_name: str) -> datetime:
    """
    Make sure Google gets a LOCAL wall-clock time + timezone separately.
    Avoids weird shifts when mixing aware datetimes + timeZone field.
    """
    tz = ZoneInfo(tz_name)
    if dt.tzinfo is None:
        dt_local = dt.replace(tzinfo=tz)
    else:
        dt_local = dt.astimezone(tz)
    return dt_local.replace(tzinfo=None)



def _json_load_or_raise(text: str, where: str) -> dict:
    try:
        return json.loads(text)
    except Exception as e:
        raise ValueError(f"{where}: invalid JSON. raw={text[:1200]}") from e


def _find_plan_obj(obj: Any) -> Optional[dict]:
    """
    Recursively find the first dict that looks like a plan.
    This fixes when the model returns wrappers like {"plan": {...}} or returns policy/context at the top level.
    """
    if isinstance(obj, dict):
        if "steps" in obj and isinstance(obj["steps"], list):
            return obj
        for k in ("plan", "output", "result", "data"):
            v = obj.get(k)
            found = _find_plan_obj(v)
            if found:
                return found
        for v in obj.values():
            found = _find_plan_obj(v)
            if found:
                return found
    elif isinstance(obj, list):
        for it in obj:
            found = _find_plan_obj(it)
            if found:
                return found
    return None

from datetime import datetime, timedelta
from typing import List, Tuple

def _push_past_busy(
    start_dt: datetime,
    duration_min: int,
    busy: List[Tuple[datetime, datetime]],
    buffer_min: int = 5,
) -> datetime:
    """
    Returns a start time >= start_dt that does NOT overlap any busy interval.
    busy: list of (busy_start, busy_end) datetimes (tz-aware, same tz as start_dt)
    """
    t = start_dt  # ✅ always defined

    # assume busy is sorted by start time
    while True:
        end_dt = t + timedelta(minutes=duration_min)

        moved = False
        for b_start, b_end in busy:
            # no overlap
            if end_dt <= b_start or t >= b_end:
                continue

            # overlap → push t to just after this busy block
            t = b_end + timedelta(minutes=buffer_min)
            moved = True
            break

        if not moved:
            return t


def _validate_plan_json(text: str) -> dict:
    obj = _json_load_or_raise(text, "planner/reviser")
    plan_obj = _find_plan_obj(obj) or obj

    if "steps" not in plan_obj:
        raise ValueError(f"planner/reviser: missing 'steps'. raw={text[:1200]}")

    raw_steps = plan_obj.get("steps") or []
    norm_steps: List[dict] = []

    for s in raw_steps:
        # Ideal schema
        if isinstance(s, dict) and {"title", "minutes", "details"} <= set(s.keys()):
            norm_steps.append(
                {
                    "title": str(s["title"]),
                    "minutes": int(s["minutes"]),
                    "details": str(s["details"]),
                }
            )
            continue

        # Common wrong schema: {"step": 1, "action": "..."}
        if isinstance(s, dict) and "action" in s:
            action = str(s.get("action") or "").strip()
            minutes = int(s.get("minutes") or 10)
            norm_steps.append(
                {
                    "title": (action[:80] if action else "Step"),
                    "minutes": max(1, min(90, minutes)),
                    "details": action or "Do the step.",
                }
            )
            continue

        # Fallback
        txt = str(s).strip()
        norm_steps.append({"title": (txt[:80] if txt else "Step"), "minutes": 10, "details": txt or "Do the step."})

    summary = (plan_obj.get("summary") or "").strip() or "Quick plan to move the goal forward."

    # Normalize total_minutes
    try:
        total_minutes = int(plan_obj.get("total_minutes")) if plan_obj.get("total_minutes") is not None else None
    except Exception:
        total_minutes = None
    if total_minutes is None:
        total_minutes = sum(int(x["minutes"]) for x in norm_steps)

    normalized = {"steps": norm_steps, "total_minutes": total_minutes, "summary": summary}

    plan = PlanOutput.model_validate(normalized) if hasattr(PlanOutput, "model_validate") else PlanOutput.parse_obj(normalized)
    out = plan.model_dump() if hasattr(plan, "model_dump") else plan.dict()
    out["total_minutes"] = sum(int(s["minutes"]) for s in out["steps"])
    return out

def _validate_daily_plan_json(text: str) -> dict:
    obj = _json_load_or_raise(text, "daily_planner")
    for k in ("summary", "items"):
        if k not in obj:
            raise ValueError(f"daily_planner: missing '{k}'. raw={text[:800]}")

    plan = DailyPlanOutput.model_validate(obj) if hasattr(DailyPlanOutput, "model_validate") else DailyPlanOutput.parse_obj(obj)
    out = plan.model_dump() if hasattr(plan, "model_dump") else plan.dict()
    return out


from typing import Tuple

def _parse_google_event_dt(evt_dt: dict, tz_name: str) -> datetime:
    """
    Google event start/end has either:
      - {"dateTime": "..."} OR
      - {"date": "YYYY-MM-DD"}  (all-day)
    Returns tz-aware datetime in tz_name.
    """
    tz = ZoneInfo(tz_name)
    if "dateTime" in evt_dt and evt_dt["dateTime"]:
        dt = datetime.fromisoformat(evt_dt["dateTime"].replace("Z", "+00:00"))
        return dt.astimezone(tz)
    if "date" in evt_dt and evt_dt["date"]:
        # all-day: treat as busy from start-of-day local
        d = datetime.fromisoformat(evt_dt["date"])
        return d.replace(tzinfo=tz)
    raise ValueError("Unknown event datetime format")

def _get_non_commitai_busy_intervals(
    user_id: str,
    *,
    tz_name: str,
    start_local: datetime,
    end_local: datetime,
    buffer_minutes: int = 5,
) -> List[Tuple[datetime, datetime]]:
    """
    Pull calendar events and return merged busy intervals (tz-aware),
    excluding commitAI events (summary starts with 'commitAI:').
    Adds a small buffer around events.
    """
    try:
        events = google_list_events_in_range(
            user_id=user_id,
            time_min=start_local,
            time_max=end_local,
            time_zone=tz_name,
        )
    except Exception:
        return []

    tz = ZoneInfo(tz_name)
    busy: List[Tuple[datetime, datetime]] = []

    for e in events:
        summary = (e.get("summary") or "").strip()
        if summary.lower().startswith("commitai:"):
            continue  # ✅ ignore our own

        st_raw = e.get("start") or {}
        en_raw = e.get("end") or {}

        try:
            st = _parse_google_event_dt(st_raw, tz_name)
            en = _parse_google_event_dt(en_raw, tz_name)
        except Exception:
            continue

        # Ensure tz-aware
        if st.tzinfo is None: st = st.replace(tzinfo=tz)
        if en.tzinfo is None: en = en.replace(tzinfo=tz)

        # add buffer
        st = st - timedelta(minutes=buffer_minutes)
        en = en + timedelta(minutes=buffer_minutes)

        if en > st:
            busy.append((st, en))

    busy.sort(key=lambda x: x[0])

    # merge overlaps
    merged: List[Tuple[datetime, datetime]] = []
    for st, en in busy:
        if not merged or st > merged[-1][1]:
            merged.append((st, en))
        else:
            merged[-1] = (merged[-1][0], max(merged[-1][1], en))

    return merged


def _today_iso_utc() -> str:
    return datetime.now(timezone.utc).date().isoformat()

def merge_goal_plans_round_robin(
    goal_plans: List[dict],
    *,
    per_goal_step_cap: int = 2,
    max_total_minutes: int = 90,
    hard_max_steps: int = 10,
) -> dict:
    """
    goal_plans item format:
      {
        "goal": {"id":..., "title":...},
        "result": {"steps":[{"title","minutes","details"}], "summary", "state", "selected_agent"...}
      }
    Returns: {"steps": [...], "total_minutes": int, "summary": str}
    """

    # Trim per-goal steps
    buckets: List[List[dict]] = []
    for gp in goal_plans:
        g = gp["goal"]
        steps = (gp["result"].get("steps") or [])[:per_goal_step_cap]
        tagged = []
        for s in steps:
            tagged.append({
                "goal_id": g["id"],
                "goal_title": g.get("title") or "Goal",
                "title": s.get("title") or "Task",
                "minutes": int(s.get("minutes") or 25),
                "details": s.get("details") or "",
            })
        buckets.append(tagged)

    merged: List[dict] = []
    total = 0

    # Round robin interleave
    idx = 0
    while len(merged) < hard_max_steps:
        progressed = False
        for b in buckets:
            if idx < len(b):
                candidate = b[idx]
                m = int(candidate["minutes"])
                if total + m <= max_total_minutes:
                    merged.append(candidate)
                    total += m
                progressed = True
                if len(merged) >= hard_max_steps:
                    break
        if not progressed:
            break
        idx += 1

    # Summary
    goal_titles = [gp["goal"].get("title") for gp in goal_plans if gp.get("goal")]
    goal_titles = [t for t in goal_titles if t]
    summary = f"Today’s routine balances: " + ", ".join(goal_titles[:4]) + ("…" if len(goal_titles) > 4 else "")

    return {"steps": merged, "total_minutes": total, "summary": summary}


def _validate_critic_json(text: str) -> dict:
    obj = _json_load_or_raise(text, "critic")
    for k in ("ok", "issues", "suggested_edits"):
        if k not in obj:
            raise ValueError(f"critic: missing '{k}'. raw={text[:1200]}")
    cr = CriticReview.model_validate(obj) if hasattr(CriticReview, "model_validate") else CriticReview.parse_obj(obj)
    return cr.model_dump() if hasattr(cr, "model_dump") else cr.dict()


def _now_in_tz(tz_name: str) -> datetime:
    if ZoneInfo is not None:
        return datetime.now(ZoneInfo(tz_name))
    # fallback: UTC aware
    return datetime.now(timezone.utc)


def _safe_opik_update_trace(*, input_obj: dict, output_obj: dict, metadata: dict, tags: List[str]) -> None:
    try:
        opik_context.update_current_trace(
            input=input_obj,
            output=output_obj,
            metadata=metadata,
            tags=tags,
        )
    except Exception:
        # Never fail the API because of tracing.
        return


def schedule_calendar_from_steps(
    *,
    user_id: str,
    steps: List[dict],
    start_in_minutes: int,
    sb: Client,
    goal_id: Optional[str] = None,
    agent_run_id: Optional[str] = None,
    tz_name: Optional[str] = None,
) -> tuple[list, Optional[str]]:
    calendar_events = []
    calendar_error = None

    try:
        tz_name = _safe_tz(tz_name)
        if ZoneInfo:
            now_local = datetime.now(ZoneInfo(tz_name))
            
        else:
            now_local = datetime.now(timezone.utc)
            tz_name = "UTC"

        cursor = now_local + timedelta(minutes=int(start_in_minutes or 5))

        for s in steps:
            mins = int(s.get("minutes", 25))
            if mins < 10:
                # Don’t create noisy 2–5 min events
                continue

            start_dt = cursor
            end_dt = cursor + timedelta(minutes=mins)

            evt = google_create_event(
                user_id=user_id,
                title=f"commitAI: {s.get('title', 'Task')}",
                details=s.get("details", ""),
                start=start_dt,
                end=end_dt,
                time_zone=tz_name,
            )

            calendar_events.append({
                "step_title": s.get("title"),
                "event_id": evt.get("id"),
                "htmlLink": evt.get("htmlLink"),
                "start": start_dt.isoformat(),
                "end": end_dt.isoformat(),
            })

            # ✅ add breathing room between blocks
            cursor = end_dt + timedelta(minutes=10)

        # ledger (optional)
        if agent_run_id and goal_id:
            sb.table("actions").insert({
                "user_id": user_id,
                "goal_id": goal_id,
                "agent_run_id": agent_run_id,
                "kind": "calendar_create_events",
                "payload": {"steps": steps},
                "status": "done",
                "result": {"calendar_events": calendar_events},
                "created_at": datetime.now(timezone.utc).isoformat(),
            }).execute()

    except Exception as e:
        calendar_error = str(e)

    return calendar_events, calendar_error

def _ensure_item_ids(plan: dict) -> dict:
    """Ensure each daily item has a stable id for checklist + calendar mapping."""
    items = plan.get("items") or []
    for it in items:
        if not it.get("item_id"):
            it["item_id"] = str(uuid.uuid4())
    plan["items"] = items
    return plan

def _build_daily_memory(sb: Client, user_id: str, goals: List[dict]) -> str:
    """Combine memory across goals (MVP)."""
    chunks = []
    for g in goals[:6]:
        try:
            chunks.append(build_memory(sb, user_id, g["id"]))
        except Exception:
            continue
    joined = "\n\n---\n\n".join(chunks)
    return joined[:2500]

def _inject_habit_items_if_missing(plan: dict, goals: List[dict]) -> dict:
    """
    Guardrail: if a goal title looks like a habit (e.g., water) and the plan didn't create recurring habit,
    inject a habit item so it ALWAYS appears in the plan UI.
    """
    items = plan.get("items") or []
    covered = set()
    for it in items:
        for gid in (it.get("goal_ids") or []):
            covered.add(gid)

    for g in goals:
        gid = g.get("id")
        title = (g.get("title") or "").lower()
        cadence = int(g.get("cadence_per_day") or 1)

        if not gid or gid in covered:
            continue

        # Heuristic: water/hydration or high-cadence goals become habits
        is_water = any(k in title for k in ["water", "hydrate", "hydration"])
        is_habit = is_water or cadence >= 3

        if is_habit:
            occ = min(max(cadence, 3), 8)  # cap for noise control
            items.append({
                "item_id": str(uuid.uuid4()),
                "title": f"{g.get('title')} (check-in)",
                "minutes": 2,
                "details": "Quick 10-second action. Log it immediately so the plan stays accurate.",
                "goal_ids": [gid],
                "kind": "habit",
                "window": "any",
                "occurrences": occ,
                "min_gap_minutes": max(60, 600 // occ),
            })
        else:
            # fallback: at least one focus item
            items.append({
                "item_id": str(uuid.uuid4()),
                "title": f"Progress on: {g.get('title')}",
                "minutes": 25,
                "details": "Do the smallest meaningful next step.",
                "goal_ids": [gid],
                "kind": "focus",
                "window": "any",
                "occurrences": 1,
                "min_gap_minutes": 60,
            })

    plan["items"] = items
    return plan



# -------------------------
# Preference + policy + memory
# -------------------------
def compute_preference_profile(sb: Client, user_id: str, goal_id: str) -> dict:
    fb_res = (
        sb.table("feedback")
        .select("created_at,agent_run_id,helpful,comment")
        .eq("user_id", user_id)
        .order("created_at", desc=True)
        .limit(30)
        .execute()
    )
    feedback = fb_res.data or []

    runs_res = (
        sb.table("agent_runs")
        .select("id,created_at,state,selected_agent,summary")
        .eq("user_id", user_id)
        .eq("goal_id", goal_id)
        .order("created_at", desc=True)
        .limit(20)
        .execute()
    )
    runs = runs_res.data or []
    run_by_id = {r["id"]: r for r in runs if r.get("id")}

    helpful_vals = [f.get("helpful") for f in feedback if f.get("helpful") is not None]
    helpful_rate = (sum(1 for v in helpful_vals if v) / max(1, len(helpful_vals))) if helpful_vals else None

    agent_scores = {"deep_work": [], "maintenance": [], "recovery": [], "triage": []}
    for f in feedback:
        rid = f.get("agent_run_id")
        if not rid or rid not in run_by_id:
            continue
        agent = run_by_id[rid].get("selected_agent")
        if agent in agent_scores and f.get("helpful") is not None:
            agent_scores[agent].append(bool(f["helpful"]))

    agent_helpful_rate: Dict[str, float] = {}
    for agent, vals in agent_scores.items():
        if vals:
            agent_helpful_rate[agent] = sum(1 for v in vals if v) / len(vals)

    comments = " ".join([(f.get("comment") or "") for f in feedback]).lower()
    prefers_short = any(k in comments for k in ["too long", "shorter", "too much", "long plan"])
    wants_specific = any(k in comments for k in ["generic", "more specific", "too vague", "concrete"])
    blocker_first = any(k in comments for k in ["blocker", "blockers", "stuck", "can't start", "unblocked"])

    return {
        "helpful_rate_last30": helpful_rate,
        "agent_helpful_rate": agent_helpful_rate,
        "prefers_short_plans": prefers_short,
        "wants_more_specific_steps": wants_specific,
        "prefers_blocker_first": blocker_first,
    }


def apply_policy(req_payload: dict, route: dict, prefs: dict) -> dict:
    selected_agent = route["selected_agent"]
    state = route["state"]

    max_steps = 5
    min_total = 15
    max_total = 60

    if prefs.get("prefers_short_plans"):
        max_steps = 4
        max_total = 40

    if int(req_payload.get("energy", 3)) <= 2:
        max_steps = min(max_steps, 4)
        max_total = min(max_total, 35)

    if state == "INCIDENT" or selected_agent == "triage":
        max_steps = min(max_steps, 4)
        max_total = min(max_total, 30)

    requirements: List[str] = []
    if (req_payload.get("blockers") or "").strip():
        requirements.append("include a step that reduces/removes blockers early")
    if prefs.get("prefers_blocker_first"):
        requirements.append("make the first step address blockers (if any)")
    if prefs.get("wants_more_specific_steps"):
        requirements.append("steps must be concrete, non-generic, include a clear first action")

    # Learned caps (hard constraints)
    if prefs.get("pref_max_steps") is not None:
        max_steps = min(max_steps, int(prefs["pref_max_steps"]))
    if prefs.get("pref_max_total_minutes") is not None:
        max_total = min(max_total, int(prefs["pref_max_total_minutes"]))

    return {
        "selected_agent": selected_agent,
        "state": state,
        "constraints": {
            "max_steps": max_steps,
            "min_total_minutes": min_total,
            "max_total_minutes": max_total,
        },
        "requirements": requirements,
        "prefs": prefs,
    }


def build_memory(sb: Client, user_id: str, goal_id: str) -> str:
    checkins = (
        sb.table("checkins")
        .select("checkin_date,energy,workload,blockers,completed")
        .eq("user_id", user_id)
        .eq("goal_id", goal_id)
        .order("checkin_date", desc=True)
        .limit(7)
        .execute()
        .data
        or []
    )

    runs = (
        sb.table("agent_runs")
        .select("created_at,state,selected_agent,summary,opik_trace_id")
        .eq("user_id", user_id)
        .eq("goal_id", goal_id)
        .order("created_at", desc=True)
        .limit(5)
        .execute()
        .data
        or []
    )

    feedback = (
        sb.table("feedback")
        .select("created_at,agent_run_id,helpful,comment")
        .eq("user_id", user_id)
        .order("created_at", desc=True)
        .limit(10)
        .execute()
        .data
        or []
    )

    lines: List[str] = []
    lines.append("RECENT_CHECKINS (newest first):")
    if not checkins:
        lines.append("- none")
    else:
        for c in checkins:
            blockers = (c.get("blockers") or "").strip()
            blockers_txt = f" blockers='{blockers[:80]}'" if blockers else ""
            lines.append(
                f"- {c.get('checkin_date')}: energy={c.get('energy')} workload={c.get('workload')}"
                f" completed={c.get('completed')}{blockers_txt}"
            )

    lines.append("\nRECENT_AGENT_RUNS (newest first):")
    if not runs:
        lines.append("- none")
    else:
        for r in runs:
            summary = (r.get("summary") or "").strip()
            lines.append(
                f"- {r.get('created_at')}: agent={r.get('selected_agent')} state={r.get('state')} "
                f"summary='{summary[:120]}'"
            )

    lines.append("\nRECENT_FEEDBACK (newest first):")
    if not feedback:
        lines.append("- none")
    else:
        helpful_vals = [f.get("helpful") for f in feedback if f.get("helpful") is not None]
        if helpful_vals:
            helpful_rate = sum(1 for v in helpful_vals if v) / max(1, len(helpful_vals))
            lines.append(f"- helpful_rate_last10={helpful_rate:.2f}")
        for f in feedback[:5]:
            cmt = (f.get("comment") or "").strip()
            cmt_txt = f" comment='{cmt[:80]}'" if cmt else ""
            lines.append(f"- {f.get('created_at')}: helpful={f.get('helpful')}{cmt_txt}")

    return "\n".join(lines)[:2500]


def load_user_prefs(sb: Client, user_id: str, goal_id: str) -> Optional[dict]:
    res = (
        sb.table("user_prefs")
        .select("*")
        .eq("user_id", user_id)
        .eq("goal_id", goal_id)
        .limit(1)
        .execute()
    )
    rows = res.data or []
    return rows[0] if rows else None


def derive_user_prefs_from_profile(profile: dict) -> dict:
    pref_max_total = 60
    pref_max_steps = 5

    if profile.get("prefers_short_plans"):
        pref_max_total = 40
        pref_max_steps = 4

    avoid_agents: List[str] = []
    ahr = profile.get("agent_helpful_rate") or {}
    for agent, rate in ahr.items():
        try:
            if float(rate) < 0.40:
                avoid_agents.append(agent)
        except Exception:
            pass

    return {
        "pref_max_total_minutes": pref_max_total,
        "pref_max_steps": pref_max_steps,
        "pref_blocker_first": bool(profile.get("prefers_blocker_first")),
        "pref_more_specific": bool(profile.get("wants_more_specific_steps")),
        "helpful_rate_last30": profile.get("helpful_rate_last30"),
        "agent_helpful_rate": ahr,
        "avoid_agents": avoid_agents,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }


def upsert_user_prefs(sb: Client, user_id: str, goal_id: str) -> dict:
    profile = compute_preference_profile(sb, user_id, goal_id)
    derived = derive_user_prefs_from_profile(profile)

    row = {"user_id": user_id, "goal_id": goal_id, **derived}
    res = sb.table("user_prefs").upsert(row, on_conflict="user_id,goal_id").execute()
    return (res.data or [row])[0]

def _day_window_bounds(now_local: datetime, window: str):
    # simple fixed windows; you can refine later
    y, m, d = now_local.year, now_local.month, now_local.day
    if window == "morning":
        return now_local.replace(hour=9, minute=0, second=0, microsecond=0), now_local.replace(hour=12, minute=0, second=0, microsecond=0)
    if window == "midday":
        return now_local.replace(hour=12, minute=0, second=0, microsecond=0), now_local.replace(hour=14, minute=0, second=0, microsecond=0)
    if window == "afternoon":
        return now_local.replace(hour=14, minute=0, second=0, microsecond=0), now_local.replace(hour=18, minute=0, second=0, microsecond=0)
    if window == "evening":
        return now_local.replace(hour=18, minute=0, second=0, microsecond=0), now_local.replace(hour=22, minute=0, second=0, microsecond=0)
    # any
    return now_local.replace(hour=9, minute=0, second=0, microsecond=0), now_local.replace(hour=22, minute=0, second=0, microsecond=0)


def schedule_daily_items(items: List[dict], *, now_local: datetime, start_in_minutes: int, buffer_minutes: int = 5,busy: Optional[List[tuple]] = None,) -> List[dict]:
    """
    Deterministic scheduler:
    - focus blocks: placed sequentially starting at cursor within their window
    - habit blocks: spread across window/horizon with min_gap enforcement
    """
    
    busy = busy or []
    busy_sorted = sorted(busy, key=lambda x: x[0])

    def _overlaps(a_start: datetime, a_end: datetime, b_start: datetime, b_end: datetime) -> bool:
        return a_start < b_end and a_end > b_start

    def _shift_to_free(start_dt: datetime, duration_min: int) -> datetime:
        """
        Push start_dt forward until [start, start+duration] doesn't overlap any busy interval.
        Assumes busy is merged + sorted.
        """
        end_dt = start_dt + timedelta(minutes=duration_min)

        i = 0
        while i < len(busy):
            b_st, b_en = busy[i]
            if _overlaps(start_dt, end_dt, b_st, b_en):
                start_dt = b_en + timedelta(minutes=buffer_minutes)
                end_dt = start_dt + timedelta(minutes=duration_min)
                # restart scan (or advance carefully)
                i = 0
                continue
            i += 1
        return start_dt

    cursor = now_local + timedelta(minutes=int(start_in_minutes or 0))
    scheduled: List[dict] = []
    
    busy = busy or []
    # ensure busy sorted
    busy_sorted = sorted(busy, key=lambda x: x[0])

    # split
    habits = [it for it in items if it.get("kind") == "habit" and int(it.get("occurrences", 1)) > 1]
    focus = [it for it in items if it not in habits]

    # 1) schedule focus sequentially
    for it in focus:
        w = it.get("window", "any")
        w_start, w_end = _day_window_bounds(now_local, w)

        dur = int(it.get("minutes", 25))
        start_dt = max(cursor, w_start)
        start_dt = _push_past_busy(start_dt, int(it.get("minutes", 25)), busy_sorted, buffer_min=buffer_minutes)
        end_dt = start_dt + timedelta(minutes=int(it.get("minutes", 25)))
        
        t = _shift_to_free(t, dur)

        # if it spills beyond window, just keep it (MVP) or clamp later
        scheduled.append({
            "item_id": it.get("item_id"),
            "title": it.get("title"),
            "details": it.get("details", ""),
            "goal_ids": it.get("goal_ids", []),
            "kind": it.get("kind", "focus"),
            "start": start_dt.isoformat(),
            "end": end_dt.isoformat(),
        })
        cursor = end_dt + timedelta(minutes=buffer_minutes)

    # helper: check min gap conflicts for same habit title
    def _conflicts(title: str, t: datetime, min_gap: int):
        for s in scheduled:
            if s["title"] != title:
                continue
            st = datetime.fromisoformat(s["start"])
            if abs((t - st).total_seconds()) < min_gap * 60:
                return True
        return False

    # 2) schedule habits spread out
    for it in habits:
        w = it.get("window", "any")
        w_start, w_end = _day_window_bounds(now_local, w)

        occ = int(it.get("occurrences", 1))
        min_gap = int(it.get("min_gap_minutes", 120))
        dur = int(it.get("minutes", 2))

        # horizon for spacing = from max(now,cursor,w_start) to w_end
        start_base = max(now_local, cursor, w_start)
        total_span = max(1, int((w_end - start_base).total_seconds() // 60))
        step = max(min_gap, total_span // occ)

        t = start_base
        for _ in range(occ):
            # find next non-conflicting slot
            t = _push_past_busy(t, dur, busy_sorted, buffer_min=buffer_minutes)
            tries = 0
            while _conflicts(it["title"], t, min_gap) and tries < 10:
                t = t + timedelta(minutes=15)
                t = _push_past_busy(t, dur, busy_sorted, buffer_min=buffer_minutes)
                tries += 1

            scheduled.append({
                "item_id": it.get("item_id"),  # ✅ NEW LINE
                "title": it.get("title"),
                "details": it.get("details", ""),
                "goal_ids": it.get("goal_ids", []),
                "kind": "habit",
                "start": t.isoformat(),
                "end": (t + timedelta(minutes=dur)).isoformat(),
            })

            t = t + timedelta(minutes=step)

    # sort by time
    scheduled.sort(key=lambda x: x["start"])
    return scheduled



# -------------------------
# Endpoints: runs + feedback
# -------------------------

@app.get("/api/daily/tasks")
def list_daily_tasks(user_id: str, daily_run_id: str):
    res = (
        sb.table("daily_tasks")
        .select("item_id,completed,completed_at,title,minutes,kind,time_window,goal_ids,details")
        .eq("user_id", user_id)
        .eq("daily_run_id", daily_run_id)
        .order("created_at", desc=False)
        .execute()
    )
    rows = res.data or []         

    for r in rows:
        r["window"] = r.get("time_window")   # keep frontend unchanged
        # optional: remove the DB field so frontend only sees "window"
        r.pop("time_window", None)
        
    return {"tasks": rows}


@app.get("/api/daily/today")
def daily_today(user_id: str, tz_name: str = "America/Detroit"):
    tz_name = _safe_tz(tz_name)
    now_local = datetime.now(ZoneInfo(tz_name))
    today = now_local.date().isoformat()

    rows = (
        sb.table("daily_runs")
        .select("id,user_id,run_date,plan_json,schedule_json,created_at")
        .eq("user_id", user_id)
        .eq("run_date", today)
        .order("created_at", desc=True)
        .limit(5)
        .execute()
        .data
        or []
    )
    if not rows:
        return {"found": False}

    # prefer COMMITTED if present, else latest
    def _status(r):
        return ((r.get("plan_json") or {}).get("_meta") or {}).get("status") or "DRAFT"

    committed = [r for r in rows if str(_status(r)).upper() == "COMMITTED"]
    chosen = committed[0] if committed else rows[0]

    plan = chosen.get("plan_json") or {}
    items = plan.get("items") or []
    schedule = chosen.get("schedule_json") or []

    return {
        "found": True,
        "daily_run_id": chosen.get("id"),
        "summary": plan.get("summary") or "",
        "items": items,
        "schedule": schedule,
        "calendar_events": [],   # optional
        "calendar_error": None,  # optional
        "status": ((plan.get("_meta") or {}).get("status") or "DRAFT"),
        "version": int(((plan.get("_meta") or {}).get("version") or 1)),
    }


@app.get("/api/runs/recent")
def recent_runs(user_id: str, limit: int = 10):
    try:
        runs = (
            sb.table("agent_runs")
            .select("id,created_at,state,selected_agent,summary,opik_trace_id")
            .eq("user_id", user_id)
            .order("created_at", desc=True)
            .limit(limit)
            .execute()
            .data
            or []
        )

        run_ids = [r["id"] for r in runs if r.get("id")]
        fb_latest: Dict[str, Any] = {}

        if run_ids:
            fb = (
                sb.table("feedback")
                .select("agent_run_id,helpful,comment,created_at")
                .in_("agent_run_id", run_ids)
                .order("created_at", desc=True)
                .execute()
                .data
                or []
            )
            for f in fb:
                rid = f["agent_run_id"]
                if rid not in fb_latest:
                    fb_latest[rid] = f

        for r in runs:
            r["feedback"] = fb_latest.get(r["id"])

        return {"runs": runs}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@track(project_name=OPIK_PROJECT, name="submit_feedback", flush=True)
def feedback_traced(payload: dict) -> dict:
    return payload


@app.post("/api/feedback")
def submit_feedback(req: FeedbackRequest):
    try:
        payload = _dump_model(req)
        feedback_traced(payload)

        sb.table("feedback").insert(
            {
                "user_id": req.user_id,
                "agent_run_id": req.agent_run_id,
                "opik_trace_id": req.opik_trace_id,
                "helpful": req.helpful,
                "comment": req.comment.strip() if req.comment else None,
                "created_at": datetime.now(timezone.utc).isoformat(),
            }
        ).execute()

        run_rows = (
            sb.table("agent_runs")
            .select("goal_id")
            .eq("id", req.agent_run_id)
            .limit(1)
            .execute()
            .data
            or []
        )
        if run_rows and run_rows[0].get("goal_id"):
            upsert_user_prefs(sb, req.user_id, run_rows[0]["goal_id"])

        return {"status": "ok"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/integrations/google/test_event")
def test_event(user_id: str):
    now = datetime.now(timezone.utc)
    evt = google_create_event(
        user_id=user_id,
        title="commitAI test event",
        details="If you see this, calendar integration works ✅",
        start=now + timedelta(minutes=5),
        end=now + timedelta(minutes=25),
        time_zone="America/Detroit",
    )
    return {"created": True, "event_id": evt.get("id"), "htmlLink": evt.get("htmlLink")}


# -------------------------
# Agents (router -> planner -> critic -> reviser loop)
# -------------------------
@track(project_name=OPIK_PROJECT, name="router", flush=True)
def router_agent(req_payload: dict) -> dict:
    completed = bool(req_payload.get("completed"))
    energy = int(req_payload.get("energy", 3))
    workload = int(req_payload.get("workload", 3))

    if completed:
        return {"state": "NORMAL", "selected_agent": "maintenance"}
    if energy <= 2 and workload >= 4:
        return {"state": "INCIDENT", "selected_agent": "triage"}
    if energy <= 2:
        return {"state": "RECOVERY", "selected_agent": "recovery"}
    if workload >= 4:
        return {"state": "AT_RISK", "selected_agent": "deep_work"}
    return {"state": "NORMAL", "selected_agent": "deep_work"}


def _agent_constraints(selected_agent: str) -> dict:
    return {
        "maintenance": {"max_steps": 3, "min_total": 8, "max_total": 20},
        "triage": {"max_steps": 4, "min_total": 10, "max_total": 35},
        "recovery": {"max_steps": 4, "min_total": 10, "max_total": 35},
        "deep_work": {"max_steps": 5, "min_total": 15, "max_total": 60},
    }.get(selected_agent, {"max_steps": 5, "min_total": 15, "max_total": 60})


@track(project_name=OPIK_PROJECT, name="planner_llm", flush=True)
def planner_agent_llm(req_payload: dict, policy: dict, context: dict) -> dict:
    system = (
        "You are CommitAI Planner.\n"
        "Return ONLY valid JSON.\n"
        "The ROOT JSON object MUST contain ONLY these keys: steps, total_minutes, summary.\n"
        "Each step MUST be an object with keys: title, minutes, details.\n"
        "No wrapper keys like plan/output/result.\n"
        "No extra keys. No markdown."
    )

    user = f"""
Schema:
{{
  "steps": [{{"title": "string", "minutes": 25, "details": "string"}}],
  "total_minutes": 50,
  "summary": "string"
}}

Constraints:
- steps count: 2..{policy["constraints"]["max_steps"]}
- total_minutes between {policy["constraints"]["min_total_minutes"]} and {policy["constraints"]["max_total_minutes"]}
- must obey requirements: {policy["requirements"]}

Context:
goal={context.get("goal")}
memory={context.get("memory")}

Today:
energy={req_payload.get("energy")}
workload={req_payload.get("workload")}
blockers={req_payload.get("blockers")}
completed={req_payload.get("completed")}
"""

    resp = client.chat.completions.create(
        model=OPENAI_MODEL,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        response_format={"type": "json_object"},
        temperature=0.4,
    )
    text = resp.choices[0].message.content or "{}"
    return _validate_plan_json(text)


@track(project_name=OPIK_PROJECT, name="daily_planner_llm", flush=True)
def daily_planner_llm(req_payload: dict, goals: List[dict], memory: str) -> dict:
    prompt = f"""
You are CommitAI Daily Planner.

You must produce ONE cohesive plan that covers ALL goals listed.

Return ONLY valid JSON:
{{
  "summary": "...",
  "items": [
    {{
      "title": "...",
      "minutes": 25,
      "details": "...",
      "goal_ids": ["..."],
      "kind": "focus" | "habit",
      "window": "morning" | "midday" | "afternoon" | "evening" | "any",
      "occurrences": 1,
      "min_gap_minutes": 120
    }}
  ]
}}

Hard rules:
- Every goal must appear in at least ONE item (goal_ids must include that goal's id).
- Habits (like water) should be kind="habit" with occurrences>1 and min_gap_minutes>=90.
- Focus work should be kind="focus" with realistic minutes.
- JSON only. No extra keys. No markdown.

User state:
energy={req_payload.get("energy")}
workload={req_payload.get("workload")}
blockers={req_payload.get("blockers")}

Goals (id/title/cadence):
{json.dumps(goals)}

Recent memory:
{memory[:1500]}
"""

    resp = client.chat.completions.create(
        model=OPENAI_MODEL or "gpt-4o-mini",
        messages=[{"role": "user", "content": prompt}],
        response_format={"type": "json_object"},
        temperature=0.3,
    )
    text = resp.choices[0].message.content or "{}"
    plan = _validate_daily_plan_json(text)

    # enforce coverage (quick guardrail)
    goal_ids = {g["id"] for g in goals if g.get("id")}
    covered = set()
    for it in plan.get("items", []):
        for gid in it.get("goal_ids", []):
            covered.add(gid)
    missing = [gid for gid in goal_ids if gid not in covered]
    if missing:
        raise ValueError(f"daily_planner: missing goal coverage for goal_ids={missing}")

    return plan


@track(project_name=OPIK_PROJECT, name="daily_rescheduler_llm", flush=True)
def daily_rescheduler_llm(
    *,
    req_payload: dict,
    goals: List[dict],
    memory: str,
    prev_plan: dict,
    completed_item_ids: List[str],
    now_local_iso: str,
) -> dict:
    """
    Reschedule for the REST OF TODAY:
    - Remove completed items
    - Revise remaining items based on new check-in (energy/workload/blockers)
    - Keep item_id stable when possible
    """
    # shrink prev_plan so prompt stays small
    prev_items = (prev_plan.get("items") or [])[:20]
    completed_set = set(completed_item_ids or [])

    completed_titles = []
    for it in prev_items:
        if it.get("item_id") in completed_set:
            completed_titles.append({"item_id": it.get("item_id"), "title": it.get("title")})

    prompt = f"""
You are CommitAI Daily Rescheduler.

Goal: Update the plan for the REST OF TODAY based on:
- User's new check-in state
- What items were completed so far
- Keep the plan cohesive across all goals

Return ONLY valid JSON:
{{
  "summary": "...",
  "items": [
    {{
      "item_id": "string or null",
      "title": "...",
      "minutes": 25,
      "details": "...",
      "goal_ids": ["..."],
      "kind": "focus" | "habit",
      "window": "morning" | "midday" | "afternoon" | "evening" | "any",
      "occurrences": 1,
      "min_gap_minutes": 120
    }}
  ]
}}

Hard rules:
- EXCLUDE completed items (completed_item_ids listed below).
- For remaining items, KEEP item_id the same if you keep that item (stability matters).
- You MAY reorder items, shorten/expand minutes, change windows, or add new items.
- If energy is low or workload is high, reduce total load (shorter plan, fewer focus blocks).
- If blockers exist, include an early action that reduces blockers.
- Habits (like water) should be kind="habit" with occurrences>1 and min_gap_minutes>=90.
- Cover all goals reasonably: every goal should appear in at least one remaining item (unless the day is clearly overloaded — then keep at least the most important per goal).
- Max 20 items. JSON only. No markdown. No extra keys.

Now (local): {now_local_iso}

User state:
energy={req_payload.get("energy")}
workload={req_payload.get("workload")}
blockers={req_payload.get("blockers")}

Goals (id/title/cadence):
{json.dumps(goals)}

Completed items (ids + titles):
{json.dumps(completed_titles)}

completed_item_ids:
{json.dumps(list(completed_set))}

Previous plan (items):
{json.dumps(prev_items)}

Recent memory:
{memory[:1500]}
"""

    resp = client.chat.completions.create(
        model=OPENAI_MODEL,
        messages=[{"role": "user", "content": prompt}],
        response_format={"type": "json_object"},
        temperature=0.25,
    )
    text = resp.choices[0].message.content or "{}"
    plan = _validate_daily_plan_json(text)
    return plan



@track(project_name=OPIK_PROJECT, name="daily_reviser_llm", flush=True)
def daily_reviser_llm(*, req_payload: dict, goals: List[dict], memory: str, prev_plan: dict, feedback: str) -> dict:
    prompt = f"""
You are CommitAI Daily Plan Reviser.

You will revise the EXISTING plan based on user feedback.
You must still cover ALL goals.

Return ONLY valid JSON:
{{
  "summary": "...",
  "items": [
    {{
      "item_id": "string or null",
      "title": "...",
      "minutes": 25,
      "details": "...",
      "goal_ids": ["..."],
      "kind": "focus" | "habit",
      "window": "morning" | "midday" | "afternoon" | "evening" | "any",
      "occurrences": 1,
      "min_gap_minutes": 120
    }}
  ]
}}

Hard rules:
- Every goal must appear in at least ONE item (goal_ids must include that goal's id).
- If feedback says "too much", shorten total load (reduce minutes/blocks).
- If feedback says "move X earlier/later", change windows accordingly.
- Habits (like water) should be kind="habit" with occurrences>1 and min_gap_minutes>=90.
- Keep items <= 20. Avoid fluff. JSON only.

User state:
energy={req_payload.get("energy")}
workload={req_payload.get("workload")}
blockers={req_payload.get("blockers")}

Goals:
{json.dumps(goals)}

Previous plan:
{json.dumps(prev_plan)[:2500]}

User feedback:
{feedback}

Recent memory:
{memory[:1500]}
"""
    resp = client.chat.completions.create(
        model=OPENAI_MODEL,
        messages=[{"role": "user", "content": prompt}],
        response_format={"type": "json_object"},
        temperature=0.25,
    )
    text = resp.choices[0].message.content or "{}"
    plan = _validate_daily_plan_json(text)
    plan = _ensure_item_ids(plan)
    plan = _inject_habit_items_if_missing(plan, goals)

    # coverage guardrail
    goal_ids = {g["id"] for g in goals if g.get("id")}
    covered = set()
    for it in plan.get("items", []):
        for gid in it.get("goal_ids", []):
            covered.add(gid)
    missing = [gid for gid in goal_ids if gid not in covered]
    if missing:
        raise ValueError(f"daily_reviser: missing goal coverage for goal_ids={missing}")

    return plan



@track(project_name=OPIK_PROJECT, name="critic_rule", flush=True)
def critic_rule(plan: dict, selected_agent: str) -> dict:
    steps = plan.get("steps") or []
    total = int(plan.get("total_minutes") or 0)

    c = _agent_constraints(selected_agent)
    issues: List[str] = []

    if not steps:
        issues.append("No steps produced.")
    if len(steps) < 2:
        issues.append("Plan must have at least 2 steps.")
    if len(steps) > c["max_steps"]:
        issues.append(f"Too many steps ({len(steps)}). Max {c['max_steps']}.")
    if total < c["min_total"]:
        issues.append(f"Plan too short ({total} min). Target >= {c['min_total']}.")
    if total > c["max_total"]:
        issues.append(f"Plan too long ({total} min). Target <= {c['max_total']}.")

    return {"ok": len(issues) == 0, "issues": issues}


@track(project_name=OPIK_PROJECT, name="critic_llm", flush=True)
def critic_llm(context: dict, state: str, selected_agent: str, policy: dict, plan: dict) -> dict:
    system = (
        "You are a strict planning critic for a productivity autopilot.\n"
        "Return ONLY valid JSON with keys: ok, issues, suggested_edits.\n"
        "Be concrete and actionable. No markdown."
    )

    payload = {
        "state": state,
        "selected_agent": selected_agent,
        "constraints": policy["constraints"],
        "requirements": policy["requirements"],
        "context": {
            "goal": context.get("goal"),
            "memory": context.get("memory"),
        },
        "plan": plan,
        "rubric": [
            "Steps must be specific and actionable.",
            "Time must be realistic for the state/agent.",
            "If blockers exist, plan should address them.",
            "Avoid vague fluff. Avoid unsafe advice.",
        ],
        "schema": {"ok": True, "issues": ["string"], "suggested_edits": ["string"]},
    }

    resp = client.chat.completions.create(
        model=OPENAI_MODEL,
        temperature=0.2,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": json.dumps(payload)},
        ],
    )
    text = resp.choices[0].message.content or "{}"
    return _validate_critic_json(text)


@track(project_name=OPIK_PROJECT, name="reviser_llm", flush=True)
def reviser_agent_llm(req_payload: dict, policy: dict, crit_issues: list, context: dict) -> dict:
    system = (
        "You are CommitAI Reviser.\n"
        "Fix the plan based on critic issues.\n"
        "Return ONLY valid JSON.\n"
        "The ROOT JSON object MUST contain ONLY these keys: steps, total_minutes, summary.\n"
        "Each step MUST be an object with keys: title, minutes, details.\n"
        "No wrapper keys. No extra keys. No markdown."
    )

    user = f"""
Critic issues:
{crit_issues}

Constraints:
- steps count: 2..{policy["constraints"]["max_steps"]}
- total_minutes between {policy["constraints"]["min_total_minutes"]} and {policy["constraints"]["max_total_minutes"]}
- requirements: {policy["requirements"]}

Context:
goal={context.get("goal")}
memory={context.get("memory")}

Today:
energy={req_payload.get("energy")}
workload={req_payload.get("workload")}
blockers={req_payload.get("blockers")}
completed={req_payload.get("completed")}
"""

    resp = client.chat.completions.create(
        model=OPENAI_MODEL,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        response_format={"type": "json_object"},
        temperature=0.3,
    )
    text = resp.choices[0].message.content or "{}"
    return _validate_plan_json(text)


MAX_ITERS = 3


@track(project_name=OPIK_PROJECT, name="run_agent_loop", flush=True)
def run_agent_loop(req_payload: dict, context: dict) -> dict:
    route = router_agent(req_payload)

    stored = load_user_prefs(sb, req_payload["user_id"], req_payload["goal_id"])
    if stored is None:
        stored = upsert_user_prefs(sb, req_payload["user_id"], req_payload["goal_id"])

    prefs = {
        "helpful_rate_last30": stored.get("helpful_rate_last30"),
        "agent_helpful_rate": stored.get("agent_helpful_rate") or {},
        "prefers_short_plans": bool(stored.get("pref_max_total_minutes") and int(stored["pref_max_total_minutes"]) <= 40),
        "wants_more_specific_steps": bool(stored.get("pref_more_specific")),
        "prefers_blocker_first": bool(stored.get("pref_blocker_first")),
        "pref_max_total_minutes": stored.get("pref_max_total_minutes"),
        "pref_max_steps": stored.get("pref_max_steps"),
        "avoid_agents": stored.get("avoid_agents") or [],
    }

    policy = apply_policy(req_payload, route, prefs)

    plan = planner_agent_llm(req_payload, policy, context)

    rule = critic_rule(plan, policy["selected_agent"])
    llm = critic_llm(
        context=context,
        state=policy["state"],
        selected_agent=policy["selected_agent"],
        policy=policy,
        plan=plan,
    )

    merged_issues: List[str] = []
    for src in (rule.get("issues", []) or []):
        if src not in merged_issues:
            merged_issues.append(src)
    for src in (llm.get("issues", []) or []):
        if src not in merged_issues:
            merged_issues.append(src)

    iters = 0
    ok = bool(rule.get("ok", False)) and bool(llm.get("ok", False))
    while (not ok) and iters < MAX_ITERS:
        plan = reviser_agent_llm(req_payload, policy, merged_issues, context)

        rule = critic_rule(plan, policy["selected_agent"])
        llm = critic_llm(
            context=context,
            state=policy["state"],
            selected_agent=policy["selected_agent"],
            policy=policy,
            plan=plan,
        )

        merged_issues = []
        for src in (rule.get("issues", []) or []):
            if src not in merged_issues:
                merged_issues.append(src)
        for src in (llm.get("issues", []) or []):
            if src not in merged_issues:
                merged_issues.append(src)

        ok = bool(rule.get("ok", False)) and bool(llm.get("ok", False))
        iters += 1

    return {
        "state": policy["state"],
        "selected_agent": policy["selected_agent"],
        "summary": plan["summary"],
        "steps": plan["steps"],
        "total_minutes": plan["total_minutes"],
        "iterations": iters,
        "critic_rule_ok": bool(rule.get("ok", False)),
        "critic_rule_issues": rule.get("issues", []) or [],
        "critic_llm_ok": bool(llm.get("ok", False)),
        "critic_llm_issues": llm.get("issues", []) or [],
        "critic_llm_suggested_edits": llm.get("suggested_edits", []) or [],
        "prefs_used": prefs,
        "policy_used": policy,
    }


# -------------------------
# Main traced autopilot
# -------------------------
@track(project_name=OPIK_PROJECT, name="run_autopilot", flush=True)
def run_autopilot_traced(req: RunAutopilotRequest) -> dict:
    t0 = time.time()

    trace = opik_context.get_current_trace_data()
    trace_id = trace.id if trace else None

    req_payload = _dump_model(req)

    goal_rows = (
        sb.table("goals")
        .select("id,title,cadence_per_day")
        .eq("id", req.goal_id)
        .limit(1)
        .execute()
        .data
        or []
    )
    goal = goal_rows[0] if goal_rows else None

    memory = build_memory(sb, req.user_id, req.goal_id)

    context = {"goal": goal, "today": req_payload, "memory": memory}

    result = run_agent_loop(req_payload=req_payload, context=context)

    lat_ms = int((time.time() - t0) * 1000)

    _safe_opik_update_trace(
        input_obj=req_payload,
        output_obj={
            "state": result["state"],
            "selected_agent": result["selected_agent"],
            "summary": result["summary"],
            "steps": result["steps"],
            "total_minutes": result["total_minutes"],
            "iterations": result["iterations"],
            "critic_rule_ok": result["critic_rule_ok"],
            "critic_llm_ok": result["critic_llm_ok"],
            "prefs_used": result["prefs_used"],
            "policy_used": result["policy_used"],
        },
        metadata={"latency_ms": lat_ms, "goal_id": req.goal_id, "checkin_id": req.checkin_id},
        tags=[
            result["state"],
            result["selected_agent"],
            f"rule_ok:{result['critic_rule_ok']}",
            f"llm_ok:{result['critic_llm_ok']}",
        ],
    )

    return {"opik_trace_id": trace_id, **result}


# -------------------------
# Calendar scheduling helper
# -------------------------
def schedule_plan_to_calendar(
    *,
    user_id: str,
    goal_id: str,
    agent_run_id: str,
    steps: List[dict],
    start_in_minutes: int,
    tz_name: str = "America/Detroit",
) -> Dict[str, Any]:
    """
    Single calendar scheduler (you had 2 duplicated ones). Returns events + optional error.
    """
    calendar_events: List[dict] = []
    calendar_error: Optional[str] = None

    try:
        now_local = _now_in_tz(tz_name)
        cursor = now_local + timedelta(minutes=int(start_in_minutes or 5))

        for s in steps:
            mins = int(s.get("minutes", 25))
            if mins < 5:
                continue

            start_dt = cursor
            end_dt = cursor + timedelta(minutes=mins)

            evt = google_create_event(
                user_id=user_id,
                title=f"commitAI: {s.get('title', 'Task')}",
                details=s.get("details", ""),
                start=start_dt,
                end=end_dt,
                time_zone=tz_name,
            )

            calendar_events.append(
                {
                    "step_title": s.get("title"),
                    "event_id": evt.get("id"),
                    "htmlLink": evt.get("htmlLink"),
                    "start": start_dt.isoformat(),
                    "end": end_dt.isoformat(),
                }
            )

            # buffer so they don't become visually glued together
            cursor = end_dt + timedelta(minutes=5)

        # action ledger
        sb.table("actions").insert(
            {
                "user_id": user_id,
                "goal_id": goal_id,
                "agent_run_id": agent_run_id,
                "kind": "calendar_create_events",
                "payload": {"steps": steps, "start_in_minutes": start_in_minutes, "tz": tz_name},
                "status": "done",
                "result": {"calendar_events": calendar_events},
                "created_at": datetime.now(timezone.utc).isoformat(),
            }
        ).execute()

    except Exception as e:
        calendar_error = str(e)

    return {
        "calendar_events": calendar_events,
        "calendar_error": calendar_error,
        "created_event_ids": [e.get("event_id") for e in calendar_events if e.get("event_id")],
    }


# -------------------------
# API: run autopilot + persist
# -------------------------
@app.post("/api/run_autopilot")
def run_autopilot(req: RunAutopilotRequest):
    try:
        result = run_autopilot_traced(req)

        trace_id = result.get("opik_trace_id")
        state = result["state"]
        agent = result["selected_agent"]
        steps = result["steps"]
        total_minutes = result["total_minutes"]
        summary = result["summary"]

        # 1) store run
        run_insert = {
            "user_id": req.user_id,
            "goal_id": req.goal_id,
            "checkin_id": req.checkin_id,
            "state": state,
            "selected_agent": agent,
            "score": None,
            "opik_trace_id": trace_id,
            "summary": summary,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        run_res = sb.table("agent_runs").insert(run_insert).execute()
        run_row = (run_res.data or [None])[0]
        if not run_row or "id" not in run_row:
            raise RuntimeError("Failed to insert agent_run")
        agent_run_id = run_row["id"]

        # 2) create tasks
        task_rows = [
            {
                "user_id": req.user_id,
                "goal_id": req.goal_id,
                "agent_run_id": agent_run_id,
                "title": s.get("title"),
                "details": s.get("details"),
                "est_minutes": int(s.get("minutes", 0)) if s.get("minutes") is not None else None,
                "status": "todo",
                "created_at": datetime.now(timezone.utc).isoformat(),
            }
            for s in steps
        ]

        created_tasks: List[dict] = []
        if task_rows:
            task_res = sb.table("tasks").insert(task_rows).execute()
            created_tasks = task_res.data or []

        # action ledger for tasks
        sb.table("actions").insert(
            {
                "user_id": req.user_id,
                "goal_id": req.goal_id,
                "agent_run_id": agent_run_id,
                "kind": "create_tasks",
                "payload": {"steps_count": len(steps), "steps": steps},
                "status": "done",
                "result": {"created_task_ids": [t.get("id") for t in created_tasks if t.get("id")]},
                "created_at": datetime.now(timezone.utc).isoformat(),
            }
        ).execute()

        # 3) optional calendar scheduling (ONLY ONCE)
        calendar_events: List[dict] = []
        calendar_error: Optional[str] = None
        created_event_ids: List[str] = []

        if req.schedule_calendar:
            cal = schedule_plan_to_calendar(
                user_id=req.user_id,
                goal_id=req.goal_id,
                agent_run_id=agent_run_id,
                steps=steps,
                start_in_minutes=int(req.start_in_minutes or 5),
                tz_name = _safe_tz(req.tz_name)
            )
            calendar_events = cal["calendar_events"]
            calendar_error = cal["calendar_error"]
            created_event_ids = cal["created_event_ids"]

        # 4) interventions table (existing behavior)
        sb.table("interventions").insert(
            {
                "user_id": req.user_id,
                "goal_id": req.goal_id,
                "agent_run_id": agent_run_id,
                "steps": steps,
                "total_minutes": total_minutes,
                "created_at": datetime.now(timezone.utc).isoformat(),
            }
        ).execute()

        return {
            "agent_run_id": agent_run_id,
            "opik_trace_id": trace_id,
            "state": state,
            "selected_agent": agent,
            "summary": summary,
            "steps": steps,
            "total_minutes": total_minutes,
            "iterations": result.get("iterations", 0),
            "critic_rule_ok": result.get("critic_rule_ok"),
            "critic_llm_ok": result.get("critic_llm_ok"),
            "created_task_ids": [t.get("id") for t in created_tasks if t.get("id")],
            "created_event_ids": created_event_ids,
            "calendar_events": calendar_events,
            "calendar_error": calendar_error,
        }
        
        

    except (ValidationError, ValueError) as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    
    
@app.post("/api/run_daily_autopilot")
def run_daily_autopilot(req: DailyAutopilotRequest):
    try:
        tz_name = _safe_tz(req.tz_name)
        now_local = datetime.now(ZoneInfo(tz_name))


        # load goals (all or subset)
        q = sb.table("goals").select("id,title,cadence_per_day").eq("user_id", req.user_id)
        if req.goal_ids:
            q = q.in_("id", req.goal_ids)
        goals = q.execute().data or []
        if not goals:
            raise HTTPException(status_code=400, detail="No goals found for user")

        req_payload = _dump_model(req)
        memory = _build_daily_memory(sb, req.user_id, goals)

        plan = daily_planner_llm(req_payload=req_payload, goals=goals, memory=memory)
        plan = _ensure_item_ids(plan)
        plan = _inject_habit_items_if_missing(plan, goals)
        
        day_end = now_local.replace(hour=23, minute=59, second=59, microsecond=0)
        busy = _get_non_commitai_busy_intervals(
            req.user_id,
            tz_name=tz_name,
            start_local=now_local,
            end_local=day_end,
            buffer_minutes=5,
        )

        schedule = schedule_daily_items(
            plan["items"],
            now_local=now_local,
            start_in_minutes=req.start_in_minutes,
            buffer_minutes=5,
            busy=busy,  # ✅
        )


        schedule = schedule_daily_items(
            plan["items"],
            now_local=now_local,
            start_in_minutes=req.start_in_minutes,
            buffer_minutes=5,
        )

        # persist draft
        plan_with_meta = {
            **plan,
            "_meta": {
                "status": "DRAFT",
                "version": 1,
                "tz": tz_name,
                "generated_at": datetime.now(timezone.utc).isoformat(),
            }
        }

        dr = sb.table("daily_runs").insert({
            "user_id": req.user_id,
            "run_date": now_local.date().isoformat(),
            "state": "DAILY",
            "selected_agent": "daily",
            "summary": plan["summary"],
            "plan_json": plan_with_meta,
            "schedule_json": schedule,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }).execute().data

        daily_run_id = (dr or [{}])[0].get("id")
        
        # after daily_run_id is computed
        task_rows = []
        for it in plan["items"]:
            task_rows.append({
                "user_id": req.user_id,
                "daily_run_id": daily_run_id,
                "item_id": it["item_id"],   # already a UUID string
                "title": it["title"],
                "details": it.get("details", ""),
                "minutes": int(it.get("minutes", 0)) if it.get("minutes") is not None else None,
                "kind": it.get("kind", "focus"),
                "time_window": it.get("window", "any"),
                "goal_ids": it.get("goal_ids", []),
                "completed": False,
                "completed_at": None,
            })

        if task_rows:
            sb.table("daily_tasks").upsert(
                task_rows,
                on_conflict="daily_run_id,item_id"
            ).execute()


        # ✅ IMPORTANT: do NOT touch calendar here anymore
        return {
            "daily_run_id": daily_run_id,
            "status": "DRAFT",
            "version": 1,
            "summary": plan["summary"],
            "items": plan["items"],
            "schedule": schedule,         # preview timeline in UI
            "calendar_events": [],
            "calendar_error": None,
        }

    except (ValidationError, ValueError) as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class DailyReviseRequest(BaseModel):
    user_id: str
    daily_run_id: str
    feedback: str
    energy: int = Field(ge=1, le=5)
    workload: int = Field(ge=1, le=5)
    blockers: Optional[str] = None
    start_in_minutes: int = Field(default=5, ge=0, le=180)
    goal_ids: Optional[List[str]] = None

@app.post("/api/daily/revise")
def daily_revise(req: DailyReviseRequest):
    try:
        row = (
            sb.table("daily_runs")
            .select("id,user_id,run_date,plan_json")
            .eq("id", req.daily_run_id)
            .limit(1)
            .execute()
            .data
            or []
        )
        if not row:
            raise HTTPException(status_code=404, detail="daily_run not found")
        row = row[0]
        if row.get("user_id") != req.user_id:
            raise HTTPException(status_code=403, detail="wrong user_id for this daily_run")

        prev_plan = row.get("plan_json") or {}
        prev_meta = (prev_plan.get("_meta") or {})
        prev_version = int(prev_meta.get("version") or 1)

        # timezone
        if ZoneInfo:
            now_local = datetime.now(ZoneInfo("America/Detroit"))
            tz_name = "America/Detroit"
        else:
            now_local = datetime.now(timezone.utc)
            tz_name = "UTC"

        # goals (all or subset)
        q = sb.table("goals").select("id,title,cadence_per_day").eq("user_id", req.user_id)
        if req.goal_ids:
            q = q.in_("id", req.goal_ids)
        goals = q.execute().data or []
        if not goals:
            raise HTTPException(status_code=400, detail="No goals found for user")

        req_payload = _dump_model(req)
        memory = _build_daily_memory(sb, req.user_id, goals)

        new_plan = daily_reviser_llm(
            req_payload=req_payload,
            goals=goals,
            memory=memory,
            prev_plan=prev_plan,
            feedback=req.feedback.strip(),
        )

        schedule = schedule_daily_items(
            new_plan["items"],
            now_local=now_local,
            start_in_minutes=req.start_in_minutes,
            buffer_minutes=5,
        )

        plan_with_meta = {
            **new_plan,
            "_meta": {
                "status": "DRAFT",
                "version": prev_version + 1,
                "parent_daily_run_id": req.daily_run_id,
                "tz": tz_name,
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "feedback": req.feedback.strip()[:500],
            }
        }

        dr = sb.table("daily_runs").insert({
            "user_id": req.user_id,
            "run_date": row.get("run_date"),
            "state": "DAILY",
            "selected_agent": "daily",
            "summary": new_plan["summary"],
            "plan_json": plan_with_meta,
            "schedule_json": schedule,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }).execute().data
        new_id = (dr or [{}])[0].get("id")

        return {
            "daily_run_id": new_id,
            "status": "DRAFT",
            "version": prev_version + 1,
            "summary": new_plan["summary"],
            "items": new_plan["items"],
            "schedule": schedule,
            "calendar_events": [],
            "calendar_error": None,
        }

    except (ValidationError, ValueError) as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class DailyCommitRequest(BaseModel):
    user_id: str
    daily_run_id: str
    start_in_minutes: int = Field(default=5, ge=0, le=180)
    tz_name: Optional[str] = None

@app.post("/api/daily/commit")
def daily_commit(req: DailyCommitRequest):
    plan: dict = {}  # ✅ always defined (prevents UnboundLocalError)
    try:
        # 1) load daily_run FIRST
        rows = (
            sb.table("daily_runs")
            .select("id,user_id,run_date,plan_json")
            .eq("id", req.daily_run_id)
            .limit(1)
            .execute()
            .data
            or []
        )
        if not rows:
            raise HTTPException(status_code=404, detail="daily_run not found")

        row = rows[0]
        if row.get("user_id") != req.user_id:
            raise HTTPException(status_code=403, detail="wrong user_id for this daily_run")

        plan = row.get("plan_json") or {}
        items = plan.get("items") or []
        if not items:
            raise HTTPException(status_code=400, detail="daily_run has no plan items")

        # 2) decide timezone (prefer saved plan meta; fallback to request; then default)
        meta = (plan.get("_meta") or {})
        tz_name = _safe_tz(meta.get("tz") or req.tz_name or "America/Detroit")

        if ZoneInfo:
            now_local = datetime.now(ZoneInfo(tz_name))
        else:
            now_local = datetime.now(timezone.utc)
            tz_name = "UTC"

        # 3) delete TODAY’s commitAI events first (only ours)
        day_start = now_local.replace(hour=0, minute=0, second=0, microsecond=0)
        day_end = day_start + timedelta(days=1)

        wipe = google_delete_commitai_events_in_range(
            req.user_id,
            time_min=day_start,
            time_max=day_end,
        )
        
        day_end = now_local.replace(hour=23, minute=59, second=59, microsecond=0)
        busy = _get_non_commitai_busy_intervals(
            req.user_id,
            tz_name=tz_name,
            start_local=now_local,
            end_local=day_end,
            buffer_minutes=5,
        )

        schedule = schedule_daily_items(
            plan["items"],
            now_local=now_local,
            start_in_minutes=req.start_in_minutes,
            buffer_minutes=5,
            busy=busy,  # ✅
        )


        # 4) recompute schedule at commit time (fresh times)
        schedule = schedule_daily_items(
            items,
            now_local=now_local,
            start_in_minutes=req.start_in_minutes,
            buffer_minutes=5,
        )

        calendar_events = []
        calendar_error = None

        # 5) create events
        try:
            tz = ZoneInfo(tz_name) if ZoneInfo else timezone.utc

            for blk in schedule:
                start_dt = datetime.fromisoformat(blk["start"])
                end_dt = datetime.fromisoformat(blk["end"])

                # ✅ ensure tz-aware
                if start_dt.tzinfo is None:
                    start_dt = start_dt.replace(tzinfo=tz)
                else:
                    start_dt = start_dt.astimezone(tz)

                if end_dt.tzinfo is None:
                    end_dt = end_dt.replace(tzinfo=tz)
                else:
                    end_dt = end_dt.astimezone(tz)

                evt = google_create_event(
                    user_id=req.user_id,
                    title=f"commitAI: {blk['title']}",
                    details=blk.get("details", ""),
                    start=start_dt,
                    end=end_dt,
                    time_zone=tz_name,
                )

                calendar_events.append({
                    "item_id": blk.get("item_id"),
                    "step_title": blk["title"],
                    "event_id": evt.get("id"),
                    "htmlLink": evt.get("htmlLink"),
                    "start": blk["start"],
                    "end": blk["end"],
                })

            # optional: add quick check-in
            if schedule:
                last_end = datetime.fromisoformat(schedule[-1]["end"])
                if last_end.tzinfo is None:
                    last_end = last_end.replace(tzinfo=tz)
                else:
                    last_end = last_end.astimezone(tz)

                chk_evt = google_create_event(
                    user_id=req.user_id,
                    title="commitAI: quick check-in",
                    details="Mark what you actually finished. If you're behind, commitAI will adjust the plan.",
                    start=last_end,
                    end=last_end + timedelta(minutes=5),
                    time_zone=tz_name,
                )
                calendar_events.append({
                    "item_id": None,
                    "step_title": "quick check-in",
                    "event_id": chk_evt.get("id"),
                    "htmlLink": chk_evt.get("htmlLink"),
                    "start": last_end.isoformat(),
                    "end": (last_end + timedelta(minutes=5)).isoformat(),
                })

        except Exception as e:
            calendar_error = str(e)

        # 6) mark committed + store enriched schedule
        meta = plan.get("_meta") or {}
        meta["status"] = "COMMITTED"
        meta["committed_at"] = datetime.now(timezone.utc).isoformat()
        meta["tz"] = tz_name
        plan["_meta"] = meta

        ev_by_key = {(e.get("item_id"), e.get("step_title")): e for e in calendar_events}

        enriched_schedule = []
        for blk in schedule:
            e = ev_by_key.get((blk.get("item_id"), blk.get("title")))
            enriched_schedule.append({
                **blk,
                "event_id": e.get("event_id") if e else None,
                "htmlLink": e.get("htmlLink") if e else None,
            })

        sb.table("daily_runs").update({
            "plan_json": plan,
            "schedule_json": enriched_schedule,
        }).eq("id", req.daily_run_id).execute()

        return {
            "daily_run_id": req.daily_run_id,
            "status": "COMMITTED",
            "summary": plan.get("summary") or "",
            "items": items,
            "schedule": enriched_schedule,
            "calendar_events": calendar_events,
            "calendar_error": calendar_error,
            "wipe": wipe,
            "tz_used": tz_name,
        }

    except (ValidationError, ValueError) as e:
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    
@app.post("/api/daily/checkin_reschedule")
def daily_checkin_reschedule(req: DailyRescheduleRequest):
    """
    WOW v2:
    - LLM revises remaining items based on check-in + progress
    - deterministic schedule from "now"
    - if already committed: delete future events and recreate
    """
    try:
        # 1) load daily_run
        row = (
            sb.table("daily_runs")
            .select("id,user_id,run_date,plan_json,schedule_json")
            .eq("id", req.daily_run_id)
            .limit(1)
            .execute()
            .data
            or []
        )
        if not row:
            raise HTTPException(status_code=404, detail="daily_run not found")
        row = row[0]
        if row.get("user_id") != req.user_id:
            raise HTTPException(status_code=403, detail="wrong user_id for this daily_run")

        prev_plan = row.get("plan_json") or {}
        prev_meta = prev_plan.get("_meta") or {}
        prev_items = prev_plan.get("items") or []
        prev_schedule = row.get("schedule_json") or []

        tz_name = _safe_tz(req.tz_name)
        now_local = datetime.now(ZoneInfo(tz_name))
        now_local_iso = now_local.isoformat()

        # 2) load goals (prefer goals referenced by this plan)
        plan_goal_ids = set()
        for it in prev_items:
            for gid in (it.get("goal_ids") or []):
                plan_goal_ids.add(gid)

        all_goals = (
            sb.table("goals")
            .select("id,title,cadence_per_day")
            .eq("user_id", req.user_id)
            .execute()
            .data
            or []
        )
        goals = [g for g in all_goals if g.get("id") in plan_goal_ids] or all_goals
        if not goals:
            raise HTTPException(status_code=400, detail="No goals found for user")

        # 3) build req payload + memory
        req_payload = {
            "user_id": req.user_id,
            "daily_run_id": req.daily_run_id,
            "energy": req.energy,
            "workload": req.workload,
            "blockers": req.blockers,
        }
        memory = _build_daily_memory(sb, req.user_id, goals)

        completed_ids = list(dict.fromkeys(req.completed_item_ids or []))  # stable unique

        # 4) LLM revise remaining items
        plan = daily_rescheduler_llm(
            req_payload=req_payload,
            goals=goals,
            memory=memory,
            prev_plan=prev_plan,
            completed_item_ids=completed_ids,
            now_local_iso=now_local_iso,
        )
        plan = _ensure_item_ids(plan)
        plan = _inject_habit_items_if_missing(plan, goals)

        # 5) schedule deterministically from now (start_in_minutes = 0)
        buffer = 10 if int(req.workload) >= 4 else 5
        
        day_end = now_local.replace(hour=23, minute=59, second=59, microsecond=0)
        busy = _get_non_commitai_busy_intervals(
            req.user_id,
            tz_name=tz_name,
            start_local=now_local,
            end_local=day_end,
            buffer_minutes=5,
        )

        schedule = schedule_daily_items(
            plan["items"],
            now_local=now_local,
            start_in_minutes=req.start_in_minutes,
            buffer_minutes=5,
            busy=busy,  # ✅
        )


        schedule = schedule_daily_items(
            plan["items"],
            now_local=now_local,
            start_in_minutes=0,
            buffer_minutes=buffer,
        )

        # 6) If committed: delete FUTURE events from old schedule and create new ones
        calendar_events = []
        calendar_error = None

        status_prev = str(prev_meta.get("status") or "DRAFT").upper()
        was_committed = status_prev == "COMMITTED"

        if was_committed:
            try:
                # delete only future commitAI events we created (those with event_id)
                for blk in prev_schedule:
                    eid = blk.get("event_id")
                    if not eid:
                        continue
                    try:
                        st = datetime.fromisoformat(str(blk.get("start")))
                    except Exception:
                        continue
                    # only delete events that start after now
                    if st.tzinfo is None:
                        # if stored without tz, treat as future-safe by comparing string is risky; skip
                        continue
                    if st > now_local:
                        try:
                            google_delete_event(req.user_id, eid)
                        except Exception:
                            # don't fail the whole reschedule if one delete fails
                            pass

                # recreate events for new schedule
                for blk in schedule:
                    start_dt = datetime.fromisoformat(blk["start"])
                    end_dt = datetime.fromisoformat(blk["end"])

                    evt = google_create_event(
                        user_id=req.user_id,
                        title=f"commitAI: {blk['title']}",
                        details=blk.get("details", ""),
                        start=start_dt,   # tz-aware
                        end=end_dt,       # tz-aware
                        time_zone=tz_name,
                    )

                    calendar_events.append({
                        "item_id": blk.get("item_id"),
                        "step_title": blk["title"],
                        "event_id": evt.get("id"),
                        "htmlLink": evt.get("htmlLink"),
                        "start": blk["start"],
                        "end": blk["end"],
                    })

                # enrich schedule with event ids
                ev_by_key = {(e.get("item_id"), e.get("step_title")): e for e in calendar_events}
                enriched_schedule = []
                for blk in schedule:
                    e = ev_by_key.get((blk.get("item_id"), blk.get("title")))
                    enriched_schedule.append({
                        **blk,
                        "event_id": e.get("event_id") if e else None,
                        "htmlLink": e.get("htmlLink") if e else None,
                    })
                schedule = enriched_schedule

            except Exception as e:
                calendar_error = str(e)

        # 7) persist updated plan + schedule (update in place)
        next_version = int(prev_meta.get("version") or 1) + 1
        new_meta = {
            **prev_meta,
            "status": "COMMITTED" if was_committed else "DRAFT",
            "version": next_version,
            "tz": tz_name,
            "rescheduled_at": datetime.now(timezone.utc).isoformat(),
            "checkin_snapshot": {
                "energy": req.energy,
                "workload": req.workload,
                "blockers": (req.blockers or "")[:500],
                "completed_item_ids": completed_ids,
                "now_local": now_local_iso,
            },
        }

        plan_to_store = {**plan, "_meta": new_meta}

        sb.table("daily_runs").update({
            "plan_json": plan_to_store,
            "schedule_json": schedule,
            "summary": plan.get("summary") or "",
        }).eq("id", req.daily_run_id).execute()

        return {
            "daily_run_id": req.daily_run_id,
            "status": new_meta["status"],
            "version": next_version,
            "summary": plan.get("summary") or "",
            "items": plan.get("items") or [],
            "schedule": schedule,
            "calendar_events": calendar_events,
            "calendar_error": calendar_error,
        }

    except (ValidationError, ValueError) as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    
    
    
@app.post("/api/calendar/commit_daily")
def commit_daily_alias(req: DailyCommitRequest):
    return daily_commit(req)



class DailyTaskToggleRequest(BaseModel):
    user_id: str
    daily_run_id: str
    item_id: str
    completed: bool

@app.post("/api/daily/task/toggle")
def toggle_daily_task(req: DailyTaskToggleRequest):
    try:
        # verify the task belongs to that user (prevent cross-user updates)
        row = (
            sb.table("daily_tasks")
            .select("id,user_id,completed")
            .eq("daily_run_id", req.daily_run_id)
            .eq("item_id", req.item_id)
            .limit(1)
            .execute()
            .data
            or []
        )
        if not row:
            raise HTTPException(status_code=404, detail="daily_task not found")
        if row[0]["user_id"] != req.user_id:
            raise HTTPException(status_code=403, detail="wrong user_id for this task")

        upd = {
            "completed": bool(req.completed),
            "completed_at": datetime.now(timezone.utc).isoformat() if req.completed else None,
        }

        sb.table("daily_tasks").update(upd)\
          .eq("daily_run_id", req.daily_run_id)\
          .eq("item_id", req.item_id)\
          .execute()

        return {"ok": True, **upd}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
