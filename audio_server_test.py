import asyncio
import websockets
import openai
import json
import wave
import os

# Initialize the OpenAI client (XXX: move API key to environment variable)
oai_client = openai.Client(api_key="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")

# Function to transcribe audio file using Whisper
def transcribe_audio(file_path):
    with open(file_path, 'rb') as audio_file:
        response = oai_client.audio.transcriptions.create(
            model="whisper-1",
            file=audio_file
        )
    print(response.text)
    return response.text

# Function to generate events from transcription using GPT-4
def generate_events_from_text(transcription):
    response = oai_client.chat.completions.create(
        model="gpt-4o",
        messages=[
            {"role": "system", "content": "You are a sports commentator. Convert the following transcription into a terse list of one-sentence discrete game events."},
            {"role": "user", "content": transcription}
        ]
    )
    events = response.choices[0].message.content
    return events

async def process_audio_stream(websocket, path):
    frames = []
    temp_audio_path = 'temp_audio.server.wav'

    while True:
        try:
            audio_chunk = await websocket.recv()
            frames.append(audio_chunk)
            
            # Save the received audio chunks to a temporary WAV file
            with wave.open(temp_audio_path, 'wb') as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(16000)
                wf.writeframes(b''.join(frames))
            
            # Transcribe the audio file using Whisper API
            transcription = transcribe_audio(temp_audio_path)
            
            # Generate game events from the transcription using GPT-4
            events = generate_events_from_text(transcription)
            
            # Send the transcription and events back to the client
            response_message = json.dumps({'transcription': transcription, 'events': events})
            await websocket.send(response_message)
        except websockets.ConnectionClosed:
            print("Connection closed")
            break
        except Exception as e:
            print(f"Error: {e}")
            break
        finally:
            # Clean up the temporary audio file
            if os.path.exists(temp_audio_path):
                # os.remove(temp_audio_path)
                print("Temporary audio file not removed")

start_server = websockets.serve(process_audio_stream, "localhost", 8765)

asyncio.get_event_loop().run_until_complete(start_server)
asyncio.get_event_loop().run_forever()
