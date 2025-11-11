class AudioNarrationService {
    constructor() {
        this.isRecording = false;
        this.mediaRecorder = null;
        this.audioChunks = [];
        this.processingInterval = null;
        
        // OpenAI API Configuration
        this.OPENAI_API_KEY = 'your-api-key';
        this.CHUNK_INTERVAL = 3000; // Process every 3 seconds
        
        // Bind methods
        this.startRecording = this.startRecording.bind(this);
        this.stopRecording = this.stopRecording.bind(this);
        this.processAudioChunk = this.processAudioChunk.bind(this);
        
        // Initialize UI elements
        this.initializeUI();
    }

    initializeUI() {
        this.startButton = document.getElementById('startNarrationBtn');
        this.audioStatus = document.getElementById('audioStatus');
        this.levelBar = document.querySelector('.level-bar');
        this.statusText = document.getElementById('audioStatusText');

        this.startButton.addEventListener('click', () => {
            if (this.isRecording) {
                this.stopRecording();
            } else {
                this.startRecording();
            }
        });
    }

    async startRecording() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            
            // Create AudioContext for level monitoring
            this.audioContext = new AudioContext();
            const source = this.audioContext.createMediaStreamSource(stream);
            const processor = this.audioContext.createScriptProcessor(2048, 1, 1);
            
            processor.onaudioprocess = (e) => {
                const inputData = e.inputBuffer.getChannelData(0);
                this.updateAudioLevel(inputData);
            };
            
            source.connect(processor);
            processor.connect(this.audioContext.destination);

            // Set up MediaRecorder
            this.mediaRecorder = new MediaRecorder(stream, {
                mimeType: 'audio/webm;codecs=opus'
            });

            this.mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    this.audioChunks.push(event.data);
                }
            };

            // Start recording
            this.mediaRecorder.start(this.CHUNK_INTERVAL);
            this.isRecording = true;

            // Update UI
            this.startButton.classList.add('recording');
            this.startButton.innerHTML = '<i class="fas fa-stop"></i> Stop Narration';
            this.audioStatus.style.display = 'flex';
            this.statusText.textContent = 'Listening...';

            // Start processing chunks periodically
            this.processingInterval = setInterval(() => {
                if (this.audioChunks.length > 0) {
                    this.processAudioChunk();
                }
            }, this.CHUNK_INTERVAL);

        } catch (error) {
            console.error('Error starting audio recording:', error);
            logEvent('Error starting audio recording');
        }
    }

    stopRecording() {
        if (this.mediaRecorder && this.isRecording) {
            this.mediaRecorder.stop();
            clearInterval(this.processingInterval);
            
            // Process any remaining audio
            if (this.audioChunks.length > 0) {
                this.processAudioChunk();
            }
        }

        if (this.audioContext) {
            this.audioContext.close();
        }

        this.isRecording = false;
        this.startButton.classList.remove('recording');
        this.startButton.innerHTML = '<i class="fas fa-microphone"></i> Start Narration';
        this.audioStatus.style.display = 'none';
    }

    updateAudioLevel(audioData) {
        // Calculate RMS value of audio data
        let sum = 0;
        for (let i = 0; i < audioData.length; i++) {
            sum += audioData[i] * audioData[i];
        }
        const rms = Math.sqrt(sum / audioData.length);
        
        // Update level bar (0-100%)
        const level = Math.min(100, rms * 400);
        this.levelBar.style.width = `${level}%`;
    }

    async processAudioChunk() {
        if (this.audioChunks.length === 0) return;

        this.statusText.textContent = 'Processing...';
        
        try {
            // Create blob from chunks
            const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm;codecs=opus' });
            this.audioChunks = []; // Clear processed chunks

            // Create FormData for API request
            const formData = new FormData();
            formData.append('file', audioBlob, 'audio.webm');
            formData.append('model', 'whisper-1');
            formData.append('language', 'en');
            formData.append('prompt', 'Ultimate frisbee game narration. Players: Cyrus, Leif, Cesc, Abby, Avery, James, Simeon, Soren, Walden');

            // Send to Whisper API
            const transcriptionResponse = await fetch('https://api.openai.com/v1/audio/transcriptions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.OPENAI_API_KEY}`
                },
                body: formData
            });

            if (!transcriptionResponse.ok) {
                throw new Error(`Whisper API error: ${transcriptionResponse.statusText}`);
            }

            const transcriptionResult = await transcriptionResponse.json();
            const transcription = transcriptionResult.text;

            // Log the transcription
            logEvent(`Transcription: ${transcription}`);

            // Process transcription with GPT-4
            const gptResponse = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.OPENAI_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: 'gpt-4',
                    messages: [
                        {
                            role: 'system',
                            content: `You are processing ultimate frisbee game events. 
                                    Extract game events from the narration and return them in a structured format.
                                    Focus on: throws, scores, turnovers, and defensive plays.`
                        },
                        {
                            role: 'user',
                            content: transcription
                        }
                    ],
                    functions: [
                        {
                            name: 'recordGameEvent',
                            description: 'Record a game event',
                            parameters: {
                                type: 'object',
                                properties: {
                                    eventType: {
                                        type: 'string',
                                        enum: ['throw', 'score', 'turnover', 'defense']
                                    },
                                    thrower: { type: 'string' },
                                    receiver: { type: 'string' },
                                    throwType: { 
                                        type: 'string',
                                        enum: ['backhand', 'forehand', 'hammer', 'scoober']
                                    },
                                    result: {
                                        type: 'string',
                                        enum: ['complete', 'incomplete', 'score', 'turnover']
                                    }
                                },
                                required: ['eventType']
                            }
                        }
                    ],
                    function_call: 'auto'
                })
            });

            if (!gptResponse.ok) {
                throw new Error(`GPT API error: ${gptResponse.statusText}`);
            }

            const gptResult = await gptResponse.json();
            
            // Process the structured game events
            if (gptResult.choices[0].function_call) {
                const gameEvent = JSON.parse(gptResult.choices[0].function_call.arguments);
                this.handleGameEvent(gameEvent);
            }

            this.statusText.textContent = 'Listening...';

        } catch (error) {
            console.error('Error processing audio:', error);
            logEvent(`Error processing audio: ${error.message}`);
            this.statusText.textContent = 'Error - Listening...';
        }
    }

    handleGameEvent(gameEvent) {
        // Integrate with your existing game state management
        logEvent(`Game Event: ${JSON.stringify(gameEvent)}`);
        
        // Here you would call your existing game state management functions
        // based on the event type
        switch (gameEvent.eventType) {
            case 'throw':
                // Call your existing throw handling code
                break;
            case 'score':
                // Call your existing score handling code
                break;
            case 'turnover':
                // Call your existing turnover handling code
                break;
            case 'defense':
                // Call your existing defense handling code
                break;
        }
    }
}

// Export the class
export default AudioNarrationService;