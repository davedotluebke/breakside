"""
Authentication routes for the Ultistats server.
"""
from datetime import timedelta
from typing import Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from jose import JWTError, jwt

from ultistats_server.auth.models import (
    User, UserCreate, UserInDB, Token, TokenData,
    create_access_token
)
from ultistats_server.config import SECRET_KEY, JWT_ALGORITHM, ACCESS_TOKEN_EXPIRE_MINUTES
from ultistats_server.sheets import operations

# Create router
router = APIRouter()

# OAuth2 scheme for token-based authentication
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="auth/login")

# User authentication
def get_user(username: str) -> Optional[UserInDB]:
    """Get a user from the database by username."""
    user_data = operations.get_user_by_username(username)
    if user_data:
        return UserInDB(
            username=user_data['username'],
            email=user_data['email'],
            full_name=user_data['full_name'],
            hashed_password=user_data['hashed_password'],
            active_games=user_data['active_games']
        )
    return None

async def get_current_user(token: str = Depends(oauth2_scheme)) -> User:
    """Get the current authenticated user from the JWT token."""
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[JWT_ALGORITHM])
        username: str = payload.get("sub")
        if username is None:
            raise credentials_exception
        token_data = TokenData(username=username)
    except JWTError:
        raise credentials_exception
    
    user = get_user(token_data.username)
    if user is None:
        raise credentials_exception
    
    return User(
        id=user.username,
        username=user.username,
        email=user.email,
        full_name=user.full_name,
        active_games=user.active_games
    )

# Routes
@router.post("/register", response_model=User)
async def register_user(user: UserCreate):
    """Register a new user."""
    # Check if user already exists
    if get_user(user.username):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Username already registered"
        )
    
    # Create user in database
    db_user = UserInDB.create_user(user)
    
    # Save user to Google Sheet
    user_data = {
        'username': db_user.username,
        'email': db_user.email,
        'full_name': db_user.full_name,
        'hashed_password': db_user.hashed_password,
        'active_games': db_user.active_games
    }
    operations.create_user(user_data)
    
    return User(
        id=db_user.username,
        username=db_user.username,
        email=db_user.email,
        full_name=db_user.full_name,
        active_games=db_user.active_games
    )

@router.post("/login", response_model=Token)
async def login_for_access_token(form_data: OAuth2PasswordRequestForm = Depends()):
    """Login and get an access token."""
    user = get_user(form_data.username)
    if not user or not user.verify_password(form_data.password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    
    access_token_expires = timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    access_token = create_access_token(
        data={"sub": user.username}, expires_delta=access_token_expires
    )
    
    return Token(access_token=access_token)

@router.get("/me", response_model=User)
async def read_users_me(current_user: User = Depends(get_current_user)):
    """Get the current authenticated user."""
    return current_user
