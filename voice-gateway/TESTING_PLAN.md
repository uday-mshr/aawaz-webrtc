# Socket.io WebSocket Testing Plan with Postman

## Prerequisites

### 1. Start Required Services
```bash
# Start Redis (if using Docker Compose)
docker-compose up redis -d

# Or start Redis locally
redis-server

# Start the Voice Gateway server
cd voice-gateway
npm run dev
```

### 2. Verify Services are Running
- **Server**: Check `http://localhost:3000` returns "Welcome to API service"
- **Redis**: Verify connection in server logs: "Redis Publisher Connected" and "Redis Subscriber Connected"
- **Socket.io**: Server should be listening on port 3000

### 3. Install Postman
- Ensure you have Postman installed (version 8.0+ supports WebSocket)
- Or use Postman Web version

---

## Postman WebSocket Testing Steps

### Step 1: Create WebSocket Connection

1. **Open Postman** → Click **"New"** → Select **"WebSocket Request"**

2. **Connection URL**: 
   ```
   ws://localhost:3000
   ```
   Or for Socket.io specifically:
   ```
   ws://localhost:3000/socket.io/?EIO=4&transport=websocket
   ```

3. **Connection Parameters** (Optional - for authentication):
   - In the **Params** tab, you can add:
     - `token`: (optional) for JWT auth (currently defaults to 'guest')

4. **Click "Connect"**
   - Expected: Connection established
   - You should see Socket.io handshake messages in the messages panel

---

### Step 2: Test Basic Connection

**Observe Connection Events:**
- After connecting, you should see Socket.io protocol messages:
  - `0{"sid":"...","upgrades":[],"pingInterval":25000,"pingTimeout":60000}`
  - Server should respond with `40` (connection acknowledgment)

**Verify in Server Logs:**
- Check for: `"Socket connected: <socket_id>"`

---

### Step 3: Test Join Room Event

**Send Event:**
```json
{
  "event": "join_room",
  "data": "test-room-123"
}
```

**Or using Socket.io protocol format:**
```
42["join_room","test-room-123"]
```

**Expected Results:**
- ✅ Server logs: `"Socket <socket_id> joined room test-room-123"`
- ✅ Redis subscription: Server subscribes to `audio_out:test-room-123`
- ✅ No error response from server

**Verify Redis Subscription:**
```bash
# In another terminal, check Redis subscriptions
redis-cli
> PUBSUB CHANNELS audio_out:*
# Should show: audio_out:test-room-123
```

---

### Step 4: Test Audio Chunk Event

**Prerequisites:**
- Must have joined a room first (Step 3)

**Send Event:**
```json
{
  "event": "audio_chunk",
  "data": "<base64_encoded_audio_data>"
}
```

**Or using Socket.io protocol:**
```
42["audio_chunk","<base64_encoded_audio_data>"]
```

**Test Data:**
- Create a small test audio buffer (e.g., 100 bytes of zeros)
- Base64 encode it: `Buffer.from(new ArrayBuffer(100)).toString('base64')`
- Example: `"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="`

**Expected Results:**
- ✅ Server publishes to Redis channel: `audio_in:test-room-123`
- ✅ Redis message contains: `{"socketId":"...","audio":"...","timestamp":...}`

**Verify Redis Publication:**
```bash
# In another terminal, subscribe to the audio input channel
redis-cli
> SUBSCRIBE audio_in:test-room-123
# Send audio_chunk from Postman, you should see the message
```

---

### Step 5: Test Builder Action Event

**Prerequisites:**
- Must have joined a room first

**Send Event:**
```json
{
  "event": "builder_action",
  "data": {
    "action": "add_node",
    "nodeType": "voice_input",
    "config": {
      "label": "User Input",
      "enabled": true
    }
  }
}
```

**Or using Socket.io protocol:**
```
42["builder_action",{"action":"add_node","nodeType":"voice_input","config":{"label":"User Input","enabled":true}}]
```

**Expected Results:**
- ✅ Server publishes to Redis channel: `builder_events:test-room-123`
- ✅ Redis message contains: `{"action":"add_node","nodeType":"voice_input","config":{...},"socketId":"..."}`

**Verify Redis Publication:**
```bash
redis-cli
> SUBSCRIBE builder_events:test-room-123
# Send builder_action from Postman, you should see the message
```

---

### Step 6: Test Start Simulation Event

**Prerequisites:**
- Must have joined a room first

**Send Event:**
```json
{
  "event": "start_simulation",
  "data": {
    "simulationId": "sim-001",
    "agentConfig": {
      "voice": "en-US",
      "model": "gpt-4",
      "temperature": 0.7
    },
    "timeout": 30000
  }
}
```

**Or using Socket.io protocol:**
```
42["start_simulation",{"simulationId":"sim-001","agentConfig":{"voice":"en-US","model":"gpt-4","temperature":0.7},"timeout":30000}]
```

**Expected Results:**
- ✅ Server publishes to Redis channel: `session_control:test-room-123`
- ✅ Redis message contains: `{"action":"START_SIMULATION","config":{...}}`

**Verify Redis Publication:**
```bash
redis-cli
> SUBSCRIBE session_control:test-room-123
# Send start_simulation from Postman, you should see the message
```

