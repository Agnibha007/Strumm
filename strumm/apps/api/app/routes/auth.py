import os
import re
import secrets
import hashlib
from datetime import datetime, timedelta
from typing import Optional
from fastapi import APIRouter, HTTPException, Depends, Request, Response, Cookie
from pydantic import BaseModel, EmailStr
from bson import ObjectId
from app.database import mongodb as db
from app.services.auth_utils import hash_otp, create_access_token, hash_password, verify_password
from app.services.email_service import send_otp_email, send_resend_otp_email, send_password_reset_email
from app.services.security import sanitize_text, sanitize_username, parse_object_id
import httpx
import logging

logger = logging.getLogger("strumm-auth")
router = APIRouter(prefix="/auth", tags=["auth"])

SESSIONS_COLLECTION = "sessions"

def hash_refresh_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()

async def create_device_session(user_id: str, email: str, username: str, request: Request, database) -> tuple[str, str]:
    # Long expiry access token: 7 days
    access_token_payload = {
        "sub": user_id,
        "email": email,
        "username": username,
        "type": "access"
    }
    access_token = create_access_token(access_token_payload, expires_delta=timedelta(days=7))
    
    # Long expiry refresh token: 30 days
    refresh_token = secrets.token_hex(32)
    refresh_token_hash = hash_refresh_token(refresh_token)
    
    # Extract device info
    device = request.headers.get("user-agent", "Unknown Device")
    
    # Save session
    session_doc = {
        "userId": user_id,
        "refreshTokenHash": refresh_token_hash,
        "device": device,
        "createdAt": datetime.utcnow(),
        "expiresAt": datetime.utcnow() + timedelta(days=30)
    }
    await database[SESSIONS_COLLECTION].insert_one(session_doc)
    
    return access_token, refresh_token
def set_auth_cookies(response: Response, access_token: str, refresh_token: str):
    response.set_cookie(
        key="access_token",
        value=access_token,
        httponly=True,
        secure=True,
        samesite="none",
        max_age=7 * 24 * 60 * 60,  # 7 days
        path="/"
    )
    response.set_cookie(
        key="refresh_token",
        value=refresh_token,
        httponly=True,
        secure=True,
        samesite="none",
        max_age=30 * 24 * 60 * 60,  # 30 days
        path="/"
    )




class EmailLoginRequest(BaseModel):
    email: EmailStr

class EmailPasswordLoginRequest(BaseModel):
    email: EmailStr
    password: str

class ForgotPasswordRequest(BaseModel):
    email: EmailStr

class EmailSignupRequest(BaseModel):
    email: EmailStr
    username: str
    displayName: str
    password: str

class OTPVerifyRequest(BaseModel):
    email: EmailStr
    otp: str

class GoogleLoginRequest(BaseModel):
    idToken: str

def should_expose_dev_otp() -> bool:
    return os.getenv("ENVIRONMENT", "development").lower() == "development" and os.getenv("EXPOSE_DEV_OTP") == "true"

def generate_otp() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"

def username_from_email(email: str) -> str:
    base = re.sub(r"[^a-z0-9_]", "_", email.split("@")[0].lower()).strip("_")[:24] or "user"
    if len(base) < 3:
        base = f"{base}_user"
    return base[:30]

async def verify_google_id_token(id_token: str) -> dict:
    client_id = os.getenv("GOOGLE_CLIENT_ID")
    if not client_id:
        raise HTTPException(status_code=500, detail="Google authentication is not configured.")

    async with httpx.AsyncClient() as client:
        response = await client.get(
            "https://oauth2.googleapis.com/tokeninfo",
            params={"id_token": sanitize_text(id_token, max_length=4096)},
            timeout=6.0
        )

    if response.status_code != 200:
        raise HTTPException(status_code=401, detail="Invalid Google identity token.")

    claims = response.json()
    if claims.get("aud") != client_id or claims.get("email_verified") not in {"true", True}:
        raise HTTPException(status_code=401, detail="Google identity token could not be verified.")
    if not claims.get("email"):
        raise HTTPException(status_code=401, detail="Google identity token is missing email.")
    return claims

