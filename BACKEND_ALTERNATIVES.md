# Backend Storage Alternatives Analysis

## Current Situation

**Goals from TODO.md:**
- Robust cloud backup of games
- Persistent between users (enables handoff)
- Interactive handoff between users
- More easily human-readable summaries of games

**Current Problems with Google Sheets Approach:**
- Google API throttling limits (~100 requests/100 seconds)
- Token expiration issues requiring retry logic
- Complex verification and retry logic needed
- Low readability of spreadsheet format (despite optimization attempts)
- High code complexity (~4500 lines of Python code)
- Slow API responses affecting user experience

## Alternative Proposals

### Option 1: JSON Files on Server Filesystem (Simplest)

**Architecture:**
- Store each game as a single JSON file: `games/{game_id}.json`
- Store teams/players metadata in `teams/{team_id}.json` and `players/{team_id}.json`
- Simple REST API that reads/writes JSON files directly
- No database, no external dependencies beyond FastAPI

**File Structure:**
```
/data/
  games/
    2024-01-15_team-vs-opponent_abc123.json
    2024-01-20_team-vs-opponent_def456.json
  teams/
    team_abc123.json
  players/
    team_abc123_players.json
  users/
    users.json  # Simple JSON array for auth
```

**Code Complexity:** ~500-800 lines
- Simple file I/O operations
- No serialization layer (JSON is native)
- No retry logic needed (filesystem is reliable)
- No API rate limits

**Pros:**
- ✅ **Extremely simple** - minimal code, easy to understand
- ✅ **Human-readable** - JSON files can be opened in any editor
- ✅ **No external dependencies** - just Python stdlib + FastAPI
- ✅ **Fast** - filesystem operations are instant
- ✅ **No throttling** - no API limits to worry about
- ✅ **Easy debugging** - can inspect files directly
- ✅ **Easy backups** - just copy directory
- ✅ **Version control friendly** - can git track games if desired

**Cons:**
- ❌ **No concurrent write protection** - race conditions possible (but rare for "friends and family")
- ❌ **No querying** - can't easily search/filter games (but can add simple indexing)
- ❌ **Scaling limits** - won't scale to thousands of games (but fine for small use case)
- ❌ **No built-in analytics** - would need to read all files for stats

**Readability:**
- JSON is structured and readable, but not as visual as a spreadsheet
- Can add a simple HTML viewer endpoint that formats games nicely
- Can export to CSV/Excel on-demand for spreadsheet viewing

**Handoff Support:**
- ✅ Full game sync via `GET /games/{game_id}` returns complete JSON
- ✅ Simple conflict resolution: last-write-wins based on file modification time
- ✅ Periodic polling works well (just read file)

---

### Option 2: SQLite Database (Balanced)

**Architecture:**
- Single SQLite database file: `ultistats.db`
- Tables: `teams`, `players`, `games`, `points`, `possessions`, `events`
- REST API uses SQLAlchemy ORM or raw SQL
- Can still export to JSON/CSV for readability

**Schema:**
```sql
teams (id, name, created_at)
players (id, team_id, name, nickname, gender, number)
games (id, team_id, opponent_name, start_timestamp, end_timestamp, ...)
points (id, game_id, point_num, start_timestamp, end_timestamp, winner, ...)
possessions (id, point_id, possession_num, type, ...)
events (id, possession_id, type, timestamp, data_json)
```

**Code Complexity:** ~800-1200 lines
- Database models and migrations
- SQL queries for CRUD operations
- Some serialization for events (store complex event data as JSON in `data_json` column)

**Pros:**
- ✅ **ACID guarantees** - no race conditions, transactional
- ✅ **Queryable** - can search/filter games easily
- ✅ **Efficient** - fast queries even with many games
- ✅ **Single file** - easy to backup (just copy `.db` file)
- ✅ **No external dependencies** - SQLite is built into Python
- ✅ **Can add indexes** - for fast lookups
- ✅ **Supports analytics** - SQL queries for statistics

