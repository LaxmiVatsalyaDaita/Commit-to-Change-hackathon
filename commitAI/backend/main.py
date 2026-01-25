# backend/main.py

import os
import json
import time
from typing import Optional, List, Dict, Any, Union

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, ValidationError
from supabase import create_client, Client
from openai import OpenAI
from opik import track, opik_context
from datetime import datetime, timezone, timedelta

try:
    from zoneinfo import ZoneInfo  # py3.9+
except Exception:
    ZoneInfo = None

from integrations.calendar_google import (
    register_google_calendar_routes,
    google_create_event,
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

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ],
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


# -------------------------
# Helpers
# -------------------------
def _dump_model(m: BaseModel) -> dict:
    return m.model_dump() if hasattr(m, "model_dump") else m.dict()


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


# -------------------------
# Endpoints: runs + feedback
# -------------------------
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
                tz_name="America/Detroit",
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