@router.post("/email")
async def send_otp(request: EmailLoginRequest):
    try:
        email = request.email.lower()
        database = db.get_db()
        
        # 1. Enforce login check: prevent login if user doesn't exist
        user = await database[db.USERS].find_one({"email": email})
        if not user:
            return {
                "success": False,
                "error": "No account found with this email. Please sign up first."
            }
        
        # Generate a 6-digit OTP code
        otp_code = generate_otp()
        hashed = hash_otp(otp_code)
        expiry = datetime.utcnow() + timedelta(minutes=10) # 10 mins validity
        
        # Upsert OTP document, making sure to clear any previous metadata (clean login flow)
        await database["otps"].update_one(
            {"email": email},
            {
                "$set": {
                    "email": email,
                    "hashed_otp": hashed,
                    "attempts": 0,
                    "expiry": expiry
                },
                "$unset": {
                    "metadata": ""
                }
            },
            upsert=True
        )
        
        logger.info(f"Generated Login OTP for {email}")

        # Send actual SMTP email if credentials are set
        email_sent = await send_otp_email(email, otp_code)

        return {
            "success": True,
            "data": {
                "message": "OTP generated successfully. Check email if SMTP configured.",
                "dev_otp": otp_code if should_expose_dev_otp() else None,
                "email_sent": email_sent
            }
        }
    except Exception as e:
        logger.error(f"Error generating login OTP: {str(e)}")
        return {
            "success": False,
            "error": "Failed to generate authentication code."
        }

@router.post("/signup")
async def send_signup_otp(request: EmailSignupRequest):
    try:
        email = request.email.lower()
        username = sanitize_username(request.username)
        display_name = sanitize_text(request.displayName, max_length=120)
        if not display_name:
            return {"success": False, "error": "Display name is required."}
        
        database = db.get_db()
        
        # 1. Enforce signup check: prevent signup if email already exists
        user_by_email = await database[db.USERS].find_one({"email": email})
        if user_by_email:
            return {
                "success": False,
                "error": "An account already exists with this email. Please log in."
            }
            
        # 2. Enforce username check: usernames must be unique
        user_by_username = await database[db.USERS].find_one({"username": username})
        if user_by_username:
            return {
                "success": False,
                "error": "Username is already taken. Please choose another."
            }
            
        # Generate a 6-digit OTP code
        otp_code = generate_otp()
        hashed = hash_otp(otp_code)
        expiry = datetime.utcnow() + timedelta(minutes=10) # 10 mins validity
        
        hashed_pass = hash_password(request.password)
        # Upsert OTP document with metadata (storing username, displayName & password until OTP verifies)
        await database["otps"].update_one(
            {"email": email},
            {
                "$set": {
                    "email": email,
                    "hashed_otp": hashed,
                    "attempts": 0,
                    "expiry": expiry,
                    "metadata": {
                        "username": username,
                        "displayName": display_name,
                        "password": hashed_pass
                    }
                }
            },
            upsert=True
        )
        
        logger.info(f"Generated Signup OTP for {email}")

        # Send actual Resend/SMTP email
        email_sent = await send_resend_otp_email(email, otp_code)

        return {
            "success": True,
            "data": {
                "message": "Signup OTP generated successfully. Check email if SMTP configured.",
                "dev_otp": otp_code if should_expose_dev_otp() else None,
                "email_sent": email_sent
            }
        }
    except Exception as e:
        logger.error(f"Error generating signup OTP: {str(e)}")
        return {
            "success": False,
            "error": f"Failed to create signup profile: {str(e)}"
        }

