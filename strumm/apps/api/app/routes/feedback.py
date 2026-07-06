"""
Feedback API routes.

Provides endpoints for users to submit feedback and track its status.
Admins can update feedback status (open → in_progress → resolved → closed).
"""
import os
import uuid
import asyncio
import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status, Query
from pydantic import BaseModel, Field

from app.database import mongodb as db
from app.routes.dependencies import get_current_user, get_optional_user
from app.services.email_service import _build_html, _divider, _section, _send_email, BRAND
from app.services.security import sanitize_text, sanitize_multiline_text

logger = logging.getLogger("strumm-feedback")

router = APIRouter(prefix="/feedback", tags=["Feedback"])

# ─── Pydantic models ───────────────────────────────────────────────────

FEEDBACK_CATEGORIES = ["bug", "feature", "improvement", "general", "other"]


class FeedbackCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    description: str = Field(..., min_length=1, max_length=5000)
    category: str = Field(default="general")
    email: Optional[str] = Field(default=None, max_length=320)

    class Config:
        json_schema_extra = {
            "example": {
                "title": "Dark mode toggle in player",
                "description": "It would be great to have a dark mode toggle directly in the fullscreen player overlay...",
                "category": "feature",
                "email": "user@example.com",
            }
        }


class FeedbackStatusUpdate(BaseModel):
    status: str = Field(..., pattern="^(open|in_progress|resolved|closed)$")


# ─── Routes ────────────────────────────────────────────────────────────


@router.post("")
async def submit_feedback(
    body: FeedbackCreate,
    current_user: Optional[dict] = Depends(get_optional_user),
):
    """Submit a new feedback entry. Auth optional — anonymous users can submit too."""
    # Validate category
    category = body.category.lower().strip()
    if category not in FEEDBACK_CATEGORIES:
        category = "general"

    feedback_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()

    feedback_doc = {
        "_id": feedback_id,
        "title": sanitize_text(body.title, max_length=200),
        "description": sanitize_multiline_text(body.description, max_length=5000),
        "category": category,
        "status": "open",
        "userId": current_user.get("id") if current_user else None,
        "email": sanitize_text(body.email, max_length=320) if body.email else None,
        "createdAt": now,
        "updatedAt": now,
        "adminNote": None,
    }

    try:
        database = db.get_db()
        await database["feedback"].insert_one(feedback_doc)

        # Send email notification to the team
        asyncio.create_task(_notify_team(feedback_doc, current_user))

        logger.info(f"Feedback submitted: {feedback_id} ({category})")
        return {
            "success": True,
            "data": {
                "id": feedback_id,
                "title": feedback_doc["title"],
                "category": category,
                "status": "open",
                "createdAt": now,
                "message": "Thank you for your feedback! Our team will review it shortly.",
            }
        }
    except Exception as e:
        logger.error(f"Failed to save feedback: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to submit feedback. Please try again.",
        )


@router.get("")
async def list_feedback(
    current_user: dict = Depends(get_current_user),
    status_filter: Optional[str] = Query(None, alias="status"),
    category_filter: Optional[str] = Query(None, alias="category"),
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=50),
):
    """List feedback submissions for the current user (or all if admin)."""
    try:
        database = db.get_db()
        query: dict = {}

        # Non-admin users only see their own feedback
        is_admin = current_user.get("role") == "admin"
        if not is_admin:
            query["userId"] = current_user["id"]
        elif status_filter:
            query["status"] = status_filter
        if category_filter:
            query["category"] = category_filter

        cursor = database["feedback"].find(query)
        total = await database["feedback"].count_documents(query)

        skip = (page - 1) * limit
        cursor = cursor.sort("createdAt", -1).skip(skip).limit(limit)
        results = []
        async for doc in cursor:
            results.append(_format_feedback(doc))

        return {
            "success": True,
            "data": {
                "items": results,
                "total": total,
                "page": page,
                "limit": limit,
                "pages": (total + limit - 1) // limit if total > 0 else 0,
            }
        }
    except Exception as e:
        logger.error(f"Failed to list feedback: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve feedback.",
        )


@router.get("/{feedback_id}")
async def get_feedback(
    feedback_id: str,
    current_user: dict = Depends(get_current_user),
):
    """Get a single feedback submission by ID."""
    try:
        database = db.get_db()
        doc = await database["feedback"].find_one({"_id": feedback_id})
        if not doc:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Feedback not found.",
            )

        # Non-admin users can only see their own
        is_admin = current_user.get("role") == "admin"
        if not is_admin and doc.get("userId") != current_user["id"]:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You do not have permission to view this feedback.",
            )

        return {
            "success": True,
            "data": _format_feedback(doc),
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get feedback {feedback_id}: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve feedback.",
        )


