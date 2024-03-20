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
            with open('recv.ogg', 'ab') as f:  # Open file in append mode
                f.write(message)
            await ws_send(websocket, "Received message and saved.")
    except websockets.exceptions.ConnectionClosed:
        pass  # Connection was closed

async def ws_send(connection, text):
    await connection.send(text)

asyncio.get_event_loop().run_until_complete(websockets.serve(ws_handler, '0.0.0.0', 7538))
asyncio.get_event_loop().run_forever()