@router.post("/verify")
async def verify_otp(
    payload: OTPVerifyRequest,
    request: Request,
    response: Response
):
    try:
        email = payload.email.lower()
        otp = payload.otp.strip()
        
        database = db.get_db()
        otp_doc = await database["otps"].find_one({"email": email})
        
        if not otp_doc:
            return {"success": False, "error": "No verification request found for this email."}
            
        # Check attempts limit
        if otp_doc.get("attempts", 0) >= 5:
            await database["otps"].delete_one({"email": email})
            return {"success": False, "error": "Maximum attempts exceeded. Please request a new code."}
            
        # Check expiry
        if datetime.utcnow() > otp_doc.get("expiry"):
            await database["otps"].delete_one({"email": email})
            return {"success": False, "error": "Code has expired. Please request a new one."}
            
        # Validate OTP
        hashed_input = hash_otp(otp)
        if hashed_input != otp_doc.get("hashed_otp"):
            # Increment attempts
            await database["otps"].update_one(
                {"email": email},
                {"$inc": {"attempts": 1}}
            )
            return {"success": False, "error": "Invalid verification code."}
            
        # Code matches, delete OTP
        await database["otps"].delete_one({"email": email})
        
        # Resolve signup metadata
        metadata = otp_doc.get("metadata")
        user = await database[db.USERS].find_one({"email": email})
        
        if metadata:
            # We are in SIGNUP flow
            if user:
                return {"success": False, "error": "Account already created. Please log in."}
                
            # Create user
            new_user = {
                "email": email,
                "username": metadata["username"],
                "displayName": metadata["displayName"],
                "password": metadata["password"],
                "avatar": None,
                "providers": ["email"],
                "theme": "Obsidian",
                "createdAt": datetime.utcnow(),
                "settings": {
                    "audioQuality": "balanced",
                    "animations": True,
                    "privacy": "public",
                    "theme": "Obsidian"
                },
                "statistics": {
                    "totalListeningTime": 0,
                    "monthlyListeningTime": 0,
                    "topSongs": [],
                    "topArtists": []
                }
            }
            res = await database[db.USERS].insert_one(new_user)
            user_id = str(res.inserted_id)
            user = new_user
            user["_id"] = res.inserted_id
        else:
            # We are in LOGIN flow
            if not user:
                return {"success": False, "error": "Account not found. Please sign up first."}
            user_id = str(user["_id"])
            
        # Generate cookies and sessions
        access_token, refresh_token = await create_device_session(
            user_id, email, user.get("username"), request, database
        )
        set_auth_cookies(response, access_token, refresh_token)
        
        # Serialize user fields
        user["id"] = user_id
        if "_id" in user:
            del user["_id"]
        if "createdAt" in user:
            user["createdAt"] = user["createdAt"].isoformat()
            
        return {
            "success": True,
            "data": {
                "token": access_token,
                "user": user
            }
        }
    except Exception as e:
        logger.error(f"Error verifying OTP: {str(e)}")
        return {
            "success": False,
            "error": f"Verification error: {str(e)}"
        }

@router.post("/google")
async def google_login(
    payload: GoogleLoginRequest,
    request: Request,
    response: Response
):
    try:
        claims = await verify_google_id_token(payload.idToken)
        email = claims["email"].lower()
        display_name = sanitize_text(claims.get("name") or email.split("@")[0], max_length=120)
        avatar = sanitize_text(claims.get("picture"), max_length=500) if claims.get("picture") else None
        database = db.get_db()
        
        user = await database[db.USERS].find_one({"email": email})
        if not user:
            # Create user on first Google login
            username = username_from_email(email)
            if await database[db.USERS].find_one({"username": username}):
                username = f"{username[:21]}_{secrets.token_hex(4)}"
            new_user = {
                "email": email,
                "username": username,
                "displayName": display_name,
                "avatar": avatar,
                "providers": ["google"],
                "theme": "Obsidian",
                "createdAt": datetime.utcnow(),
                "settings": {
                    "audioQuality": "balanced",
                    "animations": True,
                    "privacy": "public",
                    "theme": "Obsidian"
                },
                "statistics": {
                    "totalListeningTime": 0,
                    "monthlyListeningTime": 0,
                    "topSongs": [],
                    "topArtists": []
                }
            }
            res = await database[db.USERS].insert_one(new_user)
            user_id = str(res.inserted_id)
            user = new_user
            user["_id"] = res.inserted_id
        else:
            user_id = str(user["_id"])
            # Update avatar or name if changed
            updates = {}
            if avatar and user.get("avatar") != avatar:
                updates["avatar"] = avatar
            if "google" not in user.get("providers", []):
                updates["providers"] = list(set(user.get("providers", []) + ["google"]))
            if updates:
                await database[db.USERS].update_one({"_id": user["_id"]}, {"$set": updates})
                user.update(updates)
                
        # Generate cookies and sessions
        access_token, refresh_token = await create_device_session(
            user_id, email, user.get("username"), request, database
        )
        set_auth_cookies(response, access_token, refresh_token)
        
        user["id"] = user_id
        if "_id" in user:
            del user["_id"]
        if "createdAt" in user:
            user["createdAt"] = user["createdAt"].isoformat()
            
        return {
            "success": True,
            "data": {
                "token": access_token,
                "user": user
            }
        }
    except Exception as e:
        logger.error(f"Error in Google OAuth authentication: {str(e)}")
        return {
            "success": False,
            "error": f"OAuth error: {str(e)}"
        }

