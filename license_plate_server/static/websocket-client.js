/**
 * WebSocket client for License Plate Game
 * This module handles communication with the server via WebSockets
 */

class LicensePlateGameClient {
    constructor(serverUrl) {
        this.serverUrl = serverUrl || window.location.origin;
        this.token = null;
        this.websocket = null;
        this.gameId = null;
        this.callbacks = {
            onConnect: () => {},
            onDisconnect: () => {},
            onSightingAdded: () => {},
            onSightingDeleted: () => {},
            onUserJoined: () => {},
            onUserLeft: () => {},
            onError: () => {},
            onInit: () => {}
        };
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectInterval = 3000; // 3 seconds
        this.autoUpdateEnabled = true; // Flag to control server updates
    }

    /**
     * Authenticate with the server
     * @param {string} username 
     * @param {string} password 
     * @returns {Promise<boolean>}
     */
    async authenticate(username, password) {
        try {
            const formData = new URLSearchParams();
            formData.append('username', username);
            formData.append('password', password);

            const response = await fetch(`${this.serverUrl}/auth/login`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: formData
            });

            if (!response.ok) {
                throw new Error('Authentication failed');
            }

            const data = await response.json();
            this.token = data.access_token;
            // Store token in localStorage
            localStorage.setItem('license_plate_game_token', this.token);
            return true;
        } catch (error) {
            console.error('Authentication error:', error);
            this.callbacks.onError(error);
            return false;
        }
    }

    /**
     * Register a new user
     * @param {Object} userData 
     * @returns {Promise<boolean>}
     */
    async register(userData) {
        try {
            const response = await fetch(`${this.serverUrl}/auth/register`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(userData)
            });

            if (!response.ok) {
                throw new Error('Registration failed');
            }

            const data = await response.json();
            this.token = data.token;
            // Store token in localStorage
            localStorage.setItem('license_plate_game_token', this.token);
            return true;
        } catch (error) {
            console.error('Registration error:', error);
            this.callbacks.onError(error);
            return false;
        }
    }

    /**
     * Check if the client is authenticated
     * @returns {boolean}
     */
    isAuthenticated() {
        return !!this.token;
    }

    /**
     * Connect to the WebSocket server for a specific game
     * @param {string} gameId 
     * @returns {Promise<boolean>}
     */
    async connectToGame(gameId) {
        if (!this.isAuthenticated()) {
            throw new Error('Not authenticated. Please log in first.');
        }

        this.gameId = gameId;
        
        // Close existing connection if any
        if (this.websocket && this.websocket.readyState < 2) {
            this.websocket.close();
        }

        return new Promise((resolve, reject) => {
            try {
                this.websocket = new WebSocket(`${this.serverUrl.replace(/^http/, 'ws')}/ws/${gameId}?token=${this.token}`);
                
                this.websocket.onopen = () => {
                    console.log(`Connected to game ${gameId}`);
                    this.reconnectAttempts = 0;
                    this.callbacks.onConnect();
                    resolve(true);
                    
                    // Start ping interval to keep connection alive
                    this.startPingInterval();
                };
                
                this.websocket.onclose = (event) => {
                    console.log(`Disconnected from game ${gameId}`, event);
                    this.callbacks.onDisconnect();
                    
                    // Clear ping interval
                    this.clearPingInterval();
                    
                    // Attempt to reconnect if not closed deliberately
                    if (event.code !== 1000) {
                        this.attemptReconnect();
                    }
                };
                
                this.websocket.onerror = (error) => {
                    console.error('WebSocket error:', error);
                    this.callbacks.onError(error);
                    reject(error);
                };
                
                this.websocket.onmessage = (event) => {
                    this.handleMessage(event);
                };
            } catch (error) {
                console.error('WebSocket connection error:', error);
                this.callbacks.onError(error);
                reject(error);
            }
        });
    }

    /**
     * Attempt to reconnect to the server
     */
    attemptReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.log('Max reconnect attempts reached');
            return;
        }
        
        this.reconnectAttempts++;
        console.log(`Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
        
        setTimeout(() => {
            if (this.gameId) {
                this.connectToGame(this.gameId).catch(error => {
                    console.error('Reconnection failed:', error);
                });
            }
        }, this.reconnectInterval);
    }

    /**
     * Start a ping interval to keep the connection alive
     */
    startPingInterval() {
        this.pingInterval = setInterval(() => {
            if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
                this.send({
                    type: 'ping',
                    data: { timestamp: new Date().toISOString() }
                });
            }
        }, 30000); // Send ping every 30 seconds
    }

    /**
     * Clear the ping interval
     */
    clearPingInterval() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
    }

    /**
     * Disconnect from the WebSocket server
     */
    disconnect() {
        if (this.websocket) {
            this.websocket.close(1000, 'Client disconnected');
            this.websocket = null;
        }
        this.clearPingInterval();
    }

    /**
     * Handle incoming WebSocket messages
     * @param {string} data 
     */
    handleMessage(event) {
        const message = JSON.parse(event.data);
        
        if (!this.autoUpdateEnabled) {
            console.log('Server updates disabled, ignoring message:', message.type);
            return;
        }

        switch (message.type) {
            case 'init':
                if (this.callbacks.onInit) {
                    this.callbacks.onInit(message.data.sightings);
                }
                break;
            case 'new_sighting':
                if (this.callbacks.onSightingAdded) {
                    this.callbacks.onSightingAdded(message.data);
                }
                break;
            case 'sighting_deleted':
                if (this.callbacks.onSightingDeleted) {
                    this.callbacks.onSightingDeleted(message.data);
                }
                break;
            case 'user_joined':
                if (this.callbacks.onUserJoined) {
                    this.callbacks.onUserJoined(message.data);
                }
                break;
            case 'user_left':
                if (this.callbacks.onUserLeft) {
                    this.callbacks.onUserLeft(message.data);
                }
                break;
            case 'error':
                if (this.callbacks.onError) {
                    this.callbacks.onError(message.data);
                }
                break;
            case 'pong':
                // Heartbeat response, no need to handle
                break;
            default:
                console.warn('Unknown message type:', message.type);
        }
    }

    /**
     * Send a message to the server
     * @param {Object} message 
     */
    send(message) {
        if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) {
            console.error('WebSocket is not connected');
            return false;
        }
        
        this.websocket.send(JSON.stringify(message));
        return true;
    }

    /**
     * Add a plate sighting
     * @param {Object} sightingData 
     * @returns {boolean}
     */
    addSighting(sightingData) {
        return this.send({
            type: 'add_sighting',
            data: sightingData
        });
    }

    /**
     * Delete a plate sighting
     * @param {string} sightingId 
     * @returns {boolean}
     */
    deleteSighting(sightingId) {
        return this.send({
            type: 'delete_sighting',
            data: { id: sightingId }
        });
    }

    /**
     * Register callback functions
     * @param {Object} callbacks 
     */
    registerCallbacks(callbacks) {
        this.callbacks = { ...this.callbacks, ...callbacks };
    }

    /**
     * Get all games from the server
     * @returns {Promise<Array>}
     */
    async getGames() {
        if (!this.isAuthenticated()) {
            throw new Error('Not authenticated. Please log in first.');
        }

        try {
            const response = await fetch(`${this.serverUrl}/games`, {
                headers: {
                    'Authorization': `Bearer ${this.token}`
                }
            });

            if (!response.ok) {
                throw new Error('Failed to fetch games');
            }

            const data = await response.json();
            return data.games;
        } catch (error) {
            console.error('Error fetching games:', error);
            this.callbacks.onError(error);
            return [];
        }
    }

    /**
     * Create a new game
     * @param {string} name 
     * @param {string} endDate 
     * @returns {Promise<Object>}
     */
    async createGame(name, endDate) {
        if (!this.isAuthenticated()) {
            throw new Error('Not authenticated. Please log in first.');
        }

        try {
            const url = new URL(`${this.serverUrl}/games`);
            url.searchParams.append('name', name);
            if (endDate) {
                url.searchParams.append('end_date', endDate);
            }

            const response = await fetch(url.toString(), {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.token}`
                }
            });

            if (!response.ok) {
                throw new Error('Failed to create game');
            }

            return await response.json();
        } catch (error) {
            console.error('Error creating game:', error);
            this.callbacks.onError(error);
            throw error;
        }
    }

    /**
     * Request sightings data for a game
     * @param {string} gameId 
     * @returns {boolean}
     */
    requestSightings(gameId) {
        return this.send({
            type: 'get_sightings',
            data: { game_id: gameId }
        });
    }

    // Add method to control auto-updates
    setAutoUpdate(enabled) {
        this.autoUpdateEnabled = enabled;
    }
}

// Export the client class
window.LicensePlateGameClient = LicensePlateGameClient; 