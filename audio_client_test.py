import asyncio
import websockets
import wave
import json
from pydub import AudioSegment


async def send_audio_chunks(audio_file_path, uri):
    # Convert m4a to wav using pydub
    audio = AudioSegment.from_file(audio_file_path, format='m4a')
    audio = audio.set_frame_rate(16000).set_channels(1)
    temp_wav_path = "temp_audio.client.wav"
    audio.export(temp_wav_path, format='wav')

    with wave.open(temp_wav_path, 'rb') as wf:
        chunk_size = 16000 * 2 * 2  # 2 seconds of audio at 16kHz, 16-bit mono (2 bytes per sample)
        
        async with websockets.connect(uri) as websocket:
            frame_rate = wf.getframerate()
            sample_width = wf.getsampwidth()
            num_channels = wf.getnchannels()

            print(f"Frame rate: {frame_rate}, Sample width: {sample_width}, Number of channels: {num_channels}")

            while True:
                audio_chunk = wf.readframes(chunk_size)
                if not audio_chunk:
                    break

                print(f"Sending audio chunk of size {len(audio_chunk)}")
                await websocket.send(audio_chunk)
                response = await websocket.recv()
                response_data = json.loads(response)
                
                transcription = response_data['transcription']
                events = response_data['events']
                
                print("Transcription:", transcription)
                print("Events:\n", events)
                print("="*40)

# Path to your audio file
audio_file_path = './ultimate_possession_test_track.m4a'
# URI of your WebSocket server
uri = "ws://localhost:8765"

asyncio.run(send_audio_chunks(audio_file_path, uri))