@router.post("/login")
async def email_password_login(
    payload: EmailPasswordLoginRequest,
    request: Request,
    response: Response
):
    try:
        email = payload.email.lower()
        password = payload.password
        
        database = db.get_db()
        user = await database[db.USERS].find_one({"email": email})
        if not user:
            return {"success": False, "error": "Invalid email or password."}
            
        hashed_password = user.get("password")
        if not hashed_password:
            return {"success": False, "error": "This account does not use password login. Try logging in with another method."}
            
        if not verify_password(password, hashed_password):
            return {"success": False, "error": "Invalid email or password."}
            
        user_id = str(user["_id"])
        
        # Generate cookies and sessions
        access_token, refresh_token = await create_device_session(
            user_id, email, user.get("username"), request, database
        )
        set_auth_cookies(response, access_token, refresh_token)
        
        # Serialize user fields
        user["id"] = user_id
        if "_id" in user:
            del user["_id"]
        if "createdAt" in user:
            user["createdAt"] = user["createdAt"].isoformat()
            
        return {
            "success": True,
            "data": {
                "token": access_token,
                "user": user
            }
        }
    except Exception as e:
        logger.error(f"Error logging in: {str(e)}")
        return {"success": False, "error": f"Authentication error: {str(e)}"}

@router.post("/refresh")
async def refresh_session(
    response: Response,
    request: Request,
    refresh_token: Optional[str] = Cookie(None)
):
    try:
        token = refresh_token
        if not token:
            auth_header = request.headers.get("authorization")
            if auth_header and auth_header.lower().startswith("bearer "):
                token = auth_header[7:]
            else:
                try:
                    body = await request.json()
                    token = body.get("refreshToken") or body.get("refresh_token")
                except Exception:
                    pass

        if not token:
            raise HTTPException(status_code=401, detail="Refresh token missing")

        token_hash = hash_refresh_token(token)
        database = db.get_db()
        session = await database[SESSIONS_COLLECTION].find_one({"refreshTokenHash": token_hash})
        
        if not session or session.get("expiresAt") < datetime.utcnow():
            if session:
                await database[SESSIONS_COLLECTION].delete_one({"_id": session["_id"]})
            raise HTTPException(status_code=401, detail="Session expired or invalid refresh token")

        user_id = session["userId"]
        user = await database[db.USERS].find_one({"_id": parse_object_id(user_id)})
        if not user:
            raise HTTPException(status_code=401, detail="User account not found")

        new_access_token_payload = {
            "sub": user_id,
            "email": user.get("email"),
            "username": user.get("username"),
            "type": "access"
        }
        new_access_token = create_access_token(new_access_token_payload, expires_delta=timedelta(days=7))
        
        new_refresh_token = secrets.token_hex(32)
        new_refresh_token_hash = hash_refresh_token(new_refresh_token)
        
        await database[SESSIONS_COLLECTION].update_one(
            {"_id": session["_id"]},
            {
                "$set": {
                    "refreshTokenHash": new_refresh_token_hash,
                    "createdAt": datetime.utcnow(),
                    "expiresAt": datetime.utcnow() + timedelta(days=30),
                    "device": request.headers.get("user-agent", "Unknown Device")
                }
            }
        )
        
        set_auth_cookies(response, new_access_token, new_refresh_token)
        
        user["id"] = user_id
        if "_id" in user:
            del user["_id"]
        if "createdAt" in user:
            user["createdAt"] = user["createdAt"].isoformat()
            
        return {
            "success": True,
            "data": {
                "token": new_access_token,
                "refreshToken": new_refresh_token,
                "user": user
            }
        }
    except HTTPException as he:
        raise he
    except Exception as e:
        logger.error(f"Error rotating refresh token: {str(e)}")
        return {"success": False, "error": f"Refresh failed: {str(e)}"}

