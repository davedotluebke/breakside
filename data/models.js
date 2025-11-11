/*
 * Data Model Definitions
 * Contains all core data structures for game tracking
 */

// Role constants for team vs opponent
const Role = {
    TEAM: "team",
    OPPONENT: "opponent",
};

// Unknown player constant and singleton instance
const UNKNOWN_PLAYER = "Unknown Player";

// Gender constants
const Gender = {
    MMP: "MMP",
    FMP: "FMP",
    UNKNOWN: "Unknown"
};

// Player data structure
function Player(name, nickname = "", gender = Gender.UNKNOWN) {
    this.name = name;
    this.nickname = nickname;
    this.gender = gender;
    this.totalPointsPlayed = 0;
    this.consecutivePointsPlayed = 0;
    this.pointsPlayedPreviousGames = 0;
    this.totalTimePlayed = 0;  // in milliseconds
    this.completedPasses = 0;
    this.turnovers = 0;
    this.goals = 0;
    this.assists = 0;
    this.pointsWon = 0;
    this.pointsLost = 0;
}

// Note: UNKNOWN_PLAYER_OBJ singleton will be created in data/storage.js after Player is defined

// Game data structure; includes a list of 'points'
function Game(teamName, opponentName, startOn) {
    this.team = teamName;
    this.opponent = opponentName;
    this.startingPosition = startOn;
    this.scores = {
        [Role.TEAM]: 0,
        [Role.OPPONENT]: 0,
    };
    this.points = [];  // An array of Point objects
    this.gameStartTimestamp = new Date();
    this.gameEndTimestamp = null;
    this.pointsData = [];  // Array of objects, each object will have player names as keys and true/false as values.
    this.lastLineUsed = null; // Track the last line used in this game
    this.alternateGenderRatio = 'No'; // Gender ratio enforcement: 'No', 'Alternating', or ratio string like '4:3'
    this.alternateGenderPulls = false; // Whether to follow Mixed rules for alternating gender pulls
    this.startingGenderRatio = null; // 'FMP' or 'MMP' - the gender that should have more players on the first point
}

// Team data structure
function Team(name = "My Team", initialRoster = []) {
    this.name = name;
    this.games = [];  // array of Games played by this team
    this.teamRoster = []; // array of Players on the team
    this.lines = []; // array of pre-defined player lines
    initialRoster.forEach(name => {
        let newPlayer = new Player(name);
        this.teamRoster.push(newPlayer);
    });
}

// Base Event class
class Event {
    constructor(type) {
        this.type = type;
    }

    // Default summarize method for generic events
    summarize() {
        return `Event of type: ${this.type}`;
    }
}

// Throw event class
class Throw extends Event {
    constructor({thrower = "voidthrower", receiver = "voidreceiver", huck = false, breakmark = false, dump = false, hammer = false, sky = false, layout = false, score = false}) {
        super('Throw');
        this.thrower = thrower;
        this.receiver = receiver;
        this.huck_flag = huck;
        this.break_flag = breakmark;
        this.dump_flag = dump;
        this.hammer_flag = hammer;
        this.sky_flag = sky;
        this.layout_flag = layout;
        this.score_flag = score;
    }

    // Override summarize for Throw events
    summarize() {
        let verb = `${this.huck_flag ? 'hucks' : 'throws'}`;
        let summary = `${this.thrower.name} ${verb} `;
        let throwType = '';
        let receiver = this.receiver ? this.receiver.name : '';
        if (this.break_flag)        { throwType += 'break '; }
        if (this.hammer_flag)       { throwType += 'hammer '; }
        if (this.dump_flag)         { throwType += 'dump '; }
        if (throwType)              { summary += `a ${throwType}`; }
        if (receiver)               { summary += `to ${this.receiver.name} `; }
        if (this.sky_flag || this.layout_flag) {
            summary += `for a ${this.sky_flag ? "sky ":""}${this.layout_flag ? "layout ":""}catch `;
        }        
        if (this.score_flag) summary += 'for the score!';

        return summary;
    }
}

// Turnover event class
class Turnover extends Event {
    constructor({thrower = null, receiver = null, throwaway = false, huck = false, receiverError = false, goodDefense = false, stall = false}) {
        super('Turnover');
        this.thrower = thrower;
        this.receiver = receiver;
        this.throwaway_flag = throwaway;
        this.huck_flag = huck;
        this.drop_flag = receiverError;
        this.defense_flag = goodDefense;
        this.stall_flag = stall;
    }
    
    // Override summarize for Turnover events
    summarize() {
        const t = this.thrower ? this.thrower.name : "voidthrower"
        const r = this.receiver ? this.receiver.name : "voidreceiver"
        const hucktxt = this.huck_flag ? 'on a huck' : '';
        const defensetxt = this.defense_flag ? 'due to good defense' : '';
        if (this.throwaway_flag)    { return `${t} throws it away ${hucktxt} ${defensetxt}`; }
        if (this.drop_flag){ return `${r} misses the catch from ${t} ${hucktxt} ${defensetxt}`; }
        if (this.defense_flag)  { return `Turnover ${defensetxt}`; }
        if (this.stall_flag)        { return `${t} gets stalled ${defensetxt}`; }
        // Fallback for unspecified turnovers
        return `Turnover by ${t}`;
    }
}

