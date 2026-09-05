import os
import hashlib
import hmac
import secrets
import jwt
from datetime import datetime, timedelta
from typing import Optional, Dict

JWT_SECRET = os.getenv("JWT_SECRET")
ALGORITHM = "HS256"

# Fixed claims so tokens can't be replayed against the wrong context or stage.
JWT_ISSUER = "strumm-api"
JWT_AUDIENCE = "strumm"
ACCESS_TOKEN_TYPE = "access"

# Access tokens are deliberately long-lived enough to survive page reloads and
# API cold starts (the HF Spaces gateway sleeps when idle, so the first request
# after a pause can 503 for a while). The sliding 7-day refresh token is what
# really gates the session, so a 1-hour access token is safe.
ACCESS_TOKEN_EXPIRE = timedelta(hours=1)

def get_jwt_secret() -> str:
    if not JWT_SECRET or len(JWT_SECRET) < 32:
        raise RuntimeError("JWT_SECRET must be configured and at least 32 characters long.")
    return JWT_SECRET

# Constants for HMAC-peppering one-time passwords. The OTP space (6 digits) is
# trivially brute-forcible offline if the ``otps`` collection ever leaks, so the
# stored digest must be an HMAC keyed with a server-side pepper rather than a
# plain (fast, keyless) SHA-256. The pepper is derived from the JWT secret so no
# extra environment surface is needed, with an explicit domain-salt so the same
# secret is never reused verbatim for a different purpose.
OTP_PEPPER_CONTEXT = b"strumm-otp-v1"


def _otp_pepper() -> bytes:
    return hmac.new(
        OTP_PEPPER_CONTEXT,
        get_jwt_secret().encode("utf-8"),
        hashlib.sha256,
    ).digest()


# Create an HMAC-SHA256 "peppered" hash of an OTP string
def hash_otp(otp: str) -> str:
    return hmac.new(_otp_pepper(), otp.encode("utf-8"), hashlib.sha256).hexdigest()

# Generate a JWT Session Token
def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    to_encode = data.copy()
    if expires_delta:
        expire = datetime.utcnow() + expires_delta
    else:
        expire = datetime.utcnow() + ACCESS_TOKEN_EXPIRE

    to_encode.update({
        "exp": expire,
        "iss": JWT_ISSUER,
        "aud": JWT_AUDIENCE,
        # Every token minted here is a session access token; refuse to create
        # anything else rather than letting a call accidentally mint another
        # type under the same secret.
        "type": ACCESS_TOKEN_TYPE,
    })
    encoded_jwt = jwt.encode(to_encode, get_jwt_secret(), algorithm=ALGORITHM)
    return encoded_jwt

# Decode a JWT Token
def decode_access_token(token: str) -> Optional[dict]:
    try:
        decoded_payload = jwt.decode(
            token,
            get_jwt_secret(),
            algorithms=[ALGORITHM],
            issuer=JWT_ISSUER,
            audience=JWT_AUDIENCE,
        )
        if decoded_payload.get("type") != ACCESS_TOKEN_TYPE:
            return None
        return decoded_payload
    except jwt.PyJWTError:
        return None

# Secure PBKDF2 Password Hashing
def hash_password(password: str) -> str:
    salt = os.urandom(16)
    key = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 100000)
    return salt.hex() + ":" + key.hex()

def verify_password(password: str, hashed: str) -> bool:
    try:
        salt_hex, key_hex = hashed.split(":")
        salt = bytes.fromhex(salt_hex)
        key = bytes.fromhex(key_hex)
        new_key = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 100000)
        return secrets.compare_digest(new_key, key)
    except Exception:
        return False
