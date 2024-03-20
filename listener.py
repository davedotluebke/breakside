import websockets
import asyncio

import logging
logger = logging.getLogger('websockets.server')
logger.setLevel(logging.DEBUG)
logger.addHandler(logging.StreamHandler())

async def ws_handler(websocket, path):
    try:
        # handle the incoming data
        async for message in websocket:
            with open('recv.txt', 'a') as f:  # Open file in append mode
                f.write(message + '\n')  # Add newline for readability
            await ws_send(websocket, message)  # Await ws_send
    except websockets.exceptions.ConnectionClosed:
        pass  # Connection was closed

async def ws_send(connection, text):
    await connection.send(text)

asyncio.get_event_loop().run_until_complete(websockets.serve(ws_handler, '0.0.0.0', 9124))
asyncio.get_event_loop().run_forever()
