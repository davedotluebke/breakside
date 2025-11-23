"""
Authentication models for the Ultistats server.
"""
from datetime import datetime, timedelta
from typing import Optional, List, Dict, Any

from pydantic import BaseModel, EmailStr, Field
from jose import jwt
from passlib.context import CryptContext
import bcrypt

from ultistats_server.config import SECRET_KEY, JWT_ALGORITHM, ACCESS_TOKEN_EXPIRE_MINUTES

# Password hashing
pwd_context = CryptContext(
    schemes=["bcrypt"],
    bcrypt__rounds=12,  # Explicitly set rounds to avoid version check
    deprecated="auto"
)

# User models
class UserBase(BaseModel):
    username: str
    email: Optional[EmailStr] = None
    full_name: Optional[str] = None

class UserCreate(UserBase):
    password: str

class UserInDB(UserBase):
    hashed_password: str
    created_at: datetime = Field(default_factory=datetime.utcnow)
    active_games: List[str] = []
    
    def verify_password(self, plain_password: str) -> bool:
        """Verify a password against the hashed password."""
        return pwd_context.verify(plain_password, self.hashed_password)
    
    @classmethod
    def create_user(cls, user_create: UserCreate) -> 'UserInDB':
        """Create a new user with hashed password."""
        hashed_password = pwd_context.hash(user_create.password)
        return cls(
            username=user_create.username,
            email=user_create.email,
            full_name=user_create.full_name,
            hashed_password=hashed_password
        )

class User(UserBase):
    id: str
    active_games: List[str] = []

# Authentication token models
class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"

class TokenData(BaseModel):
    username: str
    
def create_access_token(data: Dict[str, Any], expires_delta: Optional[timedelta] = None) -> str:
    """Create a new JWT access token."""
    to_encode = data.copy()
    if expires_delta:
        expire = datetime.utcnow() + expires_delta
    else:
        expire = datetime.utcnow() + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, SECRET_KEY, algorithm=JWT_ALGORITHM)
    return encoded_jwt
