# integrations/calendar_google.py

import os
import secrets
import requests
from urllib.parse import urlencode
from datetime import datetime, timezone, timedelta
from typing import Optional, Dict, Any
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException
from supabase import Client

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_SCOPE = "https://www.googleapis.com/auth/calendar.events"

STATE_TTL_SECONDS = 10 * 60  # 10 minutes

router = APIRouter()
_SB: Optional[Client] = None


def _sb() -> Client:
    if _SB is None:
        raise RuntimeError("Supabase client not set. Did you call register_google_calendar_routes(app, sb)?")
    return _SB


def register_google_calendar_routes(app, sb: Client):
    global _SB
    _SB = sb
    app.include_router(router)


def _require_env(name: str) -> str:
    val = os.getenv(name)
    if not val:
        raise HTTPException(status_code=500, detail=f"Missing {name} in backend/.env")
    return val


# -------------------------
# Supabase helpers
# -------------------------
def _save_oauth_state(sb: Client, *, state: str, user_id: str, provider: str):
    sb.table("oauth_states").insert(
        {
            "state": state,
            "user_id": user_id,
            "provider": provider,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "used_at": None,
        }
    ).execute()


def _consume_oauth_state(sb: Client, *, state: str, provider: str) -> Dict[str, Any]:
    rows = (
        sb.table("oauth_states")
        .select("state,user_id,provider,created_at,used_at")
        .eq("state", state)
        .eq("provider", provider)
        .limit(1)
        .execute()
        .data
        or []
    )
    if not rows:
        raise HTTPException(status_code=400, detail="Invalid or expired OAuth state")

    row = rows[0]
    if row.get("used_at"):
        raise HTTPException(status_code=400, detail="Invalid or expired OAuth state")

    # TTL check
    created_at = row.get("created_at")
    if created_at:
        try:
            created_dt = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
            age = (datetime.now(timezone.utc) - created_dt).total_seconds()
            if age > STATE_TTL_SECONDS:
                raise HTTPException(status_code=400, detail="Invalid or expired OAuth state")
        except HTTPException:
            raise
        except Exception:
            # if parsing fails, still treat as invalid (safer)
            raise HTTPException(status_code=400, detail="Invalid or expired OAuth state")

    # mark used (filter by both state + provider)
    sb.table("oauth_states").update(
        {"used_at": datetime.now(timezone.utc).isoformat()}
    ).eq("state", state).eq("provider", provider).execute()

    return row


def _upsert_integration(sb: Client, user_id: str, provider: str, data: dict):
    sb.table("calendar_integrations").upsert(
        {
            "user_id": user_id,
            "provider": provider,
            **data,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        },
        on_conflict="user_id,provider",
    ).execute()


def _get_integration(sb: Client, user_id: str, provider: str) -> Optional[Dict[str, Any]]:
    rows = (
        sb.table("calendar_integrations")
        .select("*")
        .eq("user_id", user_id)
        .eq("provider", provider)
        .limit(1)
        .execute()
        .data
        or []
    )
    return rows[0] if rows else None


# -------------------------
# Routes
# -------------------------
@router.get("/api/integrations/google/status")
def google_status(user_id: str):
    sb = _sb()
    integ = _get_integration(sb, user_id, "google")
    return {
        "connected": bool(integ and integ.get("refresh_token")),
        "calendar_id": (integ or {}).get("calendar_id"),
        "expires_at": (integ or {}).get("expires_at"),
    }


@router.get("/api/integrations/google/start")
def google_start(user_id: str):
    sb = _sb()

    client_id = _require_env("GOOGLE_CLIENT_ID")
    redirect_uri = _require_env("GOOGLE_REDIRECT_URI")

    state = secrets.token_urlsafe(32)
    _save_oauth_state(sb, state=state, user_id=user_id, provider="google")

    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": GOOGLE_SCOPE,
        "access_type": "offline",
        "prompt": "consent",
        "state": state,
    }
    return {"auth_url": f"{GOOGLE_AUTH_URL}?{urlencode(params)}"}


