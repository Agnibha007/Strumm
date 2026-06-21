import os
import hashlib
import jwt
from datetime import datetime, timedelta
from typing import Optional, Dict

JWT_SECRET = os.getenv("JWT_SECRET")
ALGORITHM = "HS256"

def get_jwt_secret() -> str:
    if not JWT_SECRET or len(JWT_SECRET) < 32:
        raise RuntimeError("JWT_SECRET must be configured and at least 32 characters long.")
    return JWT_SECRET

# Create a SHA256 hash of an OTP string
def hash_otp(otp: str) -> str:
    return hashlib.sha256(otp.encode("utf-8")).hexdigest()

# Generate a JWT Session Token
def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    to_encode = data.copy()
    if expires_delta:
        expire = datetime.utcnow() + expires_delta
    else:
        expire = datetime.utcnow() + timedelta(days=7) # Default 1 week session
    
    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, get_jwt_secret(), algorithm=ALGORITHM)
    return encoded_jwt

# Decode a JWT Token
def decode_access_token(token: str) -> Optional[dict]:
    try:
        decoded_payload = jwt.decode(token, get_jwt_secret(), algorithms=[ALGORITHM])
        return decoded_payload
    except jwt.PyJWTError:
        return None
