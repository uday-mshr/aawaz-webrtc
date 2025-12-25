# Quick Start: Testing Socket.io Connection

## Option 1: Using Node.js Test Script (Recommended)

### Step 1: Install Test Dependency
```bash
cd voice-gateway
npm install socket.io-client
```

### Step 2: Start Services
```bash
# Terminal 1: Start Redis
docker-compose up redis -d
# Or: redis-server

# Terminal 2: Start Voice Gateway
npm run dev
```

### Step 3: Run Test Script
```bash
node test-socket.js
```

### Step 4: Test AI Response (Optional)
In a new terminal:
```bash
redis-cli
> PUBLISH audio_out:test-room-123 '{"audio":"SGVsbG8gV29ybGQ=","timestamp":1234567890}'
```

You should see the AI audio response in the test script output.

---

## Option 2: Using Postman WebSocket

### Step 1: Create WebSocket Request
1. Open Postman → New → WebSocket Request
2. URL: `ws://localhost:3000/socket.io/?EIO=4&transport=websocket`
3. Click "Connect"

### Step 2: Send Events

**Join Room:**
```
42["join_room","test-room-123"]
```

**Send Audio Chunk:**
```
42["audio_chunk","<base64_encoded_audio>"]
```

**Builder Action:**
```
42["builder_action",{"action":"add_node","nodeType":"voice_input"}]
```

**Start Simulation:**
```
42["start_simulation",{"simulationId":"sim-001","agentConfig":{"voice":"en-US"}}]
```

### Step 3: Test AI Response
In Redis CLI:
```bash
redis-cli
> PUBLISH audio_out:test-room-123 '{"audio":"test_audio_base64","timestamp":1234567890}'
```

You should receive in Postman:
```
42["ai_audio_chunk","test_audio_base64"]
```

---

## Verify Redis Channels

Check what channels are active:
```bash
redis-cli
> PUBSUB CHANNELS *
```

Subscribe to a channel to see messages:
```bash
redis-cli
> SUBSCRIBE audio_in:test-room-123
```

---

## Expected Server Logs

```
Redis Publisher Connected
Redis Subscriber Connected
App listening on http://localhost:3000
Socket connected: <socket_id>
Socket <socket_id> joined room test-room-123
```

---

## Troubleshooting

- **Cannot connect**: Check server is running on port 3000
- **Redis errors**: Verify Redis is running and accessible
- **No events received**: Ensure you've joined a room first
- **CORS issues**: Check `CORS_ORIGIN` in `.env` file

For detailed testing instructions, see `TESTING_PLAN.md`.