@router.get("/api/integrations/google/callback")
def google_callback(code: str, state: str):
    sb = _sb()

    client_id = _require_env("GOOGLE_CLIENT_ID")
    client_secret = _require_env("GOOGLE_CLIENT_SECRET")
    redirect_uri = _require_env("GOOGLE_REDIRECT_URI")

    st = _consume_oauth_state(sb, state=state, provider="google")
    user_id = st["user_id"]

    tok = requests.post(
        GOOGLE_TOKEN_URL,
        data={
            "client_id": client_id,
            "client_secret": client_secret,
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
        },
        timeout=20,
    ).json()

    if "error" in tok:
        raise HTTPException(status_code=400, detail=tok)

    expires_in = int(tok.get("expires_in", 3600))

    # IMPORTANT: refresh_token may be absent on subsequent auth flows.
    existing = _get_integration(sb, user_id, "google") or {}
    refresh_token = tok.get("refresh_token") or existing.get("refresh_token")

    if not refresh_token:
        # Without a refresh token, we can't keep the integration alive.
        raise HTTPException(status_code=400, detail="No refresh_token returned. Try removing access and re-consenting.")

    _upsert_integration(
        sb,
        user_id,
        "google",
        {
            "access_token": tok.get("access_token"),
            "refresh_token": refresh_token,
            "expires_at": (datetime.now(timezone.utc) + timedelta(seconds=expires_in)).isoformat(),
            "calendar_id": existing.get("calendar_id") or "primary",
        },
    )

    return {"ok": True}


# -------------------------
# Calendar actions
# -------------------------
def google_access_token(user_id: str) -> str:
    sb = _sb()
    integ = _get_integration(sb, user_id, "google")
    if not integ or not integ.get("refresh_token"):
        raise HTTPException(status_code=400, detail="Google calendar not connected")

    client_id = _require_env("GOOGLE_CLIENT_ID")
    client_secret = _require_env("GOOGLE_CLIENT_SECRET")

    tok = requests.post(
        GOOGLE_TOKEN_URL,
        data={
            "client_id": client_id,
            "client_secret": client_secret,
            "grant_type": "refresh_token",
            "refresh_token": integ["refresh_token"],
        },
        timeout=20,
    ).json()

    if "error" in tok:
        raise HTTPException(status_code=400, detail=tok)

    expires_in = int(tok.get("expires_in", 3600))
    _upsert_integration(
        sb,
        user_id,
        "google",
        {
            "access_token": tok.get("access_token"),
            "expires_at": (datetime.now(timezone.utc) + timedelta(seconds=expires_in)).isoformat(),
        },
    )
    return tok["access_token"]


def google_create_event(
    user_id: str,
    title: str,
    details: str,
    start: datetime,
    end: datetime,
    time_zone: str = "America/Detroit",
) -> dict:
    
    tz = ZoneInfo(time_zone)
    if start.tzinfo is None:
        start = start.replace(tzinfo=tz)
    else:
        start = start.astimezone(tz)

    if end.tzinfo is None:
        end = end.replace(tzinfo=tz)
    else:
        end = end.astimezone(tz)

    if end <= start:
        raise HTTPException(status_code=400, detail="Event end must be after start")

    sb = _sb()
    token = google_access_token(user_id)
    cal_id = (_get_integration(sb, user_id, "google") or {}).get("calendar_id") or "primary"

    # If you pass naive datetimes, Google may interpret unexpectedly.
    # Safer: require timezone-aware datetimes.
    if start.tzinfo is None or end.tzinfo is None:
        raise HTTPException(status_code=400, detail="Start/end must be timezone-aware datetimes")

    event = {
        "summary": title,
        "description": details,
        "start": {"dateTime": start.isoformat(), "timeZone": time_zone},
        "end": {"dateTime": end.isoformat(), "timeZone": time_zone},
        
        "extendedProperties": {
            "private": {
                "commitai": "1"
            }
        }
    }

    url = f"https://www.googleapis.com/calendar/v3/calendars/{cal_id}/events"
    r = requests.post(url, headers={"Authorization": f"Bearer {token}"}, json=event, timeout=20)

    if r.status_code >= 400:
        raise HTTPException(status_code=400, detail=r.text)

    return r.json()