**Cons:**
- ❌ **Less human-readable** - need SQL client or export tool to view
- ❌ **More complex than files** - need migrations, schema management
- ❌ **Binary format** - can't easily inspect raw data

**Readability:**
- Can add `GET /games/{game_id}/export` endpoint that returns formatted JSON/HTML
- Can create simple admin UI that displays games in readable format
- Export to CSV/Excel for spreadsheet viewing

**Handoff Support:**
- ✅ Full game sync via single query: `SELECT * FROM games WHERE id=?`
- ✅ Timestamp-based conflict resolution
- ✅ Efficient polling (just query latest timestamp)

---

### Option 3: Hybrid: JSON Files + SQLite Metadata Index

**Architecture:**
- Games stored as JSON files (for readability and simplicity)
- SQLite database stores only metadata/index: `games` table with `id`, `team_id`, `opponent`, `date`, `file_path`
- REST API reads/writes JSON files, updates SQLite index
- Best of both worlds: readable files + queryable metadata

**Code Complexity:** ~1000-1500 lines
- File I/O for games
- SQLite for metadata queries
- Some coordination logic

**Pros:**
- ✅ **Human-readable games** - JSON files can be inspected
- ✅ **Queryable metadata** - can search games by team, date, etc.
- ✅ **Fast game reads** - direct file access
- ✅ **Easy backups** - copy both directory and DB file

**Cons:**
- ❌ **More complex** - two storage systems to maintain
- ❌ **Consistency risk** - index could get out of sync (but can rebuild from files)

**Readability:**
- ✅ JSON files are directly readable
- ✅ Can add HTML viewer for formatted display

**Handoff Support:**
- ✅ Same as Option 1 (JSON files)

---

### Option 4: PostgreSQL Database (Overkill for MVP)

**Architecture:**
- PostgreSQL database on EC2
- Similar schema to SQLite option
- More robust, but requires database server setup

**Code Complexity:** ~1000-1500 lines (similar to SQLite)

**Pros:**
- ✅ **Production-ready** - handles concurrent writes well
- ✅ **Scalable** - can grow to many games/users
- ✅ **Advanced features** - full-text search, JSON columns, etc.

**Cons:**
- ❌ **More setup complexity** - need to install/maintain PostgreSQL
- ❌ **Overkill** - probably unnecessary for "friends and family" scale
- ❌ **Less portable** - harder to backup/move

**Verdict:** Probably overkill for current needs, but good if you expect to scale significantly.

---

## Additional Goals to Consider

Beyond the original goals, consider:

1. **Analytics & Statistics**
   - Which option makes it easiest to compute player stats?
   - SQLite/PostgreSQL: Easy with SQL queries
   - JSON files: Need to read all files and process (slower but doable)

2. **Export Capabilities**
   - Export games to CSV/Excel for spreadsheet analysis
   - Export to JSON for backup/portability
   - All options can support this via API endpoints

3. **Historical Browsing**
   - List all games for a team
   - Filter by date range
   - SQLite/PostgreSQL: Easy with queries
   - JSON files: Need directory listing + metadata parsing

4. **Sharing Games**
   - Share game via link (e.g., `/games/{game_id}`)
   - All options support this equally well

5. **Performance**
   - How fast is game creation? (all are fast)
   - How fast is event appending? (all are fast)
   - How fast is full game sync? (all are fast for single game)

6. **Backup & Recovery**
   - How easy is it to backup?
   - JSON files: Copy directory
   - SQLite: Copy `.db` file
   - PostgreSQL: `pg_dump`

7. **Multi-user Concurrent Access**
   - How well does it handle two users editing same game?
   - SQLite/PostgreSQL: Better (ACID transactions)
   - JSON files: Last-write-wins (acceptable for low concurrency)

---

## Recommendation

### **Option 1: JSON Files** (Simplest, Best for MVP)