@router.post("/logout")
async def logout_session(
    response: Response,
    refresh_token: Optional[str] = Cookie(None)
):
    try:
        if refresh_token:
            token_hash = hash_refresh_token(refresh_token)
            database = db.get_db()
            await database[SESSIONS_COLLECTION].delete_one({"refreshTokenHash": token_hash})
            
        response.delete_cookie(key="access_token", path="/")
        response.delete_cookie(key="refresh_token", path="/")
        
        return {"success": True, "data": {"message": "Logged out successfully"}}
    except Exception as e:
        logger.error(f"Error during logout: {str(e)}")
        return {"success": False, "error": f"Logout error: {str(e)}"}

@router.post("/forgot-password")
async def forgot_password(request: ForgotPasswordRequest):
    try:
        email = request.email.lower()
        database = db.get_db()
        
        # Check if user exists with this email
        user = await database[db.USERS].find_one({"email": email})
        if not user:
            # For security, we don't reveal if the email exists or not
            # We always return success to prevent email enumeration
            return {
                "success": True,
                "message": "If an account exists with this email, a password reset link has been sent."
            }
        
        # Generate a reset token
        reset_token = secrets.token_urlsafe(32)
        reset_token_hash = hashlib.sha256(reset_token.encode("utf-8")).hexdigest()
        expiry = datetime.utcnow() + timedelta(hours=1)  # 1 hour validity
        
        # Store reset token
        await database["password_resets"].update_one(
            {"email": email},
            {
                "$set": {
                    "email": email,
                    "token_hash": reset_token_hash,
                    "expiry": expiry,
                    "used": False
                }
            },
            upsert=True
        )
        
        logger.info(f"Generated password reset token for {email}")
        
        reset_link = f"{os.getenv('FRONTEND_URL', 'http://localhost:3000')}/reset-password?token={reset_token}&email={email}"
        
        # Send actual email with reset link
        email_sent = await send_password_reset_email(email, reset_link)
        if not email_sent:
            logger.warning(f"Failed to send password reset email to {email}, but continuing (dev mode fallback)")
        
        return {
            "success": True,
            "message": "If an account exists with this email, a password reset link has been sent.",
            "dev_reset_link": reset_link if os.getenv("ENVIRONMENT", "development").lower() == "development" else None,
            "email_sent": email_sent
        }
    except Exception as e:
        logger.error(f"Error generating password reset: {str(e)}")
        return {
            "success": False,
            "error": "Failed to process password reset request."
        }

@router.post("/reset-password")
async def reset_password(
    email: str,
    token: str,
    new_password: str
):
    try:
        email = email.lower()
        database = db.get_db()
        
        # Find reset token
        reset_doc = await database["password_resets"].find_one({"email": email})
        if not reset_doc:
            return {"success": False, "error": "Invalid or expired reset link."}
        
        # Verify token
        token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
        if reset_doc.get("token_hash") != token_hash:
            return {"success": False, "error": "Invalid or expired reset link."}
        
        # Check expiry
        if datetime.utcnow() > reset_doc.get("expiry"):
            return {"success": False, "error": "Reset link has expired. Please request a new one."}
        
        # Check if already used
        if reset_doc.get("used"):
            return {"success": False, "error": "This reset link has already been used."}
        
        # Validate password
        if len(new_password) < 6:
            return {"success": False, "error": "Password must be at least 6 characters long."}
        
        # Hash new password
        from app.services.auth_utils import hash_password
        hashed_password = hash_password(new_password)
        
        # Update user password
        await database[db.USERS].update_one(
            {"email": email},
            {"$set": {"password": hashed_password}}
        )
        
        # Mark reset token as used
        await database["password_resets"].update_one(
            {"email": email},
            {"$set": {"used": True}}
        )
        
        logger.info(f"Password reset successful for {email}")
        
        return {
            "success": True,
            "message": "Password has been reset successfully. You can now log in with your new password."
        }
    except Exception as e:
        logger.error(f"Error resetting password: {str(e)}")
        return {
            "success": False,
            "error": "Failed to reset password."
        }