def google_list_events(user_id: str, *, time_min: datetime, time_max: datetime) -> list:
    """
    List events between [time_min, time_max). Requires timezone-aware datetimes.
    Returns expanded single events.
    """
    if time_min.tzinfo is None or time_max.tzinfo is None:
        raise HTTPException(status_code=400, detail="time_min/time_max must be timezone-aware")

    sb = _sb()
    token = google_access_token(user_id)
    cal_id = (_get_integration(sb, user_id, "google") or {}).get("calendar_id") or "primary"

    url = f"https://www.googleapis.com/calendar/v3/calendars/{cal_id}/events"

    params = {
        "timeMin": time_min.isoformat(),
        "timeMax": time_max.isoformat(),
        "singleEvents": "true",
        "orderBy": "startTime",
        "maxResults": 2500,
    }

    items = []
    page_token = None
    while True:
        if page_token:
            params["pageToken"] = page_token

        r = requests.get(url, headers={"Authorization": f"Bearer {token}"}, params=params, timeout=20)
        if r.status_code >= 400:
            raise HTTPException(status_code=400, detail=r.text)

        data = r.json()
        items.extend(data.get("items", []))
        page_token = data.get("nextPageToken")
        if not page_token:
            break

    return items


def google_delete_event(user_id: str, *, event_id: str) -> None:
    sb = _sb()
    token = google_access_token(user_id)
    cal_id = (_get_integration(sb, user_id, "google") or {}).get("calendar_id") or "primary"

    url = f"https://www.googleapis.com/calendar/v3/calendars/{cal_id}/events/{event_id}"
    r = requests.delete(url, headers={"Authorization": f"Bearer {token}"}, timeout=20)

    if r.status_code >= 400:
        raise HTTPException(status_code=400, detail=r.text)


def google_delete_commitai_events_in_range(
    user_id: str,
    *,
    time_min: datetime,
    time_max: datetime,
) -> dict:
    """
    Deletes ONLY commitAI-created events in the time range.
    Safer rule:
      - delete if extendedProperties.private.commitai == "1"
      - OR fallback: title starts with "commitAI:" (for old events created before tagging)
    """
    events = google_list_events(user_id, time_min=time_min, time_max=time_max)

    deleted = 0
    skipped = 0

    for ev in events:
        ev_id = ev.get("id")
        summary = (ev.get("summary") or "").strip()

        # ignore all-day events (they have "date" instead of "dateTime")
        start_obj = (ev.get("start") or {})
        if "dateTime" not in start_obj:
            skipped += 1
            continue

        priv = (((ev.get("extendedProperties") or {}).get("private")) or {})
        is_commitai = (priv.get("commitai") == "1") or summary.startswith("commitAI:")

        if not is_commitai or not ev_id:
            skipped += 1
            continue

        google_delete_event(user_id, event_id=ev_id)
        deleted += 1

    return {"deleted": deleted, "skipped": skipped}


def google_delete_event(user_id: str, event_id: str) -> None:
    sb = _sb()
    token = google_access_token(user_id)
    cal_id = (_get_integration(sb, user_id, "google") or {}).get("calendar_id") or "primary"

    url = f"https://www.googleapis.com/calendar/v3/calendars/{cal_id}/events/{event_id}"
    r = requests.delete(url, headers={"Authorization": f"Bearer {token}"}, timeout=20)

    # 204 is success
    if r.status_code not in (200, 204):
        raise HTTPException(status_code=400, detail=r.text)


# integrations/calendar_google.py
from datetime import datetime
from zoneinfo import ZoneInfo

def google_list_events_in_range(
    user_id: str,
    time_min: datetime,
    time_max: datetime,
    time_zone: str = "America/Detroit",
) -> list[dict]:
    """
    Returns calendar events in [time_min, time_max].
    We will filter out commitAI events in main.py.
    """
    sb = _sb()
    token = google_access_token(user_id)
    cal_id = (_get_integration(sb, user_id, "google") or {}).get("calendar_id") or "primary"

    if time_min.tzinfo is None or time_max.tzinfo is None:
        raise HTTPException(status_code=400, detail="time_min/time_max must be tz-aware")

    url = f"https://www.googleapis.com/calendar/v3/calendars/{cal_id}/events"
    params = {
        "timeMin": time_min.isoformat(),
        "timeMax": time_max.isoformat(),
        "singleEvents": "true",
        "orderBy": "startTime",
        "maxResults": 2500,
    }

    r = requests.get(url, headers={"Authorization": f"Bearer {token}"}, params=params, timeout=20)
    if r.status_code >= 400:
        raise HTTPException(status_code=400, detail=r.text)

    data = r.json()
    return data.get("items") or []
