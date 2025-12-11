# Breakside Deployment

## ✅ Deployment Complete (December 11, 2025)

Breakside is fully deployed with CloudFront CDN for the PWA and EC2 for the API.

### Architecture

```
                              USERS
                                │
         ┌──────────────────────┼──────────────────────┐
         ▼                      ▼                      ▼
   breakside.pro          www.breakside.pro      api.breakside.pro
   (apex domain)                                        
         │                      │                      │
         ▼                      ▼                      ▼
   EC2 / nginx              CloudFront             EC2 / nginx
   (301 redirect)             (CDN)                 (proxy)
         │                      │                      │
         └──────────────►  S3 Bucket              FastAPI
                          (PWA + Viewer)         (port 8000)
```

### Live URLs

| Service | URL | Hosted On |
|---------|-----|-----------|
| **PWA** | https://www.breakside.pro | CloudFront → S3 |
| **PWA (redirect)** | https://breakside.pro | EC2 → www |
| **Static Viewer** | https://www.breakside.pro/viewer/ | CloudFront → S3 |
| **API** | https://api.breakside.pro | EC2 → FastAPI |
| **API (alt)** | https://api.breakside.us | EC2 → FastAPI |
| **Health Check** | https://api.breakside.pro/health | EC2 |

### Infrastructure

| Component | Details |
|-----------|---------|
| **CloudFront** | Distribution `E6M9KCXIU9CKD` (`d17eottm1x91n5.cloudfront.net`) |
| **S3 Bucket** | `breakside.pro` (us-east-1, static website hosting) |
| **EC2 Instance** | Amazon Linux 2, IP: 3.212.138.180 |
| **Python** | 3.8.20 with venv at `/opt/breakside/venv` |
| **Web Server** | nginx (reverse proxy, SSL termination for API + apex redirect) |
| **Process Manager** | systemd (`breakside.service`) |
| **SSL Certificates** | ACM (CloudFront) + Let's Encrypt (EC2) |
| **Data Storage** | `/var/lib/breakside/data/` on EC2 (JSON files) |

### Data Migrated

- 1 team (CUDO Mixed)
- 18 players  
- 4 games (Nov 15-16, 2025 tournament)

---

## Quick Reference Commands

### EC2 / API Management

```bash
# SSH into EC2
ssh -i ~/.ssh/your-key.pem ec2-user@3.212.138.180

# Check service status
sudo systemctl status breakside

# View live logs
sudo journalctl -u breakside -f

# Restart service
sudo systemctl restart breakside

# Deploy API code updates
cd /opt/breakside && sudo git pull && sudo systemctl restart breakside

# Renew SSL (runs automatically, but manual if needed)
sudo certbot renew

# Rebuild data index
curl -X POST https://api.breakside.pro/api/index/rebuild
```

### S3 / PWA Deployment

```bash
# Deploy PWA to S3 (from local machine)
cd /Users/luebke/src/ultistats
aws s3 sync . s3://breakside.pro/ \
  --exclude ".git/*" \
  --exclude "ultistats_server/*" \
  --exclude "data/*" \
  --exclude "scripts/*" \
  --exclude "*.py" \
  --exclude "__pycache__/*" \
  --exclude "*.md" \
  --exclude ".DS_Store" \
  --exclude "*.wav" \
  --exclude "*.ogg" \
  --exclude "*.m4a" \
  --exclude "*.webm"
# Note: store/ directory is included (contains client-side JS modules)
# Note: data/ directory is excluded (contains server-side JSON data)

# Upload static viewer
aws s3 sync ultistats_server/static/viewer/ s3://breakside.pro/viewer/

# Invalidate CloudFront cache (after S3 updates)
aws cloudfront create-invalidation --distribution-id E6M9KCXIU9CKD --paths "/*"
```

---

## Configuration Locations

| Component | Location |
|-----------|----------|
| **S3 Bucket** | AWS Console → S3 → `breakside.pro` |
| **CloudFront** | AWS Console → CloudFront → `E6M9KCXIU9CKD` |
| **ACM Certificate** | AWS Console → ACM (us-east-1) → `breakside.pro` |
| **EC2 env file** | `/etc/breakside/env` |
| **Systemd service** | `/etc/systemd/system/breakside.service` |
| **nginx config** | `/etc/nginx/conf.d/breakside.conf` |
| **Let's Encrypt certs** | `/etc/letsencrypt/live/api.breakside.us/` |
| **Certbot cron** | `/etc/cron.d/certbot` |

### DNS (Pair.com)

| Domain | Type | Value |
|--------|------|-------|
| `breakside.pro` | A | 3.212.138.180 |
| `www.breakside.pro` | CNAME | d17eottm1x91n5.cloudfront.net |
| `api.breakside.pro` | A | 3.212.138.180 |
| `breakside.us` | A | 3.212.138.180 |
| `api.breakside.us` | A | 3.212.138.180 |

---

## Future Enhancements (Post-Deployment)

After initial deployment is stable, consider:

