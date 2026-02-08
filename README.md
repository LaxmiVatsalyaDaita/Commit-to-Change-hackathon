# 🎯 Commit.ai 

**[Commit.ai](https://committochange.vercel.app) helps you *follow through* and stay commited to your New Year Resolutions.**
A productivity autopilot that turns your goals + daily check-in into a realistic, time-blocked plan — and can push it to Google Calendar — with full agent observability via Opik (by Comet).

### 1) Context → Strategy selection
Based on your check-in, the system selects an approach (agent routing), e.g.:
- **On-track mode**: optimize productivity and flow
- **Slip mode**: simplify and de-risk the plan
- **Incident mode**: triage, reduce scope, protect essentials

### 2) Multi-goal reasoning (not single-goal generation)
The planner is designed to create a **cohesive plan across all goals**, not separate independent plans.

Each task/schedule block is explicitly linked to one or more goals via `goal_ids`, so the system can measure **coverage** and detect “missing goals.”

### 3) Tool use: Calendar as an action surface
This is where it becomes truly agentic:
- The plan is a **draft**
- Clicking “Add to Google Calendar” triggers a tool action:
  - OAuth connect
  - event creation
  - persistent scheduling

### 4) Feedback loops (execution → re-planning)
As you complete tasks, you feed back execution signals:
- completed checklist items
- updated energy/workload/blockers

Then the system performs a **re-planning / rescheduling loop** to keep the plan realistic.

### 5) Observability-first (Opik / Comet)
Agentic systems fail in subtle ways. Commit.ai is built to *inspect and debug agent behavior*:
- each run stores trace identifiers (`opik_trace_id`)
- activity feed shows agent selection + run states
- enables monitoring reliability and plan quality over time

---

## Key Features

- **Goal creation** with daily cadence (e.g., 2x/day)
- **Daily check-in** (energy, workload, blockers)
- **Autopilot planner** to generate:
  - checklist items
  - a realistic timeline
- **Midday rescheduling** using completed tasks + updated check-in
- **Google Calendar integration**
  - OAuth connect flow
  - create events for schedule blocks
- **Activity feed**
  - recent runs
  - agent chosen + state
  - trace IDs for observability
- **Observability with Opik by Comet**
  - trace IDs stored per run
  - debug planner behavior + reliability

---

## Tech Stack

**Frontend**
- Next.js (App Router) + TypeScript
- Tailwind CSS UI
- Supabase Auth + Supabase DB client

**Backend**
- FastAPI (Python)
- Google Calendar OAuth + Calendar API integration
- Planner endpoints for daily runs / reschedule / commit

**Database**
- Supabase Postgres tables for goals, daily runs, tasks, OAuth state, calendar integrations, feedback, etc.

**Observability**
- Opik by Comet (trace per agent run)

**Deployment**
- Frontend: Vercel
- Backend: Render
- DB/Auth: Supabase

---

## How it works (high-level flow)

1. **User logs in** via Supabase Auth → frontend gets `user_id`
2. **Goals** are stored in Supabase (`goals` table)
3. **Run daily autopilot**
   - Frontend sends check-in + all goal IDs to backend
   - Backend generates a plan and returns:
     - `items[]` (checklist)
     - `schedule[]` (time-blocks)
     - `daily_run_id`
4. **Task completion**
   - User checks items → persisted in `daily_tasks`
5. **Reschedule**
   - Frontend sends completed IDs + updated check-in
   - Backend returns updated plan
6. **Calendar commit**
   - Backend creates Google Calendar events for schedule blocks