// Violation event class
class Violation extends Event {
    constructor({offensive = false, strip = false, pick = false, travel = false, contested = false, doubleTeam = false}) {
        super('Violation');
        this.ofoul_flag = offensive;
        this.strip_flag = strip;
        this.pick_flag = pick;
        this.travel_flag = travel;
        this.contest_flag = contested;
        this.dblteam_flag = doubleTeam;
    }
    
    // Override summarize for Violation events  
    summarize() {
        let summary = 'Violation called: ';
        if (this.offensive_flag)        { summary += 'Offensive foul '; }
        if (this.strip_flag)            { summary += 'Strip '; }
        if (this.pick_flag)             { summary += 'Pick '; }
        if (this.travel_flag)           { summary += 'Travel '; }
        if (this.contested_flag)        { summary += 'Contested foul '; }
        if (this.doubleTeam_flag)       { summary += 'Double team '; }
        return summary;
    }
}

// Defense event class
class Defense extends Event {
    constructor({defender = null, interception = false, layout = false, sky = false, Callahan = false, stall = false, unforcedError = false}) {
        super('Defense');
        this.defender = defender;       // null indicates an unforced turnover by opponent
        this.interception_flag = interception;
        this.layout_flag = layout;
        this.sky_flag = sky;
        this.Callahan_flag = Callahan;
        this.stall_flag = stall;
        this.unforcedError_flag = unforcedError;
    }
    
    // Override summarize for Defense events
    summarize() {
        let summary = '';
        let defender = this.defender ? this.defender.name : '';
        if (this.interception_flag)     { summary += 'Interception '; }
        if (this.layout_flag)           { summary += 'Layout D '; }
        if (this.sky_flag)              { summary += 'Sky D '; }
        if (this.Callahan_flag)         { summary += 'Callahan '; }
        if (this.stall_flag)            { summary += 'Stall '; }
        if (this.unforcedError_flag)    { summary += 'Unforced error '; }
        if (this.defender) {
            summary += (summary ? summary : 'Turnover caused ') + `by ${defender}`;
        } else {
            summary = (summary ? summary : 'Unforced turnover by opponent');
        }
        return summary;
    }
}

// Other event class
class Other extends Event {
    constructor({timeout = null, injury = null, timecap = null, switchsides = null, halftime = null}) {
        super('Other');
        this.timeout_flag = timeout;
        this.injury_flag = injury;
        this.timecap_flag = timecap;
        this.switchsides_flag = switchsides;
        this.halftime_flag = halftime;
    }
    
    // Override summarize for Other events
    summarize() {
        let summary = '';
        if (this.timeout_flag)      { summary += 'Timeout called. '; }
        if (this.injury_flag)       { summary += 'Injury sub called '; }
        if (this.timecap_flag)      { summary += 'Hard cap called; game over '; }
        if (this.switchsides_flag)  { summary += 'O and D switch sides '; }
        if (this.halftime_flag)     { summary += 'Halftime '; }
        return summary;
    }
}

// Pull event class
class Pull extends Event {
    constructor({puller = null, pullerGender = Gender.UNKNOWN, quality = null, flick = false, roller = false, io = false, oi = false}) {
        super('Pull');
        this.puller = puller; // Player object or null for Unknown Player
        this.pullerGender = pullerGender; // 'FMP', 'MMP', or 'Unknown'
        this.quality = quality; // 'Good Pull', 'Okay Pull', 'Poor Pull', or 'Brick'
        this.flick_flag = flick;
        this.roller_flag = roller;
        this.io_flag = io;
        this.oi_flag = oi;
    }
    
    // Override summarize for Pull events
    summarize() {
        let pullerName = this.puller ? this.puller.name : UNKNOWN_PLAYER;
        let summary = `Pull by ${pullerName}`;
        if (this.quality) {
            summary += ` (${this.quality})`;
        }
        let pullType = [];
        if (this.flick_flag) pullType.push('Flick');
        if (this.roller_flag) pullType.push('Roller');
        if (this.io_flag) pullType.push('IO');
        if (this.oi_flag) pullType.push('OI');
        if (pullType.length > 0) {
            summary += ` - ${pullType.join(', ')}`;
        }
        return summary;
    }
}

// Possession class
class Possession {
    constructor(offensive) {
        this.offensive = offensive; // true for offensive, false for defensive
        this.events = [];
    }

    addEvent(event) {
        this.events.push(event);
    }
}

// Point class
class Point {
    constructor(playingPlayers, startOn) {
        this.possessions = [];
        this.players = playingPlayers;  // An array of player names who played the point
        this.startingPosition = startOn;  // Either 'offense' or 'defense'
        this.winner = "";  // Either 'team' or 'opponent'     
        this.startTimestamp = null;
        this.endTimestamp = null;
        this.totalPointTime = 0;  // Accumulated time tracking
        this.lastPauseTime = null;  // Track when the point was last paused
    }

    addPossession(possession) {
        this.possessions.push(possession);
    }
}

