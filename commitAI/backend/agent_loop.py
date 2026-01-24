import json
from typing import Tuple, Optional
from opik import track
from .schemas import RouterDecision, PlanOutput, CriticReview  # or import from main.py if you keep it there

# --------- LLM call stub (replace later) ----------
def call_llm_json(prompt: str) -> dict:
    """
    Replace this with a real LLM call later.
    For now, return a deterministic placeholder so your pipeline works end-to-end.
    """
    raise NotImplementedError("Wire your LLM here (must return JSON dict).")

def _must_parse(schema_cls, raw: dict):
    return schema_cls.model_validate(raw) if hasattr(schema_cls, "model_validate") else schema_cls.parse_obj(raw)

@track(name="router", flush=True)
def router_llm(memory: str, req_payload: dict) -> RouterDecision:
    prompt = f"""
You are the Router agent for a productivity autopilot.
Return ONLY valid JSON.

USER_CONTEXT:
{memory}

REQUEST:
{json.dumps(req_payload)}

Decide:
- state: NORMAL | RECOVERY | AT_RISK | INCIDENT
- selected_agent: deep_work | maintenance | recovery | triage
- constraints: list of short strings (e.g., "keep plan under 35 min", "blockers: email")
- focus_minutes_cap: integer (default 35)

JSON ONLY.
"""
    raw = call_llm_json(prompt)
    return _must_parse(RouterDecision, raw)

@track(name="planner", flush=True)
def planner_llm(memory: str, req_payload: dict, decision: RouterDecision, critic_feedback: Optional[CriticReview]=None) -> PlanOutput:
    critic_text = ""
    if critic_feedback and not critic_feedback.ok:
        critic_text = f"\nCRITIC_FEEDBACK:\n{json.dumps(critic_feedback.model_dump() if hasattr(critic_feedback,'model_dump') else critic_feedback.dict())}\n"

    prompt = f"""
You are the Planner agent.
Return ONLY valid JSON that matches this shape:

{{
  "summary": "...",
  "steps": [{{"title":"...", "minutes": 3, "details":"..."}}],
  "total_minutes": 33,
  "why_this_plan": "...",
  "assumptions": ["..."],
  "risk_flags": ["..."],
  "tool_calls": [{{"tool":"...", "args":{{...}}}}]
}}

Rules:
- Total minutes MUST be <= {decision.focus_minutes_cap}
- First step MUST be executable within 2 minutes (low friction)
- Steps must explicitly address blockers if present
- No vague steps (avoid “work on project”)

USER_CONTEXT:
{memory}

REQUEST:
{json.dumps(req_payload)}

ROUTER_DECISION:
{json.dumps(decision.model_dump() if hasattr(decision,'model_dump') else decision.dict())}
{critic_text}

JSON ONLY.
"""
    raw = call_llm_json(prompt)
    plan = _must_parse(PlanOutput, raw)

    # enforce total_minutes consistency
    plan.total_minutes = sum(int(s.minutes) for s in plan.steps)

    return plan

@track(name="critic", flush=True)
def critic_llm(req_payload: dict, decision: RouterDecision, plan: PlanOutput) -> CriticReview:
    prompt = f"""
You are the Critic agent. Return ONLY valid JSON.

Check the plan against:
- total_minutes <= {decision.focus_minutes_cap}
- first step is <=2 minutes and concrete
- addresses blockers
- not overwhelming for low energy / high workload
- no contradictions

Return:
{{"ok": true/false, "issues": ["..."], "suggested_edits": ["..."]}}

REQUEST:
{json.dumps(req_payload)}

ROUTER:
{json.dumps(decision.model_dump() if hasattr(decision,'model_dump') else decision.dict())}

PLAN:
{json.dumps(plan.model_dump() if hasattr(plan,'model_dump') else plan.dict())}

JSON ONLY.
"""
    raw = call_llm_json(prompt)
    return _must_parse(CriticReview, raw)

def run_agent_loop(memory: str, req_payload: dict, max_revisions: int = 1) -> Tuple[RouterDecision, PlanOutput, CriticReview, int]:
    decision = router_llm(memory, req_payload)
    plan = planner_llm(memory, req_payload, decision)

    review = critic_llm(req_payload, decision, plan)
    revisions = 0

    while (not review.ok) and revisions < max_revisions:
        revisions += 1
        plan = planner_llm(memory, req_payload, decision, critic_feedback=review)
        review = critic_llm(req_payload, decision, plan)

    return decision, plan, review, revisions