1. **Automated backups** - Cron job to backup `/var/lib/breakside/data/` to S3
2. **Basic auth** - Add API key requirement for write operations
3. **Rate limiting** - nginx rate limiting for API endpoints
4. **Monitoring** - CloudWatch metrics or simple uptime monitoring
5. **CI/CD** - GitHub Actions to auto-deploy on push to main

---

## Future Phases (Deferred)

### Phase 7: Handoff / "Take Over" Functionality

Target: Allow multiple users to follow a game and transfer write-control.

- [ ] Backend: In-memory state `game_controllers`
- [ ] Endpoints: `/games/{game_id}/status`, `/request-takeover`, `/approve-takeover`
- [ ] Frontend: Controller badge, "Request Take Over" button, approval modal
- [ ] Disable event buttons if not controller

### Phase 8: Git-Based Backup

Target: Robust version history using Git.

- [ ] Verify `ENABLE_GIT_VERSIONING` in config
- [ ] Test git init and commit on game sync
- [ ] Add git log viewing endpoint

---

## Technical Notes

### Short ID Generation

Human-readable IDs with collision-resistant hash:

```javascript
/**
 * Generate a short, human-readable ID
 * Format: {sanitized-name}-{4-char-hash}
 * Example: "Alice-7f3a", "Sample-Team-b2c4"
 */
function generateShortId(name) {
    // Sanitize: keep alphanumeric and hyphens, max 20 chars
    const safeName = name
        .replace(/[^a-zA-Z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .substring(0, 20)
        .replace(/-+$/, ''); // trim trailing hyphens
    
    // Generate 4-char alphanumeric hash
    const hash = Math.random().toString(36).substring(2, 6);
    
    return `${safeName}-${hash}`;
}

// Examples:
// generateShortId("Alice")        -> "Alice-7f3a"
// generateShortId("Sample Team")  -> "Sample-Team-b2c4"
// generateShortId("Bob Smith Jr") -> "Bob-Smith-Jr-x9d2"
```

**Collision Handling:**
- On sync, if ID already exists on server with different data, append 2 more chars
- Example: `Alice-7f3a` collides → try `Alice-7f3a2b`
- Extremely rare with 4-char hash (1 in 1.6M chance per name)

### Server-Side Index Structure

```json
{
  "lastRebuilt": "2024-01-15T10:30:00Z",
  "playerGames": {
    "Alice-7f3a": ["2024-01-15_Team_vs_Opp_123", "2024-01-16_Team_vs_Opp_456"],
    "Bob-2d9e": ["2024-01-15_Team_vs_Opp_123"]
  },
  "teamGames": {
    "Sample-Team-b2c4": ["2024-01-15_Team_vs_Opp_123", "2024-01-16_Team_vs_Opp_456"]
  },
  "gameRoster": {
    "2024-01-15_Team_vs_Opp_123": ["Alice-7f3a", "Bob-2d9e", "Charlie-4k1m"]
  }
}
```

**Rebuild Logic:**
- Scan all games, extract player IDs from rosterSnapshot
- Scan all teams, extract player IDs
- Takes ~1 second for hundreds of games
- Triggered manually via `POST /index/rebuild` or automatically if index.json missing

### Roster Snapshot Structure

Capture player state at game time for historical accuracy:

```javascript
rosterSnapshot: {
    players: [
        {
            id: "Alice-7f3a",
            name: "Alice",
            nickname: "Ace",
            number: "7",
            gender: "FMP"
        },
        // ...
    ],
    capturedAt: "2024-01-15T10:30:00Z"
}
```

### Event Player References

Events reference players by ID:

```javascript
{
    type: "Throw",
    throwerId: "Alice-7f3a",
    receiverId: "Bob-2d9e",
    // ... other flags
}
```

### Backward Compatibility

During transition, support both formats:
- If event has `thrower` (object with name), use legacy lookup
- If event has `throwerId` (string), use ID lookup
- Migration converts legacy → ID format

### Offline Creation Flow

```
User creates player while offline:
1. generateShortId("Alice") -> "Alice-7f3a"
2. Save to localStorage with _localOnly: true
3. Add to sync queue: {type: 'player', action: 'create', id: 'Alice-7f3a', data: {...}}
4. UI shows player immediately (works offline)

When online:
5. Process sync queue
6. POST /players with player data
7. If ID collision, server returns new ID, update local
8. Remove _localOnly flag
```

---

## Success Criteria

1. ✅ Players exist as independent entities with short, readable IDs
2. ✅ Teams reference players by ID
3. ✅ Games reference teams by ID and include roster snapshot
4. ✅ All data syncs to cloud server
5. ✅ App works fully offline (create teams, players, games)
6. ✅ Existing data migrates cleanly *(4 CUDO games migrated via Python script)*
7. ✅ Stats computed correctly from events
8. ✅ Server index enables efficient cross-entity queries
9. ✅ Viewer shows games, teams, and players with navigation
10. ✅ Viewer updated incrementally with each phase