**Why:**
1. **Minimal code complexity** (~500-800 lines vs ~4500 current)
2. **No external dependencies** - no Google API, no database server
3. **Human-readable** - JSON files are easy to inspect
4. **Fast** - filesystem operations are instant
5. **Easy to debug** - can inspect files directly
6. **Easy backups** - just copy directory
7. **Meets all core goals:**
   - ✅ Cloud backup (files on server)
   - ✅ Persistent between users (shared filesystem)
   - ✅ Handoff support (read/write JSON files)
   - ✅ Human-readable (JSON + optional HTML viewer)

**Implementation:**
```python
# ultistats_server/main.py - simplified
@app.get("/games/{game_id}")
async def get_game(game_id: str):
    with open(f"data/games/{game_id}.json") as f:
        return json.load(f)

@app.post("/games/{game_id}/sync")
async def sync_game(game_id: str, game_data: dict):
    with open(f"data/games/{game_id}.json", "w") as f:
        json.dump(game_data, f, indent=2)
    return {"status": "synced"}
```

**Code Reduction:**
- Remove: `sheets/service.py` (~300 lines)
- Remove: `sheets/serialization.py` (~500 lines)
- Remove: `sheets/operations.py` (~400 lines)
- Simplify: `main.py` (remove Sheets API calls, add simple file I/O)
- **Total: ~1200 lines removed, ~200 lines added = ~3500 lines saved**

**Future Enhancements:**
- If you need querying later, can add SQLite metadata index (Option 3)
- If you need better concurrency, can migrate to PostgreSQL
- Can add HTML viewer endpoint for better readability
- Can add export endpoints (CSV, Excel) for spreadsheet viewing

---

### Alternative Recommendation: **Option 2: SQLite** (If You Want Querying)

**Why:**
- If you anticipate needing to search/filter games frequently
- If you want built-in analytics capabilities
- Still much simpler than Google Sheets (no API throttling, no retry logic)

**Code Complexity:** ~800-1200 lines (still much less than current ~4500)

---

## Migration Path

If you choose Option 1 (JSON files):

1. **Keep existing Google Sheets code** (don't delete yet)
2. **Add new JSON file endpoints** alongside Sheets endpoints
3. **Test JSON file approach** with a few games
4. **Switch client to use JSON endpoints**
5. **Once stable, remove Sheets code**

This allows gradual migration without losing existing work.

---

## Comparison Table

| Feature | Google Sheets | JSON Files | SQLite | Hybrid |
|---------|--------------|------------|--------|--------|
| **Code Complexity** | ~4500 lines | ~500-800 | ~800-1200 | ~1000-1500 |
| **Human Readable** | ⚠️ Low | ✅ High | ❌ No | ✅ High |
| **API Throttling** | ❌ Yes | ✅ No | ✅ No | ✅ No |
| **Retry Logic Needed** | ❌ Yes | ✅ No | ✅ No | ✅ No |
| **Querying** | ⚠️ Limited | ❌ No | ✅ Yes | ✅ Yes |
| **Concurrent Writes** | ⚠️ OK | ⚠️ Last-write-wins | ✅ ACID | ✅ ACID |
| **Backup Ease** | ⚠️ Manual | ✅ Copy dir | ✅ Copy file | ✅ Copy both |
| **Setup Complexity** | ❌ High | ✅ Low | ✅ Low | ⚠️ Medium |
| **Performance** | ⚠️ Slow | ✅ Fast | ✅ Fast | ✅ Fast |

---

## Questions to Consider

1. **How many games do you expect?** 
   - < 100: JSON files is fine
   - 100-1000: SQLite is better
   - > 1000: PostgreSQL

2. **How important is querying/searching?**
   - Not important: JSON files
   - Somewhat important: SQLite
   - Very important: PostgreSQL

3. **How important is human readability?**
   - Very important: JSON files or Hybrid
   - Somewhat important: Can add export endpoints
   - Not important: SQLite/PostgreSQL

4. **How much code complexity are you willing to accept?**
   - Minimize: JSON files
   - Some complexity OK: SQLite
   - Complexity OK for features: Hybrid or PostgreSQL

