## New feature: cLoud-based backend hosted on Google Sheets

I want to store Teams, Players, and Games in a backend hosted on the cloud. I want to use Google Sheets as a robust human-readable storage strategy. This app is restricted to "friends and family" for now, so it is fine to use a single Google Sheet to store all Teams (Players etc). Each Game is a separate tab in the spreadsheet, and are represented as a few header rows followed by a row-by-row serialization of each Point, Possession, and Events. The sheet should be optimized for human readability of the play-by-play events, for example with columns representing common plays (first throws - a column each for thrower, receiver, and a string listing modifiers [huck, sky, etc]; then defense, with column for defender then a string of modifier flags; then turnovers etc.). The rare events (timeouts, injury sub, etc)should be the rightmost columns.  The first couple of columns can be reserved for Point beginnings (including roster) and endings (including defense plays including "They Score" events). 

One of the first tasks will be to create a Google Sheets-based serialization and fine-tune the appearance for readability. 

As for the cloud backend, I already have a small EC2 instance and can run a Node or (slightly preferred) Python server. I have already vibe-coded a simple Google Sheets-based license plate game and gotten it working using FastAPI, but I am not attached to that app - it might be good to just directly reuse the Google Sheets API keys and other authentication mechanism from that repo, since that was a pain to get working. 

There are a few major reason to do this refactor:
- Robust cloud backup of games 
- Interactive handoff bwetween 