@router.patch("/{feedback_id}/status")
async def update_feedback_status(
    feedback_id: str,
    body: FeedbackStatusUpdate,
    current_user: dict = Depends(get_current_user),
):
    """Update feedback status (admin only)."""
    is_admin = current_user.get("role") == "admin"
    if not is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only admins can update feedback status.",
        )

    try:
        database = db.get_db()
        now = datetime.now(timezone.utc).isoformat()

        result = await database["feedback"].find_one_and_update(
            {"_id": feedback_id},
            {"$set": {"status": body.status, "updatedAt": now}},
            return_document=True,
        )

        if not result:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Feedback not found.",
            )

        # Notify the user if they have an email
        user_email = result.get("email")
        if user_email:
            asyncio.create_task(_send_status_notification(result, user_email))

        logger.info(f"Feedback {feedback_id} status updated to: {body.status}")
        return {
            "success": True,
            "data": _format_feedback(result),
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to update feedback status: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to update feedback status.",
        )


# ─── Helpers ────────────────────────────────────────────────────────────


def _format_feedback(doc: dict) -> dict:
    """Format a MongoDB feedback document for API response."""
    return {
        "id": doc["_id"],
        "title": doc.get("title", ""),
        "description": doc.get("description", ""),
        "category": doc.get("category", "general"),
        "status": doc.get("status", "open"),
        "createdAt": doc.get("createdAt", ""),
        "updatedAt": doc.get("updatedAt", ""),
        "adminNote": doc.get("adminNote"),
    }


async def _notify_team(feedback: dict, user: Optional[dict]):
    """Send an email notification to the team about new feedback."""
    team_email = os.getenv("FEEDBACK_EMAIL", "b5x003agnibha.mukherjee@gmail.com")
    user_info = f"{user.get('displayName', 'Anonymous')} (@{user.get('username', 'unknown')})" if user else "Anonymous user"
    user_email = feedback.get("email") or (user.get("email") if user else "Not provided")

    html = _build_html([
        "<h2 style=\"font-family:Georgia,'Times New Roman',serif;color:#FFFFFF;font-size:20px;margin:0 0 2px 0;font-weight:700;\">New Feedback Received</h2>",
        _divider(),
        _section("Category", f"<span style=\"font-size:14px;color:#FFFFFF;font-weight:600;\">{feedback['category'].title()}</span>"),
        _section("From", f"<p style=\"font-size:13px;color:#8E8E93;margin:0;\">{user_info}</p><p style=\"font-size:12px;color:#8E8E93;margin:4px 0 0;\">Email: {user_email}</p>"),
        _section("Title", f"<p style=\"font-size:14px;color:#FFFFFF;font-weight:600;margin:0;\">{feedback['title']}</p>"),
        _section("Description", f"<p style=\"font-size:13px;color:#8E8E93;margin:0;line-height:1.6;white-space:pre-wrap;\">{feedback['description'][:2000]}</p>"),
    ])

    await _send_email(team_email, f"[Strumm Feedback] {feedback['category'].title()}: {feedback['title'][:80]}", html)


async def _send_status_notification(feedback: dict, user_email: str):
    """Send an email to the user when their feedback status changes."""
    frontend_url = os.getenv("FRONTEND_URL", "https://strumm.me")
    status_labels = {
        "in_progress": "In Progress",
        "resolved": "Resolved \u2705",
        "closed": "Closed",
    }
    status_label = status_labels.get(feedback["status"], feedback["status"].title())
    feedback_link = f"{frontend_url}/feedback?id={feedback['_id']}"

    html = _build_html([
        "<h2 style=\"font-family:Georgia,'Times New Roman',serif;color:#FFFFFF;font-size:20px;margin:0 0 2px 0;font-weight:700;\">Feedback Status Update</h2>",
        _divider(),
        "<p style=\"font-size:14px;color:#8E8E93;margin:0 0 16px;line-height:1.6;\">Your feedback has been updated:</p>",
        _section("Feedback", f"<p style=\"font-size:14px;color:#FFFFFF;font-weight:600;margin:0;\">{feedback['title']}</p>"),
        _section("New Status", f"<span style=\"font-size:16px;color:#FF5500;font-weight:700;\">{status_label}</span>"),
        f"<div style=\"margin-top:24px;text-align:center;\"><a href=\"{feedback_link}\" style=\"display:inline-block;background-color:#FF5500;color:#FFFFFF;font-family:Georgia,'Times New Roman',serif;font-size:14px;font-weight:700;padding:12px 32px;border-radius:10px;text-decoration:none;\">View Feedback</a></div>",
    ])

    await _send_email(user_email, f"Your Strumm feedback status: {status_label}", html)