---

### Step 7: Test AI Audio Response (Simulated)

**Simulate Python Worker Response:**

Since you don't have a Python worker yet, simulate the AI response by publishing directly to Redis:

**In Terminal:**
```bash
redis-cli
> PUBLISH audio_out:test-room-123 '{"audio":"SGVsbG8gV29ybGQ=","timestamp":1234567890}'
```

**Expected Results:**
- ✅ Postman should receive event: `ai_audio_chunk`
- ✅ Event data: `"SGVsbG8gV29ybGQ="` (base64 audio)
- ✅ Server logs should show the message was received and broadcast

**In Postman:**
- You should see a message like:
  ```
  42["ai_audio_chunk","SGVsbG8gV29ybGQ="]
  ```

---

### Step 8: Test Disconnect

**Action:**
- Click **"Disconnect"** in Postman

**Expected Results:**
- ✅ Server logs: `"Disconnected: <socket_id>"`
- ✅ Connection closed gracefully

---

## Complete Test Sequence

### Test Script for Postman (Manual Steps)

1. **Connect** → `ws://localhost:3000/socket.io/?EIO=4&transport=websocket`
2. **Join Room** → `42["join_room","test-room-123"]`
3. **Send Audio Chunk** → `42["audio_chunk","<base64_audio>"]`
4. **Send Builder Action** → `42["builder_action",{"action":"test"}]`
5. **Start Simulation** → `42["start_simulation",{"simulationId":"test"}]`
6. **Simulate AI Response** (via Redis CLI) → `PUBLISH audio_out:test-room-123 '{"audio":"test"}'`
7. **Verify AI Audio Received** → Should see `42["ai_audio_chunk","test"]`
8. **Disconnect**

---

## Socket.io Protocol Format

Postman needs to send messages in Socket.io's protocol format:

- **Event Format**: `42["event_name", data]`
  - `4` = MESSAGE event type
  - `2` = EVENT packet type
  - `["event_name", data]` = JSON array with event name and data

- **Connection**: `40` = CONNECT packet
- **Ping/Pong**: `2` = PING, `3` = PONG

---

## Alternative: Using Socket.io Client Library (Node.js Test Script)

If Postman WebSocket testing is complex, create a test script:

**File: `test-socket.js`**
```javascript
const io = require('socket.io-client');

const socket = io('http://localhost:3000', {
  transports: ['websocket'],
  auth: {
    token: 'test-token'
  }
});

socket.on('connect', () => {
  console.log('✅ Connected:', socket.id);
  
  // Test join_room
  socket.emit('join_room', 'test-room-123');
  console.log('✅ Joined room: test-room-123');
  
  // Test audio_chunk
  const audioBuffer = Buffer.from(new ArrayBuffer(100));
  socket.emit('audio_chunk', audioBuffer);
  console.log('✅ Sent audio_chunk');
  
  // Test builder_action
  socket.emit('builder_action', {
    action: 'add_node',
    nodeType: 'voice_input'
  });
  console.log('✅ Sent builder_action');
  
  // Test start_simulation
  socket.emit('start_simulation', {
    simulationId: 'sim-001',
    agentConfig: { voice: 'en-US' }
  });
  console.log('✅ Sent start_simulation');
});

socket.on('ai_audio_chunk', (audio) => {
  console.log('✅ Received AI audio:', audio);
});

socket.on('disconnect', () => {
  console.log('❌ Disconnected');
});

// Keep connection alive for testing
setTimeout(() => {
  socket.disconnect();
  process.exit(0);
}, 10000);
```

**Run:**
```bash
npm install socket.io-client
node test-socket.js
```

---

## Troubleshooting

### Connection Issues
- **Cannot connect**: Check server is running on port 3000
- **CORS errors**: Verify `CORS_ORIGIN` in `.env` includes your origin
- **Connection timeout**: Check Redis is running and accessible

### Event Not Received
- **No room joined**: Ensure `join_room` is called before other events
- **Wrong format**: Verify Socket.io protocol format (`42["event", data]`)
- **Redis not publishing**: Check Redis connection in server logs

### Redis Issues
- **Not subscribed**: Verify `subscribeToRoomAudio` is called after `join_room`
- **No messages**: Check Redis pub/sub channels with `PUBSUB CHANNELS *`
- **Connection error**: Verify `REDIS_HOST` and `REDIS_PORT` in `.env`

---

## Expected Server Logs

```
Redis Publisher Connected
Redis Subscriber Connected
App listening on http://localhost:3000
Socket connected: <socket_id>
Socket <socket_id> joined room test-room-123
Disconnected: <socket_id>
```

---

## Success Criteria

✅ **All tests pass if:**
1. WebSocket connection establishes successfully
2. `join_room` event is acknowledged
3. `audio_chunk` publishes to Redis `audio_in:<room_id>`
4. `builder_action` publishes to Redis `builder_events:<room_id>`
5. `start_simulation` publishes to Redis `session_control:<room_id>`
6. AI audio response from Redis `audio_out:<room_id>` is received as `ai_audio_chunk`
7. Disconnect is handled gracefully

