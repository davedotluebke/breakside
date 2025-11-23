# License Plate Game - Server Implementation Plan of Record

## Overview
This document outlines the plan for implementing a Python-based server for the License Plate Game PWA. The server will handle all communication with Google Sheets via a service account, eliminating the need for individual users to authenticate with Google.

## Goals
- [x] Create server directory structure
- [x] Implement websocket server using Python
- [x] Set up Google Sheets API authentication using service account
- [x] Implement lightweight user enrollment/authentication
- [x] Modify the client application to use websockets
- [ ] Deploy and test the complete system

## Detailed Plan

### 1. Server Architecture
- [x] Create server directory structure
- [x] Choose Python websocket framework (FastAPI with websockets)
- [x] Design API endpoints for client-server communication
- [x] Plan data models and validation

### 2. Google Sheets Integration
- [x] Implement service account authentication
- [x] Create wrapper functions for all Google Sheets operations
- [x] Test Google Sheets integration

### 3. User Authentication System
- [x] Design simple user registration/login system
- [x] Implement session management
- [x] Create security measures (rate limiting, input validation)

### 4. Client Modifications
- [x] Update service worker to support websocket connections
- [x] Modify existing Google Sheets functions to call server APIs
- [x] Add offline mode support with synchronization

### 5. Deployment
- [x] Document deployment requirements
- [ ] Create setup scripts
- [ ] Implement logging and monitoring

## Technical Requirements

### Server Components
- Python 3.9+
- FastAPI for HTTP/WebSocket server
- Google API Client Library for Python
- SQLite for lightweight user database (optional)

### Authentication Flow
1. User registers/logs in with username/password or email
2. Server authenticates user and establishes websocket connection
3. Server handles all Google Sheets operations using service account
4. User actions trigger websocket messages to server

### API Endpoints
- `/ws` - WebSocket endpoint for real-time communication
- `/auth/register` - User registration
- `/auth/login` - User login
- `/auth/logout` - User logout

### Dependencies
```
fastapi>=0.95.0
uvicorn>=0.22.0
websockets>=11.0.3
google-auth>=2.16.0
google-api-python-client>=2.80.0
google-auth-httplib2>=0.1.0
google-auth-oauthlib>=1.0.0
pydantic>=1.10.7
python-jose>=3.3.0
passlib>=1.7.4
python-multipart>=0.0.6
```

## Implementation Timeline
1. **Week 1**: Server setup, Google Sheets integration
2. **Week 2**: User authentication, client modifications
3. **Week 3**: Testing, deployment, documentation

## Directory Structure
```
server/
├── main.py               # FastAPI application entrypoint
├── requirements.txt      # Python dependencies
├── config.py             # Configuration settings
├── static/               # Static files
│   └── websocket-client.js  # Client-side WebSocket implementation
├── templates/            # HTML templates (if needed)
├── auth/                 # Authentication modules
│   ├── __init__.py
│   ├── models.py         # User models
│   └── routes.py         # Auth routes
├── sheets/               # Google Sheets integration
│   ├── __init__.py
│   ├── service.py        # Service account implementation
│   └── operations.py     # Sheets operations
└── websocket/            # WebSocket handlers
    ├── __init__.py
    └── handlers.py       # WS message handlers
```

## Running the Server

To run the server in development mode:

1. Install the required dependencies:
   ```
   cd server
   pip install -r requirements.txt
   ```

2. Run the server:
   ```
   python -m server.main
   ```

3. The server will be available at `http://localhost:8000`

## Next Steps

1. Implement the remaining client-side modifications to use the WebSocket API
2. Test the integration between the client and server
3. Add more robust error handling and logging
4. Deploy the server to a production environment 